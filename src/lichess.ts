export type LichessImportResponse = {
  id: string;
  url: string;
};

export async function importToLichess(pgn: string, token?: string): Promise<LichessImportResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('https://lichess.org/api/import', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ pgn }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`lichess import failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as LichessImportResponse;
}
