// Private, bounded, in-memory cover bytes. Never persist account assets or use a
// shared CDN cache; SiteAccessGate and logout discard this cache on access loss.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const TTL = 2 * 60_000;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 80;
const MAX_ACTIVE = 6;
const MAX_PREFETCH_ACTIVE = MAX_ACTIVE - 2;

type CoverPriority = 'visible' | 'normal' | 'prefetch';
const priorityOrder: Record<CoverPriority, number> = { visible: 0, normal: 1, prefetch: 2 };
type Entry = {
  key: string; users: number; controller: AbortController; started: boolean;
  promise: Promise<string>; resolve: (value: string) => void; reject: (reason: unknown) => void;
  objectUrl?: string; bytes: number; expires: number;
  priority: CoverPriority;
};
const entries = new Map<string, Entry>();
const waiting: Entry[] = [];
let active = 0;
let bytes = 0;

export function canCacheCover(value: string): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === new URL(API_BASE).origin && (
      url.pathname === '/api/images/img' ||
      /^\/api\/manga\/(?:mangadex-cover|truyenqq\/cover)\//.test(url.pathname)
    );
  } catch { return false; }
}

function discard(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    bytes -= entry.bytes;
    entry.objectUrl = undefined;
  }
}

function prune() {
  for (const entry of entries.values()) {
    if (!entry.users && entry.objectUrl && (entry.expires <= Date.now() || bytes > MAX_BYTES || entries.size > MAX_ENTRIES)) discard(entry);
  }
}

function pump() {
  while (active < MAX_ACTIVE && waiting.length) {
    // Visible images must not queue behind a previous page's speculative work.
    // Leave two slots free when only prefetches are waiting.
    waiting.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    const next = waiting.findIndex(entry => entry.controller.signal.aborted || !entry.users ||
      entry.priority !== 'prefetch' || active < MAX_PREFETCH_ACTIVE);
    if (next < 0) break;
    const entry = waiting.splice(next, 1)[0];
    if (entry.controller.signal.aborted || !entry.users) continue;
    entry.started = true;
    active++;
    const timer = window.setTimeout(() => entry.controller.abort(), 15_000);
    void (async () => {
      try {
        const response = await fetch(entry.key, { credentials: 'include', signal: entry.controller.signal,
          referrerPolicy: 'no-referrer', priority: entry.priority === 'visible' ? 'high' : entry.priority === 'prefetch' ? 'low' : 'auto' });
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) throw new Error('Cover unavailable');
        const blob = await response.blob();
        if (!blob.size || entry.controller.signal.aborted) throw new DOMException('Cover cancelled', 'AbortError');
        entry.objectUrl = URL.createObjectURL(blob);
        entry.bytes = blob.size;
        entry.expires = Date.now() + TTL;
        bytes += blob.size;
        entry.resolve(entry.objectUrl);
        prune();
      } catch (error) {
        discard(entry);
        entry.reject(error);
      } finally {
        window.clearTimeout(timer);
        active--;
        pump();
      }
    })();
  }
}

export function cachedCover(value: string): string | undefined {
  const entry = entries.get(value);
  return entry?.objectUrl && (entry.expires > Date.now() || entry.users > 0) ? entry.objectUrl : undefined;
}

/** Hold an already downloaded cover while reading; never start a new fetch. */
export function retainCachedCover(key: string): () => void {
  const entry = entries.get(key);
  if (!entry?.objectUrl) return () => {};
  entry.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // React cleans up the reader before the returning detail page acquires
    // its cover. Let that page adopt the same bytes before checking expiry.
    queueMicrotask(() => { entry.users--; prune(); });
  };
}

export function invalidateCover(value: string) {
  const entry = entries.get(value);
  if (entry?.objectUrl) discard(entry);
}

export function acquireCover(key: string, priority: CoverPriority = 'normal') {
  let entry = entries.get(key);
  if (entry?.objectUrl && entry.expires <= Date.now() && !entry.users) { discard(entry); entry = undefined; }
  if (!entry) {
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    entry = { key, users: 0, controller: new AbortController(), started: false, promise, resolve, reject, bytes: 0, expires: 0, priority };
    entries.set(key, entry);
    waiting.push(entry);
  }
  const current = entry;
  if (priorityOrder[priority] < priorityOrder[current.priority]) current.priority = priority;
  current.users++;
  // Touch the entry so eviction favors images from older pages.
  entries.delete(key); entries.set(key, current);
  pump();
  let released = false;
  return { promise: current.promise, release: () => {
    if (released) return;
    released = true;
    current.users--;
    if (!current.users && !current.objectUrl) {
      current.controller.abort();
      discard(current);
      if (!current.started) current.reject(new DOMException('Cover cancelled', 'AbortError'));
    }
    // Preserve loaded bytes through React's cleanup/setup handoff to a reader.
    if (current.objectUrl) queueMicrotask(prune);
    else prune();
  } };
}

export function clearCoverCache() {
  for (const entry of entries.values()) {
    entry.controller.abort();
    if (!entry.started) entry.reject(new DOMException('Cover cancelled', 'AbortError'));
    discard(entry);
  }
  waiting.length = 0;
}

export function warmCovers(urls: string[]): () => void {
  const resources = [...new Set(urls)].filter(canCacheCover).slice(0, 6).map(url => acquireCover(url, 'prefetch'));
  resources.forEach(resource => { void resource.promise.then(resource.release, resource.release); });
  return () => resources.forEach(resource => resource.release());
}
