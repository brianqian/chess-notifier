import { fetchRecentGames, type ChessComGame } from './chess';
import { importToLichess, LichessImportError } from './lichess';
import { sendEmail, type ImportedGame } from './email';
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

const SEEN_KEY = 'seen_uuids';
const MAX_SEEN = 200;
const IMPORT_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunSummary = {
  found: number;
  new: number;
  imported: number;
  failed: number;
  rateLimited: number;
  alreadyImported: number;
  emailed: boolean;
};

export async function processNewGames(env: Env): Promise<RunSummary> {
  const seenJson = (await env.STATE.get(SEEN_KEY)) ?? '[]';
  const seen: string[] = JSON.parse(seenJson);
  const seenSet = new Set(seen);

  const games = await fetchRecentGames(env.CHESS_USERNAME);
  const newGames = games.filter((g) => !seenSet.has(g.uuid));

  const imported: ImportedGame[] = [];
  const rateLimited: ChessComGame[] = [];
  let failed = 0;
  let alreadyImported = 0;
  let bailed = false;
  let firstImport = true;
  for (const game of newGames) {
    // If we already have a Lichess URL cached (e.g. from a manual /retry or /recent), don't
    // re-import or re-email — just reconcile by marking as seen.
    const cachedUrl = await getCachedLichessUrl(env.STATE, game.uuid);
    if (cachedUrl) {
      seenSet.add(game.uuid);
      alreadyImported++;
      continue;
    }

    if (bailed) {
      rateLimited.push(game);
      continue;
    }
    if (!firstImport) await sleep(IMPORT_DELAY_MS);
    firstImport = false;
    try {
      const { url } = await importToLichess(game.pgn, env.LICHESS_TOKEN);
      imported.push({ game, lichessUrl: url });
      seenSet.add(game.uuid);
      await setCachedLichessUrl(env.STATE, game.uuid, url);
    } catch (err) {
      if (err instanceof LichessImportError && err.status === 429) {
        rateLimited.push(game);
        bailed = true;
        console.error('lichess rate-limited, enqueueing remaining games for retry', game.uuid);
      } else {
        failed++;
        console.error('lichess import failed', game.uuid, err);
      }
    }
  }

  if (rateLimited.length > 0) {
    await enqueueGames(
      env.STATE,
      rateLimited.map((g) => ({ uuid: g.uuid, pgn: g.pgn }))
    );
  }

  let emailed = false;
  if (imported.length > 0 || rateLimited.length > 0) {
    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const classesToday = timeClassesPlayedSince(games, todayStart);
    const statsByClass: Partial<Record<TimeClass, RatingStats>> = {};
    const statsEntries = await Promise.all(
      classesToday.map(
        async (tc) =>
          [tc, await fetchRatingStats(env.CHESS_USERNAME, tc, 30).catch(() => null)] as const
      )
    );
    for (const [tc, stats] of statsEntries) {
      if (stats) statsByClass[tc] = stats;
    }
    const todaySummaries = summarizeToday(games, env.CHESS_USERNAME);

    try {
      await sendEmail(env, imported, rateLimited, { statsByClass, todaySummaries });
      emailed = true;
    } catch (err) {
      console.error('email send failed', err);
    }
  }

  // Persist seen set (bounded to MAX_SEEN, most recent games kept).
  // Rate-limited games are intentionally NOT marked seen so they remain visible to retry/recovery flows.
  if (newGames.length > 0) {
    const merged = [...seen.filter((u) => seenSet.has(u)), ...imported.map((i) => i.game.uuid)];
    const trimmed = merged.slice(-MAX_SEEN);
    await env.STATE.put(SEEN_KEY, JSON.stringify(trimmed));
  }

  return {
    found: games.length,
    new: newGames.length,
    imported: imported.length,
    failed,
    rateLimited: rateLimited.length,
    alreadyImported,
    emailed,
  };
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
    if (result.status === 'failed') {
      // Dropped from queue; keep going so one bad PGN doesn't block the rest.
      continue;
    }
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
