import { useMemo } from 'react';
import { queryOptions, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { normalizeMangaDexId } from '@/lib/mangaLinks';
import { applyCardMetadata, isLegacyQQIdentifier, needsCanonicalTitle, requestCardMetadata } from '@/lib/cardMetadata';
import { thumbUrl } from '@/lib/adapters';

const metadataOptions = (id: string, client: QueryClient) => queryOptions({
  queryKey: ['manga', 'card-metadata', id],
  queryFn: () => requestCardMetadata(id, client),
  staleTime: query => query.state.data === null ? 5 * 60 * 1000 : 60 * 60 * 1000,
  gcTime: 60 * 60 * 1000,
  retry: 2,
  retryDelay: (attempt: number) => 1000 * (attempt + 1),
  refetchOnWindowFocus: false,
});

export function useCardMetadata(manga: Manga): Manga {
  const client = useQueryClient();
  const id = normalizeMangaDexId(manga.id) || manga.slug || manga.id;
  const needsTitle = needsCanonicalTitle(id, manga.title);
  const needsSync = manga.source !== 'uploaded' && isLegacyQQIdentifier(id);
  const needed = manga.source !== 'uploaded' && (needsTitle || needsSync);
  const query = useQuery({
    ...metadataOptions(id, client),
    enabled: needed,
  });
  if (query.data && manga.source !== 'uploaded') return applyCardMetadata(manga, { ...query.data, title: needsTitle ? query.data.title : manga.title });
  if (needsSync && query.data === null) return { ...manga, chapterAvailability: 'unavailable' };
  // Pending requests and transport errors keep the existing card visible.
  if (needed && normalizeMangaDexId(id)) return { ...manga, title: query.isFetching ? 'Đang tải tên truyện…' : 'Chưa lấy được tên truyện' };
  return manga;
}

type MangaRecord = Record<string, any>;
const recordId = (record: MangaRecord) => {
  const id = String(record.manga_slug || record.slug || record.manga_id || record.id || '').trim().toLowerCase();
  return normalizeMangaDexId(id) || id;
};

/** Saved cards share the same batched metadata and never rewrite saved IDs or reading progress. */
export function useCanonicalMangaRecords<T extends MangaRecord>(records: T[] | undefined,
  { enabled = true, fillMissingCovers = false, requireQQMatch = false } = {}): T[] | undefined {
  const client = useQueryClient();
  const ids = useMemo(() => enabled ? [...new Set((records || []).filter(record => {
    const id = recordId(record);
    const title = record.manga_title || record.title || record.name;
    const cover = record.manga_thumb || record.cover || record.cover_url || record.thumb;
    return record.source !== 'uploaded' && !record.is_user_upload && /^[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(id)
      && (isLegacyQQIdentifier(id) || needsCanonicalTitle(id, title) || (fillMissingCovers && !cover));
  }).map(recordId))] : [], [records, enabled, fillMissingCovers]);
  const metadata = useQueries({
    queries: ids.map(id => metadataOptions(id, client)),
    combine: results => results.map(result => result.data),
  });
  return useMemo(() => {
    if (!records) return records;
    const byId = new Map(ids.map((id, index) => [id, metadata[index]]));
    return records.filter(record => record.source === 'uploaded' || record.is_user_upload
      || !isLegacyQQIdentifier(recordId(record))
      || (requireQQMatch && enabled ? Boolean(byId.get(recordId(record))) : byId.get(recordId(record)) !== null)).map(record => {
      const id = recordId(record);
      const item = byId.get(id);
      if (!item || record.source === 'uploaded' || record.is_user_upload) return record;
      if (requireQQMatch && 'cover' in record && 'chapters' in record) {
        return applyCardMetadata(record as unknown as Manga, {
          ...item, title: needsCanonicalTitle(id, record.title) ? item.title : record.title,
        }) as unknown as T;
      }
      const next: MangaRecord = { ...record };
      if (!('manga_title' in record || 'title' in record || 'name' in record)) {
        next['manga_slug' in record ? 'manga_title' : 'title'] = item.title;
      }
      for (const field of ['manga_title', 'title', 'name']) {
        if (field in record && needsCanonicalTitle(id, record[field])) next[field] = item.title;
      }
      if (item.cover_url && fillMissingCovers && 'manga_slug' in record && !record.manga_thumb) {
        next.manga_thumb = thumbUrl(item.cover_url, item.id);
      }
      if (item.cover_url) for (const field of ['manga_thumb', 'cover', 'cover_url', 'thumb']) {
        if (field in record && !record[field]) next[field] = thumbUrl(item.cover_url, item.id);
      }
      return next as T;
    });
  }, [records, ids, metadata, fillMissingCovers, requireQQMatch, enabled]);
}
