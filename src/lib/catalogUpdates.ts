import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { normalizeMangaDexId } from '@/lib/mangaLinks';

export type CatalogUpdate = {
  source: 'mangadex' | 'truyenqq';
  revision: string;
  snapshot?: boolean;
  changes: Array<{ slug: string; chapter_id: string; chapter_name: string }>;
};

function belongsToUpdate(key: QueryKey, event: CatalogUpdate): boolean {
  if (key[0] === 'search') return true;
  if (key[0] !== 'manga' || key[1] === 'categories') return false;
  const section = String(key[1]);
  if (section === 'detail' || section === 'card-metadata' || section === 'card-chapter') {
    const id = normalizeMangaDexId(String(key[2])) || String(key[2]);
    if (event.snapshot) return Boolean(normalizeMangaDexId(id)) === (event.source === 'mangadex');
    return event.changes.some(change => change.slug === id ||
      (event.source === 'truyenqq' && change.slug.replace(/-\d+$/, '') === id));
  }
  if (section === 'chapter') return event.changes.some(change => change.chapter_id === key[2]);
  if (section === 'mangadex' || section === 'mangadex-catalog') return event.source === 'mangadex';
  if (section === 'homepage') return true;
  if (section === 'list' || section === 'category' || section === 'otruyen-filtered') {
    return event.source === 'truyenqq';
  }
  if (section === 'home' && key.includes('mangadex')) return event.source === 'mangadex';
  return true;
}

export async function applyCatalogUpdates(client: QueryClient, events: CatalogUpdate[]) {
  const predicate = (query: { queryKey: QueryKey }) => events.some(event => belongsToUpdate(query.queryKey, event));
  await client.cancelQueries({ predicate });
  return client.invalidateQueries({
    predicate,
    refetchType: 'active',
  });
}

/** One connection per visible tab. Version polling covers proxies without SSE. */
export function watchCatalogUpdates(client: QueryClient) {
  const base = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');
  const revisions = new Map<string, string>();
  const queued = new Map<string, CatalogUpdate>();
  let stream: EventSource | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;

  const receive = (event: CatalogUpdate) => {
    if (!event || !['mangadex', 'truyenqq'].includes(event.source) || !event.revision || !Array.isArray(event.changes)) return;
    const previous = revisions.get(event.source);
    if (previous === event.revision) return;
    revisions.set(event.source, event.revision);
    // Initial snapshots accompany the regular first page fetch. Reconnects must
    // refresh all details of that source, including changes missed while hidden.
    if (!previous && event.snapshot) return;
    const pending = queued.get(event.source);
    queued.set(event.source, pending ? { ...event, snapshot: pending.snapshot || event.snapshot,
      changes: [...pending.changes, ...event.changes] } : event);
    if (!debounce) debounce = setTimeout(() => {
      debounce = undefined;
      const events = [...queued.values()];
      queued.clear();
      void applyCatalogUpdates(client, events);
    }, 200);
  };
  const checkVersions = async () => {
    if (stopped || document.hidden || controller) return;
    const active = new AbortController();
    controller = active;
    const timeout = setTimeout(() => active.abort(), 6000);
    try {
      const response = await fetch(`${base}/api/manga/updates`, { signal: active.signal, cache: 'no-store', credentials: 'include' });
      if (response.ok) {
        const body = await response.json();
        if (!stopped && !active.signal.aborted) for (const event of Object.values(body.sources || {})) {
          receive({ ...(event as CatalogUpdate), snapshot: true });
        }
      }
    } catch { /* The next reconnect or version check retries. */ }
    finally { clearTimeout(timeout); if (controller === active) controller = undefined; }
  };
  const close = () => {
    stream?.close(); stream = undefined;
    if (poll) clearInterval(poll);
    poll = undefined;
    controller?.abort(); controller = undefined;
  };
  const open = () => {
    close();
    if (stopped || document.hidden) return;
    void checkVersions();
    if (typeof EventSource !== 'undefined') {
      const seenOnConnection = new Set<string>();
      stream = new EventSource(`${base}/api/manga/updates/stream`, { withCredentials: true });
      stream.addEventListener('catalog-update', message => {
        try {
          const event = JSON.parse((message as MessageEvent).data) as CatalogUpdate;
          if (!seenOnConnection.has(event.source) && revisions.has(event.source)) event.snapshot = true;
          seenOnConnection.add(event.source);
          receive(event);
        } catch { /* Ignore malformed events. */ }
      });
      stream.onopen = () => {
        seenOnConnection.clear();
        if (poll) clearInterval(poll);
        poll = undefined;
      };
      stream.onerror = () => {
        if (!poll) poll = setInterval(() => void checkVersions(), 8000);
      };
    } else poll = setInterval(() => void checkVersions(), 8000);
  };
  const visibility = () => document.hidden ? close() : open();
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', open);
  open();
  return () => {
    stopped = true; close();
    if (debounce) clearTimeout(debounce);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', open);
  };
}
