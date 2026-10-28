import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { applyCatalogUpdates, watchCatalogUpdates, type CatalogUpdate } from './catalogUpdates';

const event: CatalogUpdate = { source: 'truyenqq', revision: 'new', changes: [
  { slug: 'book-123', chapter_id: 'qq:book-123:2', chapter_name: '2' },
] };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live catalog updates', () => {
  it('refreshes active books and lists while preserving account and unrelated detail caches', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const keys = [ ['manga', 'homepage', 'combined-v2'], ['manga', 'detail', 'book-123', 'truyenqq'],
      ['manga', 'detail', 'other-456', 'truyenqq'], ['rating', 'me'], ['history'], ['user', 'stats'],
      ['manga', 'home', 'feed-v2', 'mangadex'], ['search', 'filtered-v2', 'book'] ];
    for (const key of keys) client.setQueryData(key, 'old');
    const load = vi.fn(async () => 'chapter 2');
    const observer = new QueryObserver(client, { queryKey: keys[1], queryFn: load, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => {});
    await applyCatalogUpdates(client, [event]);
    expect(client.getQueryData(keys[1])).toBe('chapter 2');
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(keys[0])?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys[7])?.isInvalidated).toBe(true);
    for (const key of keys.slice(2, 7)) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    unsubscribe(); client.clear();
  });

  it('refreshes source details after missed updates during a disconnected tab', async () => {
    const client = new QueryClient();
    const key = ['manga', 'detail', 'missed-99', 'truyenqq'];
    client.setQueryData(key, 'old');
    await applyCatalogUpdates(client, [{ ...event, snapshot: true }]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });

  it('keeps unrelated card labels cached when another book gets a new chapter', async () => {
    const client = new QueryClient();
    const changed = ['manga', 'card-metadata', 'book-123'];
    const unrelated = ['manga', 'card-metadata', 'other-456'];
    client.setQueryData(changed, { title: 'Book' });
    client.setQueryData(unrelated, { title: 'Other' });
    await applyCatalogUpdates(client, [event]);
    expect(client.getQueryState(changed)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('refreshes legacy QQ chapter cards when the canonical book receives a new chapter', async () => {
    const client = new QueryClient();
    const key = ['manga', 'card-chapter', 'book'];
    const other = ['manga', 'card-chapter', 'other'];
    client.setQueryData(key, { chapter: { chapter_name: '1' } });
    client.setQueryData(other, { chapter: { chapter_name: '1' } });
    await applyCatalogUpdates(client, [event]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('deduplicates SSE and fallback revisions and closes its connection on cleanup', async () => {
    vi.useFakeTimers();
    let listener: (message: MessageEvent) => void = () => {};
    let connection: Stream | undefined;
    const close = vi.fn();
    class Stream {
      onopen: (() => void) | null = null;
      onerror = null;
      close = close;
      constructor() { connection = this; }
      addEventListener(_name: string, callback: typeof listener) { listener = callback; }
    }
    vi.stubGlobal('EventSource', Stream);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sources: {} }) })));
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const stop = watchCatalogUpdates(client);
    listener(new MessageEvent('catalog-update', { data: JSON.stringify({ ...event, revision: 'old', snapshot: true }) }));
    listener(new MessageEvent('catalog-update', { data: JSON.stringify(event) }));
    listener(new MessageEvent('catalog-update', { data: JSON.stringify(event) }));
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const missedKey = ['manga', 'detail', 'missed-99', 'truyenqq'];
    client.setQueryData(missedKey, 'old');
    connection?.onopen?.();
    listener(new MessageEvent('catalog-update', { data: JSON.stringify({ ...event, revision: 'reconnected', changes: [] }) }));
    await vi.advanceTimersByTimeAsync(250);
    expect(client.getQueryState(missedKey)?.isInvalidated).toBe(true);
    stop();
    expect(close).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
