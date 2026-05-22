import { Hono, type Context } from 'hono';
import { getUnixTime, subHours } from 'date-fns';
import { processNewGames, drainQueue } from './processor';
import { fetchGamesSince } from './chess';
import { getCachedLichessUrl } from './cache';
import { enqueueGames, getQueue } from './queue';
import { renderRecentPage, type RecentRow } from './views';
import type { Env } from './env';

const DAILY_CRON = '0 13 * * *';
const DEFAULT_HOURS = 24;

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const checkKey = (c: AppContext) =>
  !!c.env.TRIGGER_SECRET && c.req.query('key') === c.env.TRIGGER_SECRET;

const unauthorized = (c: AppContext) => c.json({ error: 'unauthorized' }, 401);

function parseHours(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURS;
}

app.get('/', (c) => c.text('chess-notifier ok'));

app.get('/run', async (c) => {
  if (!checkKey(c)) return unauthorized(c);
  return c.json(await processNewGames(c.env));
});

app.get('/queue', async (c) => {
  if (!checkKey(c)) return unauthorized(c);
  const queue = await getQueue(c.env.STATE);
  return c.json({ size: queue.length, entries: queue });
});

app.get('/retry', async (c) => {
  if (!checkKey(c)) return unauthorized(c);
  const queue = await getQueue(c.env.STATE);
  // Kick a burst drain in the background; minute cron handles anything left over.
  c.executionCtx.waitUntil(drainQueue(c.env));
  return c.json({
    queued: queue.length,
    note: 'Bursting now; remaining games drain at the minute cron tick.',
  });
});

app.get('/recent', async (c) => {
  if (!checkKey(c)) return unauthorized(c);

  const hours = parseHours(c.req.query('hours'));
  const since = getUnixTime(subHours(new Date(), hours));
  const games = await fetchGamesSince(c.env.CHESS_USERNAME, since);
  games.sort((a, b) => b.end_time - a.end_time);

  const queue = await getQueue(c.env.STATE);
  const queuedSet = new Set(queue.map((q) => q.uuid));

  const rows: RecentRow[] = [];
  const toEnqueue: { uuid: string; pgn: string }[] = [];

  for (const game of games) {
    const cached = await getCachedLichessUrl(c.env.STATE, game.uuid);
    if (cached) {
      rows.push({ game, lichessUrl: cached, status: 'imported' });
      continue;
    }
    if (!queuedSet.has(game.uuid)) {
      toEnqueue.push({ uuid: game.uuid, pgn: game.pgn });
    }
    rows.push({ game, lichessUrl: null, status: 'queued' });
  }

  if (toEnqueue.length > 0) await enqueueGames(c.env.STATE, toEnqueue);

  const pending = queue.length + toEnqueue.length;
  return c.html(renderRecentPage(rows, c.env.CHESS_USERNAME, hours, pending));
});

async function runDailyCron(env: Env): Promise<void> {
  try {
    const summary = await processNewGames(env);
    console.log('daily cron summary', summary);
  } catch (err) {
    console.error('daily cron error', err);
  }
}

async function runDrainCron(env: Env): Promise<void> {
  try {
    const result = await drainQueue(env);
    if (result.processed > 0 || result.stopped !== 'empty') console.log('drain', result);
  } catch (err) {
    console.error('drain error', err);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(event.cron === DAILY_CRON ? runDailyCron(env) : runDrainCron(env));
  },
} satisfies ExportedHandler<Env>;
