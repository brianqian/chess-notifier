export type LichessImportResponse = {
  id: string;
  url: string;
};

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }
  return null;
}

export class LichessImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: number | null
  ) {
    super(message);
    this.name = 'LichessImportError';
  }
}

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
    throw new LichessImportError(
      `lichess import failed ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      parseRetryAfter(res.headers.get('retry-after'))
    );
  }
  return (await res.json()) as LichessImportResponse;
}
