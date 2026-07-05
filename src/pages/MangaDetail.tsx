import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useMangaDetail, useIsBookmarked, useIsFollowing, useToggleBookmark, useToggleFollow, useHistory, useRateManga } from '@/hooks/useApi';
import { useUserStore } from '@/store/userStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ratingApi, uploadApi } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import ChapterList from '@/components/manga/ChapterList';
import RatingStars from '@/components/manga/RatingStars';
import CommentSection from '@/components/manga/CommentSection';
import TagBadge from '@/components/manga/TagBadge';
import { isMatureManga } from '@/lib/contentFilter';
import { motion } from 'framer-motion';
import { Heart, Bookmark, Eye, Users, Calendar, BookOpen, UsersRound, Loader2, EyeOff, ShieldAlert, ArrowLeft, AlertTriangle, StickyNote, Languages } from 'lucide-react';
import OptimizedImage from '@/components/ui/OptimizedImage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ChapterTranslationSource, Manga } from '@/types/manga';
import { getMangaDetailPath, resolveMangaRoute } from '@/lib/mangaLinks';

const statusVi: Record<string, string> = {
  ongoing: 'Đang ra',
  completed: 'Hoàn thành',
  hiatus: 'Sắp ra mắt',
  cancelled: 'Đã huỷ',
};

function decodeHtmlEntities(value: string): string {
  if (typeof window === 'undefined') return value;
  const textarea = window.document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeDescriptionText(value: string): string {
  let text = String(value || '');
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  for (let i = 0; i < 3; i += 1) {
    const decoded = decodeHtmlEntities(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collapseSeoText(value: unknown, maxLength = 160): string {
  const text = normalizeDescriptionText(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function absoluteSeoUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return window.location.origin;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${window.location.origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function upsertMeta(selector: string, attrs: Record<string, string>): () => void {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  const wasCreated = !element;
  if (!element) {
    element = document.createElement('meta');
    document.head.appendChild(element);
  }
  const previousAttrs = Object.fromEntries(
    Object.keys(attrs).map((key) => [key, element?.getAttribute(key)]),
  ) as Record<string, string | null>;
  Object.entries(attrs).forEach(([key, value]) => {
    element?.setAttribute(key, value);
  });
  element.setAttribute('data-mangahub-runtime-seo', 'manga-detail');
  return () => {
    if (!element) return;
    if (wasCreated) {
      element.remove();
      return;
    }
    Object.entries(previousAttrs).forEach(([key, value]) => {
      if (value === null) {
        element?.removeAttribute(key);
      } else {
        element?.setAttribute(key, value);
      }
    });
    element.removeAttribute('data-mangahub-runtime-seo');
  };
}

const MANGADEX_LANGUAGE_LABELS: Record<string, string> = {
  all: 'Tất cả ngôn ngữ',
  vi: 'Tiếng Việt',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  'zh-hk': 'Chinese (HK)',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  'es-la': 'Español LATAM',
  pt: 'Português',
  'pt-br': 'Português BR',
  id: 'Indonesia',
  th: 'Thai',
  ru: 'Russian',
  it: 'Italian',
  pl: 'Polish',
  tr: 'Turkish',
  uk: 'Ukrainian',
  sl: 'Slovenian',
  nl: 'Nederlands',
  cs: 'Czech',
  ar: 'Arabic',
};

const MANGADEX_ALL_GROUPS_VALUE = '__all_groups__';
const TRANSLATION_SOURCE_ALL_VALUE = 'all';
const TRANSLATION_SOURCE_MANGADEX_VALUE = 'mangadex';
const TRANSLATION_SOURCE_LOCAL_VALUE = 'local';
const DEFAULT_DOCUMENT_TITLE = 'MangaHub - Đọc Truyện Tranh Online Miễn Phí';
const DEFAULT_DOCUMENT_DESCRIPTION = 'Đọc hàng ngàn bộ truyện tranh miễn phí trên MangaHub.';
const LOCAL_TRANSLATION_SOURCE_LABEL = 'Bản dịch web';

type TranslationSourceFilter =
  | typeof TRANSLATION_SOURCE_ALL_VALUE
  | typeof TRANSLATION_SOURCE_MANGADEX_VALUE
  | typeof TRANSLATION_SOURCE_LOCAL_VALUE;

type ChapterGroupOption = {
  id: string;
  name: string;
  count: number;
  source: Exclude<ChapterTranslationSource, 'otruyen'>;
  sourceLabel: string;
};

function formatMangaDexLanguageLabel(language: string): string {
  const code = String(language || '').trim().toLowerCase();
  if (!code) return '';
  return MANGADEX_LANGUAGE_LABELS[code] || code.toUpperCase();
}

function normalizeMangaDexChapterTitle(chapter: Manga['chapters'][number]): string {
  const title = String(chapter.title || '').trim();
  if (!title) return '';
  if (/^Ch(?:apter|ương)\s+/i.test(title) && String(chapter.scanlationGroup || '').trim()) {
    return '';
  }
  return title;
}

function getMangaDexGroupKey(group: { id?: string; name?: string } | undefined): string {
  const id = String(group?.id || '').trim();
  if (id) return id;
  return String(group?.name || '').trim().toLowerCase();
}

function normalizeSourceGroupKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function getChapterTranslationSource(chapter: Manga['chapters'][number]): ChapterTranslationSource {
  if (chapter.translationSource) return chapter.translationSource;
  if (chapter.isUserUpload) return TRANSLATION_SOURCE_LOCAL_VALUE;
  if (chapter.translatedLanguage || (chapter.scanlationGroups || []).length > 0) {
    return TRANSLATION_SOURCE_MANGADEX_VALUE;
  }
  return 'otruyen';
}

function getChapterTranslationSourceLabel(chapter: Manga['chapters'][number]): string {
  const label = String(chapter.translationSourceLabel || '').trim();
  if (label) return label;
  const source = getChapterTranslationSource(chapter);
  if (source === TRANSLATION_SOURCE_MANGADEX_VALUE) return 'MangaDex';
  if (source === TRANSLATION_SOURCE_LOCAL_VALUE) return LOCAL_TRANSLATION_SOURCE_LABEL;
  return '';
}

function getChapterGroupOptions(chapter: Manga['chapters'][number]): ChapterGroupOption[] {
  const source = getChapterTranslationSource(chapter);
  if (source === TRANSLATION_SOURCE_LOCAL_VALUE) {
    const name = String(chapter.scanlationGroup || '').trim() || LOCAL_TRANSLATION_SOURCE_LABEL;
    return [{
      id: `${TRANSLATION_SOURCE_LOCAL_VALUE}:${normalizeSourceGroupKey(name) || 'web'}`,
      name,
      count: 1,
      source: TRANSLATION_SOURCE_LOCAL_VALUE,
      sourceLabel: getChapterTranslationSourceLabel(chapter),
    }];
  }

  if (source !== TRANSLATION_SOURCE_MANGADEX_VALUE) return [];

  const groups = (chapter.scanlationGroups || [])
    .map((group) => {
      const key = getMangaDexGroupKey(group);
      if (!key) return null;
      return {
        id: `${TRANSLATION_SOURCE_MANGADEX_VALUE}:${key}`,
        name: String(group.name || '').trim() || key,
        count: 1,
        source: TRANSLATION_SOURCE_MANGADEX_VALUE,
        sourceLabel: getChapterTranslationSourceLabel(chapter),
      } satisfies ChapterGroupOption;
    })
    .filter((group): group is ChapterGroupOption => Boolean(group));

  if (groups.length > 0) return groups;

  const fallbackName = String(chapter.scanlationGroup || '').trim();
  if (!fallbackName) return [];
  return [{
    id: `${TRANSLATION_SOURCE_MANGADEX_VALUE}:${normalizeSourceGroupKey(fallbackName)}`,
    name: fallbackName,
    count: 1,
    source: TRANSLATION_SOURCE_MANGADEX_VALUE,
    sourceLabel: getChapterTranslationSourceLabel(chapter),
  }];
}

function toReaderChapterState(chapter: Manga['chapters'][number]) {
  return {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    scanlationGroup: chapter.scanlationGroup,
    translationSource: chapter.translationSource,
    translationSourceLabel: chapter.translationSourceLabel,
    scanlationGroups: chapter.scanlationGroups,
    translatedLanguage: chapter.translatedLanguage,
    isUserUpload: chapter.isUserUpload,
  };
}

function toReaderChapterSourceFilter(translationSource: TranslationSourceFilter, groupId: string): string {
  const normalizedGroupId = String(groupId || '').trim();
  if (normalizedGroupId) {
    const [maybeSource, ...rest] = normalizedGroupId.split(':');
    const source = maybeSource === TRANSLATION_SOURCE_LOCAL_VALUE || maybeSource === TRANSLATION_SOURCE_MANGADEX_VALUE
      ? maybeSource
      : translationSource === TRANSLATION_SOURCE_LOCAL_VALUE
        ? TRANSLATION_SOURCE_LOCAL_VALUE
        : TRANSLATION_SOURCE_MANGADEX_VALUE;
    const key = rest.length > 0 ? rest.join(':') : normalizedGroupId;
    return `group:${source}:${normalizeSourceGroupKey(key)}`;
  }
  if (translationSource === TRANSLATION_SOURCE_MANGADEX_VALUE) return `source:${TRANSLATION_SOURCE_MANGADEX_VALUE}`;
  if (translationSource === TRANSLATION_SOURCE_LOCAL_VALUE) return `source:${TRANSLATION_SOURCE_LOCAL_VALUE}`;
  return '__all_sources__';
}

const MangaDetail = () => {
  // Keep first payload lean so detail page renders quickly, then load the full list in background.
  const MANGADEX_FAST_CHAPTER_LIMIT = 100;
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [canToggleDescription, setCanToggleDescription] = useState(false);
  const [showMatureGateDialog, setShowMatureGateDialog] = useState(false);
  const [matureAccessGranted, setMatureAccessGranted] = useState(false);
  const [mangaDexLanguage, setMangaDexLanguage] = useState('vi');
  const [mangaDexGroupId, setMangaDexGroupId] = useState('');
  const [translationSource, setTranslationSource] = useState<TranslationSourceFilter>(
    TRANSLATION_SOURCE_MANGADEX_VALUE,
  );
  const { source: routeSource, id: routeId } = useParams<{ source?: string; id?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const mangaRoute = useMemo(
    () => resolveMangaRoute(routeSource, routeId),
    [routeSource, routeId],
  );
  const normalizedSlug = mangaRoute.identifier;
  const previewManga = useMemo(() => {
    const state = (location.state || {}) as { previewManga?: Manga };
    const preview = state.previewManga;
    if (!preview) return null;
    const previewPath = getMangaDetailPath(preview.id || preview.slug, preview.source);
    const previewSlug = String(preview.slug || '').trim().toLowerCase();
    const expectedId = String(normalizedSlug || '').trim().toLowerCase();
    if (!expectedId) return null;
    if (previewPath !== mangaRoute.canonicalPath && previewSlug !== expectedId) return null;
    return preview;
  }, [location.state, mangaRoute.canonicalPath, normalizedSlug]);
  // Detect MangaDex manga by UUID format
  const isMangaDex = mangaRoute.source === 'mangadex';
  const detailQueryIdentifier =
    !isMangaDex && previewManga?.slug ? previewManga.slug : normalizedSlug;
  const activeMangaDexLanguage = isMangaDex ? mangaDexLanguage : 'vi';
  const fastDetailQuery = useMangaDetail(detailQueryIdentifier, {
    maxMangaDexChapters: isMangaDex ? MANGADEX_FAST_CHAPTER_LIMIT : 'all',
    mangaDexLanguage: activeMangaDexLanguage,
  });
  const shouldLoadFullMangaDex =
    isMangaDex &&
    !!fastDetailQuery.data &&
    (fastDetailQuery.data.chapters?.length || 0) >= MANGADEX_FAST_CHAPTER_LIMIT;
  const fullDetailQuery = useMangaDetail(normalizedSlug, {
    enabled: shouldLoadFullMangaDex,
    maxMangaDexChapters: 'all',
    mangaDexLanguage: activeMangaDexLanguage,
  });
  const languageCatalogQuery = useMangaDetail(normalizedSlug, {
    enabled: isMangaDex && activeMangaDexLanguage !== 'all',
    maxMangaDexChapters: MANGADEX_FAST_CHAPTER_LIMIT,
    mangaDexLanguage: 'all',
  });
  const fetchedManga = isMangaDex
    ? (fullDetailQuery.data || fastDetailQuery.data)
    : fastDetailQuery.data;
  const languageCatalogManga = activeMangaDexLanguage === 'all'
    ? fetchedManga
    : languageCatalogQuery.data;
  const manga = fetchedManga || previewManga;
  const isLoading = !manga && fastDetailQuery.isLoading;
  const error = fastDetailQuery.error && !fetchedManga ? fastDetailQuery.error : null;
  const isLoadingFullMangaDex = shouldLoadFullMangaDex && fullDetailQuery.isFetching && !fullDetailQuery.data;
  const { isLoggedIn, user, isRestoringSession } = useUserStore();
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const detailReadySlug = manga ? (manga.slug || manga.id || '') : '';
  const canUseUserMangaState = isLoggedIn && !!user && !isRestoringSession && !!detailReadySlug;
  const { data: history = [] } = useHistory({
    enabled: canUseUserMangaState && !!manga,
    enrichThumbs: false,
  });

  // Fetch user-uploaded published chapters for this manga
  const { data: uploadedChaptersData } = useQuery({
    queryKey: ['uploads', 'published', detailReadySlug],
    queryFn: () => uploadApi.getPublishedChapters(detailReadySlug),
    enabled: !!detailReadySlug && !!manga,
    staleTime: 2 * 60 * 1000,
  });

  const { data: isBookmarked = false } = useIsBookmarked(detailReadySlug, canUseUserMangaState);
  const { data: isFollowed = false } = useIsFollowing(detailReadySlug, canUseUserMangaState);
  const toggleBookmark = useToggleBookmark();
  const toggleFollow = useToggleFollow();
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);

  const { data: ratingData } = useQuery({
    queryKey: ['rating', detailReadySlug],
    queryFn: () => ratingApi.getMangaRating(detailReadySlug),
    enabled: !!detailReadySlug && !!manga,
    staleTime: 5 * 60 * 1000,
  });
  const { data: myRatingData } = useQuery({
    queryKey: ['rating', 'me', detailReadySlug],
    queryFn: () => ratingApi.getMyRating(detailReadySlug),
    enabled: !!detailReadySlug && canUseUserMangaState && !!manga,
  });
  const qc = useQueryClient();
  const rateManga = useRateManga();
  const realRating = ratingData?.average || manga?.rating || 0;
  const realRatingCount = ratingData?.count || 0;
  const rawDescription = manga?.description ?? '';
  const description = useMemo(
    () => normalizeDescriptionText(String(rawDescription)),
    [rawDescription],
  );
  useEffect(() => {
    if (!manga) return;

    const title = String(manga.title || '').trim() || 'MangaHub';
    const seoTitle = `${title} - MangaHub`;
    const seoDescription =
      collapseSeoText(description) ||
      (title === 'MangaHub'
        ? DEFAULT_DOCUMENT_DESCRIPTION
        : `Đọc ${title} miễn phí trên MangaHub.`);
    const canonicalUrl = absoluteSeoUrl(mangaRoute.canonicalPath || location.pathname);
    const imageUrl = absoluteSeoUrl(String(manga.cover || manga.coverProxy || '/no-cover.svg'));
    const previousTitle = document.title;
    const existingCanonicalLink = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const canonicalLink = existingCanonicalLink || document.head.appendChild(document.createElement('link'));
    const canonicalWasCreated = !existingCanonicalLink;
    const previousCanonical = canonicalLink.getAttribute('href') || '';

    canonicalLink.setAttribute('rel', 'canonical');
    canonicalLink.setAttribute('href', canonicalUrl);
    canonicalLink.setAttribute('data-mangahub-runtime-seo', 'manga-detail');
    document.title = seoTitle;

    const cleanupMeta = [
      upsertMeta('meta[name="description"]', {
        name: 'description',
        content: seoDescription,
      }),
      upsertMeta('meta[name="robots"]', {
        name: 'robots',
        content: 'index, follow, max-image-preview:large',
      }),
      upsertMeta('meta[property="og:site_name"]', {
        property: 'og:site_name',
        content: 'MangaHub',
      }),
      upsertMeta('meta[property="og:type"]', {
        property: 'og:type',
        content: 'article',
      }),
      upsertMeta('meta[property="og:locale"]', {
        property: 'og:locale',
        content: 'vi_VN',
      }),
      upsertMeta('meta[property="og:title"]', {
        property: 'og:title',
        content: seoTitle,
      }),
      upsertMeta('meta[property="og:description"]', {
        property: 'og:description',
        content: seoDescription,
      }),
      upsertMeta('meta[property="og:url"]', {
        property: 'og:url',
        content: canonicalUrl,
      }),
      upsertMeta('meta[property="og:image"]', {
        property: 'og:image',
        content: imageUrl,
      }),
      upsertMeta('meta[name="twitter:card"]', {
        name: 'twitter:card',
        content: 'summary_large_image',
      }),
      upsertMeta('meta[name="twitter:title"]', {
        name: 'twitter:title',
        content: seoTitle,
      }),
      upsertMeta('meta[name="twitter:description"]', {
        name: 'twitter:description',
        content: seoDescription,
      }),
      upsertMeta('meta[name="twitter:image"]', {
        name: 'twitter:image',
        content: imageUrl,
      }),
    ];

    return () => {
      document.title = previousTitle || DEFAULT_DOCUMENT_TITLE;
      if (canonicalWasCreated) {
        canonicalLink.remove();
      } else if (previousCanonical) {
        canonicalLink.setAttribute('href', previousCanonical);
      } else {
        canonicalLink.setAttribute('href', window.location.origin);
      }
      canonicalLink.removeAttribute('data-mangahub-runtime-seo');
      cleanupMeta.reverse().forEach((cleanup) => cleanup());
    };
  }, [description, location.pathname, manga, mangaRoute.canonicalPath]);
  const adminNote = useMemo(
    () => normalizeDescriptionText(String(manga?.adminNotes || '')),
    [manga?.adminNotes],
  );
  const blockedByMatureFilter = !!manga && !showMatureContent && !matureAccessGranted && isMatureManga(manga);

  const handleBackFromHidden = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate('/manga', { replace: true });
  };

  useEffect(() => {
    if (!normalizedSlug || mangaRoute.isCanonical) return;
    navigate(mangaRoute.canonicalPath, { replace: true, state: location.state });
  }, [normalizedSlug, mangaRoute.isCanonical, mangaRoute.canonicalPath, location.state, navigate]);

  useEffect(() => {
    const canonicalId = String(manga?.id || '').trim();
    if (!canonicalId) return;
    const canonicalPath = getMangaDetailPath(canonicalId, manga?.source);
    if (location.pathname === canonicalPath) return;
    navigate(canonicalPath, {
      replace: true,
      state: { ...(location.state || {}), previewManga: manga },
    });
  }, [manga, location.pathname, location.state, navigate]);

  useEffect(() => {
    setIsDescExpanded(false);
  }, [normalizedSlug, description]);

  useEffect(() => {
    // Do not persist bypass across reloads: show warning again every page refresh
    // when mature content is disabled.
    setMatureAccessGranted(false);
  }, [normalizedSlug, showMatureContent]);

  useEffect(() => {
    if (!manga || !normalizedSlug) return;
    setShowMatureGateDialog(blockedByMatureFilter);
  }, [manga, normalizedSlug, blockedByMatureFilter]);

  const handleMatureAllow = () => {
    setMatureAccessGranted(true);
    setShowMatureGateDialog(false);
  };

  const handleMatureCancel = () => {
    setShowMatureGateDialog(false);
    navigate('/manga', { replace: true });
  };

  useEffect(() => {
    const measure = () => {
      const el = descriptionRef.current;
      if (!el) {
        setCanToggleDescription(false);
        return;
      }
      const width = el.clientWidth;
      if (!width) {
        setCanToggleDescription(false);
        return;
      }
      const clone = el.cloneNode(true) as HTMLParagraphElement;
      clone.className = 'text-sm text-muted-foreground leading-relaxed line-clamp-4 md:line-clamp-5';
      clone.style.position = 'absolute';
      clone.style.visibility = 'hidden';
      clone.style.pointerEvents = 'none';
      clone.style.width = `${width}px`;
      clone.style.left = '-99999px';
      clone.style.top = '0';
      clone.style.height = 'auto';
      window.document.body.appendChild(clone);
      const needsToggle = clone.scrollHeight - clone.clientHeight > 1;
      window.document.body.removeChild(clone);
      setCanToggleDescription(needsToggle);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [description]);

  const mergedChapters = useMemo(() => {
    const base = (manga?.chapters || []).map((chapter) => (
      isMangaDex
        ? {
            ...chapter,
            title: normalizeMangaDexChapterTitle(chapter),
            translationSource: chapter.translationSource || TRANSLATION_SOURCE_MANGADEX_VALUE,
            translationSourceLabel: chapter.translationSourceLabel || 'MangaDex',
          }
        : chapter
    ));
    const uploadedRaw = uploadedChaptersData?.chapters || [];
    if (!manga || !uploadedRaw.length) return base;

    const existingIds = new Set(base.map(ch => ch.id));
    for (const up of uploadedRaw) {
      if (existingIds.has(up.id)) continue;
      base.push({
        id: `upload-${up.id}`,
        mangaId: up.manga_slug || detailReadySlug,
        number: up.chapter_number ?? 0,
        title: up.chapter_title || `Chương ${up.chapter_number}`,
        pages: up.pages || [],
        uploadDate: up.published_at || up.created_at || '',
        scanlationGroup: up.profiles?.display_name || up.profiles?.username || 'User Upload',
        translationSource: TRANSLATION_SOURCE_LOCAL_VALUE,
        translationSourceLabel: String(up.translation_source_label || '').trim() || LOCAL_TRANSLATION_SOURCE_LABEL,
        isUserUpload: true,
      } as any);
    }
    return base.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }, [
    manga,
    uploadedChaptersData,
    detailReadySlug,
    isMangaDex,
  ]);

  const mangaDexLanguageOptions = useMemo(() => {
    if (!isMangaDex) return [];
    const seen = new Set<string>();
    const add = (value: unknown) => {
      const code = String(value || '').trim().toLowerCase();
      if (code) seen.add(code);
    };
    add(activeMangaDexLanguage);
    for (const sourceManga of [manga, languageCatalogManga]) {
      (sourceManga?.availableTranslatedLanguages || []).forEach(add);
      (sourceManga?.chapters || []).forEach((chapter) => add(chapter.translatedLanguage));
    }
    return Array.from(seen).sort((a, b) => {
      if (a === activeMangaDexLanguage) return -1;
      if (b === activeMangaDexLanguage) return 1;
      return formatMangaDexLanguageLabel(a).localeCompare(formatMangaDexLanguageLabel(b));
    });
  }, [activeMangaDexLanguage, isMangaDex, languageCatalogManga, manga]);

  const translationSourceOptions = useMemo(() => {
    if (!isMangaDex) return [];
    const counts = new Map<TranslationSourceFilter, number>();
    for (const chapter of mergedChapters) {
      const source = getChapterTranslationSource(chapter);
      if (source === TRANSLATION_SOURCE_MANGADEX_VALUE || source === TRANSLATION_SOURCE_LOCAL_VALUE) {
        counts.set(source, (counts.get(source) || 0) + 1);
      }
    }
    const mangaDexCount = counts.get(TRANSLATION_SOURCE_MANGADEX_VALUE) || 0;
    const localCount = counts.get(TRANSLATION_SOURCE_LOCAL_VALUE) || 0;
    const options: Array<{ id: TranslationSourceFilter; label: string; count: number }> = [];
    if (mangaDexCount > 0 && localCount > 0) {
      options.push({
        id: TRANSLATION_SOURCE_ALL_VALUE,
        label: 'Tất cả nguồn',
        count: mangaDexCount + localCount,
      });
    }
    if (mangaDexCount > 0) {
      options.push({
        id: TRANSLATION_SOURCE_MANGADEX_VALUE,
        label: 'MangaDex',
        count: mangaDexCount,
      });
    }
    if (localCount > 0) {
      options.push({
        id: TRANSLATION_SOURCE_LOCAL_VALUE,
        label: LOCAL_TRANSLATION_SOURCE_LABEL,
        count: localCount,
      });
    }
    return options;
  }, [isMangaDex, mergedChapters]);

  const selectedTranslationSourceOption = useMemo(
    () => translationSourceOptions.find((option) => option.id === translationSource),
    [translationSource, translationSourceOptions],
  );

  const sourceFilteredChapters = useMemo(() => {
    if (!isMangaDex || translationSource === TRANSLATION_SOURCE_ALL_VALUE) return mergedChapters;
    return mergedChapters.filter((chapter) => getChapterTranslationSource(chapter) === translationSource);
  }, [isMangaDex, mergedChapters, translationSource]);

  const mangaDexGroupOptions = useMemo(() => {
    if (!isMangaDex) return [];
    const groups = new Map<string, ChapterGroupOption>();
    for (const chapter of sourceFilteredChapters) {
      for (const group of getChapterGroupOptions(chapter)) {
        const existing = groups.get(group.id);
        if (existing) {
          existing.count += 1;
          continue;
        }
        groups.set(group.id, { ...group });
      }
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [isMangaDex, sourceFilteredChapters]);

  const visibleChapters = useMemo(() => {
    if (!isMangaDex || !mangaDexGroupId) return sourceFilteredChapters;
    return sourceFilteredChapters.filter((chapter) => (
      getChapterGroupOptions(chapter).some((group) => group.id === mangaDexGroupId)
    ));
  }, [isMangaDex, mangaDexGroupId, sourceFilteredChapters]);
  const readerChapterSourceFilter = useMemo(
    () => toReaderChapterSourceFilter(translationSource, mangaDexGroupId),
    [mangaDexGroupId, translationSource]
  );

  useEffect(() => {
    if (!isMangaDex) return;
    setTranslationSource(TRANSLATION_SOURCE_MANGADEX_VALUE);
    setMangaDexGroupId('');
  }, [isMangaDex, normalizedSlug]);

  useEffect(() => {
    setMangaDexGroupId('');
  }, [activeMangaDexLanguage, normalizedSlug, translationSource]);

  useEffect(() => {
    if (!isMangaDex || translationSourceOptions.length === 0) return;
    if (translationSourceOptions.some((option) => option.id === translationSource)) return;
    const preferred =
      translationSourceOptions.find((option) => option.id === TRANSLATION_SOURCE_MANGADEX_VALUE) ||
      translationSourceOptions[0];
    setTranslationSource(preferred.id);
  }, [isMangaDex, translationSource, translationSourceOptions]);

  useEffect(() => {
    if (!mangaDexGroupId) return;
    if (mangaDexGroupOptions.some((group) => group.id === mangaDexGroupId)) return;
    setMangaDexGroupId('');
  }, [mangaDexGroupId, mangaDexGroupOptions]);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
      </div>
    );
  }

  if (error) {
    const errMsg = (error as Error).message || '';
    const isHidden = errMsg.startsWith('MANGA_HIDDEN::');
    const hiddenReason = isHidden ? errMsg.slice('MANGA_HIDDEN::'.length) : '';

    if (isHidden) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center px-4">
          <div className="max-w-md w-full text-center space-y-6">
            {/* Icon */}
            <div className="relative inline-flex">
              <div className="w-24 h-24 rounded-full bg-red-500/10 flex items-center justify-center">
                <EyeOff className="w-12 h-12 text-red-400" />
              </div>
              <div className="absolute -top-1 -right-1 w-8 h-8 rounded-full bg-red-500 flex items-center justify-center">
                <ShieldAlert className="w-4 h-4 text-white" />
              </div>
            </div>

            {/* Title */}
            <div>
              <h1 className="text-2xl font-black text-foreground mb-2">Truyện đã bị ẩn</h1>
              <p className="text-sm text-muted-foreground">
                Nội dung này đã bị quản trị viên ẩn khỏi nền tảng.
              </p>
            </div>

            {/* Reason box */}
            {hiddenReason && (
              <div className="bg-red-500/8 border border-red-500/20 rounded-2xl p-4 text-left">
                <p className="text-xs font-bold text-red-400 mb-1 uppercase tracking-wide">Lý do</p>
                <p className="text-sm text-foreground/80">{hiddenReason}</p>
              </div>
            )}

            {/* Slug info */}
            <div className="bg-secondary/40 rounded-xl px-4 py-2 inline-block">
              <p className="text-[11px] font-mono text-muted-foreground">{normalizedSlug}</p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={handleBackFromHidden}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-secondary hover:bg-secondary/80 text-sm font-semibold transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Quay lại
              </button>
              <Link
                to="/"
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/80 transition-colors"
              >
                <BookOpen className="w-4 h-4" /> Trang chủ
              </Link>
            </div>
          </div>
        </div>
      );
    }

    // Generic not-found
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <BookOpen className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground font-medium">Không tìm thấy truyện này.</p>
      </div>
    );
  }

  if (!manga) {
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <BookOpen className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground font-medium">Không tìm thấy truyện này.</p>
      </div>
    );
  }

  const latestHistory = history
    .filter((h: any) => h?.manga_slug === detailReadySlug)
    .sort((a: any, b: any) => new Date(b.read_at || b.created_at || 0).getTime() - new Date(a.read_at || a.created_at || 0).getTime())[0];

  const resumeChapter = latestHistory?.chapter_id
    ? visibleChapters.find(ch => ch.id === latestHistory.chapter_id)
    : undefined;

  // Deduplicate chapters by number (same logic as ChapterList) — keep first/primary per number
  const dedupedChapters = (() => {
    const byNumber = [...visibleChapters].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const seen = new Map<number, typeof visibleChapters[0]>();
    for (const ch of byNumber) {
      const num = ch.number ?? 0;
      if (!seen.has(num)) seen.set(num, ch);
    }
    return Array.from(seen.values());
  })();

  // First chapter = chapter with the smallest number (sorted ascending)
  const firstChapter = dedupedChapters[0];

  // "Đọc ngay": go to saved progress if any, otherwise always start from chapter 1
  const startChapter = resumeChapter || firstChapter;
  const chapterMap = Object.fromEntries(
    manga.chapters.map((ch) => [ch.id, `Chương ${ch.number}`])
  );

  const handleToggleFollow = () => {
    if (!canUseUserMangaState) { navigate('/login'); return; }
    toggleFollow.mutate({ slug: detailReadySlug, title: manga.title, thumb: manga.cover, isFollowing: isFollowed });
  };

  const handleToggleBookmark = () => {
    if (!canUseUserMangaState) { navigate('/login'); return; }
    toggleBookmark.mutate({ slug: detailReadySlug, title: manga.title, thumb: manga.cover, isBookmarked });
  };

  return (
    <div className="min-h-screen -mt-16 pt-0">
      {/* Banner */}
      <div className="relative h-64 md:h-80 overflow-hidden">
        <OptimizedImage src={manga.cover} alt="" className="w-full h-full object-cover blur-xl scale-110 opacity-30" priority />
        <div className="absolute inset-0 bg-gradient-to-b from-background/50 to-background" />
        <div className="absolute inset-0 comic-dots" />
      </div>

      <div className="container mx-auto px-4 -mt-48 md:-mt-56 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row gap-6"
        >
          {/* Cover */}
          <motion.div
            initial={{ rotate: -2 }}
            animate={{ rotate: 1 }}
            className="w-48 md:w-56 shrink-0 mx-auto md:mx-0"
          >
            <OptimizedImage src={manga.cover} alt={manga.title} className="w-full aspect-[3/4] object-cover rounded-xl comic-border-accent" priority />
          </motion.div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-3xl font-comic tracking-wide mb-1">{manga.title}</h1>
            {manga.altTitle && <p className="text-sm text-muted-foreground mb-3 italic">{manga.altTitle}</p>}

            <RatingStars
              rating={realRating}
              count={realRatingCount}
              size="md"
              mangaSlug={detailReadySlug}
              interactive={isLoggedIn}
              userScore={myRatingData?.score}
              onRated={() => {
                qc.invalidateQueries({ queryKey: ['rating', detailReadySlug] });
                qc.invalidateQueries({ queryKey: ['rating', 'me', detailReadySlug] });
                qc.invalidateQueries({ queryKey: ['rating', 'batch'] });
                qc.invalidateQueries({ queryKey: ['manga', 'list'] });
                qc.invalidateQueries({ queryKey: ['manga', 'homepage'] });
              }}
            />

            <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1 font-medium"><Users className="w-4 h-4 text-primary" /> {manga.author}</span>
              <span className="flex items-center gap-1"><Eye className="w-4 h-4" /> {manga.views.toLocaleString()} lượt xem</span>
              <span className="flex items-center gap-1"><Calendar className="w-4 h-4" /> {manga.year}</span>
              <span className={`px-2.5 py-0.5 rounded-lg text-xs font-bold uppercase comic-shadow ${
                manga.status === 'ongoing' ? 'bg-manga-green/20 text-manga-green border border-manga-green/30' :
                manga.status === 'completed' ? 'bg-primary/20 text-primary border border-primary/30' :
                'bg-manga-orange/20 text-manga-orange border border-manga-orange/30'
              }`}>{statusVi[manga.status] || manga.status}</span>
            </div>

            <motion.div
              layout
              transition={{ layout: { duration: 0.28, ease: 'easeInOut' } }}
              className="mt-4 max-w-2xl overflow-hidden"
            >
              <motion.p
                ref={descriptionRef}
                layout
                transition={{ layout: { duration: 0.28, ease: 'easeInOut' } }}
                className={`text-sm text-muted-foreground leading-relaxed ${!isDescExpanded && canToggleDescription ? 'line-clamp-4 md:line-clamp-5' : ''}`}
              >
                {description || '—'}
              </motion.p>
              {canToggleDescription && (
                <button
                  type="button"
                  onClick={() => setIsDescExpanded((v) => !v)}
                  className="mt-1 text-xs font-bold text-primary hover:underline"
                >
                  {isDescExpanded ? 'Thu gọn' : 'Hiển thêm'}
                </button>
              )}
            </motion.div>

            {adminNote && (
              <div className="mt-4 max-w-2xl rounded-xl border border-primary/30 bg-primary/10 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <StickyNote className="w-4 h-4 text-primary" />
                  <p className="text-xs font-bold uppercase tracking-wide text-primary">Ghi chú từ Admin</p>
                </div>
                <p className="text-sm text-foreground/90 whitespace-pre-line leading-relaxed">{adminNote}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5 mt-4">
              {manga.genres.map((g, i) => <TagBadge key={g} tag={g} onClick={() => navigate(`/manga?genre=${encodeURIComponent(manga.tags[i] || g)}`)} />)}
            </div>

            <div className="flex flex-wrap gap-3 mt-6">
              {startChapter && (
                <Link
                  to={`/chapter/${startChapter.id}`}
                  state={{
                    mangaSlug: detailReadySlug,
                    mangaId: manga.id,
                    mangaTitle: manga.title,
                    mangaThumb: manga.cover,
                    chapterNumber: startChapter.number,
                    chapterTitle: startChapter.title,
                    chapters: mergedChapters.map(toReaderChapterState),
                    chapterSourceFilter: readerChapterSourceFilter,
                  }}
                  className="px-5 py-2.5 rounded-xl bg-manga-red text-white font-bold text-sm hover:bg-manga-red/90 transition-colors shadow-lg flex items-center gap-2"
                >
                  <BookOpen className="w-4 h-4" /> {resumeChapter ? 'Đọc tiếp' : 'Đọc ngay'}
                </Link>
              )}
              <button
                onClick={handleToggleFollow}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all border-2 comic-shadow ${
                  isFollowed ? 'bg-manga-red/20 border-manga-red/50 text-manga-red' : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-primary/30'
                }`}
              >
                <Heart className={`w-4 h-4 ${isFollowed ? 'fill-current' : ''}`} />
                {isFollowed ? 'Đang theo dõi' : 'Theo dõi'}
              </button>
              <button
                onClick={handleToggleBookmark}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all border-2 comic-shadow ${
                  isBookmarked ? 'bg-manga-yellow/20 border-manga-yellow/50 text-manga-yellow' : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-primary/30'
                }`}
              >
                <Bookmark className={`w-4 h-4 ${isBookmarked ? 'fill-current' : ''}`} />
                {isBookmarked ? 'Đã lưu' : 'Lưu truyện'}
              </button>
            </div>
          </div>
        </motion.div>

        {/* Chapters */}
        <div className="mt-12 bg-card rounded-xl comic-border p-6">
          {isLoadingFullMangaDex && (
            <div className="mb-3 text-xs text-muted-foreground">Đang tải thêm chương cũ...</div>
          )}
          {isMangaDex && (
            <div className="-mx-6 -mt-6 mb-5 rounded-t-xl border-b border-border/70 bg-muted/25 px-6 py-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Languages className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground">Nguồn dịch</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {visibleChapters.length} chương · {selectedTranslationSourceOption?.label || 'MangaDex'}
                      {translationSource !== TRANSLATION_SOURCE_LOCAL_VALUE ? ` · ${formatMangaDexLanguageLabel(activeMangaDexLanguage)}` : ''}
                      {mangaDexGroupId ? ' · đã lọc team' : ''}
                    </p>
                  </div>
                </div>

                {(fastDetailQuery.isFetching || fullDetailQuery.isFetching || languageCatalogQuery.isFetching) && (
                  <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-xs font-semibold text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang tải
                  </span>
                )}
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,220px)_minmax(0,220px)_minmax(0,1fr)]">
                <div className="space-y-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    <BookOpen className="h-3.5 w-3.5" /> Nguồn dịch
                  </span>
                  <Select
                    value={translationSource}
                    onValueChange={(value) => {
                      setTranslationSource(value as TranslationSourceFilter);
                      setMangaDexGroupId('');
                    }}
                    disabled={translationSourceOptions.length <= 1}
                  >
                    <SelectTrigger className="h-10 rounded-lg border-border/80 bg-background font-semibold disabled:opacity-60">
                      <SelectValue placeholder="Chọn nguồn dịch" />
                    </SelectTrigger>
                    <SelectContent>
                      {translationSourceOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          <span className="flex w-full items-center justify-between gap-3">
                            <span>{option.label}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                              {option.count}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    <Languages className="h-3.5 w-3.5" /> Ngôn ngữ đọc
                  </span>
                  <Select
                    value={mangaDexLanguage}
                    onValueChange={(value) => {
                      setMangaDexLanguage(value);
                      setMangaDexGroupId('');
                    }}
                    disabled={translationSource === TRANSLATION_SOURCE_LOCAL_VALUE || mangaDexLanguageOptions.length === 0}
                  >
                    <SelectTrigger className="h-10 rounded-lg border-border/80 bg-background font-semibold disabled:opacity-60">
                      <SelectValue placeholder="Chọn ngôn ngữ" />
                    </SelectTrigger>
                    <SelectContent>
                      {mangaDexLanguageOptions.map((language) => (
                        <SelectItem key={language} value={language}>
                          <span className="flex w-full items-center justify-between gap-3">
                            <span>{formatMangaDexLanguageLabel(language)}</span>
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                              {language}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    <UsersRound className="h-3.5 w-3.5" /> Team dịch
                  </span>
                  <Select
                    value={mangaDexGroupId || MANGADEX_ALL_GROUPS_VALUE}
                    onValueChange={(value) => setMangaDexGroupId(value === MANGADEX_ALL_GROUPS_VALUE ? '' : value)}
                    disabled={mangaDexGroupOptions.length === 0}
                  >
                    <SelectTrigger className="h-10 rounded-lg border-border/80 bg-background font-semibold disabled:opacity-60">
                      <SelectValue placeholder="Tất cả team" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MANGADEX_ALL_GROUPS_VALUE}>
                        Tất cả team ({sourceFilteredChapters.length})
                      </SelectItem>
                      {mangaDexGroupOptions.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {translationSource === TRANSLATION_SOURCE_ALL_VALUE ? `${group.sourceLabel} · ${group.name}` : group.name} ({group.count})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <ChapterList
            key={`${activeMangaDexLanguage}:${translationSource}:${mangaDexGroupId || 'all'}:${visibleChapters.length}`}
            chapters={visibleChapters}
            readerChapters={mergedChapters}
            readerChapterSourceFilter={readerChapterSourceFilter}
            mangaId={detailReadySlug}
            mangaDetailId={manga.id}
            mangaTitle={manga.title}
            defaultSortAsc={true}
          />
        </div>

        {/* Comments */}
        <div className="mt-8 bg-card rounded-xl comic-border p-6">
          <CommentSection mangaSlug={detailReadySlug} chapterMap={chapterMap} />
        </div>
      </div>

      {showMatureGateDialog && (
        <div className="fixed inset-0 z-[90] bg-black flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.2 }}
            className="w-full max-w-md bg-background border border-border rounded-2xl p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-full bg-manga-orange/20 text-manga-orange flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-foreground">Nội dung đã được lọc</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Truyện <span className="font-semibold text-foreground">&quot;{manga.title}&quot;</span> có phân loại{' '}
                  <span className="font-semibold text-foreground">Mature</span>.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-border bg-secondary p-3 space-y-1.5">
              <p className="text-xs text-muted-foreground">
                Bạn đang tắt tùy chọn hiển thị nội dung Mature (18+) trong phần Cài đặt.
              </p>
              <p className="text-xs text-muted-foreground">
                Chọn <span className="font-semibold text-foreground">Vẫn truy cập</span> nếu bạn muốn mở truyện này trong phiên hiện tại.
              </p>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleMatureCancel}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors"
              >
                Quay lại khám phá
              </button>
              <button
                type="button"
                onClick={handleMatureAllow}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Vẫn truy cập
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default MangaDetail;
