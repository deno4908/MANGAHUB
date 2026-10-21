import type { QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { adaptListData } from './adapters';
import { requestCardMetadata } from './cardMetadata';

/** Home ranking cards share metadata batches with visible cards, without chapter feeds. */
export async function loadHomeCardMetadata(ids: string[], client: QueryClient): Promise<Record<string, Manga>> {
  const result: Record<string, Manga> = {};
  await Promise.allSettled(ids.map(async id => {
    const metadata = await requestCardMetadata(id, client);
    if (!metadata) return;
    const item = adaptListData({ data: { items: [{
      slug: id, name: metadata.title, source: metadata.source,
      thumb_url: metadata.cover_url, status: metadata.status,
      content_rating: metadata.content_rating,
      category: (metadata.genres || []).map((name, index) => ({ name, slug: metadata.tags?.[index] || name })),
      chaptersLatest: metadata.chapters_latest || [],
    }] } }).items[0];
    if (item) result[id] = { ...item, id, slug: metadata.slug };
  }));
  return result;
}
