import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

const SEARCH_PAGE_SIZE = 24;
const MANGADEX_SEARCH_INITIAL_LIMIT = 3000;
const MANGADEX_SEARCH_LIMIT_STEP = 1500;
const MANGADEX_SEARCH_MAX_LIMIT = 10000;
const MANGADEX_SEARCH_PREFETCH_PAGES = 4;
const SEARCH_PAGE_PREFETCH_RADIUS = 2;

type MangaDexCatalogItem = {
  id: string;
  title?: string;
  cover_url?: string;
  authors_text?: string;
  updated_at?: string;
  local_last_published_at?: string;
  last_chapter?: string;
  content_rating?: string;
  genres?: string[];
  chapters?: Array<{
    id?: string;
    chapter?: string;
    publish_at?: string;
    readable_at?: string;
    created_at?: string;
    updated_at?: string;
    chapter_with_groups?: string;
  }>;
};

const toSlug = (value: string) =>
  normalizeTag(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const pickMangaDexChapterDate = (
  chapter?: MangaDexCatalogItem["chapters"][number],
  fallback?: string,
) =>
  String(
    chapter?.publish_at ||
      chapter?.readable_at ||
      chapter?.created_at ||
      chapter?.updated_at ||
      fallback ||
      "",
  ).trim();

const mangaDexCatalogToManga = (items: MangaDexCatalogItem[]): Manga[] => {
  if (!items.length) return [];
  return adaptListData({
    data: {
      items: items.map((item) => {
        const latestChapter = Array.isArray(item.chapters) ? item.chapters[0] : undefined;
        const chapterName = String(latestChapter?.chapter || item.last_chapter || "").trim();
        const chapterDate = pickMangaDexChapterDate(
          latestChapter,
          item.local_last_published_at || item.updated_at,
        );

        return {
          name: item.title || "MangaDex",
          slug: String(item.id || "").trim().toLowerCase(),
          origin_name: [item.title || "MangaDex"],
          author: [item.authors_text || "MangaDex"],
          status: "ongoing",
          thumb_url: item.cover_url || "",
          cover_url: item.cover_url || "",
          updatedAt: chapterDate || item.local_last_published_at || item.updated_at || "",
          local_last_published_at: item.local_last_published_at || chapterDate || "",
          category: (item.genres || []).map((genre) => ({
            name: genre,
            slug: toSlug(genre),
          })),
          chaptersLatest: chapterName
            ? [{
                chapter_name: chapterName,
                chapter_title: latestChapter?.chapter_with_groups || "",
                chapter_api_data: latestChapter?.id || "",
                publish_at: chapterDate,
              }]
            : [],
          last_chapter: chapterName,
          content_rating: item.content_rating || "",
          source: "mangadex",
        };
      }),
      params: {
        pagination: {
          totalItems: items.length,
          totalItemsPerPage: items.length || SEARCH_PAGE_SIZE,
          currentPage: 1,
        },
      },
    },
  }).items;
};

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
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(urlQuery);
  const [page, setPage] = useState(1);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState(urlQuery);
  const [mangaDexSearchLimit, setMangaDexSearchLimit] = useState(MANGADEX_SEARCH_INITIAL_LIMIT);

  useEffect(() => {
    if (urlQuery !== query) {
      setQuery(urlQuery);
      setDebouncedQuery(urlQuery);
      setPage(1);
    }
  }, [urlQuery]);

  const handleQueryChange = (val: string) => {
    setQuery(val);
    setPage(1);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const trimmedDebouncedQuery = debouncedQuery.trim();
  const serverSearchPage = selectedGenres.length > 0 ? 1 : page;
  const {
    data: searchData,
    isLoading,
    isFetching: isSearchFetching,
  } = useSearch(trimmedDebouncedQuery, serverSearchPage);
  const { data: homepageData } = useHomepage();
  const { data: categories = [] } = useCategories();
  const shouldLoadMangaDexCatalog = selectedGenres.length > 0;
  const mangaDexCatalogQuery = useQuery({
    queryKey: ["search", "mangadex-catalog", mangaDexSearchLimit],
    queryFn: async () => {
      const payload = await mangaApi.getMangaDexViCatalog(mangaDexSearchLimit, {
        attachRatings: false,
        attachOverrides: false,
        filterHidden: true,
        preferLatest: true,
      });
      const mangas = (payload?.mangas || []) as MangaDexCatalogItem[];
      return Array.isArray(mangas) ? mangas : [];
    },
    enabled: shouldLoadMangaDexCatalog,
    staleTime: 45 * 1000,
    gcTime: 2 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  const toggleGenre = (g: string) => {
    setPage(1);
    setSelectedGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
    );
  };

  useEffect(() => {
    setMangaDexSearchLimit(MANGADEX_SEARCH_INITIAL_LIMIT);
  }, [debouncedQuery, selectedGenres]);

  useEffect(() => {
    if (!trimmedDebouncedQuery || selectedGenres.length > 0) return;
    const totalPages = Number(searchData?.totalPages || 0);
    if (!Number.isFinite(totalPages) || totalPages <= 1) return;

    const targets = Array.from({ length: SEARCH_PAGE_PREFETCH_RADIUS }, (_, index) => page + index + 1)
      .concat(Array.from({ length: SEARCH_PAGE_PREFETCH_RADIUS }, (_, index) => page - index - 1))
      .filter((targetPage) => targetPage >= 1 && targetPage <= totalPages && targetPage !== page);

    Array.from(new Set(targets)).forEach((targetPage) => {
      void queryClient.prefetchQuery({
        queryKey: ["manga", "search", trimmedDebouncedQuery, targetPage],
        queryFn: async () => {
          const data = await mangaApi.search(trimmedDebouncedQuery, targetPage, {
            skipAuth: true,
            timeoutMs: 10_000,
          });
          return adaptListData(data);
        },
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      });
    });
  }, [page, queryClient, searchData?.totalPages, selectedGenres.length, trimmedDebouncedQuery]);

  const mangaDexCatalogItems = useMemo(
    () => mangaDexCatalogToManga(mangaDexCatalogQuery.data || []),
    [mangaDexCatalogQuery.data],
  );

  const allResults = useMemo(() => {
    let items = debouncedQuery.trim()
      ? searchData?.items || []
      : homepageData?.latest?.items || [];
    if (!showMatureContent) {
      items = items.filter((m) => !isMatureManga(m));
    }
    if (selectedGenres.length === 0) return items;
    const q = normalizeTag(debouncedQuery);
    const selected = selectedGenres.map(normalizeTag);

    const filteredBaseItems = items.filter((m) =>
      selected.every((g) => m.genres.map(normalizeTag).includes(g)),
    );

    const mangaDexMatches = mangaDexCatalogItems.filter((m) => {
      if (!showMatureContent && isMatureManga(m)) return false;
      if (
        q &&
        !normalizeTag(m.title).includes(q) &&
        !normalizeTag(m.author).includes(q) &&
        !(m.genres || []).some((g) => normalizeTag(g).includes(q))
      ) {
        return false;
      }
      return selected.every((g) => m.genres.map(normalizeTag).includes(g));
    });

    return dedupeManga([...filteredBaseItems, ...mangaDexMatches]);
  }, [
    debouncedQuery,
    searchData,
    homepageData,
    showMatureContent,
    selectedGenres,
    mangaDexCatalogItems,
  ]);

  const useClientPagination = selectedGenres.length > 0;
  const totalClientPages = Math.max(1, Math.ceil(allResults.length / SEARCH_PAGE_SIZE));
  const currentPage = useClientPagination ? Math.min(page, totalClientPages) : page;
  const results = useMemo(
    () =>
      useClientPagination
        ? allResults.slice((currentPage - 1) * SEARCH_PAGE_SIZE, currentPage * SEARCH_PAGE_SIZE)
        : allResults,
    [allResults, currentPage, useClientPagination],
  );

  useEffect(() => {
    if (!shouldLoadMangaDexCatalog) return;
    if (mangaDexCatalogQuery.isFetching) return;
    if (mangaDexSearchLimit >= MANGADEX_SEARCH_MAX_LIMIT) return;

    const remainingItems = allResults.length - currentPage * SEARCH_PAGE_SIZE;
    const nearLoadedEdge =
      currentPage >= Math.max(1, totalClientPages - MANGADEX_SEARCH_PREFETCH_PAGES);
    const lowBuffer = remainingItems <= SEARCH_PAGE_SIZE * MANGADEX_SEARCH_PREFETCH_PAGES;
    if (!nearLoadedEdge && !lowBuffer) return;

    const timer = window.setTimeout(() => {
      setMangaDexSearchLimit((limit) =>
        Math.min(MANGADEX_SEARCH_MAX_LIMIT, limit + MANGADEX_SEARCH_LIMIT_STEP),
      );
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    shouldLoadMangaDexCatalog,
    mangaDexCatalogQuery.isFetching,
    mangaDexSearchLimit,
    allResults.length,
    currentPage,
    totalClientPages,
  ]);

  const loadingState =
    (isLoading && allResults.length === 0) ||
    (
      shouldLoadMangaDexCatalog &&
      mangaDexCatalogQuery.isLoading &&
      allResults.length === 0
    );
  const showBackgroundLoading =
    !loadingState &&
    !useClientPagination &&
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
                {useClientPagination ? (
                  <MangaPagination
                    currentPage={currentPage}
                    totalPages={totalClientPages}
                    onPageChange={setPage}
                  />
                ) : debouncedQuery.trim() ? (
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
                  Không tìm thấy truyện nào. Thử từ khoá khác nhé!
                </p>
              </div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
};

export default SearchPage;
