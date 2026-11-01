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
import { useCanonicalMangaRecords } from "@/hooks/useCardMetadata";
import { resolveSavedMangaCover } from "@/lib/savedManga";
import {
  adaptMangaDetail,
  adaptListData,
  adaptHomeData,
  adaptCategories,
  adaptChapterPages,
  thumbUrl,
} from "@/lib/adapters";
import { MANGADEX_ID_RE, normalizeMangaDexId } from "@/lib/mangaLinks";
import { loadMangaDexChapterPages } from "@/lib/mangaDexImages";
import { invalidateMangaRealtimeQueries } from "@/lib/querySync";
import { mangaDetailQueryKey } from "@/lib/mangaDetailQuery";
import type { Manga } from "@/types/manga";
import { isMatureManga } from "@/lib/contentFilter";
import { MANGADEX_TAGS } from "@/lib/mangaDexTags";
import { useSettingsStore } from "@/store/settingsStore";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
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
  throw new Error(String(data?.message || "TruyenQQ unavailable"));
}

function resolveThumbSources(slug?: string, thumb?: string): { primary: string; fallback?: string } {
  return resolveSavedMangaCover(String(slug || ''), thumb);
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
export function useHomepage(enabled = true) {
  return useQuery({
    queryKey: ["manga", "homepage"],
    queryFn: async () => {
      const data = await mangaApi.getHomepage();
      return {
        latest: adaptListData(data.latest),
        ongoing: adaptListData(data.ongoing),
      };
    },
    enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
}

/** Include authentication/queue time in the source deadline, too. */
async function readHomepageSource<T>(load: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  if (parent.aborted) throw new DOMException('Homepage request cancelled', 'AbortError');
  const controller = new AbortController();
  let cancel!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new DOMException('Homepage request cancelled', 'AbortError'));
    };
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Homepage source timed out'));
    }, 6_000);
  });
  parent.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([load(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
  }
}

type HomepageSource = 'truyenqq' | 'mangadex';
type HomepageSnapshot = {
  latest: ReturnType<typeof adaptListData>;
  ongoing: ReturnType<typeof adaptListData>;
  mangadex: ReturnType<typeof adaptListData>;
  unavailableSources: HomepageSource[];
  recoveryAttempts: number;
};

function canRecoverHomepage(error: unknown): boolean {
  const failure = error as { status?: number; message?: string; retryable?: boolean } | null;
  if (failure?.retryable === false) return false;
  if (/^(MAINTENANCE_MODE|BANNED|FORBIDDEN_ROLE::|MANGA_HIDDEN::)/.test(failure?.message || '')) return false;
  const status = failure?.status;
  return !status || status >= 500 || [408, 425, 429].includes(status);
}

function homepageNeedsRecovery(state: { data?: HomepageSnapshot; error: Error | null; status: string }) {
  return canRecoverHomepage(state.error)
    && (state.status === 'error' || !!state.data?.unavailableSources.length);
}

/** Publish one initial snapshot; recover missing sources without blocking it. */
export function useHomepageCombined(maxChapters = 120, showMature = false) {
  const client = useQueryClient();
  const queryKey = ["manga", "homepage", "synchronized-v2", maxChapters, showMature];
  const featuredQuery = useQuery({
    queryKey: ["manga", "featured", 12],
    queryFn: async () => adaptListData(await mangaApi.getFeatured(12)),
    staleTime: 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const homeQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<HomepageSnapshot>(queryKey);
      const recovering = !!previous?.unavailableSources.length;
      const needsQQ = !recovering || previous.unavailableSources.includes('truyenqq');
      const needsMangaDex = !recovering || previous.unavailableSources.includes('mangadex');
      const qq = async (sourceSignal: AbortSignal) => {
        try {
          // Index already hydrates aggregate/personal ratings in one deferred batch.
          const payload = await mangaApi.getHomepage({ attachRatings: false, timeoutMs: 4_000, signal: sourceSignal });
          const visible = [...adaptListData(payload.latest || {}).items, ...adaptListData(payload.ongoing || {}).items]
            .some(item => item.source !== 'mangadex' && !normalizeMangaDexId(item.id)
              && (showMature || !isMatureManga(item)));
          if (visible) return payload;
        } catch (error) {
          if (sourceSignal.aborted || !canRecoverHomepage(error)) throw error;
        }
        if (sourceSignal.aborted) throw new DOMException('Homepage request cancelled', 'AbortError');
        // Keep the previous catalog on transient errors/empty refreshes.
        if (previous?.latest.items.length || previous?.ongoing.items.length) throw new Error('QQ home refresh unavailable');
        const fallback = await mangaApi.getOTruyenFiltered({ page: 1, limit: 24, sort: 'latest',
          showMature, attachRatings: false, timeoutMs: 2_000, signal: sourceSignal });
        if (!adaptListData(fallback).items.length) throw new Error('QQ home data unavailable');
        return { latest: fallback, ongoing: fallback };
      };
      // Keep one atomic snapshot, but do not hold a usable home screen for an
      // unresponsive second source. Both still get the full cold-start budget
      // until the first source succeeds.
      const sources = new AbortController();
      const cancel = () => sources.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const ready = <T,>(value: T, usable = true): T => {
        // Recovery has its own full budget. Reapplying the initial grace period
        // would keep starving a source that normally takes two or three seconds.
        if (!recovering && usable) graceTimer ??= setTimeout(cancel, 1_500);
        return value;
      };
      const results = await Promise.allSettled([
        needsQQ ? readHomepageSource(qq, sources.signal).then(value => ready(value)) : Promise.resolve(undefined),
        needsMangaDex ? readHomepageSource(sourceSignal => mangaApi.getMangaDexHomeBanner({ limit: 24,
          showMature, filterHidden: true, attachRatings: false, timeoutMs: 6_000, signal: sourceSignal }), sources.signal)
          .then(value => {
            if (!adaptListData(value).items.length) throw new Error('MangaDex home data unavailable');
            return ready(value);
          }) : Promise.resolve(undefined),
      ]).finally(() => {
        clearTimeout(graceTimer);
        signal.removeEventListener('abort', cancel);
      });
      if (signal.aborted) throw new DOMException('Homepage request cancelled', 'AbortError');
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      // Access/maintenance failures must not trigger source fallbacks or polling.
      // React Query retains an existing snapshot when this refresh throws.
      if (failures.some(result => !canRecoverHomepage(result.reason))) {
        throw Object.assign(new Error('Home data unavailable'), { retryable: false });
      }
      if (!previous && failures.length === results.length) throw new Error('Home data unavailable');
      const qqData = results[0].status === 'fulfilled' ? results[0].value : undefined;
      const mdxData = results[1].status === 'fulfilled' ? results[1].value : undefined;
      const failedQQSections: string[] = Array.isArray(qqData?.meta?.unavailable_sections)
        ? [...qqData.meta.unavailable_sections] : [];
      const qqLatest = qqData ? adaptListData(qqData.latest || {}) : previous?.latest || adaptListData({});
      const qqOngoing = qqData ? adaptListData(qqData.ongoing || {}) : previous?.ongoing || adaptListData({});
      if (qqData && !qqLatest.items.length && !failedQQSections.includes('latest')) failedQQSections.push('latest');
      if (qqData && !qqOngoing.items.length && !failedQQSections.includes('ongoing')) failedQQSections.push('ongoing');
      const unavailableSources = (['truyenqq', 'mangadex'] as const)
        .filter((_, index) => results[index].status === 'rejected' || (index === 0 && failedQQSections.length > 0)
          || (index === 1 && mdxData?.data?.source_unavailable === true));
      return {
        // /homepage can return HTTP 200 with only one QQ section available.
        // Keep its last good section (or the other usable QQ list on first
        // load) while recovering it, rather than replacing it with nothing.
        latest: failedQQSections.includes('latest') ? (previous?.latest.items.length ? previous.latest : qqOngoing) : qqLatest,
        ongoing: failedQQSections.includes('ongoing') ? (previous?.ongoing.items.length ? previous.ongoing : qqLatest) : qqOngoing,
        mangadex: mdxData ? adaptListData(mdxData) : previous?.mangadex || adaptListData({}),
        unavailableSources,
        recoveryAttempts: unavailableSources.length ? (recovering ? previous.recoveryAttempts + 1 : 0) : 0,
      } satisfies HomepageSnapshot;
    },
    staleTime: 30 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 0,
    refetchOnWindowFocus: query => homepageNeedsRecovery(query.state),
    refetchOnReconnect: query => homepageNeedsRecovery(query.state),
    // Retry only the missing source, quickly once and then with backoff. Queries
    // pause in hidden tabs and cancellation/access loss cannot repopulate them.
    refetchInterval: query => {
      if (!homepageNeedsRecovery(query.state)) return false;
      // A failed first load has no snapshot yet. It needs recovery too, or the
      // whole home screen stays empty until the visitor presses Retry.
      if (!query.state.data) return Math.min(1_000 * 2 ** Math.min(query.state.errorUpdateCount - 1, 5), 30_000);
      const attempt = query.state.data.recoveryAttempts;
      return attempt === 0 ? 300 : Math.min(2_000 * 2 ** Math.min(attempt - 1, 5), 60_000);
    },
    refetchIntervalInBackground: false,
  });
  return {
    ...homeQuery,
    data: homeQuery.data ? { ...homeQuery.data, featured: featuredQuery.data } : undefined,
  };
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

      const data = await mangaApi.getMangaDexViCatalog(maxChapters, { attachRatings: false, timeoutMs: 15_000 });
      if (!Array.isArray(data?.mangas) || !data.mangas.length) throw new Error("MangaDex catalog unavailable");
      return data.mangas as CatalogItem[];
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    enabled,
    // Return stale data instantly on revisit while refetching in background
    placeholderData: (prev) => prev,
    retry: 1,
    refetchOnWindowFocus: false,
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
  const maxMangaDexChapters = options.maxMangaDexChapters ?? "all";
  const mangaDexLanguage = String(options.mangaDexLanguage || "vi").trim().toLowerCase() || "vi";
  const mangaDexScanlationGroupId = String(options.mangaDexScanlationGroupId || "").trim();
  const enabled = (options.enabled ?? true) && !!slug;
  return useQuery({
    queryKey: mangaDetailQueryKey(detailQuerySlug, maxMangaDexChapters, mangaDexLanguage, mangaDexScanlationGroupId),
    queryFn: async ({ signal }) => {
      if (!slug) throw new Error("No slug");
      if (mangadexMangaId) {
        const mangaId = mangadexMangaId;
        const data = await mangaApi.getMangaDexDetail(
          mangaId,
          maxMangaDexChapters,
          mangaDexLanguage,
          { scanlationGroupId: mangaDexScanlationGroupId || undefined, signal },
        );
        if (data?.meta?.chapters_complete === false) {
          throw new Error("Danh sách chương chưa tải đủ, vui lòng thử lại.");
        }
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
      const data = await mangaApi.getDetail(slug, signal);
      return adaptMangaDetail(data);
    },
    enabled,
    staleTime: mangadexMangaId ? 10 * 60 * 1000 : 2 * 60 * 1000,
    gcTime: mangadexMangaId ? 10 * 60 * 1000 : 8 * 60 * 1000,
    refetchOnMount: true,
    placeholderData: (previousData) => previousData &&
      [previousData.id, previousData.slug].includes(detailQuerySlug) ? previousData : undefined,
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
        return {
          pages: await loadMangaDexChapterPages(mangadexChapterId),
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

export function useSearch(keyword: string, page = 1, enabled = true, genres: string[] = []) {
  const normalizedKeyword = keyword.trim();
  const showMature = useSettingsStore(s => s.settings.privacy.showMatureContent);
  return useQuery({
    queryKey: ["manga", "search", "paged-v3", normalizedKeyword, page, [...genres].sort(), showMature],
    queryFn: async ({ signal }) => {
      if (!normalizedKeyword)
        return {
          items: [] as Manga[],
          totalItems: 0,
          currentPage: 1,
          totalPages: 1,
        };
      const data = await mangaApi.search(normalizedKeyword, page, {
        limit: 24, showMature, genreSlugs: genres,
        skipAuth: true,
        attachRatings: false,
        mangaDexAttachLatest: false,
        mangaDexTimeoutMs: 10_000,
        timeoutMs: 20_000,
        signal,
      });
      return adaptListData(data);
    },
    enabled: enabled && normalizedKeyword.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useCategories(source: 'all' | 'mangadex' | 'truyenqq' = 'all') {
  const showMature = useSettingsStore(s => s.settings.privacy.showMatureContent);
  return useQuery({
    queryKey: ["manga", "categories", 'native-v2', source === 'mangadex' ? 'mangadex' : 'truyenqq'],
    initialData: source === 'mangadex' ? MANGADEX_TAGS : undefined,
    queryFn: async () => {
      if (source === 'mangadex') return MANGADEX_TAGS;
      const data = await mangaApi.getCategories();
      const otruyenCats = adaptCategories(data);
      // 'di-gioi' is an OTruyen alias of 'xuyen-khong' (both = isekai) → deduplicate
      // 'chuyen-sinh'/'reincarnation' are intentionally kept separate (NOT isekai aliases)
      const ISEKAI_ALIAS_SLUGS = new Set(['di-gioi']);
      // Remove OTruyen entries that duplicate the merged isekai entry
      const filteredOtruyen = otruyenCats.filter((c) => !ISEKAI_ALIAS_SLUGS.has(c.slug));
      return filteredOtruyen;
    },
    select: categories => {
      const existingSlugs = new Set(categories.map(category => category.slug));
      const visibleSource = source === 'all'
        ? [...categories, ...MANGADEX_TAGS.filter(tag => !existingSlugs.has(tag.slug))] : categories;
      return visibleSource.filter(category => showMature ||
        !isMatureManga({ title: category.name, tags: [category.slug] }));
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
  const user = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  const query = useQuery({
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
    enabled: isLoggedIn && !!user && !isRestoringSession,
    ...USER_DATA_QUERY_OPTIONS,
    placeholderData: (previousData) => previousData,
  });
  const data = useCanonicalMangaRecords(query.data, { enabled: isLoggedIn && !!user && !isRestoringSession, fillMissingCovers: true, refreshMetadata: true, requireQQMatch: true });
  return { ...query, data };
}

export function useIsBookmarked(slug: string, enabled = true) {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const user = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  return useQuery({
    queryKey: ["bookmark", "check", slug],
    queryFn: async () => {
      const data = await bookmarkApi.check(slug);
      return data.is_bookmarked;
    },
    enabled: enabled && !!slug && isLoggedIn && !!user && !isRestoringSession,
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
  const user = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  const query = useQuery({
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
    enabled: isLoggedIn && !!user && !isRestoringSession,
    ...USER_DATA_QUERY_OPTIONS,
    placeholderData: (previousData) => previousData,
  });
  const data = useCanonicalMangaRecords(query.data, { enabled: isLoggedIn && !!user && !isRestoringSession, fillMissingCovers: true, refreshMetadata: true, requireQQMatch: true });
  return { ...query, data };
}

export function useIsFollowing(slug: string, enabled = true) {
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const user = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  return useQuery({
    queryKey: ["follow", "check", slug],
    queryFn: async () => {
      const data = await followApi.check(slug);
      return data.is_following;
    },
    enabled: enabled && !!slug && isLoggedIn && !!user && !isRestoringSession,
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
  const user = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  const enabled = options.enabled ?? (isLoggedIn && !!user && !isRestoringSession);
  const enrichThumbs = options.enrichThumbs ?? true;

  const query = useQuery({
    queryKey: ["history", enrichThumbs ? "enriched" : "raw"],
    queryFn: async () => {
      const data = await historyApi.getAll();
      const historyItems = (data.history || []) as Array<any>;

      return historyItems.map((item: any) => {
        const mangaSlug = String(item?.manga_slug || "");
        const preferredThumb = String(item?.manga_thumb || "").trim();
        const resolvedThumb = resolveThumbSources(mangaSlug, preferredThumb);
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
  const data = useCanonicalMangaRecords(query.data, { enabled, fillMissingCovers: enrichThumbs, refreshMetadata: enrichThumbs, requireQQMatch: true });
  return { ...query, data };
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
