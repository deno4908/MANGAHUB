import { queryOptions } from '@tanstack/react-query';
import { mangaApi } from './api';
import { adaptListData } from './adapters';

/** Foreground navigation and prefetch must use the same filters and cache key. */
export function searchPageOptions(keyword: string, page: number, genres: string[], showMature: boolean) {
  const filters = { keyword: keyword.trim(), genres: [...new Set(genres)].sort(), showMature };
  return queryOptions({
    queryKey: ['manga', 'search', 'paged-v4', filters, page] as const,
    queryFn: async ({ signal }) => {
      const payload = await mangaApi.search(filters.keyword, page, {
        limit: 24, showMature, genreSlugs: filters.genres, skipAuth: true,
        attachRatings: false, mangaDexAttachLatest: false, mangaDexTimeoutMs: 10_000,
        timeoutMs: 20_000, signal,
      });
      return { ...adaptListData(payload), unavailableSources: (payload?.meta?.unavailable_sources || []) as string[] };
    },
    // A speculative partial response must be refreshed when actually opened.
    staleTime: query => query.state.data?.unavailableSources.length ? 0 : 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
