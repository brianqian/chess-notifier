import { fetchRecentGames } from './chess';
import { importToLichess } from './lichess';
import { sendEmail, type ImportedGame } from './email';
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
  emailed: boolean;
};

export async function processNewGames(env: Env): Promise<RunSummary> {
  const seenJson = (await env.STATE.get(SEEN_KEY)) ?? '[]';
  const seen: string[] = JSON.parse(seenJson);
  const seenSet = new Set(seen);

  const games = await fetchRecentGames(env.CHESS_USERNAME);
  const newGames = games.filter((g) => !seenSet.has(g.uuid));

  const imported: ImportedGame[] = [];
  let failed = 0;
  for (let i = 0; i < newGames.length; i++) {
    const game = newGames[i];
    if (i > 0) await sleep(IMPORT_DELAY_MS);
    try {
      const { url } = await importToLichess(game.pgn, env.LICHESS_TOKEN);
      imported.push({ game, lichessUrl: url });
      seenSet.add(game.uuid);
    } catch (err) {
      failed++;
      console.error('lichess import failed', game.uuid, err);
    }
  }

  let emailed = false;
  if (imported.length > 0) {
    try {
      await sendEmail(env, imported);
      emailed = true;
    } catch (err) {
      console.error('email send failed', err);
    }
  }

  // Persist seen set (bounded to MAX_SEEN, most recent games kept)
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
    emailed,
  };
}
