import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const page = parseSearchPage(searchParams.get("page"));
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState(urlQuery);
  const queryRef = useRef(urlQuery);
  const skipNextQueryUrlWriteRef = useRef(false);
  const hasInitializedQuerySyncRef = useRef(false);

  const setSearchLocation = useCallback(
    (nextQuery: string, nextPage: number, replace = false) => {
      setSearchParams((currentParams) => {
        const nextParams = new URLSearchParams(currentParams);
        const hasQuery = nextQuery.trim().length > 0;
        const safePage = Math.max(1, Math.floor(Number(nextPage) || 1));

        if (hasQuery) {
          // Preserve spaces while typing. Search requests normalize separately.
          nextParams.set("q", nextQuery);
        } else {
          nextParams.delete("q");
        }

        if (safePage > 1) {
          nextParams.set("page", String(safePage));
        } else {
          nextParams.delete("page");
        }

        return nextParams;
      }, { replace });
    },
    [setSearchParams],
  );

  const setPage = useCallback(
    (nextPage: number, replace = false) => {
      setSearchLocation(query, nextPage, replace);
    },
    [query, setSearchLocation],
  );

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (urlQuery === queryRef.current) return;

    // A URL change from back/forward or a shared link is authoritative. Do not
    // immediately write it back, otherwise it would reset its page to one.
    skipNextQueryUrlWriteRef.current = true;
    queryRef.current = urlQuery;
    setQuery(urlQuery);
    setDebouncedQuery(urlQuery);
  }, [urlQuery]);

  const handleQueryChange = (val: string) => setQuery(val);

  useEffect(() => {
    if (!hasInitializedQuerySyncRef.current) {
      hasInitializedQuerySyncRef.current = true;
      return;
    }

    if (skipNextQueryUrlWriteRef.current) {
      skipNextQueryUrlWriteRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
      // Keep a typed search shareable without adding a history entry per keystroke.
      setSearchLocation(query, 1, true);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, setSearchLocation]);

  const trimmedDebouncedQuery = debouncedQuery.trim();
  const serverSearchPage = page;
  const combinedQuery = useSearch(trimmedDebouncedQuery, page, selectedGenres.length === 0);
  const { data: homepageData } = useHomepage(!trimmedDebouncedQuery && selectedGenres.length === 0);
  const { data: categories = [] } = useCategories();
  const selectedSlugs = selectedGenres.map(name => categories.find(cat => cat.name === name)?.slug || toSlug(name));
  const filteredQuery = useQuery({
    queryKey: ["search", "filtered-v2", trimmedDebouncedQuery, selectedSlugs, page, showMatureContent],
    enabled: selectedGenres.length > 0,
    queryFn: async () => {
      const requests = [mangaApi.searchMangaDex({ keyword: trimmedDebouncedQuery, genreSlugs: selectedSlugs,
        page, sort: trimmedDebouncedQuery ? "relevance" : "latest", showMature: showMatureContent })];
      if (!trimmedDebouncedQuery) requests.push(mangaApi.getOTruyenFiltered({ genreSlugs: selectedSlugs, page, sort: "latest", showMature: showMatureContent }));
      else requests.push(mangaApi.search(trimmedDebouncedQuery, page, { includeMangaDex: false, attachRatings: false }));
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
  const activeQuery = selectedGenres.length ? filteredQuery : combinedQuery;
  const searchData = activeQuery.data;
  const isLoading = activeQuery.isLoading;
  const isSearchFetching = activeQuery.isFetching;
  const isSearchPlaceholderData = activeQuery.isPlaceholderData;
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
    if (selectedGenres.length === 0 || !trimmedDebouncedQuery) return items;
    const selected = selectedGenres.map(normalizeTag);

    const filteredBaseItems = items.filter((m) =>
      m.source === 'mangadex' || selected.every((g) => m.genres.map(normalizeTag).includes(g)),
    );

    return filteredBaseItems;
  }, [debouncedQuery, searchData, homepageData, showMatureContent, selectedGenres]);
  const results = allResults;

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
                <MangaGrid manga={results} />
                {debouncedQuery.trim() || selectedGenres.length > 0 ? (
                  <MangaPagination
                    currentPage={page}
                    totalPages={searchData?.totalPages || 1}
                    onPageChange={setPage}
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
