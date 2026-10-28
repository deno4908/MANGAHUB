import { useMemo } from 'react';
import { queryOptions, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Manga } from '@/types/manga';
import { normalizeMangaDexId, normalizeMoeId } from '@/lib/mangaLinks';
import { applyCardMetadata, isLegacyQQIdentifier, needsCanonicalTitle, requestCardMetadata } from '@/lib/cardMetadata';
import { thumbUrl } from '@/lib/adapters';
import { needsSavedCover, resolveSavedMangaCover, savedMangaId, savedMangaLookupId, savedMangaTitleHint } from '@/lib/savedManga';

const metadataOptions = (id: string, client: QueryClient, title?: string) => queryOptions({
  queryKey: ['manga', 'card-metadata', id],
  queryFn: () => requestCardMetadata(id, client, title),
  staleTime: query => query.state.data === null ? (title ? 0 : 5 * 60 * 1000) : 60 * 60 * 1000,
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
const recordId = savedMangaId;

/** Saved cards share the same batched metadata and never rewrite saved IDs or reading progress. */
export function useCanonicalMangaRecords<T extends MangaRecord>(records: T[] | undefined,
  { enabled = true, fillMissingCovers = false, requireQQMatch = false, refreshMetadata = false, retainUnavailable = false } = {}): T[] | undefined {
  const client = useQueryClient();
  const ids = useMemo(() => enabled ? [...new Set((records || []).filter(record => {
    const id = savedMangaLookupId(record);
    const title = record.manga_title || record.title || record.name;
    const cover = record.manga_thumb || record.cover || record.cover_url || record.thumb;
    return record.source !== 'uploaded' && !record.is_user_upload && /^[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(id)
      && (refreshMetadata || isLegacyQQIdentifier(id) || needsCanonicalTitle(id, title) || (fillMissingCovers && needsSavedCover(cover)));
  }).map(savedMangaLookupId))] : [], [records, enabled, fillMissingCovers, refreshMetadata]);
  const savedTitles = useMemo(() => new Map((refreshMetadata ? records || [] : []).map(record => [
    savedMangaLookupId(record), savedMangaTitleHint(record),
  ])), [records, refreshMetadata]);
  const metadata = useQueries({
    queries: ids.map(id => {
      const title = isLegacyQQIdentifier(id) ? savedTitles.get(id) || '' : '';
      return metadataOptions(id, client, title.length <= 200 ? title || undefined : undefined);
    }),
    combine: results => results.map(result => result.data),
  });
  return useMemo(() => {
    if (!records) return records;
    const byId = new Map(ids.map((id, index) => [id, metadata[index]]));
    return records.filter(record => {
      if (retainUnavailable || record.source === 'uploaded' || record.is_user_upload) return true;
      const id = recordId(record);
      const mustMatch = requireQQMatch && enabled &&
        (isLegacyQQIdentifier(id) || (refreshMetadata && !normalizeMangaDexId(id) && !normalizeMoeId(id)));
      return mustMatch ? Boolean(byId.get(savedMangaLookupId(record)))
        : !isLegacyQQIdentifier(id) || byId.get(savedMangaLookupId(record)) !== null;
    }).map(record => {
      const id = recordId(record);
      const item = byId.get(savedMangaLookupId(record));
      if (!item || record.source === 'uploaded' || record.is_user_upload) return record;
      if (requireQQMatch && 'cover' in record && 'chapters' in record) {
        return applyCardMetadata(record as unknown as Manga, {
          ...item, title: needsCanonicalTitle(id, record.title) ? item.title : record.title,
        }) as unknown as T;
      }
      const next: MangaRecord = { ...record };
      if (refreshMetadata) {
        next.manga_source_slug = item.slug;
        next.source = item.source;
        next.genres = item.genres || record.genres || [];
        next.status = item.status || record.status;
      }
      if (!('manga_title' in record || 'title' in record || 'name' in record)) {
        next['manga_slug' in record ? 'manga_title' : 'title'] = item.title;
      }
      for (const field of ['manga_title', 'title', 'name']) {
        if (field in record && needsCanonicalTitle(savedMangaLookupId(record), record[field])) next[field] = item.title;
      }
      if (fillMissingCovers && 'manga_slug' in record) {
        const covers = resolveSavedMangaCover(item.id, item.cover_url || record.manga_thumb, record.manga_thumb_fallback);
        next.manga_thumb = covers.primary;
        next.manga_thumb_fallback = covers.fallback;
      }
      if (item.cover_url) for (const field of ['cover', 'cover_url', 'thumb']) {
        if (field in record && (refreshMetadata || needsSavedCover(record[field]))) next[field] = thumbUrl(item.cover_url, item.id);
      }
      return next as T;
    });
  }, [records, ids, metadata, fillMissingCovers, requireQQMatch, enabled, refreshMetadata, retainUnavailable]);
}
