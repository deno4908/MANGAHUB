import { fetchWithTimeout } from './http';
import { isSiteAccessRestricted } from './siteAccessState';

const EDGE = import.meta.env.VITE_TRUYENQQ_EDGE_URL ||
  'https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge';
type Recovery = { ok: boolean; snapshot?: { html: string; proof: string } };
type Pending = { promise: Promise<Recovery>; controller: AbortController; readers: number; done: boolean };
const pending = new Map<string, Pending>();
const recent = new Map<string, Recovery & { until: number }>();

export function clearQQRecovery() {
  recent.clear();
  for (const running of pending.values()) running.controller.abort();
  pending.clear();
}
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

function remember(key: string, result: Recovery) {
  let until = Date.now() + 30_000;
  try {
    const metadata = JSON.parse(atob((result.snapshot?.proof.split('.')[0] || '').replaceAll('-', '+').replaceAll('_', '/')));
    if (Number.isFinite(metadata.expires)) until = Math.min(until, metadata.expires * 1000 - 1000);
  } catch { /* An older relay can omit its signed expiry. */ }
  if (until <= Date.now()) return;
  recent.delete(key);recent.set(key, { until, ...result });
  // Keep at most 4 MB of recovery HTML on mobile, with no account data.
  let bytes = [...recent.values()].reduce((sum, row) => sum + (row.snapshot?.html.length || 0) * 2, 0);
  while (recent.size > 64 || bytes > 4 * 1024 * 1024) {
    const oldest = recent.keys().next().value!;
    bytes -= (recent.get(oldest)?.snapshot?.html.length || 0) * 2;recent.delete(oldest);
  }
}

async function warm(value: Source, signal: AbortSignal | null | undefined, timeout: number, authorization?: string | null): Promise<Recovery> {
  if (signal?.aborted) return { ok: false };
  const key = JSON.stringify([value, authorization || '']);
  let running = pending.get(key);
  const previous = recent.get(key);
  if (previous && previous.until > Date.now()) return previous;
  if (!running) {
    const entry: Pending = { controller: new AbortController(), readers: 0, done: false,
      promise: Promise.resolve({ ok: false }) };
    const job: Promise<Recovery> = (async () => {
    try {
      const response = await fetchWithTimeout(EDGE.replace(/\/$/, '') + value.path, {
        // A page change may cancel one consumer of this shared fill. It must
        // not cancel recovery for the next page already waiting on it.
        method: value.keyword ? 'POST' : 'GET', credentials: 'omit', signal: entry.controller.signal,
        headers: authorization ? { Authorization: authorization } : undefined,
        ...(value.keyword ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) },
          body: new URLSearchParams({ search: value.keyword, type: '0' }).toString() } : {}),
      }, timeout);
      if (!response.ok) return { ok: false };
      const proof = response.headers.get('X-TruyenQQ-Proof');
      if (proof && proof.length <= 8192) {
        const html = await response.text();
        if (html.length <= 2 * 1024 * 1024) return { ok: true, snapshot: { html, proof } };
      }
      return { ok: true };
    } catch { return { ok: false }; }
    })();
    entry.promise = job.then(result => {
      if (!entry.controller.signal.aborted) remember(key, result);
      return result;
    }).finally(() => {
      entry.done = true;
      if (pending.get(key) === entry) pending.delete(key);
    });
    running = entry;pending.set(key, entry);
  }
  const current = running;
  current.readers++;
  let cancel!: () => void;
  const cancelled = new Promise<Recovery>(resolve => { cancel = () => resolve({ ok: false }); });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([current.promise, cancelled]);
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (--current.readers === 0 && !current.done) {
      if (pending.get(key) === current) pending.delete(key);
      current.controller.abort();
    }
  }
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
  const recovered = new Set<string>();
  for (let attempt = 0; attempt < 2 && response.headers.get('X-TruyenQQ-Error') === 'http-403'; attempt++) {
    const hint = source(response.headers.get('X-TruyenQQ-Source-Path'), response.headers.get('X-TruyenQQ-Search'));
    const remaining = deadline - Date.now();
    if (!hint || recovered.has(JSON.stringify(hint)) || remaining <= 0) return response;
    recovered.add(JSON.stringify(hint));
    const recovery = await warm(hint, options.signal, remaining, authorization);
    if (options.signal?.aborted) throw new DOMException('QQ read cancelled', 'AbortError');
    if (!recovery.ok) return response;
    const retryRemaining = deadline - Date.now();
    if (retryRemaining <= 0) return response;
    const canHandoff = response.headers.get('X-TruyenQQ-Recovery') === '1' && recovery.snapshot &&
      /^\/api\/manga\/(?:homepage|categories|truyenqq-filtered|otruyen-filtered|search|trending|detail\/[a-zA-Z0-9-]+|chapter\/[a-zA-Z0-9._-]+|(?:list|category)\/[a-zA-Z0-9-]+(?:\/batch)?|truyenqq\/(?:cover\/[a-zA-Z0-9-]+|image\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+\/[0-9]+))$/.test(apiUrl.pathname);
    if (canHandoff) {
      const headers = new Headers(options.headers);
      headers.set('Content-Type', 'application/json');headers.set('X-TruyenQQ-Recovery', '1');
      let retryUrl = url;
      try {
        const actual = new URL(response.url);
        if ([apiUrl.origin, 'https://standby.mangahub.art'].includes(actual.origin) &&
          actual.pathname === apiUrl.pathname && actual.search === apiUrl.search) retryUrl = actual.href;
      } catch { /* A synthetic response has no origin. Keep the original API. */ }
      response = await fetchWithTimeout(retryUrl, { ...options, method: 'POST', headers,
        body: JSON.stringify(recovery.snapshot) }, retryRemaining);
    } else response = await fetchWithTimeout(url, options, retryRemaining);
  }
  // Healthy backend reads already have their source data. Only an explicit
  // source denial needs the browser's relay; speculative warming spends quota
  // and competes with chapter images without improving this response.
  return response;
}
