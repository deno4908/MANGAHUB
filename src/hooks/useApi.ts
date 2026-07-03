/**
 * React Query hooks for all API endpoints.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  mangaApi,
  bookmarkApi,
  followApi,
  historyApi,
  commentApi,
  notificationApi,
  userApi,
  ratingApi,
  uploadApi,
} from "@/lib/api";
import { useUserStore } from "@/store/userStore";
import {
  adaptMangaDetail,
  adaptListData,
  adaptHomeData,
  adaptCategories,
  adaptChapterPages,
  thumbUrl,
  thumbFallbackUrl,
  MANGADEX_EXTRA_GENRES,
} from "@/lib/adapters";
import { MANGADEX_ID_RE, normalizeMangaDexId } from "@/lib/mangaLinks";
import { getLocalMangaDexChapterPages } from "@/lib/mangaDexImages";
import { invalidateMangaRealtimeQueries } from "@/lib/querySync";
import type { Manga } from "@/types/manga";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MANGADEX_CATALOG_TIMEOUT_MS = 15_000;
const HOMEPAGE_MANGADEX_FALLBACK_TIMEOUT_MS = 6_000;
const LOCAL_COVER_FALLBACK = "/no-cover.svg";
const USER_DATA_QUERY_OPTIONS = {
  staleTime: 0,
  gcTime: 5 * 60 * 1000,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: 1,
};

function isOTruyenErrorPayload(data: any): boolean {
  const status = String(data?.status || "").trim().toLowerCase();
  return status === "error";
}

function assertOTruyenPayload(data: any) {
  if (!isOTruyenErrorPayload(data)) return;
  throw new Error(String(data?.message || "OTruyen unavailable"));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("MangaDex request timeout"));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

function isMangaDexThumbUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      host.endsWith("uploads.mangadex.org") ||
      host.endsWith("mangadex.network")
    );
  } catch {
    return false;
  }
}

function toAbsoluteApiUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${API_BASE}${raw}`;
  return `${API_BASE}/${raw}`;
}

function extractProxyTargetUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidate = toAbsoluteApiUrl(raw);
  try {
    const parsed = new URL(candidate);
    if (parsed.pathname !== "/api/images/img") return "";
    const target = parsed.searchParams.get("url");
    if (!target) return "";
    const decoded = decodeURIComponent(target);
    return /^https?:\/\//i.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function resolveThumbSources(
  slug?: string,
  thumb?: string,
): { primary: string; fallback?: string } {
  const mangaSlug = String(slug || "").trim();
  const raw = String(thumb || "").trim();
  if (raw) {
    const proxyTarget = extractProxyTargetUrl(raw);
    if (proxyTarget) {
      return {
        primary: toAbsoluteApiUrl(raw),
        fallback: isMangaDexThumbUrl(proxyTarget) ? LOCAL_COVER_FALLBACK : proxyTarget,
      };
    }

    if (/^https?:\/\//i.test(raw)) {
      if (isMangaDexThumbUrl(raw)) {
        return {
          primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`,
          fallback: LOCAL_COVER_FALLBACK,
        };
      }
      return { primary: raw, fallback: LOCAL_COVER_FALLBACK };
    }

    if (raw.startsWith("//")) {
      const full = `https:${raw}`;
      if (isMangaDexThumbUrl(full)) {
        return {
          primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(full)}`,
          fallback: LOCAL_COVER_FALLBACK,
        };
      }
      return { primary: full, fallback: LOCAL_COVER_FALLBACK };
    }

    if (raw.startsWith("/uploads/comics/")) {
      const direct = `https://img.otruyenapi.com${raw}`;
      const fallback = thumbFallbackUrl(raw, mangaSlug) || direct;
      return {
        primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(direct)}`,
        fallback,
      };
    }

    if (raw.startsWith("uploads/comics/")) {
      const direct = `https://img.otruyenapi.com/${raw}`;
      const fallback = thumbFallbackUrl(raw, mangaSlug) || direct;
      return {
        primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(direct)}`,
        fallback,
      };
    }

    const resolved = thumbUrl(raw, mangaSlug);
    if (/^https?:\/\/img\.otruyenapi\.com/i.test(resolved)) {
      return {
        primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(resolved)}`,
        fallback: thumbFallbackUrl(raw, mangaSlug) || resolved,
      };
    }

    return {
      primary: resolved,
      fallback: thumbFallbackUrl(raw, mangaSlug) || LOCAL_COVER_FALLBACK,
    };
  }

  if (normalizeMangaDexId(mangaSlug)) {
    const mdxId = normalizeMangaDexId(mangaSlug)!;
    return {
      primary: `${API_BASE}/api/manga/mangadex-cover/${mdxId}`,
      fallback: LOCAL_COVER_FALLBACK,
    };
  }

  if (!mangaSlug) {
    return { primary: LOCAL_COVER_FALLBACK };
  }

  const direct = thumbUrl("", mangaSlug);
  return {
    primary: `${API_BASE}/api/images/img?url=${encodeURIComponent(direct)}`,
    fallback: direct,
  };
}

function fallbackThumb(slug?: string, thumb?: string) {
  return resolveThumbSources(slug, thumb).primary;
}

function toMangaDexCover(coverUrl?: string, mangaId?: string): string {
  const raw = String(coverUrl || "").trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
  }
  return LOCAL_COVER_FALLBACK;
}

function parseDateMs(value: unknown): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const maxFutureMs = Date.now() + 2 * 24 * 60 * 60 * 1000;
  if (ms > maxFutureMs) return null;
  return ms;
}

function pickMangaDexChapterDate(ch: any, mangaUpdatedAt?: unknown): string {
  const candidates = [
    ch?.publish_at,
    ch?.readable_at,
    ch?.created_at,
    ch?.updated_at,
    mangaUpdatedAt,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    if (parseDateMs(raw) !== null) return raw;
  }
  return "";
}

function normalizeMangaDexChapterNumber(value: unknown): number {
  const raw = String(value || "").replace(",", ".").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ─── Manga ───

export function useHome() {
  return useQuery({
    queryKey: ["manga", "home"],
    queryFn: async () => {
      const data = await mangaApi.getHome();
      return adaptHomeData(data);
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

/** Combined homepage data — 1 request instead of 2 */
export function useHomepage() {
  return useQuery({
    queryKey: ["manga", "homepage"],
    queryFn: async () => {
      const data = await mangaApi.getHomepage();
      return {
        latest: adaptListData(data.latest),
        ongoing: adaptListData(data.ongoing),
      };
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

/** Homepage + MangaDex catalog in one hook for Index page. */
export function useHomepageCombined(maxChapters = 120) {
  const queryClient = useQueryClient();
  const homepageCombinedKey = ["manga", "homepage", "combined", maxChapters] as const;
  const mangadexCatalogKey = [
    "manga",
    "mangadex",
    "vi-catalog",
    maxChapters,
  ] as const;

  return useQuery({
    queryKey: homepageCombinedKey,
    queryFn: async () => {
      type HomepageMangaDexItem = {
        id: string;
        url?: string;
        title: string;
        cover_url?: string;
        authors_text?: string;
        updated_at?: string;
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

      const cachedCatalogRaw = queryClient.getQueryData(mangadexCatalogKey);
      const cachedCatalog = Array.isArray(cachedCatalogRaw)
        ? (cachedCatalogRaw as HomepageMangaDexItem[])
        : [];

      const homepagePromise = mangaApi.getHomepage();
      const featuredPromise = mangaApi.getFeatured(12);

      const [homepageResult, featuredResult] = await Promise.allSettled([
        homepagePromise,
        featuredPromise,
      ]);

      const homepagePayload = homepageResult.status === "fulfilled" ? homepageResult.value : {};
      const featuredPayload = featuredResult.status === "fulfilled" ? featuredResult.value : {};
      const latest = adaptListData((homepagePayload as any).latest || {});
      const ongoing = adaptListData((homepagePayload as any).ongoing || {});
      const featured = adaptListData(featuredPayload || {});

      return {
        latest,
        ongoing,
        featured,
        mangaDexMangas: cachedCatalog,
      };
    },
    staleTime: 3 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
}

export function useMangaDexViCatalog(
  maxChapters: number | "all" = 200,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const queryKey = ["manga", "mangadex", "vi-catalog", maxChapters] as const;

  return useQuery({
    queryKey,
    queryFn: async () => {
      type CatalogItem = {
        id: string;
        url?: string;
        title: string;
        cover_url?: string;
        authors_text?: string;
        updated_at?: string;
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

      let mangas: CatalogItem[] = [];
      try {
        const data = await withTimeout(
          mangaApi.getMangaDexViCatalog(maxChapters),
          MANGADEX_CATALOG_TIMEOUT_MS,
        );
        mangas = (data?.mangas || []) as CatalogItem[];
      } catch {
        mangas = [];
      }

      if (mangas.length > 0) return mangas;

      try {
        const fallbackMaxChapters = typeof maxChapters === "number" ? maxChapters : 200;
        const fallback = await withTimeout(
          mangaApi.getCombinedList("truyen-moi", 1, fallbackMaxChapters),
          HOMEPAGE_MANGADEX_FALLBACK_TIMEOUT_MS,
        );
        const fallbackMangas = (fallback?.mangadex?.mangas || []) as CatalogItem[];
        if (Array.isArray(fallbackMangas) && fallbackMangas.length > 0) {
          return fallbackMangas;
        }
      } catch {
        // Cached data below keeps the homepage usable during MangaDex hiccups.
      }

      const cached = queryClient.getQueryData(queryKey);
      if (Array.isArray(cached) && cached.length > 0) {
        return cached as typeof mangas;
      }

      throw new Error("MangaDex catalog empty");
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    enabled,
    // Return stale data instantly on revisit while refetching in background
    placeholderData: (prev) => prev,
    retry: (failureCount) => failureCount < 3,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 8000),
  });
}

export function useMangaList(type = "truyen-moi", page = 1, enabled = true) {
  return useQuery({
    queryKey: ["manga", "list", type, page],
    queryFn: async () => {
      const data = await mangaApi.getList(type, page);
      assertOTruyenPayload(data);
      return adaptListData(data);
    },
    enabled,
    staleTime: 2 * 60 * 1000,
    refetchOnMount: "always",
  });
}

type UseMangaDetailOptions = {
  enabled?: boolean;
  maxMangaDexChapters?: number | "all";
  mangaDexLanguage?: string;
  mangaDexScanlationGroupId?: string;
};

export function useMangaDetail(
  slug: string | undefined,
  options: UseMangaDetailOptions = {},
) {
  const mangadexMangaId = slug ? normalizeMangaDexId(slug) : null;
  const detailQuerySlug = mangadexMangaId || slug;
  const source = mangadexMangaId ? "mangadex" : "otruyen";
  const maxMangaDexChapters = options.maxMangaDexChapters ?? "all";
  const mangaDexLanguage = String(options.mangaDexLanguage || "vi").trim().toLowerCase() || "vi";
  const mangaDexScanlationGroupId = String(options.mangaDexScanlationGroupId || "").trim();
  const enabled = (options.enabled ?? true) && !!slug;
  return useQuery({
    queryKey: [
      "manga",
      "detail",
      detailQuerySlug,
      source,
      mangadexMangaId ? maxMangaDexChapters : "otruyen",
      mangadexMangaId ? mangaDexLanguage : "otruyen",
      mangadexMangaId ? mangaDexScanlationGroupId || "all-groups" : "otruyen",
    ],
    queryFn: async () => {
      if (!slug) throw new Error("No slug");
      if (mangadexMangaId) {
        const mangaId = mangadexMangaId;
        const data = await mangaApi.getMangaDexDetail(
          mangaId,
          maxMangaDexChapters,
          mangaDexLanguage,
          { scanlationGroupId: mangaDexScanlationGroupId || undefined },
        );
        const item = data?.manga || {};
        const chapters = (item.chapters || [])
          // Skip chapters with no valid UUID id — fake fallback ids break the reader
          .filter((ch: any) => MANGADEX_ID_RE.test(String(ch.id || '').trim()))
          // Skip MangaPlus / external-only chapters (no images served via MangaDex at-home API)
          .filter((ch: any) => {
            const extUrl = String(ch.external_url || ch.externalUrl || '').trim();
            if (extUrl) return false; // has external redirect — unreadable in app
            const group = String(ch.chapter_with_groups || ch.scanlation_group || ch.group || '').toLowerCase();
            if (group.includes('mangaplus') || group.includes('manga plus')) return false;
            return true;
          })
          .map((ch: any) => {
            const chapterDate = pickMangaDexChapterDate(ch, item?.updated_at);
            const chapterNumber = normalizeMangaDexChapterNumber(ch?.chapter);
            const scanlationGroups = Array.isArray(ch.scanlation_groups)
              ? ch.scanlation_groups
                  .map((group: any) => ({
                    id: String(group?.id || "").trim(),
                    name: String(group?.name || "").trim(),
                    website: String(group?.website || "").trim() || undefined,
                    discord: String(group?.discord || "").trim() || undefined,
                  }))
                  .filter((group: { id: string; name: string }) => group.id || group.name)
              : [];
            const groupNames = scanlationGroups
              .map((group: { name: string }) => group.name)
              .filter(Boolean);
            return {
              id: String(ch.id),
              mangaId: mangaId,
              number: chapterNumber,
              title: ch.chapter_with_groups || ch.title || `Chương ${ch.chapter || "?"}`,
              pages: [],
              uploadDate: chapterDate,
              scanlationGroup: groupNames.join(", "),
              translationSource: String(ch.translation_source || "mangadex").trim().toLowerCase() || "mangadex",
              translationSourceLabel: String(ch.translation_source_label || "MangaDex").trim() || "MangaDex",
              scanlationGroups,
              translatedLanguage: String(ch.translated_language || mangaDexLanguage || "").trim().toLowerCase(),
            };
          })
          // Sort ascending by chapter number (bé → lớn)
          .sort((a, b) => {
            if (a.number !== b.number) return a.number - b.number;
            const ta = parseDateMs(a.uploadDate) ?? 0;
            const tb = parseDateMs(b.uploadDate) ?? 0;
            return ta - tb;
          });
        const chaptersNewestFirst = [...chapters].reverse();
        return {
          id: mangaId,
          slug: mangaId,
          source: "mangadex",
          title: item.title || "Untitled",
          altTitle: "",
          author: item.authors_text || "MangaDex",
          artist: item.authors_text || "MangaDex",
          description: item.description || "",
          cover: toMangaDexCover(item.cover_url, mangaId),
          status: (item.status || "ongoing") as Manga["status"],
          type: "manga" as Manga["type"],
          genres: item.genres || [],
          tags: [],
          rating: 0,
          ratingCount: 0,
          myRating: null,
          follows: 0,
          views: Number(item.view_count || item.views || 0),
          year: Number(item.year || new Date().getFullYear()),
          chapters,
          availableTranslatedLanguages: Array.isArray(item.available_translated_languages)
            ? item.available_translated_languages
                .map((language: unknown) => String(language || "").trim().toLowerCase())
                .filter(Boolean)
            : [],
          lastUpdated: item.updated_at || chaptersNewestFirst[0]?.uploadDate || "",
          contentRating: String(item.content_rating || item.contentRating || "").trim().toLowerCase(),
          isFeatured: Boolean(item.is_featured ?? item.isFeatured),
          featuredAt: (() => {
            const value = item.featured_at ?? item.featuredAt;
            if (value === null || value === undefined) return undefined;
            const text = String(value).trim();
            return text || undefined;
          })(),
          adminNotes: (() => {
            const value = item.admin_notes ?? item.adminNotes;
            if (value === null || value === undefined) return undefined;
            const text = String(value).trim();
            return text || undefined;
          })(),
        } as Manga;
      }
      const data = await mangaApi.getDetail(slug);
      return adaptMangaDetail(data);
    },
    enabled,
    staleTime: mangadexMangaId ? 10 * 60 * 1000 : 2 * 60 * 1000,
    gcTime: mangadexMangaId ? 10 * 60 * 1000 : 8 * 60 * 1000,
    refetchOnMount: mangadexMangaId ? false : "always",
    placeholderData: (previousData) => previousData,
    retry: mangadexMangaId ? 1 : 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

export function useChapter(chapterId: string | undefined) {
  const isUserUpload = chapterId?.startsWith("upload-") ?? false;
  const uploadDbId = isUserUpload ? chapterId!.slice("upload-".length) : null;
  const mangadexChapterId = !isUserUpload && chapterId ? normalizeMangaDexId(chapterId) : null;
  const isMangaDexChapter = !!mangadexChapterId;
  const resolvedChapterId = mangadexChapterId || chapterId;
  return useQuery({
    queryKey: ["manga", "chapter", resolvedChapterId],
    queryFn: async () => {
      if (!resolvedChapterId) throw new Error("No chapter id");

      // User-uploaded chapters — pages are stored as URLs in the DB
      if (isUserUpload && uploadDbId) {
        const data = await uploadApi.getUpload(uploadDbId);
        const upload = data?.upload || data;
        const pages: string[] = Array.isArray(upload?.pages) ? upload.pages.filter(Boolean) : [];
        return {
          pages,
          raw: { data: { item: {} } },
        };
      }

      if (mangadexChapterId) {
        try {
          const localImageUrls = await getLocalMangaDexChapterPages(mangadexChapterId);
          if (localImageUrls.length > 0) {
            return {
              pages: localImageUrls,
              raw: { data: { item: {} } },
            };
          }
        } catch {
          // Browser-side MangaDex API can be blocked on some networks.
          // Fall back to the backend At-Home lookup below.
        }

        const attempts: Array<{ mode: "saver"; refresh: boolean }> = [
          { mode: "saver", refresh: false },
          { mode: "saver", refresh: true },
        ];
        let lastError: unknown = null;

        for (const attempt of attempts) {
          try {
            const data = await mangaApi.getMangaDexChapterPages(
              mangadexChapterId,
              attempt.mode,
              attempt.refresh,
              8_000,
            );
            const imageUrls = Array.isArray(data?.image_urls)
              ? (data.image_urls as string[]).filter(Boolean)
              : [];
            if (imageUrls.length > 0) {
              return {
                pages: imageUrls,
                raw: { data: { item: {} } },
              };
            }
          } catch (error) {
            lastError = error;
          }
        }

        if (lastError instanceof Error) {
          throw lastError;
        }
        if (lastError) {
          throw new Error("Không tải được chương MangaDex");
        }

        return {
          pages: [],
          raw: { data: { item: {} } },
        };
      }
      const data = await mangaApi.getChapter(resolvedChapterId);
      return {
        pages: adaptChapterPages(data),
        raw: data,
      };
    },
    enabled: !!resolvedChapterId,
    staleTime: isUserUpload ? 5 * 60 * 1000 : isMangaDexChapter ? 30 * 1000 : 60 * 60 * 1000,
    gcTime: isUserUpload ? 10 * 60 * 1000 : isMangaDexChapter ? 5 * 60 * 1000 : 30 * 60 * 1000,
    retry: isMangaDexChapter ? 0 : 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

export function useSearch(keyword: string, page = 1) {
  const normalizedKeyword = keyword.trim();
  return useQuery({
    queryKey: ["manga", "search", normalizedKeyword, page],
    queryFn: async () => {
      if (!normalizedKeyword)
        return {
          items: [] as Manga[],
          totalItems: 0,
          currentPage: 1,
          totalPages: 1,
        };
      const data = await mangaApi.search(normalizedKeyword, page, {
        skipAuth: true,
        timeoutMs: 10_000,
      });
      return adaptListData(data);
    },
    enabled: normalizedKeyword.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ["manga", "categories"],
    queryFn: async () => {
      const data = await mangaApi.getCategories();
      const otruyenCats = adaptCategories(data);
      // 'di-gioi' is an OTruyen alias of 'xuyen-khong' (both = isekai) → deduplicate
      // 'chuyen-sinh'/'reincarnation' are intentionally kept separate (NOT isekai aliases)
      const ISEKAI_ALIAS_SLUGS = new Set(['di-gioi']);
      // Remove OTruyen entries that duplicate the merged isekai entry
      const filteredOtruyen = otruyenCats.filter((c) => !ISEKAI_ALIAS_SLUGS.has(c.slug));
      // Merge MangaDex-exclusive genres (skip if same slug already exists)
      const existingSlugs = new Set(filteredOtruyen.map((c) => c.slug));
      const extra = MANGADEX_EXTRA_GENRES.filter((g) => !existingSlugs.has(g.slug));
      return [...filteredOtruyen, ...extra];
    },
    staleTime: 60 * 60 * 1000,
  });
}

export function useCategoryManga(slug: string, page = 1) {
  return useQuery({
    queryKey: ["manga", "category", slug, page],
    queryFn: async () => {
      const data = await mangaApi.getCategoryManga(slug, page);
      assertOTruyenPayload(data);
      return adaptListData(data);
    },
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
    // No placeholderData: when slug changes we want to show loading state immediately
    // so old tag's totalPages don't bleed into the new tag's pagination
  });
}

// ─── Bookmarks ───

export function useBookmarks() {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  return useQuery({
    queryKey: ["bookmarks"],
    queryFn: async () => {
      const data = await bookmarkApi.getAll();
      return (data.bookmarks || []).map((item: any) => {
        const resolvedThumb = resolveThumbSources(item.manga_slug, item.manga_thumb);
        return {
          ...item,
          manga_thumb: resolvedThumb.primary,
          manga_thumb_fallback: resolvedThumb.fallback || "",
        };
      });
    },
    enabled: isLoggedIn,
    ...USER_DATA_QUERY_OPTIONS,
    placeholderData: (previousData) => previousData,
  });
}

export function useIsBookmarked(slug: string) {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  return useQuery({
    queryKey: ["bookmark", "check", slug],
    queryFn: async () => {
      const data = await bookmarkApi.check(slug);
      return data.is_bookmarked;
    },
    enabled: !!slug && isLoggedIn,
    ...USER_DATA_QUERY_OPTIONS,
  });
}

export function useToggleBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      slug,
      title,
      thumb,
      isBookmarked,
    }: {
      slug: string;
      title: string;
      thumb: string;
      isBookmarked: boolean;
    }) => {
      if (isBookmarked) {
        return bookmarkApi.remove(slug);
      } else {
        return bookmarkApi.add(slug, title, thumb);
      }
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["bookmarks"] });
      await qc.cancelQueries({ queryKey: ["bookmark", "check", vars.slug] });

      const prevList = qc.getQueryData<any[]>(["bookmarks"]);
      const prevCheck = qc.getQueryData<boolean>([
        "bookmark",
        "check",
        vars.slug,
      ]);
      const nextStatus = !vars.isBookmarked;

      qc.setQueryData(["bookmark", "check", vars.slug], nextStatus);
      qc.setQueryData(["bookmarks"], (old: any) => {
        const list = Array.isArray(old) ? old : [];
        if (nextStatus) {
          const exists = list.some((it: any) => it?.manga_slug === vars.slug);
          if (exists) return list;
          const resolvedThumb = resolveThumbSources(vars.slug, vars.thumb);
          return [
            {
              manga_slug: vars.slug,
              manga_title: vars.title || vars.slug,
              manga_thumb: resolvedThumb.primary,
              manga_thumb_fallback: resolvedThumb.fallback || "",
              created_at: new Date().toISOString(),
            },
            ...list,
          ];
        }
        return list.filter((it: any) => it?.manga_slug !== vars.slug);
      });

      return { prevList, prevCheck };
    },
    onError: (_err, vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(["bookmarks"], ctx.prevList);
      qc.setQueryData(["bookmark", "check", vars.slug], ctx.prevCheck);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["bookmarks"], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["bookmark", "check", vars.slug], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["public-profile"], refetchType: "active" });
      invalidateMangaRealtimeQueries(qc);
    },
  });
}

// ─── Follows ───

export function useFollows() {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  return useQuery({
    queryKey: ["follows"],
    queryFn: async () => {
      const data = await followApi.getAll();
      return (data.follows || []).map((item: any) => {
        const resolvedThumb = resolveThumbSources(item.manga_slug, item.manga_thumb);
        return {
          ...item,
          manga_thumb: resolvedThumb.primary,
          manga_thumb_fallback: resolvedThumb.fallback || "",
        };
      });
    },
    enabled: isLoggedIn,
    ...USER_DATA_QUERY_OPTIONS,
    placeholderData: (previousData) => previousData,
  });
}

export function useIsFollowing(slug: string) {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  return useQuery({
    queryKey: ["follow", "check", slug],
    queryFn: async () => {
      const data = await followApi.check(slug);
      return data.is_following;
    },
    enabled: !!slug && isLoggedIn,
    ...USER_DATA_QUERY_OPTIONS,
  });
}

export function useToggleFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      slug,
      title,
      thumb,
      isFollowing,
    }: {
      slug: string;
      title: string;
      thumb: string;
      isFollowing: boolean;
    }) => {
      if (isFollowing) {
        return followApi.remove(slug);
      } else {
        return followApi.add(slug, title, thumb);
      }
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["follows"] });
      await qc.cancelQueries({ queryKey: ["follow", "check", vars.slug] });

      const prevList = qc.getQueryData<any[]>(["follows"]);
      const prevCheck = qc.getQueryData<boolean>([
        "follow",
        "check",
        vars.slug,
      ]);
      const nextStatus = !vars.isFollowing;

      qc.setQueryData(["follow", "check", vars.slug], nextStatus);
      qc.setQueryData(["follows"], (old: any) => {
        const list = Array.isArray(old) ? old : [];
        if (nextStatus) {
          const exists = list.some((it: any) => it?.manga_slug === vars.slug);
          if (exists) return list;
          const resolvedThumb = resolveThumbSources(vars.slug, vars.thumb);
          return [
            {
              manga_slug: vars.slug,
              manga_title: vars.title || vars.slug,
              manga_thumb: resolvedThumb.primary,
              manga_thumb_fallback: resolvedThumb.fallback || "",
              created_at: new Date().toISOString(),
            },
            ...list,
          ];
        }
        return list.filter((it: any) => it?.manga_slug !== vars.slug);
      });

      return { prevList, prevCheck };
    },
    onError: (_err, vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(["follows"], ctx.prevList);
      qc.setQueryData(["follow", "check", vars.slug], ctx.prevCheck);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ["follows"], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["follow", "check", vars.slug], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["public-profile"], refetchType: "active" });
      invalidateMangaRealtimeQueries(qc);
    },
  });
}

// ─── History ───

type UseHistoryOptions = {
  enabled?: boolean;
  enrichThumbs?: boolean;
};

export function useHistory(options: UseHistoryOptions = {}) {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const enabled = options.enabled ?? isLoggedIn;
  const enrichThumbs = options.enrichThumbs ?? true;

  return useQuery({
    queryKey: ["history", enrichThumbs ? "enriched" : "raw"],
    queryFn: async () => {
      const data = await historyApi.getAll();
      const historyItems = (data.history || []) as Array<any>;

      if (!enrichThumbs) {
        return historyItems.map((item: any) => {
          const resolvedThumb = resolveThumbSources(item?.manga_slug, item?.manga_thumb);
          return {
            ...item,
            manga_thumb: resolvedThumb.primary,
            manga_thumb_fallback: resolvedThumb.fallback || "",
          };
        });
      }

      const missingMangaDexIds: string[] = [];
      for (const item of historyItems) {
        const mangaSlug = String(item?.manga_slug || "");
        const mangaThumb = String(item?.manga_thumb || "").trim();
        const mangaDexId = normalizeMangaDexId(mangaSlug);
        if (!mangaDexId || mangaThumb) continue;
        if (!missingMangaDexIds.includes(mangaDexId)) {
          missingMangaDexIds.push(mangaDexId);
        }
      }

      const mangadexCoverById: Record<string, string> = {};
      if (missingMangaDexIds.length > 0) {
        try {
          const viCatalog = await mangaApi.getMangaDexViCatalog(200);
          const mangas = Array.isArray(viCatalog?.mangas) ? viCatalog.mangas : [];
          for (const manga of mangas) {
            const id = String(manga?.id || "").trim().toLowerCase();
            const cover = String(manga?.cover_url || "").trim();
            if (id && cover) {
              mangadexCoverById[id] = cover;
            }
          }
        } catch {
          // Ignore catalog failures and keep graceful thumbnail fallbacks.
        }
      }

      return historyItems.map((item: any) => {
        const mangaSlug = String(item?.manga_slug || "");
        const mangaDexId = normalizeMangaDexId(mangaSlug)?.toLowerCase();
        const preferredThumb = String(item?.manga_thumb || "").trim();
        const backfilledThumb =
          !preferredThumb && mangaDexId
            ? mangadexCoverById[mangaDexId] || ""
            : preferredThumb;
        const resolvedThumb = resolveThumbSources(mangaSlug, backfilledThumb);
        return {
          ...item,
          manga_thumb: resolvedThumb.primary,
          manga_thumb_fallback: resolvedThumb.fallback || "",
        };
      });
    },
    enabled,
    ...USER_DATA_QUERY_OPTIONS,
    placeholderData: (previousData) => previousData,
  });
}

export function useSaveHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: historyApi.add,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["history"], refetchType: "active" });
      invalidateMangaRealtimeQueries(qc);
    },
  });
}

// ─── Comments ───

export function useComments(slug: string, chapterId?: string) {
  return useQuery({
    queryKey: ["comments", slug, chapterId],
    queryFn: async () => {
      const data = await commentApi.getByManga(slug, chapterId);
      return data.comments || [];
    },
    enabled: !!slug,
  });
}

export function useCreateComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: commentApi.create,
    onSuccess: (_data, vars: any) => {
      // Invalidate the comment list so it re-fetches fresh data from server
      qc.invalidateQueries({ queryKey: ["comments", vars?.manga_slug] });
      qc.invalidateQueries({ queryKey: ["public-profile"], refetchType: "active" });
      qc.invalidateQueries({ queryKey: ["notifications"], refetchType: "active" });
    },
  });
}

// ─── Notifications ───

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      const data = await notificationApi.getAll();
      return {
        notifications: data.notifications || [],
        unreadCount: data.unread_count || 0,
      };
    },
    refetchInterval: 30_000,         // poll every 30s (was 60s)
    refetchOnWindowFocus: true,      // immediately sync when user returns to tab
    staleTime: 20_000,              // treat as stale after 20s
  });
}

// ─── User ───

export function useUserStats() {
  return useQuery({
    queryKey: ["user", "stats"],
    queryFn: async () => {
      const data = await userApi.getStats();
      return data.stats;
    },
  });
}

// ─── Ratings ───

export function useRateManga() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, score }: { slug: string; score: number }) =>
      ratingApi.rate(slug, score),
    onMutate: async ({ slug, score }) => {
      await qc.cancelQueries({ queryKey: ["rating", "me", slug] });
      const prev = qc.getQueryData<any>(["rating", "me", slug]);
      // Optimistically set personal score
      qc.setQueryData(["rating", "me", slug], { score, manga_slug: slug });
      return { prev, slug };
    },
    onError: (_err, { slug }, ctx) => {
      if (ctx?.prev !== undefined)
        qc.setQueryData(["rating", "me", slug], ctx.prev);
    },
    onSettled: (_d, _e, { slug }) => {
      // Refetch the public average so it reflects the new vote
      qc.invalidateQueries({ queryKey: ["rating", slug] });
      qc.invalidateQueries({ queryKey: ["rating", "me", slug] });
      qc.invalidateQueries({ queryKey: ["rating", "me", "browse"] });
      qc.invalidateQueries({ queryKey: ["rating", "batch"] });
      qc.invalidateQueries({ queryKey: ["manga", "list"] });
      qc.invalidateQueries({ queryKey: ["manga", "homepage"] });
      qc.invalidateQueries({ queryKey: ["manga", "mangadex", "vi-catalog"] });
      qc.invalidateQueries({ queryKey: ["manga", "mangadex-catalog"] });
      invalidateMangaRealtimeQueries(qc);
    },
  });
}

// ─── Trending ───
export function useTrending(limit = 20) {
  return useQuery({
    queryKey: ["manga", "trending", limit],
    queryFn: async () => {
      const data = await mangaApi.getTrending(limit);
      return data.trending || [];
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: "always",
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
}
