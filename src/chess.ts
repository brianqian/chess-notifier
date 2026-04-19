export type ChessComPlayer = {
  username: string;
  rating: number;
  result: string;
};

export type ChessComGame = {
  url: string;
  pgn: string;
  end_time: number;
  uuid: string;
  time_class: string;
  time_control: string;
  rated: boolean;
  white: ChessComPlayer;
  black: ChessComPlayer;
};

const UA = "chess-notifier (personal, contact: qian.brian@gmail.com)";

export async function fetchRecentGames(
  username: string,
): Promise<ChessComGame[]> {
  const archivesRes = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`,
    { headers: { "User-Agent": UA } },
  );
  if (!archivesRes.ok) {
    throw new Error(
      `chess.com archives fetch failed: ${archivesRes.status} ${archivesRes.statusText}`,
    );
  }
  const { archives } = (await archivesRes.json()) as { archives: string[] };
  // Pull last two monthly archives to cover month rollover.
  const recent = archives.slice(-2);

  const games: ChessComGame[] = [];
  for (const url of recent) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const data = (await res.json()) as { games: ChessComGame[] };
    games.push(...data.games);
  }
  games.sort((a, b) => a.end_time - b.end_time);
  return games;
}
