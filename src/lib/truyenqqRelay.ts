import { fetchWithTimeout } from './http';
import { isSiteAccessRestricted } from './siteAccessState';

const EDGE = import.meta.env.VITE_TRUYENQQ_EDGE_URL ||
  'https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge';
const pending = new Map<string, Promise<boolean>>();
const warmedUntil = new Map<string, number>();
type Source = { path: string; keyword?: string };

function source(path: string | null, encodedKeyword?: string | null): Source | null {
  if (!path || path.length > 2048 || !/^\/[a-zA-Z0-9][a-zA-Z0-9/_.?=&,%+-]*$/.test(path)) return null;
  if (path.split('?')[0] === '/frontend/search/search') {
    try {
      const keyword = decodeURIComponent(encodedKeyword || '');
      return keyword && keyword.length <= 200 ? { path, keyword } : null;
    } catch { return null; }
  }
  return { path };
}

async function warm(value: Source, signal: AbortSignal | null | undefined, timeout: number, authorization?: string | null): Promise<boolean> {
  if (signal?.aborted) return false;
  const key = JSON.stringify([value, authorization || '']);
  const running = pending.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const response = await fetchWithTimeout(EDGE.replace(/\/$/, '') + value.path, {
        // Same-origin Access cookies work without exposing cookies to workers.dev.
        method: value.keyword ? 'POST' : 'GET', credentials: 'same-origin', signal,
        headers: authorization ? { Authorization: authorization } : undefined,
        ...(value.keyword ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) },
          body: new URLSearchParams({ search: value.keyword, type: '0' }).toString() } : {}),
      }, timeout);
      if (!response.ok) return false;
      warmedUntil.set(key, Date.now() + 45_000);
      if (warmedUntil.size > 200) warmedUntil.delete(warmedUntil.keys().next().value!);
      return true;
    } catch { return false; }
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}

function refreshSource(value: unknown, keyword: string | null, signal: AbortSignal | null | undefined, authorization?: string | null) {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'truyenqqko.com') return;
    const hint = source(url.pathname + url.search, keyword ? encodeURIComponent(keyword) : null);
    if (hint && (warmedUntil.get(JSON.stringify([hint, authorization || ''])) || 0) < Date.now()) void warm(hint, signal, 10_000, authorization);
  } catch { /* Source hints are optional. */ }
}

/** Recover public QQ reads without forwarding account credentials to the relay. */
export async function fetchWithTruyenQQRelay(url: string, options: RequestInit, timeout: number): Promise<Response> {
  const apiUrl = new URL(url, window.location.origin);
  if (!apiUrl.pathname.startsWith('/api/manga/') || (options.method || 'GET').toUpperCase() !== 'GET') {
    return fetchWithTimeout(url, options, timeout);
  }
  const deadline = Date.now() + timeout;
  const authorization = isSiteAccessRestricted() ? new Headers(options.headers).get('Authorization') : null;
  let response = await fetchWithTimeout(url, options, timeout);
  for (let attempt = 0; attempt < 2 && response.headers.get('X-TruyenQQ-Error') === 'http-403'; attempt++) {
    const hint = source(response.headers.get('X-TruyenQQ-Source-Path'), response.headers.get('X-TruyenQQ-Search'));
    const remaining = deadline - Date.now();
    if (!hint || remaining <= 0 || !await warm(hint, options.signal, remaining, authorization)) return response;
    const retryRemaining = deadline - Date.now();
    if (retryRemaining <= 0) return response;
    response = await fetchWithTimeout(url, options, retryRemaining);
  }
  if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.clone().json().catch(() => null);
    for (const value of [payload, payload?.latest, payload?.ongoing]) {
      refreshSource(value?.data?.source_url, apiUrl.searchParams.get('keyword'), options.signal, authorization);
    }
  }
  return response;
}
