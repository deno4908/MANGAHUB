import type { QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { adaptListData } from './adapters';
import { requestCardMetadata } from './cardMetadata';

/** Home ranking cards share metadata batches with visible cards, without chapter feeds. */
type MetadataCards = Record<string, Manga | null>;
const retryWindows = new WeakMap<object, number>();

/** Incomplete source reads get a short recovery window, never an endless poll. */
export function cardMetadataRetryInterval(query: { state: { data?: MetadataCards } }, ids: string[]): number | false {
  if (ids.every(id => id in (query.state.data || {}))) return false;
  let until = retryWindows.get(query);
  if (until === undefined) { until = Date.now() + 20_000; retryWindows.set(query, until); }
  return Date.now() < until ? 5000 : false;
}
export async function loadHomeCardMetadata(ids: string[], client: QueryClient,
  publish?: (ready: MetadataCards) => void): Promise<MetadataCards> {
  const result: Record<string, Manga | null> = {};
  await Promise.allSettled(ids.map(async id => {
    const metadata = await requestCardMetadata(id, client);
    if (!metadata) { result[id] = null; publish?.({ ...result }); return; }
    const item = adaptListData({ data: { items: [{
      slug: id, name: metadata.title, source: metadata.source,
      thumb_url: metadata.cover_url, status: metadata.status,
      content_rating: metadata.content_rating,
      category: (metadata.genres || []).map((name, index) => ({ name, slug: metadata.tags?.[index] || name })),
      chaptersLatest: metadata.chapters_latest || [],
    }] } }).items[0];
    if (item) {
      result[id] = { ...item, id, slug: metadata.slug };
      publish?.({ ...result });
    }
  }));
  return result;
}
