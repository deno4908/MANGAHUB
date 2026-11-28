import { fetchWithTimeout } from './http';
import { isSiteAccessRestricted } from './siteAccessState';

const EDGE = import.meta.env.VITE_TRUYENQQ_EDGE_URL ||
  'https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge';
type Recovery = { ok: boolean; snapshot?: { html: string; proof: string }; retryAt?: number };
type Pending = { promise: Promise<Recovery>; controller: AbortController; readers: number; done: boolean };
const pending = new Map<string, Pending>();
const recent = new Map<string, Recovery & { until: number }>();
const repairs = new Map<string, Promise<void>>();
let generation = 0;

export function clearQQRecovery() {
  generation++;
  repairs.clear();
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
  const remembered = { ...result, until, ...(!result.ok ? { retryAt: until } : {}) };
  recent.delete(key);recent.set(key, remembered);
  // Keep at most 4 MB of recovery HTML on mobile, with no account data.
  let bytes = [...recent.values()].reduce((sum, row) => sum + (row.snapshot?.html.length || 0) * 2, 0);
  while (recent.size > 64 || bytes > 4 * 1024 * 1024) {
    const oldest = recent.keys().next().value!;
    bytes -= (recent.get(oldest)?.snapshot?.html.length || 0) * 2;recent.delete(oldest);
  }
  return remembered;
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
      return !entry.controller.signal.aborted ? remember(key, result) || result : result;
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

async function waitForAuthorization(resolve: () => Promise<string | null>, signal: AbortSignal | null | undefined,
  timeout: number): Promise<string | null> {
  if (signal?.aborted || timeout <= 0) return null;
  let timer: ReturnType<typeof setTimeout>;
  let cancel!: () => void;
  try {
    return await new Promise<string | null>(done => {
      cancel = () => done(null);
      timer = setTimeout(cancel, timeout);
      signal?.addEventListener('abort', cancel, { once: true });
      // Refresh can be shared by other requests. Stop waiting, not their job.
      Promise.resolve().then(resolve).then(done, cancel);
    });
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Recover public QQ reads; only the owned relay may receive website authorization. */
export async function fetchWithTruyenQQRelay(url: string, options: RequestInit, timeout: number,
  resolveAuthorization?: () => Promise<string | null>): Promise<Response> {
  const apiUrl = new URL(url, window.location.origin);
  if (!apiUrl.pathname.startsWith('/api/manga/') || (options.method || 'GET').toUpperCase() !== 'GET') {
    return fetchWithTimeout(url, options, timeout);
  }
  const deadline = Date.now() + timeout;
  let authorization = isSiteAccessRestricted() ? new Headers(options.headers).get('Authorization') : null;
  let retryOptions = options;
  const started = generation;
  const initial = await fetchWithTimeout(url, options, timeout);
  const recover = async () => {
  let response = initial;
  const recovered = new Set<string>();
  const prepared = new Map<string, Recovery>();
  for (let attempt = 0; attempt < 2 && response.headers.get('X-TruyenQQ-Error') === 'http-403'; attempt++) {
    const hint = source(response.headers.get('X-TruyenQQ-Source-Path'), response.headers.get('X-TruyenQQ-Search'));
    let remaining = deadline - Date.now();
    if (!hint || recovered.has(JSON.stringify(hint)) || remaining <= 0) return response;
    recovered.add(JSON.stringify(hint));
    if (isSiteAccessRestricted() && !authorization) {
      // The API can authorize a read with its HttpOnly cookie while a new tab
      // has no in-memory token. Restore only after a proven source failure;
      // healthy reads keep their cookie fast path and cost no auth request.
      authorization = resolveAuthorization ? await waitForAuthorization(resolveAuthorization, options.signal, remaining) : null;
      if (options.signal?.aborted) throw new DOMException('QQ read cancelled', 'AbortError');
      if (!authorization || started !== generation) return response;
      const headers = new Headers(options.headers);
      headers.set('Authorization', authorization);
      retryOptions = { ...options, headers };
      remaining = deadline - Date.now();
      if (remaining <= 0) return response;
    }
    const hintKey = JSON.stringify(hint);
    if (!prepared.has(hintKey)) {
      if (prepared.size >= 2) return response;
      const hints = [hint];
      if (attempt === 0 && response.headers.get('X-TruyenQQ-Recovery') === '1' &&
          /^\/tim-kiem-nang-cao\/trang-\d+(?:\?|$)/.test(hint.path) &&
          /^\/api\/manga\/(?:truyenqq|otruyen)-filtered$/.test(apiUrl.pathname)) {
        try {
          const raw = response.headers.get('X-TruyenQQ-Source-Paths') || '';
          const paths: unknown = raw.length <= 4096 ? JSON.parse(raw) : null;
          if (Array.isArray(paths) && paths.length <= 2) {
            for (const path of paths) {
              const extra = typeof path === 'string' ? source(path) : null;
              // Only the same filtered query's proven failed native pages.
              // Keep the existing two-fill budget and fixed owned relay.
              if (extra && /^\/tim-kiem-nang-cao\/trang-\d+(?:\?|$)/.test(extra.path) &&
                  extra.path.split('?')[1] === hint.path.split('?')[1] &&
                  !hints.some(value => value.path === extra.path) && hints.length < 2) hints.push(extra);
            }
          }
        } catch { /* Older servers expose only the single source hint. */ }
      }
      const fills = await Promise.all(hints.map(value => warm(value, options.signal, remaining, authorization)));
      hints.forEach((value, index) => prepared.set(JSON.stringify(value), fills[index]));
    }
    const recovery = prepared.get(hintKey)!;
    if (options.signal?.aborted) throw new DOMException('QQ read cancelled', 'AbortError');
    if (started !== generation) return response;
    if (!recovery.ok) {
      // Every image sharing this source must wait for the same failed fill
      // to expire. Early retries can only get the same cached failure.
      const seconds = Math.ceil(((recovery.retryAt || 0) - Date.now()) / 1000);
      if (!response.ok && seconds > 0) {
        const headers = new Headers(response.headers);headers.set('Retry-After', String(seconds));
        const deferred = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        Object.defineProperty(deferred, 'url', { value: response.url });
        return deferred;
      }
      return response;
    }
    const retryRemaining = deadline - Date.now();
    if (retryRemaining <= 0) return response;
    const canHandoff = response.headers.get('X-TruyenQQ-Recovery') === '1' && recovery.snapshot &&
      /^\/api\/manga\/(?:homepage|categories|truyenqq-filtered|otruyen-filtered|search|trending|detail\/[a-zA-Z0-9-]+|chapter\/[a-zA-Z0-9._-]+|(?:list|category)\/[a-zA-Z0-9-]+(?:\/batch)?|truyenqq\/(?:cover\/[a-zA-Z0-9-]+|image\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+\/[0-9]+))$/.test(apiUrl.pathname);
    if (canHandoff) {
      const headers = new Headers(retryOptions.headers);
      headers.set('Content-Type', 'application/json');headers.set('X-TruyenQQ-Recovery', '1');
      let retryUrl = url;
      try {
        const actual = new URL(response.url);
        if ([apiUrl.origin, 'https://standby.mangahub.art'].includes(actual.origin) &&
          actual.pathname === apiUrl.pathname && actual.search === apiUrl.search) retryUrl = actual.href;
      } catch { /* A synthetic response has no origin. Keep the original API. */ }
      response = await fetchWithTimeout(retryUrl, { ...retryOptions, method: 'POST', headers,
        body: JSON.stringify(recovery.snapshot) }, retryRemaining);
    } else response = await fetchWithTimeout(url, retryOptions, retryRemaining);
  }
  // Healthy backend reads already have their source data. Only an explicit
  // source denial needs the browser's relay; speculative warming spends quota
  // and competes with chapter images without improving this response.
  return response;
  };
  if (initial.ok && initial.headers.get('X-TruyenQQ-Stale') === '1') {
    // Valid last-good pages render immediately. Repair only a proven source
    // failure, in the same bounded recovery budget; never poll or speculate.
    const key = JSON.stringify([url, authorization, initial.headers.get('X-TruyenQQ-Source-Path')]);
    if (!repairs.has(key)) {
      const started = generation;
      const job = recover().then(async response => {
        if (response === initial) return;
        if (started === generation && response.ok && !response.headers.has('X-TruyenQQ-Error')) {
          window.dispatchEvent(new Event('mangahub:qq-source-recovered'));
        }
        await response.body?.cancel();
      }).catch(() => { /* Keep the already-rendered last-good page. */ }).finally(() => {
        if (repairs.get(key) === job) repairs.delete(key);
      });
      repairs.set(key, job);
    }
    return initial;
  }
  return recover();
}
