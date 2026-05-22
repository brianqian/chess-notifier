import { getUnixTime, subHours, startOfDay } from 'date-fns';
import { fetchGamesSince, type ChessComGame } from './chess';
import { importToLichess, LichessImportError } from './lichess';
import { sendEmail, type GameRow } from './email';
import { getCachedLichessUrl, setCachedLichessUrl } from './cache';
import { enqueueGames, popNext, requeueHead } from './queue';
import {
  fetchRatingStats,
  summarizeToday,
  timeClassesPlayedSince,
  type RatingStats,
  type TimeClass,
} from './ratings';
import type { Env } from './env';

const REPORT_WINDOW_HOURS = 24;
const IMPORT_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunSummary = {
  games: number;
  alreadyCached: number;
  freshlyImported: number;
  queued: number;
  emailed: boolean;
};

export async function processDailyReport(env: Env): Promise<RunSummary> {
  const since = getUnixTime(subHours(new Date(), REPORT_WINDOW_HOURS));
  const games = await fetchGamesSince(env.CHESS_USERNAME, since);
  games.sort((a, b) => a.end_time - b.end_time);

  const rows: GameRow[] = [];
  const toEnqueue: { uuid: string; pgn: string }[] = [];
  let alreadyCached = 0;
  let freshlyImported = 0;
  let bailed = false;
  let firstImport = true;

  for (const game of games) {
    const cached = await getCachedLichessUrl(env.STATE, game.uuid);
    if (cached) {
      rows.push({ game, lichessUrl: cached });
      alreadyCached++;
      continue;
    }

    if (bailed) {
      toEnqueue.push({ uuid: game.uuid, pgn: game.pgn });
      rows.push({ game, lichessUrl: null });
      continue;
    }

    if (!firstImport) await sleep(IMPORT_DELAY_MS);
    firstImport = false;
    try {
      const { url } = await importToLichess(game.pgn, env.LICHESS_TOKEN);
      await setCachedLichessUrl(env.STATE, game.uuid, url);
      rows.push({ game, lichessUrl: url });
      freshlyImported++;
    } catch (err) {
      if (err instanceof LichessImportError && err.status === 429) {
        bailed = true;
        toEnqueue.push({ uuid: game.uuid, pgn: game.pgn });
        rows.push({ game, lichessUrl: null });
        console.warn('lichess rate-limited; enqueueing the rest of the window', game.uuid);
      } else {
        console.error('lichess import failed', game.uuid, err);
        rows.push({ game, lichessUrl: null });
      }
    }
  }

  if (toEnqueue.length > 0) {
    await enqueueGames(env.STATE, toEnqueue);
  }

  let emailed = false;
  if (rows.length > 0) {
    const ratingContext = await buildRatingContext(env, games);
    try {
      await sendEmail(env, rows, ratingContext);
      emailed = true;
    } catch (err) {
      console.error('email send failed', err);
    }
  }

  return {
    games: games.length,
    alreadyCached,
    freshlyImported,
    queued: toEnqueue.length,
    emailed,
  };
}

async function buildRatingContext(env: Env, games: ChessComGame[]) {
  const todayStart = getUnixTime(startOfDay(new Date())) * 1000;
  const classesToday = timeClassesPlayedSince(games, todayStart);
  const statsEntries = await Promise.all(
    classesToday.map(
      async (tc) =>
        [tc, await fetchRatingStats(env.CHESS_USERNAME, tc, 30).catch(() => null)] as const
    )
  );
  const statsByClass: Partial<Record<TimeClass, RatingStats>> = {};
  for (const [tc, stats] of statsEntries) {
    if (stats) statsByClass[tc] = stats;
  }
  const todaySummaries = summarizeToday(games, env.CHESS_USERNAME);
  return { statsByClass, todaySummaries };
}

export type DrainResult =
  | { status: 'empty' }
  | { status: 'imported'; uuid: string; url: string }
  | { status: 'rate_limited'; uuid: string; retryAfter: number | null }
  | { status: 'failed'; uuid: string; error: string }
  | { status: 'missing_pgn'; uuid: string };

// Cap chosen to fit the Workers waitUntil budget: 8 × IMPORT_DELAY_MS + import RTT ≈ 13s.
const DRAIN_BATCH_MAX = 8;

export type DrainBatchResult = {
  processed: number;
  stopped: 'empty' | 'rate_limited' | 'failed' | 'batch_limit';
  lastResult?: DrainResult;
};

export async function drainQueue(env: Env): Promise<DrainBatchResult> {
  let processed = 0;
  let lastResult: DrainResult | undefined;
  for (let i = 0; i < DRAIN_BATCH_MAX; i++) {
    if (i > 0) await sleep(IMPORT_DELAY_MS);
    const result = await drainOneFromQueue(env);
    lastResult = result;
    if (result.status === 'empty') return { processed, stopped: 'empty', lastResult };
    if (result.status === 'rate_limited') {
      // Next minute-cron tick will be ~60s later — past Lichess's worst-case cooldown.
      return { processed, stopped: 'rate_limited', lastResult };
    }
    processed++;
    if (result.status === 'failed') continue;
  }
  return { processed, stopped: 'batch_limit', lastResult };
}

export async function drainOneFromQueue(env: Env): Promise<DrainResult> {
  const next = await popNext(env.STATE);
  if (!next) return { status: 'empty' };

  const cached = await getCachedLichessUrl(env.STATE, next.uuid);
  if (cached) return { status: 'imported', uuid: next.uuid, url: cached };

  try {
    const { url } = await importToLichess(next.pgn, env.LICHESS_TOKEN);
    await setCachedLichessUrl(env.STATE, next.uuid, url);
    return { status: 'imported', uuid: next.uuid, url };
  } catch (err) {
    if (err instanceof LichessImportError && err.status === 429) {
      await requeueHead(env.STATE, next);
      console.warn('drain: rate-limited, re-queued', next.uuid, 'retryAfter=', err.retryAfter);
      return { status: 'rate_limited', uuid: next.uuid, retryAfter: err.retryAfter };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('drain: import failed (dropping)', next.uuid, message);
    return { status: 'failed', uuid: next.uuid, error: message };
  }
}
