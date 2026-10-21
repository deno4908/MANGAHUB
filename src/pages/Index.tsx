import { useMemo, useEffect, useState, useCallback } from 'react';
import { ImageFailureContext } from '@/components/ui/ImageFailureContext';
import { isMangaDexCoverUrl } from '@/lib/homeSourceFallback';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadHomeCardMetadata } from '@/lib/homeCardMetadata';
import { useHomepageCombined } from '@/hooks/useApi';
import { useSettingsStore } from '@/store/settingsStore';
import { useUserStore } from '@/store/userStore';
import MangaGrid from '@/components/manga/MangaGrid';
import HeroSlider from '@/components/manga/HeroSlider';
import GenreCloud from '@/components/manga/GenreCloud';
import { AlertTriangle, ArrowRight, Bell, CalendarDays, Wrench, X } from 'lucide-react';
import { announcementApi, mangaApi, ratingApi, subscribeHomepageRefresh } from '@/lib/api';
import {
  adaptListData,
  pickBestTitle as pickBestMangaTitle,
  repairMojibakeText,
  thumbFallbackUrl,
  thumbUrl,
} from '@/lib/adapters';
import { isEcchiManga, isMatureManga } from '@/lib/contentFilter';
import { normalizeMangaDexId } from '@/lib/mangaLinks';
import { applyBatchRatingsPayload } from '@/lib/mangaRatings';
import type { Manga } from '@/types/manga';

const SkeletonGrid = ({ count = 6 }: { count?: number }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="animate-pulse">
        <div className="aspect-[3/4] bg-muted rounded-lg" />
        <div className="mt-2 h-3 bg-muted rounded w-3/4" />
        <div className="mt-1 h-2 bg-muted rounded w-1/2" />
      </div>
    ))}
  </div>
);

const SkeletonHorizontal = () => (
  <div className="space-y-2">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="flex gap-3 p-3 animate-pulse">
        <div className="w-14 h-[78px] bg-muted rounded shrink-0" />
        <div className="flex-1 py-1">
          <div className="h-3 bg-muted rounded w-3/4" />
          <div className="mt-2 h-2 bg-muted rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

const getAnnouncementTone = (type?: string) => {
  switch (type) {
    case 'maintenance':
      return {
        icon: Wrench,
        label: 'Bảo trì',
        ring: 'border-amber-400/40',
        badge: 'bg-amber-400/15 text-amber-500',
        glow: 'from-amber-500/25 via-orange-500/10 to-transparent',
        button: 'bg-amber-500 text-white hover:bg-amber-600',
        orb: 'bg-amber-400/25',
      };
    case 'event':
      return {
        icon: CalendarDays,
        label: 'Event',
        ring: 'border-emerald-400/40',
        badge: 'bg-emerald-400/15 text-emerald-500',
        glow: 'from-emerald-500/25 via-cyan-500/10 to-transparent',
        button: 'bg-emerald-500 text-white hover:bg-emerald-600',
        orb: 'bg-emerald-400/25',
      };
    case 'warning':
      return {
        icon: AlertTriangle,
        label: 'Cảnh báo',
        ring: 'border-red-400/40',
        badge: 'bg-red-400/15 text-red-500',
        glow: 'from-red-500/25 via-orange-500/10 to-transparent',
        button: 'bg-red-500 text-white hover:bg-red-600',
        orb: 'bg-red-400/25',
      };
    default:
      return {
        icon: Bell,
        label: 'Thông báo',
        ring: 'border-primary/40',
        badge: 'bg-primary/15 text-primary',
        glow: 'from-primary/25 via-accent/10 to-transparent',
        button: 'bg-primary text-primary-foreground hover:bg-primary/90',
        orb: 'bg-primary/25',
      };
  }
};

const getSafeAnnouncementHref = (value?: string | null) => {
  const href = String(value || '').trim();
  if (!href) return '';
  const lower = href.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || href.startsWith('/') ? href : '';
};

const HomeAnnouncementPopup = ({ announcement }: { announcement?: SiteAnnouncement | null }) => {
  const [closed, setClosed] = useState(false);
  if (!announcement?.id || closed) return null;

  const dismissVersion = announcement.updated_at || announcement.created_at || announcement.expires_at || '';
  const storageKey = `${ANNOUNCEMENT_DISMISS_KEY_PREFIX}${announcement.id}:${dismissVersion}`;
  let dismissedByStorage = false;
  try {
    dismissedByStorage = typeof window !== 'undefined' && Boolean(window.localStorage.getItem(storageKey));
  } catch {
    dismissedByStorage = false;
  }
  if (dismissedByStorage) {
    return null;
  }

  const tone = getAnnouncementTone(announcement.announcement_type);
  const Icon = tone.icon;
  const ctaHref = getSafeAnnouncementHref(announcement.cta_url);
  const hasImage = Boolean(announcement.image_url);
  const isExternalCta = /^https?:\/\//i.test(ctaHref);
  const sizeClass =
    announcement.popup_size === 'wide'
      ? 'max-w-4xl'
      : announcement.popup_size === 'compact'
        ? 'max-w-md'
        : 'max-w-2xl';
  const titleClass =
    announcement.popup_size === 'compact'
      ? 'text-xl sm:text-2xl'
      : 'text-2xl sm:text-4xl';
  const close = () => {
    try {
      window.localStorage.setItem(storageKey, String(Date.now()));
    } catch {
      // Ignore storage failures; local state still closes this popup.
    }
    setClosed(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md px-4 py-6">
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className={`relative w-full ${sizeClass} overflow-hidden rounded-[2rem] border ${tone.ring} bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl`}
      >
        <div className={`absolute inset-x-0 top-0 h-48 bg-gradient-to-br ${tone.glow}`} />
        <div className={`absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl ${tone.orb}`} />
        <div className="absolute -left-20 bottom-0 h-48 w-48 rounded-full bg-white/5 blur-3xl" />
        {announcement.popup_dismissible !== false ? (
          <button
            onClick={close}
            className="absolute right-4 top-4 z-20 rounded-full border border-white/15 bg-background/70 p-2 text-muted-foreground shadow-lg backdrop-blur hover:text-foreground hover:bg-background transition-colors"
            aria-label="Đóng thông báo"
          >
            <X className="w-4 h-4" />
          </button>
        ) : null}

        <div className={`relative grid ${hasImage && announcement.popup_size !== 'compact' ? 'md:grid-cols-[0.92fr_1.08fr]' : ''}`}>
          {hasImage && announcement.popup_size !== 'compact' ? (
            <div className="relative min-h-[220px] md:min-h-[420px] overflow-hidden bg-muted">
              <img
                src={announcement.image_url}
                alt={announcement.title}
                className="absolute inset-0 h-full w-full object-cover"
                loading="eager"
                decoding="async"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent md:bg-gradient-to-r md:from-transparent md:to-card/75" />
              <div className={`absolute left-5 top-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide backdrop-blur ${tone.badge}`}>
                <Icon className="w-4 h-4" />
                {tone.label}
              </div>
            </div>
          ) : null}

          <div className="relative p-6 sm:p-8">
            {!hasImage || announcement.popup_size === 'compact' ? (
              <div className={`mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide ${tone.badge}`}>
                <Icon className="w-4 h-4" />
                {tone.label}
              </div>
            ) : null}
            <h2 className={`${titleClass} font-black leading-[1.05] tracking-tight pr-10`}>
              {announcement.title}
            </h2>
            {hasImage && announcement.popup_size === 'compact' ? (
              <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-muted">
                <img
                  src={announcement.image_url}
                  alt={announcement.title}
                  className="h-36 w-full object-cover"
                  loading="eager"
                  decoding="async"
                />
              </div>
            ) : null}
            <p className="mt-4 text-sm sm:text-base text-muted-foreground whitespace-pre-line leading-relaxed">
              {announcement.message}
            </p>
            <div className="mt-7 flex flex-col sm:flex-row sm:items-center gap-2">
              {ctaHref ? (
                <a
                  href={ctaHref}
                  target={isExternalCta ? '_blank' : undefined}
                  rel={isExternalCta ? 'noreferrer' : undefined}
                  className={`inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black shadow-lg transition-colors ${tone.button}`}
                  onClick={() => {
                    if (announcement.popup_dismissible !== false) close();
                  }}
                >
                  {announcement.cta_label || 'Xem ngay'}
                  <ArrowRight className="w-4 h-4" />
                </a>
              ) : null}
              {announcement.popup_dismissible !== false ? (
                <button
                  onClick={close}
                  className="inline-flex items-center justify-center rounded-2xl border border-border bg-background/70 px-5 py-3 text-sm font-bold text-foreground hover:bg-background transition-colors"
                >
                  Đã hiểu
                </button>
              ) : null}
            </div>
            {announcement.expires_at ? (
              <p className="mt-4 text-[11px] font-semibold text-muted-foreground">
                Hiển thị đến {new Date(announcement.expires_at).toLocaleString('vi-VN')}
              </p>
            ) : null}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

type MangaDexCatalogItem = {
  id: string;
  url?: string;
  title: string;
  cover_url?: string;
  authors_text?: string;
  updated_at?: string;
  latest_chapter?: string;
  last_chapter?: string;
  chapter_newest?: string;
  is_featured?: boolean;
  featured_at?: string;
  admin_notes?: string;
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

type MyRatedMangaItem = {
  manga_slug: string;
  score: number;
  updated_at?: string;
  title?: string;
  thumb?: string;
  genres?: string[];
  tags?: string[];
  latest_chapter?: string;
  latestChapter?: string;
  latest_chapter_updated_at?: string;
  latestChapterUpdatedAt?: string;
};

type TopRatedGlobalItem = {
  manga_slug: string;
  average: number;
  count: number;
  updated_at?: string;
};

type TrendingMangaItem = {
  slug?: string;
  title?: string;
  thumb?: string;
  views?: number | string;
  genres?: string[];
  tags?: string[];
  status?: string;
  latest_chapter?: string;
  latestChapter?: string;
  latest_chapter_updated_at?: string;
  latestChapterUpdatedAt?: string;
  last_updated?: string;
  lastUpdated?: string;
  content_rating?: string;
  contentRating?: string;
  is_mature?: boolean;
  isMature?: boolean;
};

type SiteAnnouncement = {
  id: string;
  title: string;
  message: string;
  announcement_type?: 'system' | 'maintenance' | 'event' | 'warning' | string;
  image_url?: string;
  cta_label?: string;
  cta_url?: string;
  popup_size?: 'compact' | 'standard' | 'wide' | string;
  popup_dismissible?: boolean;
  priority?: number;
  starts_at?: string;
  expires_at?: string;
  created_at?: string;
  updated_at?: string;
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const MY_RATED_HOME_LIMIT = 80;
const DEFAULT_CARD_COVER_FALLBACK = '/no-cover.svg';
const GUEST_TOP_RATED_LIMIT = 24;
const HOME_POPULAR_LIMIT = 12;
const HOME_POPULAR_TRENDING_FETCH_LIMIT = 50;
const RATING_BATCH_CHUNK_SIZE = 30;
const RATING_BATCH_WAVE_SIZE = 2;
const RATING_BATCH_TIMEOUT_MS = 4_500;
const ANNOUNCEMENT_DISMISS_KEY_PREFIX = 'mb:home-announcement-dismissed:';
const HOME_SOURCE_SYNC_GRACE_MS = 3_000;
const HOME_DEFERRED_WORK_IDLE_MS = 900;

type HomeIdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const scheduleHomeDeferredWork = (callback: () => void, timeoutMs = HOME_DEFERRED_WORK_IDLE_MS) => {
  if (typeof window === 'undefined') return () => undefined;

  const win = window as HomeIdleWindow;
  if (typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => win.cancelIdleCallback?.(id);
  }

  const timer = window.setTimeout(callback, timeoutMs);
  return () => window.clearTimeout(timer);
};
// Proxy URL = primary (local disk cache after startup warmup = instant)
const toMangaDexCoverProxy = (coverUrl?: string, mangaId?: string) => {
  const raw = String(coverUrl || '').trim();
  try {
    const parsed = new URL(raw, API_BASE);
    if (parsed.pathname === '/api/images/img') {
      return /^https?:\/\//i.test(raw) ? raw : `${API_BASE}${raw}`;
    }
  } catch {
    // Fall through to the regular cover handling.
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
  }
  return DEFAULT_CARD_COVER_FALLBACK;
};

// Direct CDN URL kept only for metadata/debug. Cards should prefer the local proxy.
const toMangaDexCoverDirect = (coverUrl?: string): string => {
  const raw = String(coverUrl || '').trim();
  if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
  return '';
};

const extractImageProxyTarget = (value?: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, API_BASE);
    if (parsed.pathname !== '/api/images/img') return '';
    const target = parsed.searchParams.get('url') || '';
    return /^https?:\/\//i.test(target) ? target : '';
  } catch {
    return '';
  }
};

const collectWarmupCoverUrls = (items: Manga[], limit = 30): string[] => {
  const urls = new Set<string>();
  for (const item of items) {
    const cover = String(item.cover || '').trim();
    const fallback = String(item.coverProxy || '').trim();
    const candidates = [
      extractImageProxyTarget(cover),
      extractImageProxyTarget(fallback),
      /^https?:\/\/uploads\.mangadex\.org/i.test(cover) ? cover : '',
      /^https?:\/\/uploads\.mangadex\.org/i.test(fallback) ? fallback : '',
    ];
    for (const candidate of candidates) {
      if (!candidate || urls.has(candidate)) continue;
      urls.add(candidate);
      if (urls.size >= limit) return Array.from(urls);
    }
  }
  return Array.from(urls);
};

const preloadCoverCache = (urls: string[]) => {
  if (!urls.length) return;
  const query = new URLSearchParams({ urls: urls.join(',') });
  fetch(`${API_BASE}/api/images/preload?${query.toString()}`, {
    credentials: 'include',
    cache: 'no-store',
  }).catch(() => {});
};

const parseTime = (value?: string) => {
  const ts = Date.parse(String(value || ''));
  if (!Number.isFinite(ts)) return 0;
  const maxFuture = Date.now() + 2 * 24 * 60 * 60 * 1000;
  return ts > maxFuture ? 0 : ts;
};

const chapterRecencyTime = (manga: Manga): number => {
  const chapterTimes = Array.isArray(manga.chapters)
    ? manga.chapters
        .map((chapter) => parseTime(chapter?.uploadDate))
        .filter((ts) => ts > 0)
    : [];
  if (chapterTimes.length > 0) {
    return Math.max(...chapterTimes);
  }
  return parseTime(manga.lastUpdated);
};

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const compareByPopular = (a: Manga, b: Manga): number => {
  const viewsA = Math.max(0, toNumber(a.views));
  const viewsB = Math.max(0, toNumber(b.views));
  const viewsDiff = viewsB - viewsA;
  if (viewsDiff !== 0) return viewsDiff;

  const ratingCountDiff = Math.max(0, toNumber(b.ratingCount)) - Math.max(0, toNumber(a.ratingCount));
  if (ratingCountDiff !== 0) return ratingCountDiff;

  const ratingDiff = Math.max(0, toNumber(b.rating)) - Math.max(0, toNumber(a.rating));
  if (ratingDiff !== 0) return ratingDiff;

  return String(a.title || '').localeCompare(String(b.title || ''), 'vi');
};

const mapTrendingStatus = (value?: string): Manga['status'] => {
  const normalized = normalizeLooseText(repairMojibakeText(value));
  if (normalized.includes('completed') || normalized.includes('hoan thanh')) return 'completed';
  if (normalized.includes('hiatus') || normalized.includes('coming soon') || normalized.includes('sap ra')) return 'hiatus';
  if (normalized.includes('cancel')) return 'cancelled';
  return 'ongoing';
};

const getTrendingChapterText = (row: TrendingMangaItem): string =>
  repairMojibakeText(row.latest_chapter || row.latestChapter || '').trim();

const getTrendingUpdatedAt = (row: TrendingMangaItem): string =>
  String(
    row.latest_chapter_updated_at ||
      row.latestChapterUpdatedAt ||
      row.last_updated ||
      row.lastUpdated ||
      '',
  ).trim();

const buildTrendingChapter = (slug: string, row: TrendingMangaItem): Manga['chapters'] => {
  const chapterText = getTrendingChapterText(row);
  if (!chapterText) return [];

  const chapterNum = parseChapterNumberFromText(chapterText);
  const hasNumber = isValidChapterNumber(chapterNum);
  return [{
    id: String((row as any).latest_chapter_id || `trending-${slug}-latest`),
    mangaId: slug,
    number: hasNumber ? chapterNum : -1,
    title: hasNumber ? chapterLabelFromNumber(chapterNum) : chapterText,
    pages: [],
    uploadDate: getTrendingUpdatedAt(row),
    scanlationGroup: '',
  }];
};

const toAbsoluteThumbUrl = (value?: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${API_BASE}${raw}`;
  return raw;
};

const isMangaDexSlug = (slug: string): boolean => {
  return !!normalizeMangaDexId(slug);
};

const toMangaDexDetailId = (slug: string): string => {
  return normalizeMangaDexId(slug) || '';
};

const INVALID_PUBLIC_MANGA_SLUGS = new Set([
  'admin',
  'api',
  'bookmarks',
  'browse',
  'chapter',
  'chapters',
  'completed',
  'history',
  'images',
  'img',
  'latest',
  'login',
  'manga',
  'none',
  'notifications',
  'null',
  'popular',
  'profile',
  'random',
  'ranking',
  'rankings',
  'read',
  'reader',
  'register',
  'search',
  'settings',
  'u',
  'undefined',
  'upload',
  'uploads',
]);

const isInvalidPublicMangaSlug = (value: unknown): boolean => {
  const normalized = String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length < 3) return true;
  if (toMangaDexDetailId(normalized)) return false;
  return INVALID_PUBLIC_MANGA_SLUGS.has(normalized);
};

const getMangaFromLookup = (lookup: Map<string, Manga>, value: unknown): Manga | undefined => {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) return undefined;

  const detailId = toMangaDexDetailId(slug);
  return (
    lookup.get(slug) ||
    (detailId ? lookup.get(detailId) || lookup.get(`mdx-${detailId}`) : undefined)
  );
};

const normalizeTrendingViews = (row: TrendingMangaItem, isMangaDexItem: boolean): number => {
  const anyRow = row as any;
  const rawViews = Math.max(0, toNumber(anyRow.views ?? anyRow.view_count));
  if (!isMangaDexItem) return rawViews;

  const localViews = Math.max(0, toNumber(anyRow.local_view_count ?? anyRow.localViewCount));
  if (localViews > 0) return localViews;

  const popularityScore = Math.max(
    0,
    toNumber(anyRow.mangadex_popularity_score ?? anyRow.popularity_score ?? anyRow.popularityScore),
  );
  if (rawViews >= 900_000 && (popularityScore <= 0 || Math.abs(rawViews - popularityScore) <= 10_000)) {
    return 0;
  }
  return rawViews;
};

const normalizeLooseText = (value: string): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseChapterNumberFromText = (value: unknown): number => {
  const raw = String(value ?? '').trim();
  if (!raw) return Number.NaN;

  const direct = Number(raw.replace(',', '.'));
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const normalized = normalizeLooseText(raw);
  if (!normalized) return Number.NaN;

  const keywordMatch = normalized.match(/\b(?:chapter|chuong|ch)\.?\s*(\d+(?:[.,]\d+)?)/i);
  if (keywordMatch) {
    const parsed = Number(keywordMatch[1].replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const looksLikeRelativeTime = /\b(ago|truoc|trc|gio|phut|ngay|tuan|thang|nam|h)\b/.test(normalized);
  if (looksLikeRelativeTime) return Number.NaN;

  const leadingMatch = normalized.match(/^(\d+(?:[.,]\d+)?)(?=$|[\s)\]-])/);
  if (!leadingMatch) return Number.NaN;

  const parsed = Number(leadingMatch[1].replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
};

const isValidChapterNumber = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const firstValidChapterNumber = (...values: number[]): number => {
  for (const value of values) {
    if (isValidChapterNumber(value)) return value;
  }
  return Number.NaN;
};

const formatChapterNumber = (value: number): string => {
  if (!isValidChapterNumber(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(value)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
};

const chapterLabelFromNumber = (value: number): string => {
  const formatted = formatChapterNumber(value);
  return formatted ? `Chương ${formatted}` : '';
};

const isSlugLikeTitle = (title: string, slug: string): boolean => {
  const rawTitle = repairMojibakeText(title).trim();
  const normalizedTitle = normalizeLooseText(rawTitle);
  const normalizedSlug = normalizeLooseText(slug).replace(/\s+/g, '-');
  if (!normalizedTitle) return !/[^\x00-\x7f]/.test(rawTitle);
  if (normalizedTitle === normalizedSlug.replace(/-/g, ' ')) return true;
  if (normalizedTitle === `mdx ${normalizedSlug.replace(/-/g, ' ')}`) return true;
  if (isMangaDexSlug(normalizedTitle.replace(/\s+/g, '-'))) return true;
  return (
    normalizedTitle === 'mangadex' ||
    normalizedTitle === 'untitled' ||
    normalizedTitle === 'dang cap nhat tieu de' ||
    normalizedTitle === 'chua co tieu de' ||
    normalizedTitle === 'khong co tieu de' ||
    normalizedTitle === 'khong co ten' ||
    normalizedTitle === 'no title'
  );
};

const humanizeSlugTitle = (slug: string): string => {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized || isMangaDexSlug(normalized)) return '';
  if (!normalized.includes('-')) return '';
  const words = normalized
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.length ? words.join(' ') : '';
};

const pickDisplayTitle = (slug: string, ...candidates: Array<string | undefined>): string => {
  const best = pickBestMangaTitle(slug, ...candidates);
  if (best) return best;

  let fallback = '';

  for (const candidate of candidates) {
    const text = repairMojibakeText(candidate).trim();
    if (!text) continue;

    const normalized = normalizeLooseText(text);
    const isGenericPlaceholder =
      normalized === 'mangadex' ||
      normalized === 'untitled' ||
      normalized === 'dang cap nhat tieu de' ||
      normalized === 'chua co tieu de' ||
      normalized === 'khong co tieu de' ||
      normalized === 'khong co ten' ||
      normalized === 'no title';
    const isInvalid = isGenericPlaceholder || isSlugLikeTitle(text, slug);
    if (!fallback && normalized && !isInvalid) {
      fallback = text;
    }

    if (isInvalid) continue;
    return text;
  }
  return fallback || humanizeSlugTitle(slug);
};

const dedupeById = (items: Manga[]): Manga[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = String(item.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const mergeUniqueMangaById = (primary: Manga[], fallback: Manga[], limit: number): Manga[] => {
  const byId = new Map<string, Manga>();

  for (const item of [...primary, ...fallback]) {
    const key = String(item.id || '').trim().toLowerCase();
    if (!key) continue;

    const current = byId.get(key);
    if (!current || compareByPopular(item, current) < 0) {
      byId.set(key, item);
    }
  }

  return Array.from(byId.values()).sort(compareByPopular).slice(0, limit);
};

const getMyRatedLatestChapter = (record: MyRatedMangaItem): string =>
  String(record.latest_chapter || record.latestChapter || '').trim();

const getMyRatedLatestChapterUpdatedAt = (record: MyRatedMangaItem): string =>
  String(
    record.latest_chapter_updated_at ||
      record.latestChapterUpdatedAt ||
      record.updated_at ||
      '',
  ).trim();

const buildMyRatedChapters = (slug: string, record: MyRatedMangaItem): Manga['chapters'] => {
  const chapterRaw = getMyRatedLatestChapter(record);
  const chapterNum = parseChapterNumberFromText(chapterRaw);
  if (!isValidChapterNumber(chapterNum)) return [];

  return [
    {
      id: `ch-${slug}-rated`,
      mangaId: slug,
      number: chapterNum,
      title: chapterLabelFromNumber(chapterNum),
      pages: [],
      uploadDate: getMyRatedLatestChapterUpdatedAt(record),
      scanlationGroup: '',
    },
  ];
};

const hasReadableChapter = (chapters: Manga['chapters'] | undefined): boolean =>
  Array.isArray(chapters) &&
  chapters.some((chapter) => (
    chapter?.number !== null &&
    chapter?.number !== undefined &&
    isValidChapterNumber(Number(chapter.number))
  ));

const mergeBatchRatingsPayload = (
  target: { ratings: Record<string, any>; my_scores: Record<string, any> },
  payload: any,
) => {
  const ratings = (payload?.ratings || {}) as Record<string, any>;
  const myScores = (payload?.my_scores || {}) as Record<string, any>;
  Object.assign(target.ratings, ratings);
  Object.assign(target.my_scores, myScores);
};

const fetchBatchRatingsParallel = async (
  slugs: string[],
  timeoutMs = RATING_BATCH_TIMEOUT_MS,
): Promise<{ ratings: Record<string, any>; my_scores: Record<string, any> }> => {
  const uniqueSlugs = Array.from(
    new Set(slugs.map((slug) => String(slug || '').trim().toLowerCase()).filter(Boolean)),
  );
  if (!uniqueSlugs.length) return { ratings: {}, my_scores: {} };

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueSlugs.length; i += RATING_BATCH_CHUNK_SIZE) {
    chunks.push(uniqueSlugs.slice(i, i + RATING_BATCH_CHUNK_SIZE));
  }

  const merged = { ratings: {}, my_scores: {} } as {
    ratings: Record<string, any>;
    my_scores: Record<string, any>;
  };

  for (let i = 0; i < chunks.length; i += RATING_BATCH_WAVE_SIZE) {
    const wave = chunks.slice(i, i + RATING_BATCH_WAVE_SIZE);
    const settled = await Promise.allSettled(
      wave.map((chunk) => ratingApi.getBatchRatings(chunk, timeoutMs)),
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      mergeBatchRatingsPayload(merged, result.value);
    }
  }

  return merged;
};

const pickChapterDate = (chapter?: MangaDexCatalogItem['chapters'][number], mangaUpdatedAt?: string) => {
  const candidates = [chapter?.publish_at, chapter?.readable_at, chapter?.created_at, chapter?.updated_at, mangaUpdatedAt];
  for (const candidate of candidates) {
    if (parseTime(candidate) > 0) return String(candidate);
  }
  return '';
};

const getMangaDexChapterNumber = (chapter?: MangaDexCatalogItem['chapters'][number]): number => {
  if (!chapter) return Number.NaN;
  const parsed = firstValidChapterNumber(
    parseChapterNumberFromText(chapter?.chapter),
    parseChapterNumberFromText(chapter?.chapter_with_groups)
  );
  return isValidChapterNumber(parsed) ? parsed : 0;
};

const getMangaDexFallbackChapterNumber = (item: Partial<MangaDexCatalogItem> | any): number =>
  firstValidChapterNumber(
    parseChapterNumberFromText(item?.latest_chapter),
    parseChapterNumberFromText(item?.latestChapter),
    parseChapterNumberFromText(item?.last_chapter),
    parseChapterNumberFromText(item?.lastChapter),
    parseChapterNumberFromText(item?.chapter_newest),
    parseChapterNumberFromText(item?.chapterNewest),
  );

const pickLatestChapter = (item: MangaDexCatalogItem) => {
  const chapters = item.chapters || [];
  if (!chapters.length) return undefined;
  return [...chapters].sort((a, b) => {
    const numberDiff = getMangaDexChapterNumber(b) - getMangaDexChapterNumber(a);
    if (numberDiff !== 0) return numberDiff;

    return parseTime(pickChapterDate(b, item.updated_at)) - parseTime(pickChapterDate(a, item.updated_at));
  })[0];
};

const pickStableDate = (chapterDate?: string, mangaUpdatedAt?: string) => {
  const chapterTs = parseTime(chapterDate);
  if (chapterTs > 0) return chapterDate as string;
  const mangaTs = parseTime(mangaUpdatedAt);
  if (mangaTs > 0) return mangaUpdatedAt as string;
  return '';
};

const getReadableChapterNumberForHome = (chapter?: Manga['chapters'][number]): number => {
  if (!chapter) return Number.NaN;
  if (
    chapter.number !== null &&
    chapter.number !== undefined &&
    isValidChapterNumber(Number(chapter.number))
  ) {
    return Number(chapter.number);
  }
  return parseChapterNumberFromText(chapter.title);
};

const pickLatestReadableChapterForHome = (chapters: Manga['chapters']): Manga['chapters'][number] | undefined => {
  if (!Array.isArray(chapters) || chapters.length === 0) return undefined;

  const readable = chapters.filter((chapter) => {
    const parsed = getReadableChapterNumberForHome(chapter);
    return isValidChapterNumber(parsed);
  });
  if (!readable.length) return undefined;

  return [...readable].sort((a, b) => {
    const numA = getReadableChapterNumberForHome(a);
    const numB = getReadableChapterNumberForHome(b);
    const numberDiff = numB - numA;
    if (numberDiff !== 0) return numberDiff;

    const timeDiff = parseTime(b?.uploadDate) - parseTime(a?.uploadDate);
    if (timeDiff !== 0) return timeDiff;

    return String(b?.id || '').localeCompare(String(a?.id || ''));
  })[0];
};

type MangaDexLatestChapterMeta = {
  latestChapter?: Manga['chapters'][number];
  lastUpdated?: string;
};

const buildMangaDexLatestMeta = (
  detailId: string,
  chapterNum: number,
  chapterDate?: string,
  chapterId?: string,
): MangaDexLatestChapterMeta | null => {
  if (!isValidChapterNumber(chapterNum)) return null;
  const safeDate = String(chapterDate || '').trim() || new Date().toISOString();
  return {
    latestChapter: {
      id: String(chapterId || `mdx-ch-${detailId}-latest`),
      mangaId: detailId,
      number: chapterNum,
      title: chapterLabelFromNumber(chapterNum),
      pages: [],
      uploadDate: safeDate,
      scanlationGroup: '',
    },
    lastUpdated: safeDate,
  };
};

const buildMangaDexLatestMetaFromBatch = (
  detailId: string,
  latest: any,
): MangaDexLatestChapterMeta | null => {
  const chapterNum =
    firstValidChapterNumber(
      parseChapterNumberFromText(latest?.chapter_name),
      parseChapterNumberFromText(latest?.chapter_title),
    );
  const chapterDate = String(
    latest?.publish_at ||
    latest?.readable_at ||
    latest?.created_at ||
    latest?.updated_at ||
    '',
  ).trim();
  return buildMangaDexLatestMeta(detailId, chapterNum, chapterDate, latest?.chapter_id || latest?.id);
};

const buildMangaDexLatestMetaFromDetail = (
  detailId: string,
  payload: any,
): MangaDexLatestChapterMeta | null => {
  const item = (payload?.manga || {}) as any;
  const chapterRows = Array.isArray(item.chapters) ? item.chapters : [];
  const best = chapterRows
    .map((chapter: any) => {
      const chapterNum =
        firstValidChapterNumber(
          parseChapterNumberFromText(chapter?.chapter),
          parseChapterNumberFromText(chapter?.chapter_with_groups),
          parseChapterNumberFromText(chapter?.title),
        );
      const resolvedChapterNum = isValidChapterNumber(chapterNum) ? chapterNum : 0;
      const chapterDate = String(
        chapter?.publish_at ||
        chapter?.readable_at ||
        chapter?.created_at ||
        chapter?.updated_at ||
        item?.updated_at ||
        '',
      ).trim();
      return {
        chapterNum: resolvedChapterNum,
        chapterDate,
        id: String(chapter?.id || '').trim(),
      };
    })
    .filter((chapter) => isValidChapterNumber(chapter.chapterNum))
    .sort((a, b) => {
      const numberDiff = b.chapterNum - a.chapterNum;
      if (numberDiff !== 0) return numberDiff;
      return parseTime(b.chapterDate) - parseTime(a.chapterDate);
    })[0];

  if (best) {
    return buildMangaDexLatestMeta(detailId, best.chapterNum, best.chapterDate || item?.updated_at, best.id);
  }

  const fallbackChapterNum = getMangaDexFallbackChapterNumber(item);
  return buildMangaDexLatestMeta(detailId, fallbackChapterNum, item?.updated_at);
};

const fetchMangaDexLatestChapterMetaMap = async (
  detailIds: string[],
  detailFallbackLimit = 3,
): Promise<Record<string, MangaDexLatestChapterMeta>> => {
  const ids = Array.from(new Set(detailIds.map((id) => toMangaDexDetailId(id) || String(id || '').trim().toLowerCase()).filter(Boolean)));
  const result: Record<string, MangaDexLatestChapterMeta> = {};
  if (!ids.length) return result;

  try {
    const payload = await mangaApi.getMangaDexLatestChapters(ids, { fast: true });
    const latestMap = (payload?.items || {}) as Record<string, any>;
    for (const detailId of ids) {
      const latest = latestMap[detailId] || latestMap[`mdx-${detailId}`];
      const meta = buildMangaDexLatestMetaFromBatch(detailId, latest);
      if (!meta?.latestChapter) continue;
      result[detailId] = meta;
      result[`mdx-${detailId}`] = meta;
    }
  } catch {
    // Detail fallback below handles transient batch failures.
  }

  return result;
};

const syncMangaDexLatestChapters = (
  items: Manga[],
  map: Record<string, MangaDexLatestChapterMeta>,
): Manga[] => {
  if (!items.length || !map || Object.keys(map).length === 0) return items;

  return items.map((item) => {
    const detailId = toMangaDexDetailId(String(item.id || ''));
    if (!detailId) return item;

    const meta = map[detailId] || map[`mdx-${detailId}`];
    if (!meta?.latestChapter) return item;

    const currentLatest = pickLatestReadableChapterForHome(item.chapters || []);
    const currentNum = getReadableChapterNumberForHome(currentLatest);
    const syncedNum = Number(meta.latestChapter.number);
    const currentTs = parseTime(currentLatest?.uploadDate);
    const syncedTs = parseTime(meta.latestChapter.uploadDate);

    const shouldReplace =
      !currentLatest ||
      !isValidChapterNumber(currentNum) ||
      currentNum <= 1 ||
      syncedNum > currentNum ||
      (syncedNum === currentNum && syncedTs > currentTs);

    if (!shouldReplace) return item;

    return {
      ...item,
      chapters: [meta.latestChapter],
      lastUpdated: meta.lastUpdated || item.lastUpdated,
    };
  });
};

const Index = () => {
  const queryClient = useQueryClient();
  const [hasMangaDexCoverFailure, setHasMangaDexCoverFailure] = useState(false);
  const reportHomeImageFailure = useCallback((src: string) => {
    if (isMangaDexCoverUrl(src)) setHasMangaDexCoverFailure(true);
  }, []);
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const authUser = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  const canUseUserRatings = isLoggedIn && !!authUser && !isRestoringSession;
  const ratingViewerKey = useUserStore((s) => {
    const raw = String(s.user?.id || s.user?.email || '').trim().toLowerCase();
    return raw || 'auth';
  });
  const {
    data,
    isLoading: isInitialMergedLoading,
    isError: isHomepageError,
    refetch: refetchHomepageCombined,
  } = useHomepageCombined(120);
  const isHomepageCoreReady = !isInitialMergedLoading;
  const {
    data: homeBannerData,
    isLoading: isHomeBannerLoading,
    isError: isHomeBannerError,
    refetch: refetchHomeBanner,
  } = useQuery({
    queryKey: ['manga', 'home', 'feed-v2', 'mangadex', showMatureContent],
    queryFn: async () => {
      const payload = await mangaApi.getMangaDexHomeBanner({
        limit: 24,
        showMature: showMatureContent,
        filterHidden: true,
        timeoutMs: 18_000,
      });
      return adaptListData(payload);
    },
    staleTime: 30 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 0,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const isMangaDexUnavailable = isHomeBannerError || hasMangaDexCoverFailure;
  const isHomeSourceAvailable = useCallback((item: Manga) =>
    !isMangaDexUnavailable || (item.source !== 'mangadex' && !normalizeMangaDexId(item.id)),
  [isMangaDexUnavailable]);
  const hasQQHomeItems = [data?.latest, data?.ongoing]
    .some(section => section?.items?.some(item => item.source !== 'mangadex' && !normalizeMangaDexId(item.id)
      && (showMatureContent || !isMatureManga(item))));
  const needsQQFallback = !hasQQHomeItems && (isHomepageError || isMangaDexUnavailable);
  const { data: qqFallbackData, isLoading: isQQFallbackLoading, refetch: refetchQQFallback } = useQuery({
    queryKey: ['manga', 'home', 'qq-fallback', showMatureContent],
    queryFn: async ({ signal }) => {
      const payload = await mangaApi.getOTruyenFiltered({
        page: 1, limit: 24, sort: 'latest', showMature: showMatureContent, attachRatings: false, signal,
      });
      const result = adaptListData(payload);
      if (!result.items.length) throw new Error('QQ home data unavailable');
      return result;
    },
    enabled: needsQQFallback,
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
  });
  const { data: announcementData } = useQuery({
    queryKey: ['site-announcements', 'active-home-popup'],
    queryFn: () => announcementApi.getActive(3),
    enabled: isHomepageCoreReady,
    staleTime: 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 60 * 1000,
  });
  const activeAnnouncement = useMemo<SiteAnnouncement | null>(() => {
    const rows = (announcementData as any)?.announcements;
    if (!Array.isArray(rows)) return null;
    return (rows.find((row) => row?.id && row?.title && row?.message) || null) as SiteAnnouncement | null;
  }, [announcementData]);

  useEffect(() => {
    return subscribeHomepageRefresh(() => {
      void refetchHomepageCombined();
    });
  }, [refetchHomepageCombined]);

  const featured = data?.featured?.items || [];
  const latest = [...(data?.latest?.items || []), ...(qqFallbackData?.items || [])];
  const ongoing = [...(data?.ongoing?.items || []), ...(qqFallbackData?.items || [])];
  const hasOTruyenHomeItems = latest.length > 0 || ongoing.length > 0 || featured.length > 0;
  const [homeDeferredWorkReady, setHomeDeferredWorkReady] = useState(false);
  // Render whichever source arrives first; late MangaDex data remains live.
  const isHomePrimaryReady = Boolean(data || homeBannerData || qqFallbackData);
  useEffect(() => {
    if (!isHomePrimaryReady) {
      setHomeDeferredWorkReady(false);
      return;
    }

    let cancelled = false;
    const cleanup = scheduleHomeDeferredWork(() => {
      if (!cancelled) setHomeDeferredWorkReady(true);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [isHomePrimaryReady]);

  const canRunHomeDeferredQueries = isHomePrimaryReady && homeDeferredWorkReady;

  const mangaDexItems = isMangaDexUnavailable ? [] : (homeBannerData?.items || []);

  const visibleMangaDexItems = useMemo(
    () => (showMatureContent ? mangaDexItems : mangaDexItems.filter((m) => !isMatureManga(m))),
    [mangaDexItems, showMatureContent],
  );

  const visibleLatest = useMemo(
    () => latest.filter(m => isHomeSourceAvailable(m) && (showMatureContent || !isMatureManga(m))),
    [latest, showMatureContent, isHomeSourceAvailable],
  );

  const visibleOngoing = useMemo(
    () => ongoing.filter(m => isHomeSourceAvailable(m) && (showMatureContent || !isMatureManga(m))),
    [ongoing, showMatureContent, isHomeSourceAvailable],
  );

  const visibleFeatured = useMemo(
    () => featured.filter(m => isHomeSourceAvailable(m) && (showMatureContent || !isMatureManga(m))),
    [featured, showMatureContent, isHomeSourceAvailable],
  );

  const homeBannerItemsCandidate = useMemo(
    () => {
      const items = isMangaDexUnavailable ? [] : (homeBannerData?.items || []);
      const visible = showMatureContent ? items : items.filter((m) => !isMatureManga(m));
      return visible.filter((m) => {
        const title = String(m.title || '').trim();
        const cover = String(m.cover || '').trim();
        return title && cover && !cover.includes('no-cover');
      });
    },
    [homeBannerData?.items, showMatureContent, isMangaDexUnavailable],
  );
  const homeBannerItems = homeBannerItemsCandidate;

  const latestMerged = useMemo(() => {
    const merged = [...visibleLatest, ...visibleMangaDexItems, ...homeBannerItems];
    const seen = new Set<string>();
    return merged.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }).sort((a, b) => chapterRecencyTime(b) - chapterRecencyTime(a));
  }, [visibleLatest, visibleMangaDexItems, homeBannerItems]);

  const ongoingMerged = useMemo(() => {
    const merged = [...visibleOngoing, ...visibleMangaDexItems];
    const seen = new Set<string>();
    return merged.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }).sort((a, b) => chapterRecencyTime(b) - chapterRecencyTime(a));
  }, [visibleOngoing, visibleMangaDexItems]);

  const { data: myRatedHomeData } = useQuery({
    queryKey: ['rating', 'me', 'home', ratingViewerKey, MY_RATED_HOME_LIMIT],
    queryFn: async () => {
      try {
        return await ratingApi.getMyRatedManga(MY_RATED_HOME_LIMIT);
      } catch {
        return { items: [] };
      }
    },
    enabled: canUseUserRatings && canRunHomeDeferredQueries,
    staleTime: 2 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const myRatedOverlayItems = useMemo<Manga[]>(() => {
    const rows = ((myRatedHomeData as any)?.items || []) as MyRatedMangaItem[];
    if (!rows.length) return [];

    const lookup = new Map<string, Manga>();
    for (const item of [...latestMerged, ...ongoingMerged, ...visibleMangaDexItems]) {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key || lookup.has(key)) continue;
      lookup.set(key, item);
    }

    const overlays: Manga[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const slug = String(row.manga_slug || '').trim().toLowerCase();
      if (isMangaDexUnavailable && normalizeMangaDexId(slug)) continue;
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const score = Number(row.score);
      if (!Number.isFinite(score)) continue;

      const rowGenres = Array.isArray(row.genres)
        ? row.genres.map((genre) => String(genre || '').trim()).filter(Boolean)
        : [];
      let rowTags = Array.isArray(row.tags)
        ? row.tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!rowTags.length && rowGenres.length) {
        rowTags = rowGenres
          .map((genre) => genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
          .filter(Boolean);
      }

      const existing = lookup.get(slug);
      const ratedChapters = buildMyRatedChapters(slug, row);
      if (existing) {
        const safeTitle = pickDisplayTitle(slug, existing.title, row.title);
        const existingCover = String(existing.cover || '').trim();
        const existingFallbackCover = String(existing.coverProxy || '').trim();
        if (!safeTitle && !existingCover && !existingFallbackCover) {
          continue;
        }
        overlays.push({
          ...existing,
          title: safeTitle || String(existing.title || '').trim() || 'Chưa có tiêu đề',
          coverProxy: existing.coverProxy || DEFAULT_CARD_COVER_FALLBACK,
          genres: (existing.genres && existing.genres.length) ? existing.genres : rowGenres,
          tags: (existing.tags && existing.tags.length) ? existing.tags : rowTags,
          chapters: hasReadableChapter(existing.chapters) ? existing.chapters : ratedChapters,
          myRating: score,
          rating: Number(existing.rating || 0) > 0 ? Number(existing.rating || 0) : score,
          ratingCount: Number(existing.ratingCount || 0) > 0 ? Number(existing.ratingCount || 0) : 1,
          lastUpdated: String(
            getMyRatedLatestChapterUpdatedAt(row) ||
              row.updated_at ||
              existing.lastUpdated ||
              new Date().toISOString(),
          ),
        });
        continue;
      }

      const isMdx = isMangaDexSlug(slug);
      const rawThumb = toAbsoluteThumbUrl(row.thumb);
      const safeTitle = pickDisplayTitle(slug, row.title);
      if (!safeTitle && !rawThumb) {
        continue;
      }
      if (isMdx && !rawThumb) {
        continue;
      }
      const cover = rawThumb
        ? (isMdx ? toMangaDexCoverProxy(rawThumb, slug) : thumbUrl(rawThumb, slug))
        : DEFAULT_CARD_COVER_FALLBACK;
      const coverProxy = rawThumb
        ? (isMdx ? DEFAULT_CARD_COVER_FALLBACK : (thumbFallbackUrl(rawThumb, slug) || rawThumb || DEFAULT_CARD_COVER_FALLBACK))
        : DEFAULT_CARD_COVER_FALLBACK;

      overlays.push({
        id: slug,
        title: safeTitle || 'Chưa có tiêu đề',
        author: isMdx ? 'MangaDex' : 'TruyenQQ',
        artist: isMdx ? 'MangaDex' : 'TruyenQQ',
        description: '',
        cover,
        coverProxy,
        status: 'ongoing',
        type: 'manga',
        genres: rowGenres,
        tags: rowTags,
        rating: score,
        ratingCount: 1,
        myRating: score,
        follows: 0,
        views: 0,
        year: new Date().getFullYear(),
        contentRating: '',
        chapters: ratedChapters,
        lastUpdated: String(
          getMyRatedLatestChapterUpdatedAt(row) ||
            row.updated_at ||
            new Date().toISOString(),
        ),
      });
    }

    return overlays.slice(0, MY_RATED_HOME_LIMIT);
  }, [myRatedHomeData, latestMerged, ongoingMerged, visibleMangaDexItems, isMangaDexUnavailable]);

  const ratingSlugs = useMemo(() => {
    const slugs = new Set<string>();
    [
      ...visibleFeatured.slice(0, 12),
      ...latestMerged.slice(0, 18),
      ...ongoingMerged.slice(0, 12),
      ...myRatedOverlayItems.slice(0, 24),
    ].forEach((m) => {
      const slug = String(m.id || '').trim();
      if (slug) slugs.add(slug);
    });
    return Array.from(slugs);
  }, [visibleFeatured, latestMerged, ongoingMerged, myRatedOverlayItems]);

  const { data: homeBatchRatingData } = useQuery({
    queryKey: ['rating', 'batch', 'home', ratingViewerKey, ratingSlugs],
    queryFn: async () => {
      if (!ratingSlugs.length) return { ratings: {} };
      try {
        return await fetchBatchRatingsParallel(ratingSlugs);
      } catch {
        return { ratings: {}, my_scores: {} };
      }
    },
    enabled: canRunHomeDeferredQueries && ratingSlugs.length > 0,
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const applyBatchRatings = useMemo(() => {
    return (items: Manga[]) => applyBatchRatingsPayload(items, homeBatchRatingData);
  }, [homeBatchRatingData]);

  const latestMergedRated = useMemo(
    () => applyBatchRatings(latestMerged),
    [latestMerged, applyBatchRatings],
  );

  const ongoingMergedRated = useMemo(
    () => applyBatchRatings(ongoingMerged),
    [ongoingMerged, applyBatchRatings],
  );

  const featuredRated = useMemo(
    () => applyBatchRatings(visibleFeatured),
    [visibleFeatured, applyBatchRatings],
  );

  const myRatedOverlayRated = useMemo(
    () => applyBatchRatings(myRatedOverlayItems),
    [myRatedOverlayItems, applyBatchRatings],
  );

  const { data: guestTopRatedData } = useQuery({
    queryKey: ['rating', 'top', 'guest', GUEST_TOP_RATED_LIMIT],
    queryFn: async () => {
      try {
        return await ratingApi.getTopRatedManga(GUEST_TOP_RATED_LIMIT);
      } catch {
        return { items: [] };
      }
    },
    enabled: canRunHomeDeferredQueries,
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedRows = useMemo<TopRatedGlobalItem[]>(
    () => (((guestTopRatedData as any)?.items || []) as TopRatedGlobalItem[])
      .filter(row => !isMangaDexUnavailable || !normalizeMangaDexId(row.manga_slug)),
    [guestTopRatedData, isMangaDexUnavailable],
  );

  const topRatedKnownLookup = useMemo(() => {
    const lookup = new Map<string, Manga>();
    const sources = dedupeById([
      ...featuredRated,
      ...latestMergedRated,
      ...ongoingMergedRated,
      ...visibleMangaDexItems,
    ]);
    for (const item of sources) {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key || lookup.has(key)) continue;
      lookup.set(key, item);
    }
    return lookup;
  }, [featuredRated, latestMergedRated, ongoingMergedRated, visibleMangaDexItems]);

  const guestTopRatedMissingSlugs = useMemo(() => {
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || '').trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      if (topRatedKnownLookup.has(slug)) continue;
      missing.push(slug);
      if (missing.length >= 6) break;
    }

    return missing;
  }, [guestTopRatedRows, topRatedKnownLookup]);

  const { data: guestTopRatedResolvedMap = {} } = useQuery({
    queryKey: ['rating', 'top', 'guest', 'card-metadata-v2', guestTopRatedMissingSlugs],
    queryFn: () => loadHomeCardMetadata(guestTopRatedMissingSlugs, queryClient),
    enabled: canRunHomeDeferredQueries && guestTopRatedMissingSlugs.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedItems = useMemo<Manga[]>(() => {
    const resolvedLookup = (guestTopRatedResolvedMap || {}) as Record<string, Manga>;
    const output: Manga[] = [];

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug)) continue;

      const trustedAverage = Number(row?.average || 0);
      const trustedCount = Number(row?.count || 0);

      const known = topRatedKnownLookup.get(slug);
      const resolved = resolvedLookup[slug];
      const base = resolved || known;

      if (base) {
        output.push({
          ...base,
          id: slug,
          rating: Number.isFinite(trustedAverage) ? trustedAverage : 0,
          ratingCount: Number.isFinite(trustedCount) ? trustedCount : 0,
          myRating: null,
          lastUpdated: String(row?.updated_at || base.lastUpdated || '').trim() || base.lastUpdated,
        });
        continue;
      }

      const nextItem: Manga = {
        id: slug,
        title: pickDisplayTitle(slug) || 'Chưa có tiêu đề',
        author: isMangaDexSlug(slug) ? 'MangaDex' : 'TruyenQQ',
        artist: isMangaDexSlug(slug) ? 'MangaDex' : 'TruyenQQ',
        description: '',
        cover: DEFAULT_CARD_COVER_FALLBACK,
        coverProxy: DEFAULT_CARD_COVER_FALLBACK,
        status: 'ongoing',
        type: 'manga',
        genres: [],
        tags: [],
        rating: Number.isFinite(trustedAverage) ? trustedAverage : 0,
        ratingCount: Number.isFinite(trustedCount) ? trustedCount : 0,
        myRating: null,
        follows: 0,
        views: 0,
        year: new Date().getFullYear(),
        chapters: [],
        lastUpdated: String(row?.updated_at || '').trim() || new Date().toISOString(),
        contentRating: '',
      };

      const hasResolvedTitle = Boolean(String(nextItem.title || '').trim()) && !isInvalidPublicMangaSlug(nextItem.title);
      const hasResolvedCover = Boolean(String(nextItem.cover || '').trim()) && !String(nextItem.cover || '').includes('no-cover');
      if (!hasResolvedTitle && !hasResolvedCover) continue;
      output.push(nextItem);
    }

    return dedupeById(output);
  }, [guestTopRatedRows, topRatedKnownLookup, guestTopRatedResolvedMap]);

  const guestTopRatedVisible = useMemo(
    () => (showMatureContent ? guestTopRatedItems : guestTopRatedItems.filter((m) => !isMatureManga(m))),
    [guestTopRatedItems, showMatureContent],
  );

  const guestTopRatedLookup = useMemo(() => {
    const lookup = new Map<string, Manga>();
    for (const item of guestTopRatedItems) {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key || lookup.has(key)) continue;
      lookup.set(key, item);
    }
    return lookup;
  }, [guestTopRatedItems]);

  const homeAggregateRatingMap = useMemo(
    () => ((homeBatchRatingData as any)?.ratings || {}) as Record<string, any>,
    [homeBatchRatingData],
  );

  const getTrustedAggregateFor = (manga: Manga) => {
    const rawId = String(manga.id || '').trim();
    const normId = rawId.toLowerCase();
    const aggregate =
      homeAggregateRatingMap[rawId] ||
      homeAggregateRatingMap[normId] ||
      homeAggregateRatingMap[`mdx-${normId}`];

    const average = Number(aggregate?.average ?? 0);
    const count = Number(aggregate?.count ?? 0);
    const hasAggregate =
      Number.isFinite(average) &&
      Number.isFinite(count) &&
      (count > 0 || average > 0);

    return {
      average: hasAggregate ? average : 0,
      count: hasAggregate ? count : 0,
      hasAggregate,
    };
  };

  const heroBannerItems = useMemo(() => {
    const merged = dedupeById([...featuredRated, ...homeBannerItems, ...latestMergedRated, ...ongoingMergedRated]);
    const visibleForBanner = showMatureContent
      ? merged
      : merged.filter((m) => !isEcchiManga(m));

    const featuredItems = visibleForBanner
      .filter((m) => Boolean(m.isFeatured))
      .sort((a, b) => {
        const featuredAtDiff = parseTime(b.featuredAt) - parseTime(a.featuredAt);
        if (featuredAtDiff !== 0) return featuredAtDiff;
        return chapterRecencyTime(b) - chapterRecencyTime(a);
      });

    const featuredBoostMap = new Map<string, number>();
    const totalFeatured = featuredItems.length;
    featuredItems.forEach((item, index) => {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key) return;
      // Pinned manga gets an explicit boost level.
      // If 1 pinned manga => boost +1, if N pinned mangas => boosts +N..+1.
      featuredBoostMap.set(key, Math.max(1, totalFeatured - index));
    });

    return [...visibleForBanner].sort((a, b) => {
      const keyA = String(a.id || '').trim().toLowerCase();
      const keyB = String(b.id || '').trim().toLowerCase();
      const boostA = featuredBoostMap.get(keyA) || 0;
      const boostB = featuredBoostMap.get(keyB) || 0;
      if (boostB !== boostA) return boostB - boostA;

      const featuredDiff = Number(Boolean(b.isFeatured)) - Number(Boolean(a.isFeatured));
      if (featuredDiff !== 0) return featuredDiff;

      const featuredAtDiff = parseTime(b.featuredAt) - parseTime(a.featuredAt);
      if (featuredAtDiff !== 0) return featuredAtDiff;

      const updatedDiff = chapterRecencyTime(b) - chapterRecencyTime(a);
      if (updatedDiff !== 0) return updatedDiff;
      return compareByPopular(a, b);
    });
  }, [featuredRated, homeBannerItems, latestMergedRated, ongoingMergedRated, showMatureContent]);

  const latestHomeDisplay = useMemo(() => {
    const heroMangaDexItems = heroBannerItems.slice(0, 5).filter((item) => {
      return Boolean(toMangaDexDetailId(String(item.id || '')));
    });
    return dedupeById([...heroMangaDexItems, ...latestMergedRated]).slice(0, 10);
  }, [heroBannerItems, latestMergedRated]);

  const { data: trendingPayload, isLoading: isTrendingLoading } = useQuery({
    queryKey: ['manga', 'home', 'trending-popular-v3', HOME_POPULAR_TRENDING_FETCH_LIMIT],
    queryFn: async () => {
      try {
        return await mangaApi.getTrending(HOME_POPULAR_TRENDING_FETCH_LIMIT, 'all');
      } catch {
        return { trending: [] };
      }
    },
    enabled: canRunHomeDeferredQueries,
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const trendingRows = useMemo<TrendingMangaItem[]>(
    () => (((trendingPayload as any)?.trending || []) as TrendingMangaItem[])
      .filter(row => !isMangaDexUnavailable || !normalizeMangaDexId(row.slug)),
    [trendingPayload, isMangaDexUnavailable],
  );

  const popularFromTrending = useMemo<Manga[]>(() => {
    if (!trendingRows.length) return [];

    const output: Manga[] = [];
    const seen = new Set<string>();

    for (const row of trendingRows) {
      const slug = String(row.slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug)) continue;

      const detailId = toMangaDexDetailId(slug);
      const itemId = detailId || slug;
      if (seen.has(itemId)) continue;
      seen.add(itemId);

      const base =
        getMangaFromLookup(topRatedKnownLookup, slug) ||
        getMangaFromLookup(guestTopRatedLookup, slug);
      const rawThumb = toAbsoluteThumbUrl(String(row.thumb || '').trim());
      const isMdx = Boolean(detailId);
      const cover = rawThumb
        ? (isMdx ? toMangaDexCoverProxy(rawThumb, detailId || slug) : thumbUrl(rawThumb, detailId || slug))
        : (base?.cover || DEFAULT_CARD_COVER_FALLBACK);
      const coverProxy = rawThumb
        ? (isMdx ? DEFAULT_CARD_COVER_FALLBACK : thumbFallbackUrl(rawThumb, slug) || rawThumb)
        : (base?.coverProxy || DEFAULT_CARD_COVER_FALLBACK);
      const rowGenres = Array.isArray(row.genres)
        ? row.genres.map((genre) => repairMojibakeText(genre).trim()).filter(Boolean)
        : [];
      const rowTags = Array.isArray(row.tags)
        ? row.tags.map((tag) => repairMojibakeText(tag).trim()).filter(Boolean)
        : [];
      const trendingChapters = buildTrendingChapter(itemId, row);
      const views = normalizeTrendingViews(row, isMdx);
      const lastUpdated = getTrendingUpdatedAt(row) || base?.lastUpdated || '';

      const nextItem: Manga = {
        ...(base || {
          id: itemId,
          title: pickDisplayTitle(itemId, row.title) || 'Chưa có tiêu đề',
          author: isMdx ? 'MangaDex' : 'TruyenQQ',
          artist: isMdx ? 'MangaDex' : 'TruyenQQ',
          description: '',
          status: mapTrendingStatus(row.status),
          type: 'manga' as const,
          rating: 0,
          ratingCount: 0,
          myRating: null,
          follows: 0,
          year: new Date().getFullYear(),
        }),
        id: itemId,
        title: pickDisplayTitle(itemId, base?.title, row.title) || base?.title || 'Chưa có tiêu đề',
        cover,
        coverProxy,
        genres: rowGenres.length ? rowGenres : (base?.genres || []),
        tags: rowTags.length ? rowTags : (base?.tags || []),
        status: base?.status || mapTrendingStatus(row.status),
        views,
        chapters: trendingChapters.length ? trendingChapters : (base?.chapters || []),
        lastUpdated,
        contentRating: String(row.content_rating || row.contentRating || base?.contentRating || '').trim().toLowerCase(),
        isMature: Boolean(row.is_mature ?? row.isMature ?? base?.isMature),
        is_mature: Boolean(row.is_mature ?? row.isMature ?? (base as any)?.is_mature),
      };

      const hasResolvedTitle = Boolean(String(nextItem.title || '').trim()) && !isInvalidPublicMangaSlug(nextItem.title);
      const hasResolvedCover = Boolean(String(nextItem.cover || '').trim()) && !String(nextItem.cover || '').includes('no-cover');
      if (!hasResolvedTitle && !hasResolvedCover) continue;
      output.push(nextItem);
    }

    const visible = showMatureContent ? output : output.filter((item) => !isMatureManga(item));
    return visible.sort(compareByPopular).slice(0, HOME_POPULAR_LIMIT);
  }, [trendingRows, topRatedKnownLookup, guestTopRatedLookup, showMatureContent]);

  const popular = useMemo(
    () => dedupeById([...featuredRated, ...latestMergedRated, ...ongoingMergedRated]).sort(compareByPopular),
    [featuredRated, latestMergedRated, ongoingMergedRated],
  );
  const popularVisible = useMemo(
    () => mergeUniqueMangaById(popularFromTrending, popular, HOME_POPULAR_LIMIT),
    [popularFromTrending, popular],
  );
  const popularRatingSlugs = useMemo(
    () => Array.from(new Set(
      popularVisible
        .map((item) => String(item.id || '').trim().toLowerCase())
        .filter(Boolean),
    )),
    [popularVisible],
  );
  const { data: popularBatchRatingData } = useQuery({
    queryKey: ['rating', 'batch', 'home-popular', ratingViewerKey, popularRatingSlugs],
    queryFn: async () => {
      if (!popularRatingSlugs.length) return { ratings: {}, my_scores: {} };
      try {
        return await fetchBatchRatingsParallel(popularRatingSlugs);
      } catch {
        return { ratings: {}, my_scores: {} };
      }
    },
    enabled: canRunHomeDeferredQueries && popularRatingSlugs.length > 0,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const popularRatedVisible = useMemo(
    () => applyBatchRatingsPayload(popularVisible, popularBatchRatingData),
    [popularVisible, popularBatchRatingData],
  );
  const popularMangaDexIds = useMemo(() => {
    const ids = new Set<string>();

    for (const item of popularRatedVisible) {
      const detailId = toMangaDexDetailId(String(item.id || ''));
      if (!detailId) continue;
      ids.add(detailId);
    }

    return Array.from(ids);
  }, [popularRatedVisible]);

  const { data: popularMangaDexChapterMap = {} } = useQuery({
    queryKey: ['manga', 'index', 'popular-mangadex-latest-chapter-v2', popularMangaDexIds],
    queryFn: () => fetchMangaDexLatestChapterMetaMap(popularMangaDexIds, 3),
    enabled: canRunHomeDeferredQueries && popularMangaDexIds.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const popularDisplay = useMemo(
    () => syncMangaDexLatestChapters(popularRatedVisible, popularMangaDexChapterMap as Record<string, MangaDexLatestChapterMeta>),
    [popularRatedVisible, popularMangaDexChapterMap],
  );

  const topRatedBase = canUseUserRatings
    ? dedupeById([...ongoingMergedRated, ...latestMergedRated, ...myRatedOverlayRated])
    : dedupeById([...ongoingMergedRated, ...latestMergedRated]);
  const topRatedCandidates = topRatedBase
    .sort((a, b) => {
      const aMyRating = Number(a.myRating || 0);
      const bMyRating = Number(b.myRating || 0);
      const aAggregate = getTrustedAggregateFor(a);
      const bAggregate = getTrustedAggregateFor(b);
      const aScore = aMyRating > 0 ? aMyRating : aAggregate.average;
      const bScore = bMyRating > 0 ? bMyRating : bAggregate.average;

      const ratingDiff = bScore - aScore;
      if (ratingDiff !== 0) return ratingDiff;

      const countDiff = bAggregate.count - aAggregate.count;
      if (countDiff !== 0) return countDiff;

      return (b.views || 0) - (a.views || 0);
    });
  const topRatedWithScores = topRatedCandidates.filter(
    (m) => {
      const aggregate = getTrustedAggregateFor(m);
      const myRating = Number(m.myRating || 0);
      return aggregate.hasAggregate || (canUseUserRatings && myRating > 0);
    },
  );
  const topRated = dedupeById([...guestTopRatedVisible, ...topRatedWithScores]);
  const topRatedVisible = topRated.slice(0, 6);

  const topRatedMangaDexIds = useMemo(() => {
    const ids = new Set<string>();

    for (const item of topRatedVisible) {
      const detailId = toMangaDexDetailId(String(item.id || ''));
      if (!detailId) continue;
      ids.add(detailId);
    }

    return Array.from(ids);
  }, [topRatedVisible]);

  const { data: topRatedMangaDexChapterMap = {} } = useQuery({
    queryKey: ['manga', 'index', 'top-rated-mangadex-latest-chapter-v4', topRatedMangaDexIds],
    queryFn: () => fetchMangaDexLatestChapterMetaMap(topRatedMangaDexIds, 3),
    enabled: canRunHomeDeferredQueries && topRatedMangaDexIds.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const topRatedDisplay = useMemo(() => {
    const candidates = isMangaDexUnavailable
      ? dedupeById([...topRated, ...[...popular].sort((a, b) => b.rating - a.rating)]).slice(0, 6)
      : topRated;
    return syncMangaDexLatestChapters(candidates, topRatedMangaDexChapterMap as Record<string, MangaDexLatestChapterMeta>);
  }, [topRated, topRatedMangaDexChapterMap, isMangaDexUnavailable, popular]);

  const isHomeSynchronizedLoading = !heroBannerItems.length &&
    (isInitialMergedLoading || (!isMangaDexUnavailable && isHomeBannerLoading) || (needsQQFallback && isQQFallbackLoading));
  const isTopRatedSectionLoading = isHomeSynchronizedLoading;

  const homeCoverWarmupUrls = useMemo(() => {
    return collectWarmupCoverUrls(
      dedupeById([
        ...heroBannerItems.slice(0, 5),
        ...latestMergedRated.slice(0, 10),
        ...popularDisplay.slice(0, 12),
        ...topRatedDisplay.slice(0, 6),
      ]),
      18,
    );
  }, [heroBannerItems, latestMergedRated, popularDisplay, topRatedDisplay]);

  useEffect(() => {
    if (!canRunHomeDeferredQueries || !homeCoverWarmupUrls.length) return;
    const timers = homeCoverWarmupUrls
      .reduce<string[][]>((chunks, url, index) => {
        const chunkIndex = Math.floor(index / 6);
        if (!chunks[chunkIndex]) chunks[chunkIndex] = [];
        chunks[chunkIndex].push(url);
        return chunks;
      }, [])
      .map((chunk, index) => window.setTimeout(() => preloadCoverCache(chunk), 1200 + index * 900));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [canRunHomeDeferredQueries, homeCoverWarmupUrls]);

  const isHeroBannerLoading = isHomeSynchronizedLoading;

  return (
    <ImageFailureContext.Provider value={reportHomeImageFailure}>
    <div className="min-h-screen">
      <HomeAnnouncementPopup key={activeAnnouncement?.id || 'none'} announcement={activeAnnouncement} />
      <section className="container mx-auto px-4 pt-5">
        {isHeroBannerLoading ? (
          <div className="h-[340px] bg-muted rounded-2xl animate-pulse" />
        ) : heroBannerItems.length > 0 ? (
          <HeroSlider manga={heroBannerItems.slice(0, 5)} />
        ) : (
          <div className="h-[340px] bg-muted rounded-2xl flex items-center justify-center">
            {isHomepageError && isHomeBannerError ? (
              <div className="text-center space-y-3">
                <p className="text-muted-foreground font-medium">Chưa tải được truyện. Vui lòng thử lại.</p>
                <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground" onClick={() => { void refetchHomepageCombined(); void refetchHomeBanner(); if (needsQQFallback) void refetchQQFallback(); }}>Thử lại</button>
              </div>
            ) : <p className="text-muted-foreground font-medium">Chưa có truyện để hiển thị.</p>}
          </div>
        )}
      </section>

      <div className="container mx-auto px-4 mt-10 space-y-10 pb-16">
        <Section title="Mới cập nhật" link="/manga?sort=latest">
          {isHomeSynchronizedLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <SkeletonHorizontal />
              <SkeletonHorizontal />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
              <MangaGrid manga={latestHomeDisplay.slice(0, 5)} variant="horizontal" />
              <MangaGrid manga={latestHomeDisplay.slice(5, 10)} variant="horizontal" />
            </div>
          )}
        </Section>

        <Section title="Phổ biến nhất" link="/manga?sort=popular">
          {isHomeSynchronizedLoading || (isTrendingLoading && !popularVisible.length)
            ? <SkeletonGrid count={12} />
            : <MangaGrid manga={popularDisplay} lazyBatch initialBatchSize={6} batchStep={6} batchDelayMs={240} />}
        </Section>

        <Section title="Đánh giá cao" link="/manga?sort=rating">
          {isTopRatedSectionLoading
            ? <SkeletonGrid />
            : <MangaGrid manga={topRatedDisplay.slice(0, 6)} lazyBatch initialBatchSize={4} batchStep={2} batchDelayMs={220} />}
        </Section>

        <Section title="Mới thêm gần đây" link="/manga">
          {isHomeSynchronizedLoading ? <SkeletonGrid /> : <MangaGrid manga={latestHomeDisplay.slice(0, 6)} lazyBatch initialBatchSize={4} batchStep={2} batchDelayMs={220} />}
        </Section>

        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="accent-line" />
            <h2 className="ed-heading text-2xl">Thể loại</h2>
          </div>
          <div className="ed-card p-5">
            <GenreCloud />
          </div>
        </section>
      </div>
    </div>
    </ImageFailureContext.Provider>
  );
};

const Section = ({ title, link, children }: { title: string; link: string; children: React.ReactNode }) => (
  <motion.section
    initial={{ opacity: 0, y: 14 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: '-40px' }}
    transition={{ duration: 0.4 }}
  >
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-3">
        <div className="accent-line" />
        <h2 className="ed-heading text-2xl">{title}</h2>
      </div>
      <Link to={link} className="flex items-center gap-1 text-xs text-primary font-semibold hover:underline transition-all">
        Xem tất cả <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
    {children}
  </motion.section>
);

export default Index;
