import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { searchPageOptions } from '@/lib/searchQuery';
import { warmCovers } from '@/lib/coverCache';
import { resolveSavedMangaCover } from '@/lib/savedManga';
import {
  useSearch,
  useHomepage,
  useCategories,
} from "@/hooks/useApi";
import { useSettingsStore } from "@/store/settingsStore";
import { isMatureManga } from "@/lib/contentFilter";
import { mangaApi } from "@/lib/api";
import { adaptListData } from "@/lib/adapters";
import type { Manga } from "@/types/manga";
import MangaGrid from "@/components/manga/MangaGrid";
import MangaPagination from "@/components/manga/MangaPagination";
import TagBadge from "@/components/manga/TagBadge";
import { Search as SearchIcon, Loader2 } from "lucide-react";
import { motion } from "framer-motion";

const normalizeTag = (value: string) =>
  (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .trim();

const parseSearchPage = (value: string | null) => {
  const page = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

const toSlug = (value: string) =>
  normalizeTag(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const dedupeManga = (items: Manga[]): Manga[] => {
  const seen = new Set<string>();
  const result: Manga[] = [];
  for (const item of items) {
    const key = String(item.id || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const SearchPage = () => {
  const queryClient = useQueryClient();
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const page = parseSearchPage(searchParams.get("page"));
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const inputTimer = useRef<ReturnType<typeof setTimeout>>();
  const debouncedQuery = urlQuery;
  const setSearchLocation = useCallback((nextQuery: string, nextPage: number, replace = false) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (nextQuery.trim()) next.set("q", nextQuery); else next.delete("q");
      if (nextPage > 1) next.set("page", String(nextPage)); else next.delete("page");
      return next;
    }, { replace });
  }, [setSearchParams]);
  // URL navigation owns the submitted query and page. Only typing schedules a
  // reset to page one; a new setSearchParams callback must never schedule it.
  useEffect(() => {
    clearTimeout(inputTimer.current);
    setQuery(urlQuery);
  }, [urlQuery, page]);
  useEffect(() => () => clearTimeout(inputTimer.current), []);
  const handleQueryChange = (value: string) => {
    setQuery(value);
    clearTimeout(inputTimer.current);
    inputTimer.current = setTimeout(() => setSearchLocation(value, 1, true), 200);
  };
  const setPage = (nextPage: number) => {
    clearTimeout(inputTimer.current);
    setQuery(urlQuery);
    setSearchLocation(urlQuery, nextPage);
  };

  const trimmedDebouncedQuery = debouncedQuery.trim();
  const serverSearchPage = page;
  const { data: homepageData } = useHomepage(!trimmedDebouncedQuery && selectedGenres.length === 0);
  const { data: categories = [] } = useCategories();
  const selectedSlugs = selectedGenres.map(name => categories.find(cat => cat.name === name)?.slug || toSlug(name));
  const combinedQuery = useSearch(trimmedDebouncedQuery, page, true, selectedSlugs);
  const filteredQuery = useQuery({
    queryKey: ["search", "filtered-v2", trimmedDebouncedQuery, selectedSlugs, page, showMatureContent],
    enabled: selectedGenres.length > 0 && !trimmedDebouncedQuery,
    queryFn: async () => {
      const requests = [mangaApi.searchMangaDex({ keyword: trimmedDebouncedQuery, genreSlugs: selectedSlugs,
        page, limit: 12, sort: "latest", showMature: showMatureContent })];
      if (!trimmedDebouncedQuery) requests.push(mangaApi.getOTruyenFiltered({ genreSlugs: selectedSlugs, page, limit: 12, sort: "latest", showMature: showMatureContent }));
      const settled = await Promise.allSettled(requests);
      const pages = settled.filter((item): item is PromiseFulfilledResult<any> => item.status === "fulfilled")
        .map(item => adaptListData(item.value));
      if (!pages.length) throw new Error("Search unavailable");
      return { items: dedupeManga(pages.flatMap(value => value.items)), currentPage: page,
        totalItems: pages.reduce((sum, value) => sum + value.totalItems, 0),
        totalPages: Math.max(1, ...pages.map(value => value.totalPages)) };
    },
    staleTime: 2 * 60 * 1000, retry: 1, refetchOnWindowFocus: false,
  });
  const activeQuery = selectedGenres.length && !trimmedDebouncedQuery ? filteredQuery : combinedQuery;
  const searchData = activeQuery.data;
  const isLoading = activeQuery.isLoading;
  const isSearchFetching = activeQuery.isFetching;
  const isSearchPlaceholderData = activeQuery.isPlaceholderData;
  const genreKey = [...selectedSlugs].sort().join(',');
  const totalPages = searchData?.totalPages || 1;
  const canWarmSearch = !!trimmedDebouncedQuery && query.trim() === trimmedDebouncedQuery
    && !isSearchFetching && !isSearchPlaceholderData && searchData?.currentPage === page
    && !combinedQuery.data?.unavailableSources.length;
  const prefetchSearchPage = useCallback((target: number) => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!canWarmSearch || target === page || target < 1 || target > totalPages
        || document.visibilityState === 'hidden' || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')) return;
    return queryClient.prefetchQuery(searchPageOptions(trimmedDebouncedQuery, target,
      genreKey ? genreKey.split(',') : [], showMatureContent));
  }, [canWarmSearch, page, totalPages, queryClient, trimmedDebouncedQuery, genreKey, showMatureContent]);
  useEffect(() => {
    if (!canWarmSearch || page >= totalPages) return;
    let live = true;
    let releaseCovers = () => {};
    const options = searchPageOptions(trimmedDebouncedQuery, page + 1,
      genreKey ? genreKey.split(',') : [], showMatureContent);
    // Only the adjacent page; this does not recursively crawl later pages.
    const timer = window.setTimeout(() => {
      const request = prefetchSearchPage(page + 1);
      if (!request) return;
      void request.then(() => {
        const next = queryClient.getQueryData(options.queryKey);
        if (!live || !next || next.unavailableSources.length) return;
        releaseCovers = warmCovers(next.items.slice(0, 6)
          .map(item => resolveSavedMangaCover(item.id, item.cover, item.coverProxy, 256).primary));
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
      // Give newly mounted cards a chance to acquire the same image bytes.
      queueMicrotask(releaseCovers);
    };
  }, [canWarmSearch, page, totalPages, trimmedDebouncedQuery, genreKey, showMatureContent, prefetchSearchPage, queryClient]);
  const toggleGenre = (g: string) => {
    setPage(1);
    setSelectedGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
    );
  };

  const allResults = useMemo(() => {
    let items = debouncedQuery.trim() || selectedGenres.length > 0
      ? searchData?.items || []
      : homepageData?.latest?.items || [];
    if (!showMatureContent) {
      items = items.filter((m) => !isMatureManga(m));
    }
    return items;
  }, [debouncedQuery, searchData, homepageData, showMatureContent, selectedGenres]);
  const results = allResults.slice(0, 24);

  const loadingState =
    (isLoading && allResults.length === 0) ||
    (
      Boolean(trimmedDebouncedQuery) &&
      isSearchFetching &&
      (isSearchPlaceholderData || Number(searchData?.currentPage || 0) !== serverSearchPage)
    );
  const showBackgroundLoading =
    !loadingState &&
    Boolean(trimmedDebouncedQuery) &&
    isSearchFetching;

  return (
    <div className="container mx-auto px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="accent-line" />
          <h1 className="ed-heading text-2xl">Tìm Kiếm Truyện</h1>
        </div>

        {/* Search input */}
        <div className="relative max-w-2xl mb-6">
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Nhập tên truyện, tác giả, ID hoặc từ khoá MANGADEX..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 text-sm transition-all"
            autoFocus
          />
        </div>

        {/* Genre filters */}
        <div className="flex flex-wrap gap-1.5 mb-6">
          {categories.map((cat) => (
            <TagBadge
              key={cat.slug}
              tag={cat.name}
              active={selectedGenres.includes(cat.name)}
              onClick={() => toggleGenre(cat.name)}
            />
          ))}
        </div>

        {/* Results */}
        {loadingState ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground font-medium">
                {allResults.length} kết quả
              </p>
              {showBackgroundLoading ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Đang tải trang {page}
                </span>
              ) : null}
            </div>
            {results.length > 0 ? (
              <>
                <MangaGrid manga={results} lazyBatch={false} animateEntrance={false} />
                {debouncedQuery.trim() || selectedGenres.length > 0 ? (
                  <MangaPagination
                    currentPage={page}
                    totalPages={searchData?.totalPages || 1}
                    onPageChange={setPage}
                    onPageIntent={prefetchSearchPage}
                  />
                ) : null}
              </>
            ) : (
              <div className="text-center py-20">
                <SearchIcon className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-muted-foreground font-medium">
                  {activeQuery.isError ? 'Chưa tải được kết quả. Vui lòng thử lại.' : 'Không tìm thấy truyện nào. Thử từ khoá khác nhé!'}
                </p>
                {activeQuery.isError && <button className="mt-3 px-4 py-2 rounded-lg bg-primary text-primary-foreground" onClick={() => void activeQuery.refetch()}>Thử lại</button>}
              </div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
};

export default SearchPage;
