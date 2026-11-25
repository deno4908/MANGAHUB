import { readReaderMetaFromStorage, writeReaderMetaToStorage, parseChapterNumber, formatChapterNumber, isInvalidMangaSlug, cleanSlug, parseQQChapter, mergeReaderChapters, type ReaderChapter, type PersistedChapterMeta } from '@/lib/readerMetadata';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChapter } from '@/hooks/useApi';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUserStore } from '@/store/userStore';
import { mangaApi } from '@/lib/api';
import { useReaderProgress } from '@/hooks/useReaderProgress';
import type { ReadingHistory } from '@/lib/readingHistory';
import { adaptChapterPages, adaptMangaDetail, getChapterPageFallback } from '@/lib/adapters';
import { getMangaDetailPath, normalizeMangaDexId } from '@/lib/mangaLinks';
import { loadMangaDexChapterPages } from '@/lib/mangaDexImages';
import { incrementMangaViewsInQueryCache, invalidateMangaRealtimeQueries } from '@/lib/querySync';
import { retainCachedCover, canCacheReaderImage, warmReaderImages } from '@/lib/coverCache';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReaderImage from '@/components/reader/ReaderImage';
import ReaderSettings from '@/components/reader/ReaderSettings';
import { useIsMobile } from '@/hooks/use-mobile';
import CommentSection from '@/components/manga/CommentSection';
import {
  ChevronLeft, ChevronRight, Maximize, Minimize, Settings,
  ArrowLeft, List, Bookmark, Home, MessageCircle, Pause,
  MoveHorizontal, Pointer as PointerIcon, Loader2
} from 'lucide-react';

const AUTO_HIDE_DELAY = 3000;
const VIEW_TRACK_MIN_SECONDS = 12;
const VIEW_TRACK_MIN_PROGRESS = 15;
const VIEW_TRACK_MIN_PAGES = 2;

const createReadSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

interface ChapterState {
  mangaId?: string;
  mangaSlug?: string;
  mangaTitle?: string;
  mangaThumb?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  chapters?: ReaderChapter[];
  chapterSourceFilter?: string;
  resume?: ReadingHistory;
  resumeViewer?: string;
}

const CHAPTER_SOURCE_ALL = '__all_sources__';
const EMPTY_READER_CHAPTERS: ReaderChapter[] = [];

function normalizeReaderChapter(chapter: any): ReaderChapter {
  const rawNumber = Number(chapter?.number ?? chapter?.chapter_number ?? chapter?.chapter);
  const scanlationGroups = Array.isArray(chapter?.scanlationGroups)
    ? chapter.scanlationGroups
    : Array.isArray(chapter?.scanlation_groups)
      ? chapter.scanlation_groups
      : [];
  return {
    id: String(chapter?.id || '').trim(),
    number: Number.isFinite(rawNumber) ? rawNumber : 0,
    title: String(chapter?.title || chapter?.chapter_title || '').trim(),
    scanlationGroup: String(chapter?.scanlationGroup || chapter?.scanlation_group || chapter?.group || '').trim(),
    translationSource: String(chapter?.translationSource || chapter?.translation_source || '').trim().toLowerCase(),
    translationSourceLabel: String(chapter?.translationSourceLabel || chapter?.translation_source_label || '').trim(),
    scanlationGroups: scanlationGroups
      .map((group: any) => ({
        id: String(group?.id || '').trim(),
        name: String(group?.name || '').trim(),
        website: String(group?.website || '').trim() || undefined,
        discord: String(group?.discord || '').trim() || undefined,
      }))
      .filter((group: { id?: string; name?: string }) => group.id || group.name),
    translatedLanguage: String(chapter?.translatedLanguage || chapter?.translated_language || '').trim().toLowerCase(),
    isUserUpload: Boolean(chapter?.isUserUpload || chapter?.is_user_upload),
  };
}

function normalizeReaderChapters(chapters: any[]): ReaderChapter[] {
  return (Array.isArray(chapters) ? chapters : [])
    .map(normalizeReaderChapter)
    .filter((chapter) => chapter.id);
}

function normalizeFilterToken(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function getReaderChapterSource(chapter: ReaderChapter): string {
  const explicit = normalizeFilterToken(chapter.translationSource || '');
  if (explicit) return explicit;
  if (chapter.isUserUpload || chapter.id.startsWith('upload-')) return 'local';
  if (normalizeMangaDexId(chapter.id) || chapter.translatedLanguage || (chapter.scanlationGroups || []).length > 0) {
    return 'mangadex';
  }
  return 'truyenqq';
}

function getReaderChapterSourceLabel(chapter: ReaderChapter): string {
  const label = String(chapter.translationSourceLabel || '').trim();
  if (label) return label;
  const source = getReaderChapterSource(chapter);
  if (source === 'mangadex') return 'MangaDex';
  if (source === 'local') return 'Bản dịch web';
  if (source === 'truyenqq') return 'TruyenQQ';
  return source;
}

function getReaderChapterGroups(chapter: ReaderChapter): Array<{ id: string; name: string }> {
  const fromGroups = (chapter.scanlationGroups || [])
    .map((group) => {
      const name = String(group.name || '').trim();
      const id = String(group.id || normalizeFilterToken(name)).trim();
      return id || name ? { id, name: name || id } : null;
    })
    .filter((group): group is { id: string; name: string } => Boolean(group));
  if (fromGroups.length > 0) return fromGroups;

  const source = getReaderChapterSource(chapter);
  const fallback = String(chapter.scanlationGroup || '').trim();
  if (fallback) {
    return fallback
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((name) => ({ id: normalizeFilterToken(name), name }));
  }
  if (source === 'local') return [{ id: 'web', name: getReaderChapterSourceLabel(chapter) }];
  return [];
}

function chapterSortNumber(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

function normalizeChapterCompareKey(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mangadexId = normalizeMangaDexId(raw);
  if (mangadexId) return mangadexId;
  return raw.replace(/^mdx-/i, '').split('/').pop()!.trim().toLowerCase();
}

function chapterIdMatches(chapterId: string, candidates: Array<string | undefined | null>): boolean {
  const key = normalizeChapterCompareKey(chapterId);
  if (!key) return false;
  return candidates.some((candidate) => normalizeChapterCompareKey(candidate) === key);
}

function filterReaderChaptersBySource(chapters: ReaderChapter[], filter: string): ReaderChapter[] {
  if (filter === CHAPTER_SOURCE_ALL) return chapters;
  if (filter.startsWith('source:')) {
    const source = filter.slice('source:'.length);
    return chapters.filter((chapter) => getReaderChapterSource(chapter) === source);
  }
  if (filter.startsWith('group:')) {
    const [, source, groupKey] = filter.split(':');
    return chapters.filter((chapter) => (
      getReaderChapterSource(chapter) === source &&
      getReaderChapterGroups(chapter).some((group) => normalizeFilterToken(group.id || group.name) === groupKey)
    ));
  }
  return chapters;
}

function inferReaderChapterFilter(chapter?: ReaderChapter): string {
  if (!chapter) return CHAPTER_SOURCE_ALL;
  const source = getReaderChapterSource(chapter);
  const group = getReaderChapterGroups(chapter)[0];
  if (group) return `group:${source}:${normalizeFilterToken(group.id || group.name)}`;
  return `source:${source}`;
}

function extractSlugFromChapterPath(chapterPath?: string | null): string {
  if (!chapterPath) return '';
  const parts = String(chapterPath).split('/').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '';

  // Common pattern: uploads/comics/{slug}/...
  const comicsIdx = parts.findIndex(p => p.toLowerCase() === 'comics');
  if (comicsIdx >= 0 && parts.length > comicsIdx + 1) {
    const slug = cleanSlug(parts[comicsIdx + 1]);
    if (!isInvalidMangaSlug(slug)) return slug;
  }

  // Fallback: first non-reserved segment
  for (const p of parts) {
    const slug = cleanSlug(p);
    if (!isInvalidMangaSlug(slug)) return slug;
  }
  return '';
}

const ChapterReader = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const normalizedChapterId = id?.startsWith('mdx-') ? id.slice(4) : id;
  const currentChapterId = normalizeMangaDexId(normalizedChapterId) || normalizedChapterId || '';
  const qqChapter = parseQQChapter(currentChapterId);
  const chapterState = (location.state || {}) as ChapterState;
  const { data: chapterData, isLoading } = useChapter(currentChapterId || undefined);
  const store = useReaderStore();
  const imageLoadingMode = useSettingsStore((s) => s.settings.reader.imageLoading || 'preload');
  const silentViewTracking = useSettingsStore((s) => Boolean(s.settings.privacy.silentViewTracking));
  const { user, isLoggedIn } = useUserStore();
  const shouldSuppressViewTracking = user?.role === 'admin' && silentViewTracking;
  const queryClient = useQueryClient();
  const detectedMobile = useIsMobile();
  const mobileReaderRef = useRef(detectedMobile);
  if (detectedMobile) mobileReaderRef.current = true;
  const isMobile = mobileReaderRef.current;
  const viewTrackedRef = useRef(false);
  const viewSessionStartedRef = useRef(false);
  const readSessionIdRef = useRef('');
  const readSessionStartedAtRef = useRef(0);
  const commentRef = useRef<HTMLDivElement>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showChapterList, setShowChapterList] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [visiblePage, setVisiblePage] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [viewEligibilityTick, setViewEligibilityTick] = useState(0);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [chapterSourceFilter, setChapterSourceFilter] = useState(
    chapterState.chapterSourceFilter || CHAPTER_SOURCE_ALL
  );

  const readerRef = useRef<HTMLDivElement>(null);
  const autoScrollTimer = useRef<number>();
  const preloadedRef = useRef<Set<string>>(new Set());
  const privatePreloads = useRef<Set<() => void>>(new Set());
  const prefetchTriggeredRef = useRef(false);

  useEffect(() => {
    if (!id || !normalizedChapterId) return;
    if (!id.startsWith('mdx-')) return;
    navigate(`/chapter/${normalizedChapterId}`, { replace: true, state: location.state });
  }, [id, normalizedChapterId, navigate, location.state]);

  const pages = chapterData?.pages || [];
  const totalPages = pages.length;
  const rawItem = chapterData?.raw?.data?.item || {};
  const rawSeo = chapterData?.raw?.data?.seoOnPage || {};

  const persistedMeta = useMemo(
    () => readReaderMetaFromStorage([id, currentChapterId, normalizedChapterId]),
    [id, currentChapterId, normalizedChapterId]
  );

  const fallbackMangaSlug = (() => {
    // Try each field individually — validate before accepting
    for (const raw of [rawItem.comic_slug, rawItem.manga_slug, rawItem.slug]) {
      const s = cleanSlug(raw);
      if (s && !isInvalidMangaSlug(s)) return s;
    }
    // Last resort: extract from chapter path (e.g. uploads/comics/{slug}/...)
    const fromPath = extractSlugFromChapterPath(rawItem.chapter_path);
    if (fromPath && !isInvalidMangaSlug(fromPath)) return fromPath;
    return qqChapter?.slug || '';
  })();
  const fallbackMangaTitle = rawItem.comic_name || rawSeo.titleHead || 'Đang tải...';
  const fallbackMangaThumb = String(rawItem.thumb_url || rawItem.thumb || rawItem.cover_url || '').trim();
  const fallbackChapterNumber = qqChapter?.number ?? parseChapterNumber(rawItem.chapter_name);
  const fallbackChapterTitle = rawItem.chapter_title || '';
  const rawMangaDetailId = String(qqChapter?.slug || chapterState.mangaId || persistedMeta.mangaId || '').trim();
  const mangaSlug = cleanSlug(qqChapter?.slug || chapterState.mangaSlug || persistedMeta.mangaSlug || fallbackMangaSlug || rawMangaDetailId);
  const safeMangaSlug = isInvalidMangaSlug(mangaSlug) ? '' : mangaSlug;
  const mangaDetailId = rawMangaDetailId || safeMangaSlug;
  const mangaDetailPath = mangaDetailId ? getMangaDetailPath(mangaDetailId) : '/manga';
  const mangaTitle = chapterState.mangaTitle || persistedMeta.mangaTitle || fallbackMangaTitle;
  const mangaThumb = String(chapterState.mangaThumb || persistedMeta.mangaThumb || fallbackMangaThumb || '').trim();
  useEffect(() => retainCachedCover(mangaThumb), [mangaThumb]);
  const provisionalChapterNumber = qqChapter?.number ?? parseChapterNumber(chapterState.chapterNumber) ?? fallbackChapterNumber;
  const stateChapters = useMemo(
    () => normalizeReaderChapters(chapterState.chapters || []),
    [chapterState.chapters]
  );
  const persistedChapters = useMemo(
    () => normalizeReaderChapters(persistedMeta.chapters || []),
    [persistedMeta.chapters]
  );

  const getUniqueChapterCount = (list: ReaderChapter[]) => {
    return new Set(
      list
        .map((chapter) => String(chapter?.id || '').trim())
        .filter(Boolean)
    ).size;
  };

  const knownChapterCount = Math.max(
    getUniqueChapterCount(stateChapters),
    getUniqueChapterCount(persistedChapters)
  );

  const { data: fallbackChapterList = EMPTY_READER_CHAPTERS, isFetching: isFallbackChapterListLoading } = useQuery({
    queryKey: ['manga', 'detail', safeMangaSlug, 'chapter-list-fallback'],
    queryFn: async ({ signal }) => {
      if (!safeMangaSlug) return [] as ReaderChapter[];

      const mangaDexId = normalizeMangaDexId(safeMangaSlug);
      if (mangaDexId) {
        const raw = await mangaApi.getMangaDexDetail(mangaDexId, 'all', 'vi', { signal });
        const item = raw?.manga || {};
        const chapterRows = Array.isArray(item.chapters) ? item.chapters : [];
        const chapters = chapterRows
          .map((ch: any) => {
            const chapterId = String(ch?.id || '').trim();
            const chapterNumber = parseChapterNumber(ch?.chapter);
            return {
              id: chapterId,
              number: chapterNumber ?? Number.NaN,
              title: ch?.chapter_with_groups || ch?.title || `Chương ${ch?.chapter || '?'}`,
              scanlationGroup: ch?.scanlationGroup || ch?.scanlation_group || ch?.group || '',
              translationSource: ch?.translationSource || ch?.translation_source || 'mangadex',
              translationSourceLabel: ch?.translationSourceLabel || ch?.translation_source_label || 'MangaDex',
              scanlationGroups: ch?.scanlationGroups || ch?.scanlation_groups || [],
              translatedLanguage: ch?.translatedLanguage || ch?.translated_language || '',
            };
          })
          .filter((ch) => {
            return !!ch.id && !!normalizeMangaDexId(ch.id) && Number.isFinite(ch.number) && ch.number >= 0;
          })
          .sort((a, b) => a.number - b.number);
        return chapters;
      }

      const raw = await mangaApi.getDetail(safeMangaSlug, signal);
      const detail = adaptMangaDetail(raw);
      return normalizeReaderChapters(detail.chapters || []);
    },
    enabled: !!safeMangaSlug,
    initialData: () => knownChapterCount > 1
      ? (stateChapters.length >= persistedChapters.length ? stateChapters : persistedChapters)
      : undefined,
    // Persisted navigation can render immediately, but its age must survive a
    // remount. Treating an old list as fresh hid newly published next chapters.
    initialDataUpdatedAt: stateChapters.length > 1 ? undefined : persistedMeta.savedAt || 0,
    refetchOnMount: query => query.state.data?.some(chapter => chapterIdMatches(chapter.id, [currentChapterId])) ? true : 'always',
    staleTime: 10 * 60 * 1000,
  });

  const baseChapters = useMemo(() => mergeReaderChapters(
    [persistedChapters, stateChapters, fallbackChapterList], currentChapterId),
    [stateChapters, persistedChapters, fallbackChapterList, currentChapterId]
  );

  const chapters = useMemo(() => {
    const nonEmptyId = baseChapters.filter((chapter) => String(chapter?.id || '').trim());
    const nonNegative = nonEmptyId.filter((chapter) => Number.isFinite(Number(chapter.number)) && Number(chapter.number) >= 0);
    return nonNegative.length > 0 ? nonNegative : nonEmptyId;
  }, [baseChapters]);

  const currentChapterFromList = useMemo(
    () => chapters.find((chapter) => chapterIdMatches(chapter.id, [currentChapterId, id, normalizedChapterId])),
    [chapters, currentChapterId, id, normalizedChapterId]
  );
  const chapterNumber = currentChapterFromList?.number ?? provisionalChapterNumber;
  const chapterNumberLabel = qqChapter && chapterNumber === undefined ? qqChapter.label : formatChapterNumber(chapterNumber);
  const chapterTitle = currentChapterFromList?.title ?? chapterState.chapterTitle ?? fallbackChapterTitle;
  const chapterFallbackLabel = chapterNumberLabel !== '?' ? `Chương ${chapterNumberLabel}` : 'Chương hiện tại';
  const cleanChapterTitle = String(chapterTitle || '').trim();
  const chapterDisplayTitle = cleanChapterTitle && cleanChapterTitle !== chapterFallbackLabel ? cleanChapterTitle : '';
  const chapterHistoryName = cleanChapterTitle || chapterFallbackLabel;

  const chapterSourceOptions = useMemo(() => {
    const options = new Map<string, { id: string; label: string; count: number; rank: number }>();
    const bump = (id: string, label: string, rank: number) => {
      const existing = options.get(id);
      if (existing) {
        existing.count += 1;
        return;
      }
      options.set(id, { id, label, count: 1, rank });
    };

    for (const chapter of chapters) {
      const source = getReaderChapterSource(chapter);
      const sourceLabel = getReaderChapterSourceLabel(chapter);
      bump(`source:${source}`, sourceLabel, 1);

      const seenGroups = new Set<string>();
      for (const group of getReaderChapterGroups(chapter)) {
        const groupKey = normalizeFilterToken(group.id || group.name);
        if (!groupKey || seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        const label = sourceLabel && sourceLabel !== group.name
          ? `${sourceLabel} · ${group.name}`
          : group.name;
        bump(`group:${source}:${groupKey}`, label, 2);
      }
    }

    return [
      { id: CHAPTER_SOURCE_ALL, label: 'Tất cả nguồn', count: chapters.length, rank: 0 },
      ...Array.from(options.values()).sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.label.localeCompare(b.label);
      }),
    ];
  }, [chapters]);

  const filteredChapters = useMemo(() => {
    return filterReaderChaptersBySource(chapters, chapterSourceFilter);
  }, [chapterSourceFilter, chapters]);

  useEffect(() => {
    if (chapters.length === 0) return;
    if (chapterSourceOptions.some((option) => option.id === chapterSourceFilter)) return;
    setChapterSourceFilter(CHAPTER_SOURCE_ALL);
  }, [chapterSourceFilter, chapterSourceOptions, chapters.length]);

  useEffect(() => {
    const nextFilter = chapterState.chapterSourceFilter || persistedMeta.chapterSourceFilter || CHAPTER_SOURCE_ALL;
    // Restore only when navigation metadata changes. An invalid saved filter
    // must not fight the validation effect above on every render.
    setChapterSourceFilter((current) => current === nextFilter ? current : nextFilter);
  }, [chapterState.chapterSourceFilter, currentChapterId, persistedMeta.chapterSourceFilter]);

  useEffect(() => {
    if (!id) return;
    if (!safeMangaSlug || chapters.length === 0) return;
    const payload: PersistedChapterMeta = {
      mangaId: mangaDetailId,
      mangaSlug: safeMangaSlug,
      mangaTitle,
      mangaThumb,
      chapters,
      chapterSourceFilter,
    };
    writeReaderMetaToStorage([id, currentChapterId, normalizedChapterId], payload);
  }, [id, currentChapterId, normalizedChapterId, mangaDetailId, safeMangaSlug, mangaTitle, mangaThumb, chapters, chapterSourceFilter]);

  const navigationChapters = useMemo(() => {
    const inferredFilter = chapterSourceFilter === CHAPTER_SOURCE_ALL
      ? inferReaderChapterFilter(currentChapterFromList)
      : chapterSourceFilter;
    const sourceScoped = filterReaderChaptersBySource(chapters, inferredFilter);
    const candidateList = sourceScoped.length > 0 ? sourceScoped : filteredChapters;
    const hasCurrentInFilter = candidateList.some((chapter) => (
      chapterIdMatches(chapter.id, [currentChapterId, id, normalizedChapterId])
    ));
    return hasCurrentInFilter ? candidateList : chapters;
  }, [chapterSourceFilter, chapters, currentChapterFromList, currentChapterId, filteredChapters, id, normalizedChapterId]);

  // Normalize chapter order to avoid edge cases like chapter 0 losing next button.
  const orderedChapters = useMemo(
    () => [...navigationChapters].sort((a, b) => chapterSortNumber(a.number) - chapterSortNumber(b.number)),
    [navigationChapters]
  );
  const chapterIndex = orderedChapters.findIndex((chapter) => (
    chapterIdMatches(chapter.id, [currentChapterId, id, normalizedChapterId])
  ));
  const currentChapterIndex = chapterIndex >= 0
    ? chapterIndex
    : Number.isFinite(chapterNumber) && Number(chapterNumber) >= 0
      ? orderedChapters.findIndex(c => c.number === chapterNumber)
      : -1;
  const prevChapter = currentChapterIndex > 0 ? orderedChapters[currentChapterIndex - 1] : undefined;
  const nextChapter = currentChapterIndex >= 0 && currentChapterIndex < orderedChapters.length - 1
    ? orderedChapters[currentChapterIndex + 1]
    : undefined;
  useEffect(() => {
    store.setCurrentPage(0);
    store.setAutoScroll(false);
    setVisiblePage(0);
    setScrollProgress(0);
    setShowComments(false);
    viewTrackedRef.current = false;
    viewSessionStartedRef.current = false;
    readSessionIdRef.current = createReadSessionId();
    readSessionStartedAtRef.current = Date.now();
    setViewEligibilityTick(0);
    prefetchTriggeredRef.current = false;
    preloadedRef.current.clear();
    window.scrollTo(0, 0);
  }, [id]);

  // ─── Start a server-side read session before a view can be counted ───
  useEffect(() => {
    if (shouldSuppressViewTracking) return;
    if (!id || !safeMangaSlug || viewSessionStartedRef.current) return;
    if (!readSessionIdRef.current) {
      readSessionIdRef.current = createReadSessionId();
      readSessionStartedAtRef.current = Date.now();
    }
    viewSessionStartedRef.current = true;
    mangaApi.startViewSession(safeMangaSlug, {
      chapterId: id,
      readSessionId: readSessionIdRef.current,
    }).catch(() => {});
  }, [id, safeMangaSlug, shouldSuppressViewTracking]);

  useEffect(() => {
    if (shouldSuppressViewTracking) return;
    if (!id || !safeMangaSlug || viewTrackedRef.current) return;
    const timer = window.setInterval(() => {
      setViewEligibilityTick((tick) => tick + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [id, safeMangaSlug, shouldSuppressViewTracking]);

  // ─── Count view only after real reading signals are present ───
  useEffect(() => {
    if (shouldSuppressViewTracking) return;
    if (!id || !safeMangaSlug || viewTrackedRef.current) return;
    if (!readSessionIdRef.current || !readSessionStartedAtRef.current) return;
    if (totalPages <= 0) return;

    const elapsedSeconds = Math.floor((Date.now() - readSessionStartedAtRef.current) / 1000);
    const progress = store.mode === 'horizontal'
      ? Math.round(((store.currentPage + 1) / totalPages) * 100)
      : Math.round(scrollProgress);
    const pageSeen = store.mode === 'horizontal' ? store.currentPage + 1 : visiblePage + 1;
    const minPages = totalPages <= 1 ? 1 : VIEW_TRACK_MIN_PAGES;

    if (elapsedSeconds < VIEW_TRACK_MIN_SECONDS) return;
    if (progress < VIEW_TRACK_MIN_PROGRESS && pageSeen < minPages) return;

    viewTrackedRef.current = true;
    mangaApi.addView(safeMangaSlug, id, {
      readSessionId: readSessionIdRef.current,
      elapsedSeconds,
      progress,
      pageSeen,
      totalPages,
    }).then((result) => {
      if (!result?.counted) return;
      incrementMangaViewsInQueryCache(queryClient, [safeMangaSlug, mangaDetailId], 1);
      invalidateMangaRealtimeQueries(queryClient);
    }).catch(() => {
      viewTrackedRef.current = false;
    });
  }, [
    id,
    safeMangaSlug,
    mangaDetailId,
    queryClient,
    totalPages,
    visiblePage,
    store.currentPage,
    store.mode,
    scrollProgress,
    viewEligibilityTick,
    shouldSuppressViewTracking,
  ]);

  const prefetchChapterData = useCallback(async (chapterId: string) => {
    const normalizedId = normalizeMangaDexId(chapterId) || chapterId;
    const mangadexId = normalizeMangaDexId(normalizedId);
    if (mangadexId) {
      return {
        pages: await loadMangaDexChapterPages(mangadexId),
        raw: { data: { item: {} } },
      };
    }

    const data = await mangaApi.getChapter(normalizedId);
    return {
      pages: adaptChapterPages(data),
      raw: data,
    };
  }, []);

  useReaderProgress({
    chapter: currentChapterId, manga: safeMangaSlug, mangaId: mangaDetailId,
    title: mangaTitle, thumb: mangaThumb, chapterName: chapterHistoryName,
    totalPages, mode: store.mode, currentPage: store.currentPage,
    container: readerRef, resume: chapterState.resume,
    resumeViewer: chapterState.resumeViewer,
  });

  useEffect(() => {
    if (store.autoScroll && store.mode !== 'horizontal') {
      store.setShowControls(false);
      setShowSettings(false);
      setShowChapterList(false);
      autoScrollTimer.current = window.setInterval(() => {
        window.scrollBy({ top: store.autoScrollSpeed, behavior: 'auto' });
      }, 30);
    }
    return () => { if (autoScrollTimer.current) clearInterval(autoScrollTimer.current); };
  }, [store.autoScroll, store.autoScrollSpeed, store.mode]);

  // Show controls at top, hide when scrolling down
  useEffect(() => {
    let lastY = window.scrollY;
    const handleScroll = () => {
      const y = window.scrollY;
      if (y < 50) {
        store.setShowControls(true);
      } else if (y > lastY + 30 && store.showControls) {
        store.setShowControls(false);
        setShowSettings(false);
        setShowChapterList(false);
      }
      lastY = y;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [store.showControls]);

  // ─── Viewport-centric preloading: prioritize pages near current view ───
  useEffect(() => () => {
    privatePreloads.current.forEach(release => release());
    privatePreloads.current.clear();
  }, [currentChapterId]);
  useEffect(() => {
    if (!pages.length) return;
    const mode = imageLoadingMode;

    const preloadImageUrl = (url: string, priority: 'high' | 'low') => {
      if (!url || preloadedRef.current.has(url)) return;
      preloadedRef.current.add(url);
      if (canCacheReaderImage(url)) { privatePreloads.current.add(warmReaderImages([url]));return; }
      const img = new Image();
      img.fetchPriority = priority;
      img.src = url;
    };

    const preloadUrls = (urls: string[], highPriorityCount = 0) => {
      urls.forEach((url, index) => {
        preloadImageUrl(url, index < highPriorityCount ? 'high' : 'low');
      });
    };

    const eagerCount = mode === 'standard' ? 2 : 3;

    // Keep bandwidth focused on the current reading area instead of queueing
    // the whole chapter and delaying images the user is actively viewing.
    preloadUrls(pages.slice(0, eagerCount), eagerCount);
  }, [pages, imageLoadingMode]);

  // ─── Preload pages around the currently visible page ───
  useEffect(() => {
    if (!pages.length) return;
    // The initial effect already queues the first 2-3 pages. Wait until the
    // reader advances before expanding the preload window.
    if (visiblePage === 0) return;
    const mode = imageLoadingMode;
    const AHEAD = mode === 'aggressive' ? 5 : mode === 'standard' ? 2 : 3;
    const HIGH_PRIORITY_AHEAD = mode === 'aggressive' ? 3 : 2;
    const start = visiblePage + 1;
    const end = Math.min(visiblePage + AHEAD + 1, pages.length);
    const preloadImageUrl = (url: string, priority: 'high' | 'low') => {
      if (!url || preloadedRef.current.has(url)) return;
      preloadedRef.current.add(url);
      if (canCacheReaderImage(url)) { privatePreloads.current.add(warmReaderImages([url]));return; }
      const img = new Image();
      img.fetchPriority = priority;
      img.src = url;
    };
    for (let i = start; i < end; i++) {
      const url = pages[i];
      preloadImageUrl(url, i <= visiblePage + HIGH_PRIORITY_AHEAD ? 'high' : 'low');
    }
  }, [visiblePage, pages, imageLoadingMode]);

  // ─── Prefetch next chapter metadata only when the reader is near the end ───
  useEffect(() => {
    if (imageLoadingMode === 'standard') return;
    if (prefetchTriggeredRef.current || !nextChapter || totalPages === 0) return;

    const pagesFromEnd = imageLoadingMode === 'aggressive' ? 5 : 3;
    const threshold = Math.max(1, totalPages - pagesFromEnd);
    if (visiblePage < threshold) return;

    prefetchTriggeredRef.current = true;
    const nextChapterId = normalizeMangaDexId(nextChapter.id) || nextChapter.id;
    const isMangaDexNextChapter = !!normalizeMangaDexId(nextChapter.id);
    queryClient.prefetchQuery({
      queryKey: ['manga', 'chapter', nextChapterId],
      queryFn: () => prefetchChapterData(nextChapterId),
      staleTime: isMangaDexNextChapter ? 30 * 1000 : 60 * 60 * 1000,
    });
  }, [visiblePage, totalPages, nextChapter, queryClient, prefetchChapterData, imageLoadingMode]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key === 'c') {
      if (showComments) setShowComments(false);
      else if (isMobile) commentRef.current?.scrollIntoView({ behavior: 'smooth' });
      else setShowComments(true);
      return;
    }
    if (showComments) return;
    if (store.mode === 'horizontal') {
      const dir = store.pageDirection === 'rtl' ? -1 : 1;
      if (e.key === 'ArrowRight') store.setCurrentPage(Math.min(store.currentPage + dir, totalPages - 1));
      if (e.key === 'ArrowLeft') store.setCurrentPage(Math.max(store.currentPage - dir, 0));
    }
    if (key === 'f') { e.preventDefault(); store.toggleFullscreen(); }
    if (e.key === 'Escape') { store.setShowControls(true); setShowSettings(false); setShowChapterList(false); }
    if (e.key === ' ' && store.mode !== 'horizontal') { e.preventDefault(); store.setAutoScroll(!store.autoScroll); }
    if (e.key === '+' || e.key === '=') store.setZoom(store.zoom + 10);
    if (e.key === '-') store.setZoom(store.zoom - 10);
    if (e.key === '0') store.setZoom(100);
  }, [store.mode, store.currentPage, totalPages, store.pageDirection, store.autoScroll, store.zoom, showComments, isMobile]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (store.isFullscreen) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.().catch(() => {});
  }, [store.isFullscreen]);

  useEffect(() => {
    if (store.mode === 'horizontal') return;
    const handleScroll = () => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      setScrollProgress(h > 0 ? (window.scrollY / h) * 100 : 0);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [store.mode]);

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart || store.mode !== 'horizontal') return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      const dir = store.pageDirection === 'rtl' ? -1 : 1;
      if (dx < 0) store.setCurrentPage(Math.min(store.currentPage + dir, totalPages - 1));
      else store.setCurrentPage(Math.max(store.currentPage - dir, 0));
    }
    setTouchStart(null);
  };

  const handlePageVisible = useCallback((index: number) => { setVisiblePage(index); }, []);

  const toggleControlsOnClick = () => {
    if (showComments) return;
    if (showSettings || showChapterList) { setShowSettings(false); setShowChapterList(false); return; }
    store.setShowControls(!store.showControls);
  };

  const navigateChapter = (ch: ReaderChapter) => {
    navigate(`/chapter/${ch.id}`, {
      state: {
        mangaId: mangaDetailId,
        mangaSlug: safeMangaSlug,
        mangaTitle,
        mangaThumb,
        chapterNumber: ch.number,
        chapterTitle: ch.title,
        chapters,
        chapterSourceFilter,
      },
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">Đang tải chương...</p>
      </div>
    );
  }

  if (!chapterData || totalPages === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-3 bg-background">
        <p className="text-4xl">😕</p>
        <p className="text-muted-foreground font-medium">Không tìm thấy chương này.</p>
        <Link to="/" className="text-primary hover:underline text-sm font-bold">← Về trang chủ</Link>
      </div>
    );
  }

  const progress = store.mode === 'horizontal' ? ((store.currentPage + 1) / totalPages) * 100 : scrollProgress;
  const displayPage = store.mode === 'horizontal' ? store.currentPage + 1 : visiblePage + 1;

  return (
    <div className="flex min-h-screen w-full max-w-full overflow-x-hidden bg-background">
      <div
        ref={readerRef}
        className={`relative min-h-screen min-w-0 max-w-full flex-1 select-none overflow-x-hidden transition-all duration-300 ${showComments && !isMobile ? 'mr-0' : ''}`}
        onClick={toggleControlsOnClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
      {store.showProgressBar && (
        <div className="fixed top-0 left-0 right-0 z-50 h-1 bg-secondary/30">
          <motion.div className="h-full manga-gradient" style={{ width: `${progress}%` }} transition={{ duration: 0.1 }} />
        </div>
      )}

      {/* Auto scroll floating stop button */}
      <AnimatePresence>
        {store.autoScroll && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileTap={{ scale: 0.9 }}
            onClick={(e) => { e.stopPropagation(); store.setAutoScroll(false); }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="fixed bottom-8 right-8 z-[9999] flex items-center gap-2 px-5 py-3 rounded-full bg-destructive text-destructive-foreground text-sm font-bold shadow-2xl cursor-pointer select-auto pointer-events-auto"
          >
            <Pause className="w-4 h-4" /> Dừng cuộn
          </motion.button>
        )}
      </AnimatePresence>

      {/* Top controls */}
      <AnimatePresence>
        {store.showControls && (
          <motion.div
            initial={{ opacity: 0, y: -30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.2 }}
            className="fixed top-0 left-0 right-0 z-40 bg-background/60 backdrop-blur-md border-b border-border/30"
            onClick={e => e.stopPropagation()}
          >
            <div className="container mx-auto px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <Link to={mangaDetailPath} className="p-1.5 rounded-lg hover:bg-secondary/80 transition-colors shrink-0">
                  <ArrowLeft className="w-5 h-5" />
                </Link>
                <div className="min-w-0">
                  <p className="text-sm font-bold line-clamp-1">{mangaTitle}</p>
                  <p className="text-[11px] text-muted-foreground">Ch. {chapterNumberLabel} {chapterDisplayTitle ? `• ${chapterDisplayTitle}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <motion.button whileTap={{ scale: 0.8 }}
                  onClick={() => {
                    if (isMobile) commentRef.current?.scrollIntoView({ behavior: 'smooth' });
                    else setShowComments(!showComments);
                  }}
                  className={`p-2 rounded-lg transition-colors ${showComments ? 'bg-primary/20 text-primary' : 'hover:bg-secondary/80'}`}
                >
                  <MessageCircle className="w-4 h-4" />
                </motion.button>
                <motion.button whileTap={{ scale: 0.8 }}
                  onClick={() => { setShowChapterList(!showChapterList); setShowSettings(false); }}
                  className={`p-2 rounded-lg transition-colors ${showChapterList ? 'bg-primary/20 text-primary' : 'hover:bg-secondary/80'}`}
                >
                  <List className="w-4 h-4" />
                </motion.button>
                <motion.button whileTap={{ scale: 0.8 }}
                  onClick={() => { setShowSettings(!showSettings); setShowChapterList(false); }}
                  className={`p-2 rounded-lg transition-colors ${showSettings ? 'bg-primary/20 text-primary' : 'hover:bg-secondary/80'}`}
                >
                  <Settings className="w-4 h-4" />
                </motion.button>
                <motion.button whileTap={{ scale: 0.8 }} onClick={store.toggleFullscreen} className="p-2 rounded-lg hover:bg-secondary/80 transition-colors">
                  {store.isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </motion.button>
              </div>
            </div>

            <AnimatePresence>
              {showChapterList && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden border-t border-border/50">
                  <div className="container mx-auto px-4 py-3 max-h-72 overflow-y-auto scrollbar-hide">
                    {isFallbackChapterListLoading ? (
                      <div className="py-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Đang tải danh sách chương...
                      </div>
                    ) : chapters.length > 0 ? (
                      <div className="space-y-3">
                        {chapterSourceOptions.length > 2 && (
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Nguồn dịch</p>
                              <p className="text-xs text-muted-foreground">
                                {filteredChapters.length}/{chapters.length} chương
                              </p>
                            </div>
                            <select
                              value={chapterSourceFilter}
                              onChange={(event) => setChapterSourceFilter(event.target.value)}
                              className="h-9 w-full rounded-lg border border-border/60 bg-background/80 px-3 text-xs font-semibold text-foreground outline-none transition-colors hover:bg-secondary/50 focus:border-primary sm:w-72"
                            >
                              {chapterSourceOptions.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label} ({option.count})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {filteredChapters.length > 0 ? (
                          <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-1.5">
                            {filteredChapters.map(ch => (
                              <button
                                key={ch.id}
                                onClick={() => navigateChapter(ch)}
                                title={getReaderChapterSourceLabel(ch)}
                                className={`px-2 py-1.5 rounded text-xs font-bold transition-all ${chapterIdMatches(ch.id, [currentChapterId, id, normalizedChapterId]) ? 'bg-primary text-primary-foreground' : 'bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
                              >
                                {formatChapterNumber(ch.number)}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="py-3 text-center text-xs text-muted-foreground">Không có chương phù hợp với nguồn dịch này.</p>
                        )}
                      </div>
                    ) : (
                      <p className="py-3 text-center text-xs text-muted-foreground">Không tải được danh sách chương.</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence>{showSettings && <ReaderSettings />}</AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reader Content — top padding accounts for fixed top-bar height when visible */}
      <div
        className={`${store.showControls ? 'pt-14' : 'pt-0'} pb-16 transition-[padding] duration-200 overflow-x-hidden`}
        style={{ transform: `scale(${store.zoom / 100})`, transformOrigin: 'top center', filter: `brightness(${store.brightness}%)` }}
      >
        {store.mode === 'horizontal' ? (
          <div className="flex items-center justify-center min-h-screen relative">
            <button onClick={e => { e.stopPropagation(); const dir = store.pageDirection === 'rtl' ? 1 : -1; store.setCurrentPage(Math.max(0, store.currentPage + dir)); }}
              disabled={store.pageDirection === 'rtl' ? store.currentPage >= totalPages - 1 : store.currentPage <= 0}
              className="fixed left-1 md:left-4 top-1/2 -translate-y-1/2 z-30 p-2 md:p-3 rounded-full bg-card/70 backdrop-blur-sm border border-border/50 hover:bg-card transition-all disabled:opacity-0 disabled:pointer-events-none">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <AnimatePresence mode="wait">
              <motion.div key={store.currentPage} initial={{ opacity: 0, x: store.pageDirection === 'rtl' ? -20 : 20 }}
                animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                className={`w-full mx-auto ${store.imageFit === 'width' ? 'max-w-4xl' : ''} ${store.imageFit === 'original' ? '[&_img]:max-h-[90vh]' : ''}`}>
                <ReaderImage src={pages[store.currentPage] || ''} fallbackSrc={getChapterPageFallback(pages[store.currentPage] || '')}
                  alt={`Trang ${store.currentPage + 1}`} index={store.currentPage} imageFit={store.imageFit} pageGap={0} priority />
              </motion.div>
            </AnimatePresence>
            <button onClick={e => { e.stopPropagation(); const dir = store.pageDirection === 'rtl' ? -1 : 1; store.setCurrentPage(Math.min(totalPages - 1, store.currentPage + dir)); }}
              disabled={store.pageDirection === 'rtl' ? store.currentPage <= 0 : store.currentPage >= totalPages - 1}
              className="fixed right-1 md:right-4 top-1/2 -translate-y-1/2 z-30 p-2 md:p-3 rounded-full bg-card/70 backdrop-blur-sm border border-border/50 hover:bg-card transition-all disabled:opacity-0 disabled:pointer-events-none">
              <ChevronRight className="w-5 h-5" />
            </button>
            <div className="fixed left-0 top-0 w-1/3 h-full z-20 cursor-pointer"
              onClick={e => { e.stopPropagation(); const dir = store.pageDirection === 'rtl' ? 1 : -1; store.setCurrentPage(Math.max(0, Math.min(totalPages - 1, store.currentPage + dir))); }} />
            <div className="fixed right-0 top-0 w-1/3 h-full z-20 cursor-pointer"
              onClick={e => { e.stopPropagation(); const dir = store.pageDirection === 'rtl' ? -1 : 1; store.setCurrentPage(Math.max(0, Math.min(totalPages - 1, store.currentPage + dir))); }} />
          </div>
        ) : (
          <div className={`${store.mode === 'webtoon' ? 'max-w-2xl' : 'max-w-4xl'} mx-auto`}>
            {pages.map((page, i) => (
              <ReaderImage
                key={`${id}-${i}`}
                src={page}
                fallbackSrc={getChapterPageFallback(page)}
                alt={`Trang ${i + 1}`}
                index={i}
                imageFit={store.imageFit}
                pageGap={store.pageGap}
                onVisible={handlePageVisible}
                priority={i < (imageLoadingMode === 'standard' ? 2 : 3)}
              />
            ))}
            {/* End of chapter + comments */}
            <div className="text-center py-16 space-y-6" onClick={e => e.stopPropagation()}>
              <div className="w-16 h-0.5 mx-auto bg-border" />
              <p className="text-muted-foreground font-medium text-sm">Hết {chapterFallbackLabel.toLowerCase()}</p>
              <div className="flex justify-center gap-3 flex-wrap">
                {prevChapter && (
                  <button onClick={() => navigateChapter(prevChapter)} className="px-5 py-2.5 rounded-xl bg-secondary border border-border text-sm font-bold hover:bg-secondary/80 transition-colors flex items-center gap-1.5">
                    <ChevronLeft className="w-4 h-4" /> Chương trước
                  </button>
                )}
                <Link to={mangaDetailPath} className="px-5 py-2.5 rounded-xl bg-secondary border border-border text-sm font-bold hover:bg-secondary/80 transition-colors flex items-center gap-1.5">
                  <Home className="w-4 h-4" /> Chi tiết truyện
                </Link>
                {nextChapter && (
                  <button onClick={() => navigateChapter(nextChapter)} className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 transition-colors flex items-center gap-1.5 shadow-md">
                    Chương sau <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div ref={commentRef} className="max-w-3xl mx-auto mt-12 text-left">
                <CommentSection
                  mangaSlug={safeMangaSlug}
                  postChapterId={id}
                  chapterLabel={chapterFallbackLabel}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <ShortcutsHint isMobile={isMobile} />
      </div>

      {/* Comment sidebar */}
      <AnimatePresence>
        {showComments && !isMobile && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '35%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="h-screen sticky top-0 bg-card border-l border-border overflow-y-auto overflow-x-hidden shrink-0 max-w-[35vw]"
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          >
            <div className={`p-4 transition-all duration-200 ${store.showControls ? 'pt-16' : 'pt-4'}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-lg flex items-center gap-2"><MessageCircle className="w-5 h-5 text-primary" /> Bình luận</h3>
                <button onClick={() => setShowComments(false)} className="p-2 rounded-lg hover:bg-secondary transition-colors text-sm font-bold text-muted-foreground">✕</button>
              </div>
              <CommentSection
                mangaSlug={safeMangaSlug}
                postChapterId={id}
                chapterLabel={chapterFallbackLabel}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom controls */}
      <AnimatePresence>
        {store.showControls && !showComments && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.2 }}
            className="fixed bottom-0 left-0 right-0 z-40 bg-background/60 backdrop-blur-md border-t border-border/30" onClick={e => e.stopPropagation()}>
            <div className="container mx-auto px-4 py-2 flex items-center justify-between gap-2">
              {prevChapter ? (
                <button onClick={() => navigateChapter(prevChapter)} className="flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-primary transition-colors shrink-0">
                  <ChevronLeft className="w-4 h-4" /><span className="hidden sm:inline">Trước</span>
                </button>
              ) : <div className="w-12" />}
              {store.mode === 'horizontal' ? (
                <div className="flex items-center gap-2 flex-1 max-w-sm mx-auto">
                  <span className="text-[10px] text-muted-foreground font-bold w-4 text-right">{store.pageDirection === 'rtl' ? totalPages : 1}</span>
                  <input type="range" min={0} max={totalPages - 1} value={store.currentPage} onChange={e => store.setCurrentPage(Number(e.target.value))}
                    className="flex-1 accent-primary h-1" style={{ direction: store.pageDirection === 'rtl' ? 'rtl' : 'ltr' }} />
                  <span className="text-[10px] text-muted-foreground font-bold w-4">{store.pageDirection === 'rtl' ? 1 : totalPages}</span>
                </div>
              ) : (
                <span className="text-xs font-bold text-muted-foreground">Ch. {chapterNumberLabel} / {chapters.length || '?'}</span>
              )}
              {nextChapter ? (
                <button onClick={() => navigateChapter(nextChapter)} className="flex items-center gap-1 text-sm font-bold text-muted-foreground hover:text-primary transition-colors shrink-0">
                  <span className="hidden sm:inline">Sau</span><ChevronRight className="w-4 h-4" />
                </button>
              ) : <div className="w-12" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ShortcutsHint = ({ isMobile }: { isMobile: boolean }) => {
  const [show, setShow] = useState(true);
  useEffect(() => { const t = setTimeout(() => setShow(false), 4000); return () => clearTimeout(t); }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          className="fixed bottom-16 right-4 z-30 bg-card/90 backdrop-blur-sm border border-border/50 rounded-lg px-3 py-2 text-[10px] text-muted-foreground space-y-0.5 pointer-events-none">
          {isMobile ? (
            <>
              <p className="flex items-center gap-1.5"><span className="inline-flex items-center gap-1 bg-secondary px-1.5 py-0.5 rounded text-[9px]"><MoveHorizontal className="w-3 h-3" /> Vuốt</span> Chuyển trang</p>
              <p className="flex items-center gap-1.5"><span className="inline-flex items-center gap-1 bg-secondary px-1.5 py-0.5 rounded text-[9px]"><PointerIcon className="w-3 h-3" /> x2</span> Ẩn/hiện menu</p>
            </>
          ) : (
            <>
              <p><kbd className="bg-secondary px-1 rounded text-[9px]">←→</kbd> Chuyển trang</p>
              <p><kbd className="bg-secondary px-1 rounded text-[9px]">Space</kbd> Tự cuộn</p>
              <p><kbd className="bg-secondary px-1 rounded text-[9px]">F</kbd> Toàn màn hình</p>
              <p><kbd className="bg-secondary px-1 rounded text-[9px]">C</kbd> Bình luận</p>
              <p><kbd className="bg-secondary px-1 rounded text-[9px]">+/-</kbd> Thu phóng</p>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ChapterReader;
