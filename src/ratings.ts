import type { ChessComGame } from './chess';

const UA = 'chess-notifier (personal, contact: qian.brian@gmail.com)';

// `daily` likely uses a different callback path; not supported here yet.
export const TIME_CLASSES = ['rapid', 'blitz', 'bullet'] as const;
export type TimeClass = (typeof TIME_CLASSES)[number];

export type HistoryPoint = {
  timestamp: number; // ms
  day: number; // days-since-epoch (chess.com)
  rating: number;
  day_close_rating: number;
};

export type RatingStats = {
  timeClass: TimeClass;
  history: HistoryPoint[];
  rating_first: number;
  rating_last: number;
  rating_max: number;
  rating_delta: number;
  win_count: number;
  loss_count: number;
  draw_count: number;
  count: number;
};

type StatsResponse = {
  stats?: {
    history?: HistoryPoint[];
    rating_first?: number;
    rating_last?: number;
    rating_max?: number;
    rating_delta?: number;
    win_count?: number;
    loss_count?: number;
    draw_count?: number;
    count?: number;
  };
};

function isTimeClass(s: string): s is TimeClass {
  return (TIME_CLASSES as readonly string[]).includes(s);
}

export async function fetchRatingStats(
  username: string,
  timeClass: TimeClass,
  days = 30
): Promise<RatingStats | null> {
  const url = `https://www.chess.com/callback/stats/live/${timeClass}/${encodeURIComponent(username)}/${days}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
  if (!res.ok) {
    console.error(`stats fetch failed (${timeClass}): ${res.status} ${res.statusText}`);
    return null;
  }
  const data = (await res.json()) as StatsResponse;
  const s = data.stats;
  if (!s || !s.history || s.history.length === 0) return null;
  return {
    timeClass,
    history: s.history,
    rating_first: s.rating_first ?? s.history[0].day_close_rating,
    rating_last: s.rating_last ?? s.history[s.history.length - 1].day_close_rating,
    rating_max: s.rating_max ?? 0,
    rating_delta: s.rating_delta ?? 0,
    win_count: s.win_count ?? 0,
    loss_count: s.loss_count ?? 0,
    draw_count: s.draw_count ?? 0,
    count: s.count ?? 0,
  };
}

/**
 * Returns the time classes that have at least one game in `games` since `sinceMs`
 * — used to decide which stats endpoints to hit.
 */
export function timeClassesPlayedSince(games: ChessComGame[], sinceMs: number): TimeClass[] {
  const seen = new Set<TimeClass>();
  for (const g of games) {
    if (g.end_time * 1000 < sinceMs) continue;
    if (isTimeClass(g.time_class)) seen.add(g.time_class);
  }
  return TIME_CLASSES.filter((tc) => seen.has(tc));
}

export type TodaySummary = {
  timeClass: TimeClass;
  before: number; // pre-game rating of today's first game
  // Inferred post-game rating of today's last game. Chess.com only exposes
  // pre-game ratings in archives, so we use the next game's pre-game rating
  // as "after". When today's last game IS the most recent game in the archive
  // (typical right after a fresh import), we don't yet have a next game —
  // `deltaComplete=false` flags that the displayed delta covers N-1 of N games.
  after: number;
  delta: number;
  deltaComplete: boolean;
  wins: number;
  losses: number;
  draws: number;
  games: number;
};

/**
 * For each time class with games today (UTC), compute today's delta and W/L/D
 * directly from archive games. The chess.com /callback stats endpoint lags by
 * ~a day, so it can't be the source of truth for intra-day numbers.
 */
export function summarizeToday(
  games: ChessComGame[],
  username: string,
  nowMs = Date.now()
): TodaySummary[] {
  const lower = username.toLowerCase();
  const todayStart = startOfUtcDay(nowMs);
  const sortedByTime = [...games].sort((a, b) => a.end_time - b.end_time);

  const byClass = new Map<TimeClass, ChessComGame[]>();
  for (const g of sortedByTime) {
    if (!isTimeClass(g.time_class)) continue;
    if (g.end_time * 1000 < todayStart) continue;
    const arr = byClass.get(g.time_class) ?? [];
    arr.push(g);
    byClass.set(g.time_class, arr);
  }

  const out: TodaySummary[] = [];
  for (const [tc, todaysGames] of byClass) {
    const first = todaysGames[0];
    const last = todaysGames[todaysGames.length - 1];
    const before = meIn(first, lower).rating;
    const allOfClass = sortedByTime.filter((g) => g.time_class === tc);
    const lastIdx = allOfClass.findIndex((g) => g.uuid === last.uuid);
    const nextGame = allOfClass[lastIdx + 1];
    const after = nextGame ? meIn(nextGame, lower).rating : meIn(last, lower).rating;
    const deltaComplete = nextGame != null;

    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const g of todaysGames) {
      const me = meIn(g, lower);
      const opp = me === g.white ? g.black : g.white;
      if (me.result === 'win') wins++;
      else if (opp.result === 'win') losses++;
      else draws++;
    }

    out.push({
      timeClass: tc,
      before,
      after,
      delta: after - before,
      deltaComplete,
      wins,
      losses,
      draws,
      games: todaysGames.length,
    });
  }
  out.sort((a, b) => TIME_CLASSES.indexOf(a.timeClass) - TIME_CLASSES.indexOf(b.timeClass));
  return out;
}

function meIn(game: ChessComGame, lowerUsername: string) {
  return game.white.username.toLowerCase() === lowerUsername ? game.white : game.black;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
