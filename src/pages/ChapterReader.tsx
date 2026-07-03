import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useChapter } from '@/hooks/useApi';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUserStore } from '@/store/userStore';
import { historyApi, mangaApi } from '@/lib/api';
import { adaptChapterPages, adaptMangaDetail, getChapterPageFallback } from '@/lib/adapters';
import { getMangaDetailPath, normalizeMangaDexId } from '@/lib/mangaLinks';
import { getLocalMangaDexChapterPages, getMangaDexImageFallback } from '@/lib/mangaDexImages';
import { incrementMangaViewsInQueryCache, invalidateMangaRealtimeQueries } from '@/lib/querySync';
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
const READER_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
}

interface ReaderChapter {
  id: string;
  number: number;
  title: string;
  scanlationGroup?: string;
  translationSource?: string;
  translationSourceLabel?: string;
  scanlationGroups?: Array<{
    id?: string;
    name?: string;
    website?: string;
    discord?: string;
  }>;
  translatedLanguage?: string;
  isUserUpload?: boolean;
}

interface PersistedChapterMeta {
  mangaId?: string;
  mangaSlug?: string;
  mangaTitle?: string;
  mangaThumb?: string;
  chapters?: ReaderChapter[];
  chapterSourceFilter?: string;
  savedAt?: number;
}

const CHAPTER_SOURCE_ALL = '__all_sources__';

function readerMetaKey(chapterId: string): string {
  return `reader:chapter-meta:${chapterId}`;
}

function readerMangaMetaKey(mangaKey: string): string {
  return `reader:manga-meta:${mangaKey}`;
}

function readerChapterIndexKey(chapterId: string): string {
  return `reader:chapter-index:${chapterId}`;
}

function parseStoredReaderMeta(raw: string | null, store?: Storage, key?: string): PersistedChapterMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const savedAt = Number(parsed.savedAt || 0);
    if (savedAt && Date.now() - savedAt > READER_META_TTL_MS) {
      if (store && key) store.removeItem(key);
      return {};
    }
    return parsed as PersistedChapterMeta;
  } catch {
    return {};
  }
}

function isUsableReaderMeta(meta: PersistedChapterMeta): boolean {
  const chapterCount = Array.isArray(meta.chapters)
    ? new Set(meta.chapters.map((chapter) => String(chapter?.id || '').trim()).filter(Boolean)).size
    : 0;
  const slug = cleanSlug(meta.mangaSlug);
  const mangaId = cleanSlug(meta.mangaId);
  return chapterCount > 1 || (!!slug && !isInvalidMangaSlug(slug)) || (!!mangaId && !isInvalidMangaSlug(mangaId));
}

function readReaderMetaFromStorage(chapterIds: Array<string | undefined | null>): PersistedChapterMeta {
  if (typeof window === 'undefined') return {};
  const normalizedIds = Array.from(
    new Set(chapterIds.map((chapterId) => String(chapterId || '').trim()).filter(Boolean)),
  );
  const keys = Array.from(
    new Set(normalizedIds.map(readerMetaKey)),
  );
  const stores: Storage[] = [window.localStorage, window.sessionStorage];

  for (const key of keys) {
    for (const store of stores) {
      try {
        const parsed = parseStoredReaderMeta(store.getItem(key), store, key);
        if (Object.keys(parsed).length && isUsableReaderMeta(parsed)) return parsed;
      } catch {
        // Ignore storage errors.
      }
    }
  }

  for (const chapterId of normalizedIds) {
    const indexKey = readerChapterIndexKey(chapterId);
    for (const store of stores) {
      try {
        const rawIndex = store.getItem(indexKey);
        if (!rawIndex) continue;
        const index = JSON.parse(rawIndex);
        const savedAt = Number(index?.savedAt || 0);
        if (savedAt && Date.now() - savedAt > READER_META_TTL_MS) {
          store.removeItem(indexKey);
          continue;
        }
        const mangaKey = String(index?.mangaKey || '').trim();
        if (!mangaKey) continue;
        const metaKey = readerMangaMetaKey(mangaKey);
        const parsed = parseStoredReaderMeta(store.getItem(metaKey), store, metaKey);
        if (Object.keys(parsed).length && isUsableReaderMeta(parsed)) return parsed;
      } catch {
        // Ignore storage errors.
      }
    }
  }

  return {};
}

function writeReaderMetaToStorage(
  chapterIds: Array<string | undefined | null>,
  payload: PersistedChapterMeta,
) {
  if (typeof window === 'undefined') return;
  const normalizedIds = Array.from(
    new Set(chapterIds.map((chapterId) => String(chapterId || '').trim()).filter(Boolean)),
  );
  const keys = Array.from(
    new Set(normalizedIds.map(readerMetaKey)),
  );
  const savedAt = Date.now();
  const value = JSON.stringify({ ...payload, savedAt });
  for (const key of keys) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Ignore storage errors.
    }
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore storage errors.
    }
  }

  const mangaKey = String(payload.mangaId || payload.mangaSlug || '').trim();
  if (!mangaKey) return;
  const metaKey = readerMangaMetaKey(mangaKey);
  const indexValue = JSON.stringify({ mangaKey, savedAt });
  const indexedChapterIds = Array.from(
    new Set([
      ...normalizedIds,
      ...(payload.chapters || []).map((chapter) => String(chapter?.id || '').trim()).filter(Boolean),
    ]),
  );

  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      store.setItem(metaKey, value);
    } catch {
      // Ignore storage errors.
    }
    for (const chapterId of indexedChapterIds) {
      try {
        store.setItem(readerChapterIndexKey(chapterId), indexValue);
      } catch {
        // Ignore storage errors.
      }
    }
  }
}

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
  return 'otruyen';
}

function getReaderChapterSourceLabel(chapter: ReaderChapter): string {
  const label = String(chapter.translationSourceLabel || '').trim();
  if (label) return label;
  const source = getReaderChapterSource(chapter);
  if (source === 'mangadex') return 'MangaDex';
  if (source === 'local') return 'Bản dịch web';
  if (source === 'otruyen') return 'OTruyen';
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

function parseChapterNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const raw = String(value || '').trim().replace(',', '.');
  if (!raw) return undefined;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatChapterNumber(value: number | undefined): string {
  if (!Number.isFinite(value || Number.NaN) || Number(value) <= 0) return '?';
  return Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
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

function isInvalidMangaSlug(slug?: string | null): boolean {
  if (!slug) return true;
  const s = slug.trim().toLowerCase();
  if (!s || s.length < 3) return true;
  // All-numeric slugs are invalid (dates like '20231216', IDs, etc.)
  if (/^\d+$/.test(s)) return true;
  // Hex hashes are invalid (MongoDB ObjectIDs, MD5 etc.)
  if (/^[0-9a-f]{20,}$/.test(s)) return true;
  // Chapter-like segments (chapter0, chapter1, etc.)
  if (/^chapter\d*$/.test(s)) return true;
  const compact = s.replace(/[-_\s.]+/g, '');
  if (/^(?:c|ch|chap|chapter|chuong|tap|episode|ep)\d/.test(compact)) return true;
  return ['uploads', 'comics', 'chapters', 'chapter', 'api', 'img', 'images', 'v1', 'data'].includes(s);
}

function cleanSlug(value?: string | null): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]/g, '');
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
  const chapterState = (location.state || {}) as ChapterState;
  const { data: chapterData, isLoading } = useChapter(currentChapterId || undefined);
  const store = useReaderStore();
  const imageLoadingMode = useSettingsStore((s) => s.settings.reader.imageLoading || 'preload');
  const { user, isLoggedIn } = useUserStore();
  const queryClient = useQueryClient();
  const detectedMobile = useIsMobile();
  const mobileReaderRef = useRef(detectedMobile);
  if (detectedMobile) mobileReaderRef.current = true;
  const isMobile = mobileReaderRef.current;
  const lastHistorySentAtRef = useRef(0);
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
  const [horizontalRetryCount, setHorizontalRetryCount] = useState(0);
  const [horizontalUseFallback, setHorizontalUseFallback] = useState(false);
  const [horizontalLoaded, setHorizontalLoaded] = useState(false);
  const [chapterSourceFilter, setChapterSourceFilter] = useState(
    chapterState.chapterSourceFilter || CHAPTER_SOURCE_ALL
  );

  const readerRef = useRef<HTMLDivElement>(null);
  const autoScrollTimer = useRef<number>();
  const preloadedRef = useRef<Set<string>>(new Set());
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
    return '';
  })();
  const fallbackMangaTitle = rawItem.comic_name || rawSeo.titleHead || 'Đang tải...';
  const fallbackMangaThumb = String(rawItem.thumb_url || rawItem.thumb || rawItem.cover_url || '').trim();
  const fallbackChapterNumber = parseChapterNumber(rawItem.chapter_name);
  const fallbackChapterTitle = rawItem.chapter_title || '';
  const mangaSlug = cleanSlug(chapterState.mangaSlug || persistedMeta.mangaSlug || fallbackMangaSlug);
  const safeMangaSlug = isInvalidMangaSlug(mangaSlug) ? '' : mangaSlug;
  const rawMangaDetailId = String(chapterState.mangaId || persistedMeta.mangaId || '').trim();
  const mangaDetailId = rawMangaDetailId || safeMangaSlug;
  const mangaDetailPath = mangaDetailId ? getMangaDetailPath(mangaDetailId) : '/manga';
  const mangaTitle = chapterState.mangaTitle || persistedMeta.mangaTitle || fallbackMangaTitle;
  const mangaThumb = String(chapterState.mangaThumb || persistedMeta.mangaThumb || fallbackMangaThumb || '').trim();
  const provisionalChapterNumber = parseChapterNumber(chapterState.chapterNumber) ?? fallbackChapterNumber;
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
  const shouldFetchFallbackChapterList = knownChapterCount <= 1;

  const { data: fallbackChapterList = [], isFetching: isFallbackChapterListLoading } = useQuery({
    queryKey: ['manga', 'detail', safeMangaSlug, 'chapter-list-fallback'],
    queryFn: async () => {
      if (!safeMangaSlug) return [] as ReaderChapter[];

      const mangaDexId = normalizeMangaDexId(safeMangaSlug);
      if (mangaDexId) {
        const raw = await mangaApi.getMangaDexDetail(mangaDexId, 'all');
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

      const raw = await mangaApi.getDetail(safeMangaSlug);
      const detail = adaptMangaDetail(raw);
      return normalizeReaderChapters(detail.chapters || []);
    },
    enabled: !!safeMangaSlug && shouldFetchFallbackChapterList,
    staleTime: 10 * 60 * 1000,
  });

  const baseChapters = useMemo(() => [stateChapters, persistedChapters, fallbackChapterList].reduce(
      (best, current) => {
        const currentCount = getUniqueChapterCount(current);
        const bestCount = getUniqueChapterCount(best);
        return currentCount > bestCount ? current : best;
      },
    [] as ReaderChapter[]
    ),
    [stateChapters, persistedChapters, fallbackChapterList]
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
  const chapterNumberLabel = formatChapterNumber(chapterNumber);
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
    if (nextFilter === chapterSourceFilter) return;
    setChapterSourceFilter(nextFilter);
  }, [chapterState.chapterSourceFilter, chapterSourceFilter, currentChapterId, persistedMeta.chapterSourceFilter]);

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
    : Number(chapterNumber) > 0
      ? orderedChapters.findIndex(c => c.number === chapterNumber)
      : -1;
  const prevChapter = currentChapterIndex > 0 ? orderedChapters[currentChapterIndex - 1] : undefined;
  const nextChapter = currentChapterIndex >= 0 && currentChapterIndex < orderedChapters.length - 1
    ? orderedChapters[currentChapterIndex + 1]
    : undefined;
  const nextNextChapter = currentChapterIndex >= 0 && currentChapterIndex < orderedChapters.length - 2
    ? orderedChapters[currentChapterIndex + 2]
    : undefined;

  useEffect(() => {
    store.setCurrentPage(0);
    store.setAutoScroll(false);
    setVisiblePage(0);
    setScrollProgress(0);
    setShowComments(false);
    setHorizontalRetryCount(0);
    setHorizontalUseFallback(false);
    setHorizontalLoaded(false);
    lastHistorySentAtRef.current = 0;
    viewTrackedRef.current = false;
    viewSessionStartedRef.current = false;
    readSessionIdRef.current = createReadSessionId();
    readSessionStartedAtRef.current = Date.now();
    setViewEligibilityTick(0);
    prefetchTriggeredRef.current = false;
    preloadedRef.current.clear();
    window.scrollTo(0, 0);
  }, [id]);

  useEffect(() => {
    setHorizontalRetryCount(0);
    setHorizontalUseFallback(false);
    setHorizontalLoaded(false);
  }, [store.currentPage, id]);

  useEffect(() => {
    if (store.mode !== 'horizontal' || horizontalLoaded || horizontalUseFallback) return;
    const page = pages[store.currentPage] || '';
    const fallback = getChapterPageFallback(page) || getMangaDexImageFallback(page);
    if (!fallback) return;
    const timeout = window.setTimeout(() => {
      setHorizontalUseFallback(true);
      setHorizontalRetryCount(0);
    }, 6_000);
    return () => window.clearTimeout(timeout);
  }, [store.mode, store.currentPage, pages, horizontalLoaded, horizontalUseFallback]);

  // ─── Start a server-side read session before a view can be counted ───
  useEffect(() => {
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
  }, [id, safeMangaSlug]);

  useEffect(() => {
    if (!id || !safeMangaSlug || viewTrackedRef.current) return;
    const timer = window.setInterval(() => {
      setViewEligibilityTick((tick) => tick + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [id, safeMangaSlug]);

  // ─── Count view only after real reading signals are present ───
  useEffect(() => {
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
  ]);

  const prefetchChapterData = useCallback(async (chapterId: string) => {
    const normalizedId = normalizeMangaDexId(chapterId) || chapterId;
    const mangadexId = normalizeMangaDexId(normalizedId);
    if (mangadexId) {
      try {
        const localImageUrls = await getLocalMangaDexChapterPages(mangadexId);
        if (localImageUrls.length > 0) {
          return {
            pages: localImageUrls,
            raw: { data: { item: {} } },
          };
        }
      } catch {
        // Fall through to backend lookup when direct MangaDex API is blocked.
      }

      const attempts: Array<{ mode: 'saver'; refresh: boolean }> = [
        { mode: 'saver', refresh: false },
        { mode: 'saver', refresh: true },
      ];
      let lastError: unknown = null;

      for (const attempt of attempts) {
        try {
          const data = await mangaApi.getMangaDexChapterPages(
            mangadexId,
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

      if (lastError instanceof Error) throw lastError;
      throw new Error('Không tải được trang chapter MangaDex');
    }

    const data = await mangaApi.getChapter(normalizedId);
    return {
      pages: adaptChapterPages(data),
      raw: data,
    };
  }, []);

  const upsertHistoryCache = useCallback((entry: {
    manga_slug: string;
    manga_title: string;
    manga_thumb: string;
    chapter_id: string;
    chapter_name: string;
    page: number;
    progress: number;
    client_read_at: string;
  }) => {
    queryClient.setQueryData(['history'], (old: any) => {
      const current = Array.isArray(old) ? old : [];
      const filtered = current.filter((it: any) => it.manga_slug !== entry.manga_slug);
      return [{ ...entry, read_at: entry.client_read_at }, ...filtered];
    });
  }, [queryClient]);

  const hasMeaningfulHistoryProgress = useCallback((progress: number, page: number) => {
    if (totalPages <= 0) return false;
    const elapsedSeconds = readSessionStartedAtRef.current
      ? Math.floor((Date.now() - readSessionStartedAtRef.current) / 1000)
      : 0;
    const pageSeen = Math.max(0, page) + 1;
    const minProgress = totalPages <= 2 ? 1 : 5;
    return elapsedSeconds >= 8 || progress >= minProgress || pageSeen >= 2;
  }, [totalPages]);

  // ─── Update progress periodically ───
  useEffect(() => {
    if (!isLoggedIn || !id || !safeMangaSlug || totalPages === 0) return;
    const progress = store.mode === 'horizontal'
      ? Math.round(((store.currentPage + 1) / totalPages) * 100)
      : Math.round(scrollProgress);
    const page = store.mode === 'horizontal' ? store.currentPage : visiblePage;

    const timer = setTimeout(() => {
      if (!hasMeaningfulHistoryProgress(progress, page)) return;
      const clientReadAt = new Date().toISOString();
      const sentAt = Date.parse(clientReadAt);
      if (sentAt - lastHistorySentAtRef.current < 2500) return;
      lastHistorySentAtRef.current = sentAt;
      const entry = {
        manga_slug: safeMangaSlug,
        manga_title: mangaTitle,
        manga_thumb: mangaThumb,
        chapter_id: id,
        chapter_name: chapterHistoryName,
        page,
        progress: Math.min(progress, 100),
        client_read_at: clientReadAt,
      };
      historyApi.add(entry)
        .then((result) => {
          if (result?.stale) return;
          upsertHistoryCache(entry);
        })
        .catch(() => {});
    }, 3000); // debounce 3s

    return () => clearTimeout(timer);
  }, [isLoggedIn, id, safeMangaSlug, visiblePage, store.currentPage, scrollProgress, totalPages, store.mode, mangaTitle, mangaThumb, chapterHistoryName, upsertHistoryCache, hasMeaningfulHistoryProgress]);

  useEffect(() => {
    if (!isLoggedIn || !id || !safeMangaSlug || totalPages === 0) return;

    const flushHistory = () => {
      const progress = store.mode === 'horizontal'
        ? Math.round(((store.currentPage + 1) / totalPages) * 100)
        : Math.round(scrollProgress);
      const page = store.mode === 'horizontal' ? store.currentPage : visiblePage;
      if (!hasMeaningfulHistoryProgress(progress, page)) return;
      const entry = {
        manga_slug: safeMangaSlug,
        manga_title: mangaTitle,
        manga_thumb: mangaThumb,
        chapter_id: id,
        chapter_name: chapterHistoryName,
        page,
        progress: Math.min(Math.max(progress, 0), 100),
        client_read_at: new Date().toISOString(),
      };
      historyApi.add(entry, { keepalive: true, timeoutMs: 5_000 })
        .then((result) => {
          if (result?.stale) return;
          upsertHistoryCache(entry);
        })
        .catch(() => {});
    };

    const onVisibilityChange = () => {
      if (document.hidden) flushHistory();
    };

    window.addEventListener('pagehide', flushHistory);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushHistory);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    isLoggedIn,
    id,
    safeMangaSlug,
    totalPages,
    store.mode,
    store.currentPage,
    visiblePage,
    scrollProgress,
    mangaTitle,
    mangaThumb,
    chapterHistoryName,
    upsertHistoryCache,
    hasMeaningfulHistoryProgress,
  ]);

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
  useEffect(() => {
    if (!pages.length) return;
    const mode = imageLoadingMode;

    const preloadImageUrl = (url: string, priority: 'high' | 'low') => {
      if (!url || preloadedRef.current.has(url)) return;
      preloadedRef.current.add(url);
      const img = new Image();
      img.fetchPriority = priority;
      img.src = url;
    };

    const preloadUrls = (urls: string[], highPriorityCount = 0) => {
      urls.forEach((url, index) => {
        preloadImageUrl(url, index < highPriorityCount ? 'high' : 'low');
        preloadImageUrl(getChapterPageFallback(url), 'low');
      });
    };

    const eagerCount = mode === 'aggressive' ? 12 : mode === 'standard' ? 2 : 8;

    // Keep bandwidth focused on the current reading area instead of queueing
    // the whole chapter and delaying images the user is actively viewing.
    preloadUrls(pages.slice(0, eagerCount), mode === 'aggressive' ? 5 : 3);
  }, [pages, imageLoadingMode]);

  // ─── Preload pages around the currently visible page ───
  useEffect(() => {
    if (!pages.length) return;
    const mode = imageLoadingMode;
    const AHEAD = mode === 'aggressive' ? 20 : mode === 'standard' ? 4 : 12;
    const HIGH_PRIORITY_AHEAD = mode === 'aggressive' ? 6 : 4;
    const start = visiblePage + 1;
    const end = Math.min(visiblePage + AHEAD + 1, pages.length);
    const preloadImageUrl = (url: string, priority: 'high' | 'low') => {
      if (!url || preloadedRef.current.has(url)) return;
      preloadedRef.current.add(url);
      const img = new Image();
      img.fetchPriority = priority;
      img.src = url;
    };
    for (let i = start; i < end; i++) {
      const url = pages[i];
      preloadImageUrl(url, i <= visiblePage + HIGH_PRIORITY_AHEAD ? 'high' : 'low');
      preloadImageUrl(getChapterPageFallback(url), 'low');
    }
  }, [visiblePage, pages, imageLoadingMode]);

  // ─── Eager prefetch next chapter right after current chapter is ready ───
  useEffect(() => {
    if (imageLoadingMode === 'standard') return;
    if (prefetchTriggeredRef.current || !nextChapter) return;
    prefetchTriggeredRef.current = true;
    const nextChapterId = normalizeMangaDexId(nextChapter.id) || nextChapter.id;
    const isMangaDexNextChapter = !!normalizeMangaDexId(nextChapter.id);
    queryClient.prefetchQuery({
      queryKey: ['manga', 'chapter', nextChapterId],
      queryFn: async () => {
        const prefetched = await prefetchChapterData(nextChapterId);
        const pages = prefetched.pages;
        const eagerPages = pages.slice(0, imageLoadingMode === 'aggressive' ? 10 : 5);
        eagerPages.forEach((url, index) => {
          if (!url) return;
          const priority = index <= (imageLoadingMode === 'aggressive' ? 3 : 1) ? 'high' : 'low';
          if (!preloadedRef.current.has(url)) {
            preloadedRef.current.add(url);
            const img = new Image();
            img.fetchPriority = priority;
            img.src = url;
          }
          const fallbackUrl = getChapterPageFallback(url);
          if (fallbackUrl && !preloadedRef.current.has(fallbackUrl)) {
            preloadedRef.current.add(fallbackUrl);
            const fallbackImg = new Image();
            fallbackImg.fetchPriority = 'low';
            fallbackImg.src = fallbackUrl;
          }
        });
        return prefetched;
      },
      staleTime: isMangaDexNextChapter ? 30 * 1000 : 60 * 60 * 1000,
    });
  }, [nextChapter, queryClient, prefetchChapterData, imageLoadingMode]);

  // ─── Prefetch one-more chapter when near end ───
  useEffect(() => {
    if (imageLoadingMode === 'standard') return;
    if (!nextNextChapter || totalPages === 0) return;
    const threshold = imageLoadingMode === 'aggressive'
      ? Math.max(Math.floor(totalPages * 0.6), totalPages - 8)
      : Math.max(Math.floor(totalPages * 0.75), totalPages - 5);
    if (visiblePage >= threshold) {
      const nextNextChapterId = normalizeMangaDexId(nextNextChapter.id) || nextNextChapter.id;
      const isMangaDexNextNextChapter = !!normalizeMangaDexId(nextNextChapter.id);
      queryClient.prefetchQuery({
        queryKey: ['manga', 'chapter', nextNextChapterId],
        queryFn: () => prefetchChapterData(nextNextChapterId),
        staleTime: isMangaDexNextNextChapter ? 30 * 1000 : 60 * 60 * 1000,
      });
    }
  }, [visiblePage, totalPages, nextNextChapter, queryClient, prefetchChapterData, imageLoadingMode]);

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
  const currentHorizontalPage = pages[store.currentPage] || '';
  const horizontalFallbackPage = getChapterPageFallback(currentHorizontalPage) || getMangaDexImageFallback(currentHorizontalPage);
  const activeHorizontalPage =
    horizontalUseFallback && horizontalFallbackPage
      ? horizontalFallbackPage
      : currentHorizontalPage;
  const horizontalPageSrc = horizontalRetryCount > 0
    ? `${activeHorizontalPage}${activeHorizontalPage.includes('?') ? '&' : '?'}retry=${horizontalRetryCount}`
    : activeHorizontalPage;

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
              <motion.img key={store.currentPage} initial={{ opacity: 0, x: store.pageDirection === 'rtl' ? -20 : 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                src={horizontalPageSrc} alt={`Trang ${store.currentPage + 1}`}
                className={`select-none ${store.imageFit === 'height' ? 'max-h-screen max-w-full w-auto h-auto' : store.imageFit === 'width' ? 'w-full max-w-4xl h-auto' : 'max-h-[90vh] max-w-full'} object-contain mx-auto`}
                draggable={false}
                onLoad={() => setHorizontalLoaded(true)}
                onError={() => {
                  if (!horizontalUseFallback && horizontalFallbackPage) {
                    setHorizontalUseFallback(true);
                    setHorizontalRetryCount(0);
                    setHorizontalLoaded(false);
                    return;
                  }
                  setHorizontalRetryCount((prev) => (prev >= 3 ? prev : prev + 1));
                }} />
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
                priority={i < 8}
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
