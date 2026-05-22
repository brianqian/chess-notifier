import { getUnixTime } from 'date-fns';

const QUEUE_KEY = 'retry_queue';
const PGN_PREFIX = 'pgn:';
const PGN_TTL_SECONDS = 60 * 60 * 24 * 30;

export type QueueEntry = { uuid: string; addedAt: number };

export type DequeuedGame = { uuid: string; pgn: string };

async function readQueue(state: KVNamespace): Promise<QueueEntry[]> {
  const json = await state.get(QUEUE_KEY);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(state: KVNamespace, queue: QueueEntry[]): Promise<void> {
  await state.put(QUEUE_KEY, JSON.stringify(queue));
}

export async function getQueue(state: KVNamespace): Promise<QueueEntry[]> {
  return readQueue(state);
}

export async function enqueueGames(
  state: KVNamespace,
  games: { uuid: string; pgn: string }[]
): Promise<number> {
  if (games.length === 0) return 0;
  const existing = await readQueue(state);
  const existingUuids = new Set(existing.map((e) => e.uuid));
  const now = getUnixTime(new Date());
  const toAdd: QueueEntry[] = [];
  for (const g of games) {
    if (existingUuids.has(g.uuid)) continue;
    await state.put(PGN_PREFIX + g.uuid, g.pgn, { expirationTtl: PGN_TTL_SECONDS });
    toAdd.push({ uuid: g.uuid, addedAt: now });
    existingUuids.add(g.uuid);
  }
  if (toAdd.length === 0) return 0;
  await writeQueue(state, [...existing, ...toAdd]);
  return toAdd.length;
}

export async function isQueued(state: KVNamespace, uuid: string): Promise<boolean> {
  const queue = await readQueue(state);
  return queue.some((e) => e.uuid === uuid);
}

export async function popNext(state: KVNamespace): Promise<DequeuedGame | null> {
  const queue = await readQueue(state);
  if (queue.length === 0) return null;
  const [head, ...rest] = queue;
  await writeQueue(state, rest);
  const pgn = await state.get(PGN_PREFIX + head.uuid);
  await state.delete(PGN_PREFIX + head.uuid);
  if (!pgn) return null;
  return { uuid: head.uuid, pgn };
}

export async function requeueHead(state: KVNamespace, game: DequeuedGame): Promise<void> {
  const queue = await readQueue(state);
  // Always restore the PGN — popNext deleted it, and a concurrent enqueue may have
  // re-added the uuid without its PGN if the cache had been populated and then cleared.
  await state.put(PGN_PREFIX + game.uuid, game.pgn, { expirationTtl: PGN_TTL_SECONDS });
  if (queue.some((e) => e.uuid === game.uuid)) return;
  await writeQueue(state, [{ uuid: game.uuid, addedAt: getUnixTime(new Date()) }, ...queue]);
}
