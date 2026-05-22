const LICHESS_URL_PREFIX = 'lichess_url:';
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export async function getCachedLichessUrl(
  state: KVNamespace,
  uuid: string
): Promise<string | null> {
  return state.get(LICHESS_URL_PREFIX + uuid);
}

export async function setCachedLichessUrl(
  state: KVNamespace,
  uuid: string,
  url: string
): Promise<void> {
  await state.put(LICHESS_URL_PREFIX + uuid, url, { expirationTtl: TTL_SECONDS });
}
