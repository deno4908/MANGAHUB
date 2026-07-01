import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMangaStore } from '@/store/mangaStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUserStore } from '@/store/userStore';
import { useCategoryManga, useCategories } from '@/hooks/useApi';
import { mangaApi, ratingApi } from '@/lib/api';
import { adaptListData, adaptMangaDetail, thumbFallbackUrl, thumbUrl } from '@/lib/adapters';
import { isMatureManga } from '@/lib/contentFilter';
import {
  getMangaSource,
  normalizeMangaDexId,
  normalizeOTruyenObjectId,
  toOTruyenRouteId,
} from '@/lib/mangaLinks';
import MangaGrid from '@/components/manga/MangaGrid';
import FilterPanel from '@/components/manga/FilterPanel';
import MangaPagination from '@/components/manga/MangaPagination';
import { MangaGridSkeleton } from '@/components/manga/Skeletons';
import { SlidersHorizontal, X, BookOpen, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Manga } from '@/types/manga';
import type { SortOption } from '@/types/manga';

const normalizeTag = (value: string) =>
  (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim();

const toSlug = (value: string) => normalizeTag(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type MangaDexCatalogItem = {
  id: string;
  url?: string;
  title: string;
  cover_url?: string;
  authors_text?: string;
  year?: number | string;
  updated_at?: string;
  local_last_published_at?: string;
  view_count?: number | string;
  views?: number | string;
  local_view_count?: number | string;
  content_rating?: string;
  contentRating?: string;
  is_mature?: boolean;
  isMature?: boolean;
  last_chapter?: string;
  latest_chapter?: string;
  chapter_newest?: string;
  mangadex_popularity_rank?: number | string;
  mangadex_popularity_score?: number | string;
  popularity_score?: number | string;
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
type OTruyenListData = ReturnType<typeof adaptListData>;
type BrowseSourceTab = 'otruyen' | 'mangadex';
const MANGADEX_CATALOG_LIMIT_DEFAULT = 500;
const MANGADEX_CATALOG_LIMIT_WITH_MATURE = 800;
const MANGADEX_CATALOG_LIMIT_TAB_DEFAULT = 10000;
const MANGADEX_CATALOG_LIMIT_TAB_WITH_MATURE = 10000;
const POPULAR_MANGADEX_CATALOG_LIMIT_CAP = 500;
const BROWSE_PAGE_SIZE = 24;
const RATING_SORT_BATCH_MAX = 140;
const MDX_SLOT_DEFAULT = 12;
const MDX_SLOT_FIRST_WINDOW = 18;
const CONTINUOUS_SORT_WINDOW_PAGES = 20;
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const MY_RATED_BATCH_MAX = 180;
const POPULAR_TRENDING_LIMIT = 300;
const POPULAR_TRENDING_TIMEOUT_MS = 9_000;
const POPULAR_TRENDING_FALLBACK_LIMIT = 80;
const POPULAR_TRENDING_FALLBACK_TIMEOUT_MS = 4_500;
const GLOBAL_SORT_FETCH_CHUNK = 24;
const GLOBAL_SORT_FETCH_MAX_PAGES = 3000;
const MANGADEX_CATALOG_LIMIT_LIGHT_DEFAULT = 500;
const MANGADEX_CATALOG_LIMIT_LIGHT_WITH_MATURE = 800;
const MANGADEX_DEMAND_INITIAL_PAGES = 16;
const MANGADEX_DEMAND_INITIAL_LIMIT = 3000;
const MANGADEX_DEMAND_STEP_PAGES = 6;
const MANGADEX_DEMAND_LIMIT_STEP = Math.ceil((BROWSE_PAGE_SIZE * MANGADEX_DEMAND_STEP_PAGES * 1.35) / 100) * 100;
const MANGADEX_DEMAND_PREFETCH_PAGES = 5;
const MANGADEX_DEMAND_PREFETCH_ITEMS = BROWSE_PAGE_SIZE * MANGADEX_DEMAND_PREFETCH_PAGES;
const MANGADEX_DEMAND_EDGE_REFETCH_PAGES = 7;
const MANGADEX_DEMAND_EDGE_REFETCH_ITEMS = BROWSE_PAGE_SIZE * MANGADEX_DEMAND_EDGE_REFETCH_PAGES;
const MANGADEX_DEMAND_EDGE_REFETCH_DELAY_MS = 2500;
const MANGADEX_DEMAND_EDGE_REFETCH_COOLDOWN_MS = 15000;
const MANGADEX_DEMAND_EDGE_DELAY_MS = 80;
const MANGADEX_DEMAND_ADVANCE_COOLDOWN_MS = 1800;
const MANGADEX_DEMAND_BACKGROUND_DELAY_MS = 1000;
const MANGADEX_DEMAND_BACKGROUND_LIMIT = 6000;
const MANGADEX_DEMAND_FILTERED_INITIAL_LIMIT = 6000;
const MANGADEX_DEMAND_FILTERED_LIMIT_STEP = 1000;
const MANGADEX_CATALOG_QUERY_VERSION = 'v20260426-demand-small-batches';
const DEFAULT_CARD_COVER_FALLBACK = '/no-cover.svg';
const MANGADEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATING_BATCH_CHUNK_SIZE = 40;
const RATING_BATCH_WAVE_SIZE = 3;
const RATING_BATCH_TIMEOUT_MS = 5_500;
const REAL_CHAPTER_SYNC_MAX = 12;
const REAL_CHAPTER_SYNC_TIMEOUT_MS = 6_000;
const MANGADEX_ENRICH_MAX = 6;
const MANGADEX_VISIBLE_CHAPTER_FALLBACK_MAX = BROWSE_PAGE_SIZE;
const MANGADEX_VISIBLE_CHAPTER_FALLBACK_CONCURRENCY = 3;
const MANGADEX_VISIBLE_CHAPTER_FALLBACK_CHAPTERS = 20;
const MANGADEX_VISIBLE_CHAPTER_FALLBACK_TIMEOUT_MS = 8_000;
const GUEST_TOP_RATED_LIMIT = 120;
const GUEST_TOP_RATED_RESOLVE_MAX = 36;
const MOJIBAKE_RE = /[ÃÂÄÅÆÐ]/;
const NON_ASCII_RE = /[^\x00-\x7f]/;

type MyRatedMangaItem = {
  manga_slug: string;
  score: number;
  year?: number | string;
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
  views?: number;
  genres?: string[];
  tags?: string[];
  status?: string;
  latest_chapter?: string;
  latest_chapter_updated_at?: string;
  latestChapterUpdatedAt?: string;
  last_updated?: string;
  lastUpdated?: string;
  content_rating?: string;
  contentRating?: string;
  is_mature?: boolean;
  isMature?: boolean;
};

const mojibakeScore = (value: string): number =>
  (String(value || '').match(MOJIBAKE_RE) || []).length;

const repairMojibakeText = (value: unknown): string => {
  const text = String(value || '');
  if (!text || mojibakeScore(text) === 0) return text;

  const candidates = [text];
  try {
    const bytes = Uint8Array.from(Array.from(text).map((ch) => ch.charCodeAt(0) & 0xff));
    const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (fixed) candidates.push(fixed);
  } catch {
    // keep original text
  }

  let best = text;
  let bestScore = mojibakeScore(text);
  for (const candidate of candidates.slice(1)) {
    const score = mojibakeScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

const normalizeLooseText = (value: string): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseBrowsePageParam = (value: string | null): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  const normalized = Math.floor(parsed);
  return normalized >= 1 ? normalized : 1;
};

const BROWSE_PAGE_MEMORY_STORAGE_KEY = 'mb:browse-page-memory:v1';

type BrowsePageMemoryFilters = {
  genres: string[];
  status: string | null;
  year: number | null;
  minRating: number;
  sort: SortOption;
  search: string;
};

const buildBrowsePageMemoryKey = (source: BrowseSourceTab, filters: BrowsePageMemoryFilters): string => {
  const genres = [...(filters.genres || [])].map((genre) => String(genre).trim().toLowerCase()).sort().join(',');
  const search = String(filters.search || '').trim().toLowerCase();
  return [
    source,
    filters.sort || 'popular',
    search,
    genres,
    filters.status || '',
    filters.year || '',
    filters.minRating || 0,
  ].join('|');
};

const readBrowsePageMemory = (): Record<string, number> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(BROWSE_PAGE_MEMORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const getRememberedBrowsePage = (key: string): number => {
  const page = Number(readBrowsePageMemory()[key]);
  return Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
};

const rememberBrowsePage = (key: string, page: number) => {
  if (typeof window === 'undefined' || !key) return;
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  try {
    const memory = readBrowsePageMemory();
    if (safePage <= 1) {
      delete memory[key];
    } else {
      memory[key] = safePage;
    }

    const entries = Object.entries(memory);
    const trimmed = entries.length > 80 ? Object.fromEntries(entries.slice(-80)) : memory;
    sessionStorage.setItem(BROWSE_PAGE_MEMORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore unavailable sessionStorage.
  }
};

const isMangaDexCoverUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith('uploads.mangadex.org') || host.endsWith('mangadex.network');
  } catch {
    return false;
  }
};

const isNoCoverValue = (value?: string): boolean => {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (raw === DEFAULT_CARD_COVER_FALLBACK) return true;
  return raw.endsWith('/no-cover.svg');
};

const extractMangaDexDetailId = (value: string): string | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const direct = normalizeMangaDexId(normalized);
  if (direct) return direct;

  const embedded = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return embedded ? normalizeMangaDexId(embedded[0]) : null;
};

const isMangaDexSlug = (slug: string): boolean => Boolean(extractMangaDexDetailId(slug));

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

const normalizePublicMangaSlug = (value: unknown): string =>
  String(value || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');

const isInvalidPublicMangaSlug = (value: unknown): boolean => {
  const normalized = normalizePublicMangaSlug(value);
  if (!normalized || normalized.length < 3) return true;
  if (isMangaDexSlug(normalized)) return false;
  return INVALID_PUBLIC_MANGA_SLUGS.has(normalized);
};

const hasSyntheticRouteCover = (value: unknown): boolean => {
  const raw = String(value || '').trim().toLowerCase();
  return /(?:^|[/?=&%-])(browse|random|undefined|null|none)-thumb\./.test(raw);
};

const isUnresolvedPublicManga = (item: Manga): boolean => {
  if (isInvalidPublicMangaSlug(item.id)) return true;

  const normalizedTitle = normalizeLooseText(repairMojibakeText(item.title));
  const cover = String(item.cover || '').trim();
  const coverProxy = String(item.coverProxy || '').trim();
  const genericTitle =
    !normalizedTitle ||
    normalizedTitle === 'chua co tieu de' ||
    normalizedTitle === 'dang cap nhat' ||
    normalizedTitle === 'mangadex' ||
    normalizedTitle === 'untitled' ||
    normalizedTitle === 'no title';
  const noRealCover = isNoCoverValue(cover) && isNoCoverValue(coverProxy);
  return genericTitle && (noRealCover || hasSyntheticRouteCover(cover) || hasSyntheticRouteCover(coverProxy));
};

const isItemInBrowseSource = (item: Pick<Manga, 'id' | 'source'>, source: BrowseSourceTab): boolean => {
  const slug = String(item.id || '').trim().toLowerCase();
  if (isInvalidPublicMangaSlug(slug)) return false;
  const isMdx = getMangaSource(slug, item.source) === 'mangadex';
  return source === 'mangadex' ? isMdx : !isMdx;
};

const toMangaDexDetailId = (slug: string): string => extractMangaDexDetailId(slug) || '';

const addBrowseAliasKey = (keys: Set<string>, value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return;
  keys.add(raw);

  const mdxId = normalizeMangaDexId(raw);
  if (mdxId) {
    keys.add(mdxId);
    keys.add(`mdx-${mdxId}`);
    return;
  }

  const objectId = normalizeOTruyenObjectId(raw);
  if (objectId) {
    keys.add(objectId);
    const routeId = toOTruyenRouteId(objectId);
    if (routeId) keys.add(routeId.toLowerCase());
  }
};

const getBrowseAliasKeys = (itemOrSlug: Partial<Manga> | string | null | undefined): string[] => {
  const keys = new Set<string>();
  if (typeof itemOrSlug === 'string') {
    addBrowseAliasKey(keys, itemOrSlug);
  } else if (itemOrSlug) {
    addBrowseAliasKey(keys, itemOrSlug.id);
    addBrowseAliasKey(keys, (itemOrSlug as any).slug);
    addBrowseAliasKey(keys, (itemOrSlug as any).manga_slug);
    addBrowseAliasKey(keys, (itemOrSlug as any).mangaSlug);
    addBrowseAliasKey(keys, (itemOrSlug as any)._id);
  }
  return [...keys].filter((key) => !isInvalidPublicMangaSlug(key));
};

const getMappedNumberByAlias = (
  map: Map<string, number>,
  itemOrSlug: Partial<Manga> | string,
  mode: 'max' | 'min' = 'max',
): number | undefined => {
  let best: number | undefined;
  for (const key of getBrowseAliasKeys(itemOrSlug)) {
    const value = map.get(key);
    if (value === undefined) continue;
    best = best === undefined
      ? value
      : mode === 'min'
        ? Math.min(best, value)
        : Math.max(best, value);
  }
  return best;
};

const toAbsoluteThumbUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/api/')) return `${API_BASE}${raw}`;
  return raw;
};

const toImageProxyUrl = (value: string): string =>
  `${API_BASE}/api/images/img?url=${encodeURIComponent(value)}`;

const extractImageProxyTargetUrl = (value?: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw, API_BASE);
    if (!parsed.pathname.toLowerCase().includes('/api/images/img')) return '';

    const encodedTarget = String(parsed.searchParams.get('url') || '').trim();
    if (!encodedTarget) return '';

    if (/^https?:\/\//i.test(encodedTarget)) {
      return encodedTarget;
    }

    const decoded = decodeURIComponent(encodedTarget);
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
};

// Return direct CDN URL — faster, no proxy cold-start latency
const toMangaDexCoverDirect = (coverUrl?: string): string => {
  const raw = String(coverUrl || '').trim();
  if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
  return '';
};

// Proxy URL used as fallback when direct CDN fails
const toMangaDexCoverProxy = (coverUrl?: string, mangaId?: string): string => {
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

const parseRelativeTime = (value: string): number => {
  const normalized = normalizeLooseText(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;

  const now = Date.now();
  if (normalized === 'vua xong' || normalized === 'just now') return now;
  if (!/\b(truoc|ago)\b/.test(normalized)) return 0;

  const match = normalized.match(/(\d+)\s*(giay|second|phut|minute|gio|hour|h|ngay|day|tuan|week|thang|month|nam|year)/);
  if (!match) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const unit = match[2];
  const unitMs =
    unit === 'giay' || unit === 'second'
      ? 1000
      : unit === 'phut' || unit === 'minute'
        ? 60 * 1000
        : unit === 'gio' || unit === 'hour' || unit === 'h'
          ? 60 * 60 * 1000
          : unit === 'ngay' || unit === 'day'
            ? 24 * 60 * 60 * 1000
            : unit === 'tuan' || unit === 'week'
              ? 7 * 24 * 60 * 60 * 1000
              : unit === 'thang' || unit === 'month'
                ? 30 * 24 * 60 * 60 * 1000
                : 365 * 24 * 60 * 60 * 1000;

  return now - amount * unitMs;
};

const parseTime = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) {
    const maxFuture = Date.now() + 2 * 24 * 60 * 60 * 1000;
    return ts > maxFuture ? 0 : ts;
  }

  const relativeTs = parseRelativeTime(raw);
  if (relativeTs > 0) return relativeTs;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const maxFuture = Date.now() + 2 * 24 * 60 * 60 * 1000;
    return millis > maxFuture ? 0 : millis;
  }

  return 0;
};

const looksLikeRelativeTimeLabel = (normalizedValue: string): boolean =>
  /\b(ago|truoc|trc|gio|phut|ngay|tuan|thang|nam|h)\b/.test(normalizedValue);

const parseChapterNumberFromText = (value: unknown): number => {
  const raw = repairMojibakeText(value ?? '').trim();
  if (!raw) return 0;

  const direct = Number(raw.replace(',', '.'));
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const normalized = normalizeLooseText(raw);
  if (!normalized) return 0;

  const keywordMatch = normalized.match(/\b(?:chapter|chuong|ch)\.?\s*(\d+(?:[.,]\d+)?)/i);
  if (keywordMatch) {
    const parsed = Number(keywordMatch[1].replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  if (looksLikeRelativeTimeLabel(normalized)) return 0;

  const leadingMatch = normalized.match(/^(\d+(?:[.,]\d+)?)(?=$|[\s)\]-])/);
  if (!leadingMatch) return 0;

  const parsed = Number(leadingMatch[1].replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const isValidChapterNumber = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

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

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
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

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toValidYear = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const year = Math.trunc(parsed);
  const maxYear = new Date().getFullYear() + 1;
  if (year < 1900 || year > maxYear) return 0;
  return year;
};

const yearFromTimestamp = (value?: string): number => {
  const ts = parseTime(value);
  if (ts <= 0) return 0;
  return toValidYear(new Date(ts).getFullYear());
};

const resolveMangaDexYear = (item: MangaDexCatalogItem): number =>
  toValidYear((item as any).year) || yearFromTimestamp(item.updated_at) || 0;

const isSlugLikeTitle = (title: string, slug: string): boolean => {
  const rawTitle = String(title || '').trim();
  const normalizedTitle = normalizeLooseText(repairMojibakeText(title));
  const normalizedSlug = normalizeLooseText(slug).replace(/\s+/g, '-');
  if (!normalizedTitle) return !NON_ASCII_RE.test(rawTitle);
  if (normalizedTitle === normalizedSlug.replace(/-/g, ' ') && !NON_ASCII_RE.test(rawTitle)) return true;
  if (normalizedTitle === `mdx ${normalizedSlug.replace(/-/g, ' ')}`) return true;
  if (MANGADEX_ID_RE.test(normalizedTitle.replace(/\s+/g, '-'))) return true;
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

const titlePreferenceScore = (value: string): number => {
  const text = String(value || '').trim();
  if (!text) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (NON_ASCII_RE.test(text)) score += 4;
  score += mojibakeScore(text) === 0 ? 2 : -Math.min(2, mojibakeScore(text));
  score += Math.min(text.length, 80) / 80;
  return score;
};

const pickDisplayTitle = (slug: string, ...candidates: Array<string | undefined>): string => {
  let best = '';
  let bestScore = Number.NEGATIVE_INFINITY;
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

    const score = titlePreferenceScore(text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }

  return best || fallback || humanizeSlugTitle(slug);
};

const getTrendingCoverSources = (item: { slug?: string; thumb?: string }): { cover: string; coverProxy?: string } => {
  const slug = String(item.slug || '').trim().toLowerCase();
  const isMdx = isMangaDexSlug(slug);
  const rawThumb = toAbsoluteThumbUrl(String(item.thumb || '').trim());

  if (rawThumb) {
    if (/^https?:\/\//i.test(rawThumb)) {
      const proxyTarget = extractImageProxyTargetUrl(rawThumb);
      if (proxyTarget) {
        return {
          cover: rawThumb,
          coverProxy: proxyTarget,
        };
      }

      if (isMangaDexCoverUrl(rawThumb)) {
        return {
          cover: toMangaDexCoverProxy(rawThumb, slug),
          coverProxy: DEFAULT_CARD_COVER_FALLBACK,
        };
      }

      const proxyFallback = toImageProxyUrl(rawThumb);
      return {
        cover: rawThumb,
        coverProxy: proxyFallback !== rawThumb ? proxyFallback : DEFAULT_CARD_COVER_FALLBACK,
      };
    }

    const proxiedCover = thumbUrl(rawThumb, slug);
    const inferredProxyTarget = extractImageProxyTargetUrl(proxiedCover);

    return {
      cover: isMdx ? (toMangaDexCoverProxy(rawThumb, slug) || proxiedCover) : proxiedCover,
      coverProxy: isMdx
        ? DEFAULT_CARD_COVER_FALLBACK
        : (thumbFallbackUrl(rawThumb, slug) || inferredProxyTarget || DEFAULT_CARD_COVER_FALLBACK),
    };
  }

  if (isMdx) {
    return { cover: DEFAULT_CARD_COVER_FALLBACK, coverProxy: DEFAULT_CARD_COVER_FALLBACK };
  }

  const guessed = thumbUrl('', slug);
  return {
    cover: guessed || DEFAULT_CARD_COVER_FALLBACK,
    coverProxy: DEFAULT_CARD_COVER_FALLBACK,
  };
};

const normalizeTrendingList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => repairMojibakeText(entry).trim())
    .filter(Boolean);
};

const getTrendingContentRating = (row: TrendingMangaItem): string =>
  String(row.content_rating || row.contentRating || '').trim().toLowerCase();

const mapTrendingStatus = (value?: string): Manga['status'] => {
  const normalized = normalizeLooseText(repairMojibakeText(value || ''));
  if (!normalized) return 'ongoing';
  if (normalized.includes('hoan thanh') || normalized.includes('completed')) return 'completed';
  if (normalized.includes('sap') || normalized.includes('tam') || normalized.includes('hiatus')) return 'hiatus';
  return 'ongoing';
};

const resolveTrendingTimestamp = (
  row: TrendingMangaItem,
  fallbackTimestamp?: string,
): string => {
  for (const candidate of [
    row.latest_chapter_updated_at,
    row.latestChapterUpdatedAt,
    row.last_updated,
    row.lastUpdated,
    fallbackTimestamp,
  ]) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    if (parseTime(raw) > 0) return raw;
  }
  return '';
};

const buildTrendingChapterFallback = (
  slug: string,
  row: TrendingMangaItem,
  status: Manga['status'],
  uploadDate?: string,
): Manga['chapters'] => {
  const chapterRaw = repairMojibakeText(row.latest_chapter).trim();
  const safeDate = resolveTrendingTimestamp(row, uploadDate);

  if (chapterRaw) {
    const chapterNum = parseChapterNumberFromText(chapterRaw);
    if (isValidChapterNumber(chapterNum)) {
      return [{
        id: `ch-${slug}-trending`,
        mangaId: slug,
        number: chapterNum,
        title: chapterLabelFromNumber(chapterNum),
        pages: [],
        uploadDate: safeDate || '',
        scanlationGroup: '',
      }];
    }
  }

  if (status === 'hiatus') {
    return [{
      id: `ch-${slug}-coming-soon`,
      mangaId: slug,
      number: -2,
      title: 'Sắp ra mắt',
      pages: [],
      uploadDate: safeDate || '',
      scanlationGroup: '',
    }];
  }

  return [];
};

type MangaDexEnrichMeta = {
  cover?: string;
  coverProxy?: string;
  genres?: string[];
  tags?: string[];
  status?: Manga['status'];
  latestChapter?: Manga['chapters'][number];
  lastUpdated?: string;
  contentRating?: string;
};

type RealChapterSyncMeta = {
  latestChapter?: Manga['chapters'][number];
  lastUpdated?: string;
};

const hasReadableChapter = (chapter?: Manga['chapters'][number]): boolean => {
  if (!chapter) return false;
  return Number.isFinite(chapter.number) && chapter.number >= 0;
};

const pickLatestReadableChapter = (
  chapters: Manga['chapters'],
): Manga['chapters'][number] | undefined => {
  if (!Array.isArray(chapters) || chapters.length === 0) return undefined;

  const candidates = chapters.filter((chapter) => hasReadableChapter(chapter));
  if (!candidates.length) return undefined;

  return [...candidates].sort((a, b) => {
    const numberDiff = toNumber(b.number) - toNumber(a.number);
    if (numberDiff !== 0) return numberDiff;

    const timeDiff = parseTime(b.uploadDate) - parseTime(a.uploadDate);
    if (timeDiff !== 0) return timeDiff;

    return String(b.id || '').localeCompare(String(a.id || ''));
  })[0];
};

const isPlaceholderChapterTitle = (title?: string): boolean => {
  const normalizedTitle = normalizeLooseText(String(title || '').trim());
  return (
    !normalizedTitle ||
    normalizedTitle === 'mangadex' ||
    normalizedTitle === 'sap ra mat' ||
    normalizedTitle === 'dang cap nhat' ||
    normalizedTitle === 'chua co du lieu chuong'
  );
};

const isReadableMangaDexDetailChapter = (chapter: any): boolean => {
  const chapterNum =
    parseChapterNumberFromText(chapter?.chapter) ||
    parseChapterNumberFromText(chapter?.chapter_with_groups);
  return isValidChapterNumber(chapterNum);
};

const isSyntheticChapterId = (chapterId: string, slug: string): boolean => {
  const normalizedId = String(chapterId || '').trim().toLowerCase();
  const normalizedSlug = String(slug || '').trim().toLowerCase();
  if (!normalizedId) return true;

  const syntheticSuffixes = ['-trending', '-rated', '-placeholder', '-latest', '-coming-soon'];
  if (syntheticSuffixes.some((suffix) => normalizedId.endsWith(suffix))) {
    return true;
  }

  if (normalizedSlug && normalizedId === `ch-${normalizedSlug}-latest`) {
    return true;
  }

  return false;
};

const shouldSyncRealChapterForBrowse = (item: Manga): boolean => {
  const slug = String(item.id || '').trim().toLowerCase();
  if (isInvalidPublicMangaSlug(slug)) return false;
  if (item.externalUrl) return false;
  if (isMangaDexSlug(slug)) return false;

  return true;
};

const hasRealChapterData = (chapters: Manga['chapters']): boolean => {
  if (!Array.isArray(chapters) || chapters.length === 0) return false;
  return chapters.some((chapter) => {
    if (!chapter) return false;
    if (Number.isFinite(chapter.number) && chapter.number >= 0) return true;
    const normalizedTitle = normalizeLooseText(String(chapter.title || '').trim());
    if (!normalizedTitle) return false;
    if (normalizedTitle === 'mangadex') return false;
    if (normalizedTitle === 'sap ra mat') return false;
    if (normalizedTitle === 'dang cap nhat') return false;
    if (normalizedTitle === 'chua co du lieu chuong') return false;
    return true;
  });
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
  const chapterRaw = repairMojibakeText(getMyRatedLatestChapter(record)).trim();
  if (!chapterRaw) return [];

  const parsedChapterNum = parseChapterNumberFromText(chapterRaw);
  const uploadDate = getMyRatedLatestChapterUpdatedAt(record);

  if (!isValidChapterNumber(parsedChapterNum)) return [];

  return [
    {
      id: `ch-${slug}-rated`,
      mangaId: slug,
      number: parsedChapterNum,
      title: chapterLabelFromNumber(parsedChapterNum),
      pages: [],
      uploadDate,
      scanlationGroup: '',
    },
  ];
};

const latestSortTimestampCache = new WeakMap<Manga, number>();

const getLatestSortTimestamp = (manga: Manga): number => {
  const cached = latestSortTimestampCache.get(manga);
  if (cached !== undefined) return cached;

  const isMangaDexItem = isMangaDexSlug(String(manga.id || ''));
  let chapterTs = 0;
  if (Array.isArray(manga.chapters)) {
    for (const chapter of manga.chapters) {
      if (isMangaDexItem && (!hasReadableChapter(chapter) || isPlaceholderChapterTitle(chapter?.title))) {
        continue;
      }
      const ts = parseTime(chapter?.uploadDate);
      if (ts > chapterTs) chapterTs = ts;
    }
  }

  const mangaDexPublishedTs = isMangaDexItem
    ? Math.max(
        parseTime((manga as any).mangaDexLatestPublishedAt),
        parseTime((manga as any).localLastPublishedAt),
        parseTime((manga as any).local_last_published_at),
      )
    : 0;
  const resolved = isMangaDexItem
    ? Math.max(chapterTs, mangaDexPublishedTs)
    : chapterTs > 0
      ? chapterTs
      : parseTime(manga.lastUpdated);
  latestSortTimestampCache.set(manga, resolved);
  return resolved;
};

const compareByPopularWithPriority = (
  a: Manga,
  b: Manga,
  priority: Map<string, number>,
): number => {
  if (priority.size > 0) {
    const indexA = getMappedNumberByAlias(priority, a, 'min');
    const indexB = getMappedNumberByAlias(priority, b, 'min');

    if (indexA !== undefined && indexB !== undefined) {
      return indexA - indexB;
    }
    if (indexA !== undefined) return -1;
    if (indexB !== undefined) return 1;
  }

  return compareByPopular(a, b);
};

const compareByRating = (a: Manga, b: Manga): number => {
  const ratingDiff = toNumber(b.rating) - toNumber(a.rating);
  if (ratingDiff !== 0) return ratingDiff;
  const countDiff = toNumber(b.ratingCount) - toNumber(a.ratingCount);
  if (countDiff !== 0) return countDiff;
  const viewsDiff = toNumber(b.views) - toNumber(a.views);
  if (viewsDiff !== 0) return viewsDiff;
  const updatedDiff = getLatestSortTimestamp(b) - getLatestSortTimestamp(a);
  if (updatedDiff !== 0) return updatedDiff;
  return String(a.title || '').localeCompare(String(b.title || ''), 'vi');
};

const getRealViewSortScore = (manga: Manga): number => {
  if (isMangaDexSlug(String(manga.id || ''))) {
    return Math.max(0, toNumber((manga as any).localViewCount ?? (manga as any).local_view_count ?? 0));
  }
  return Math.max(0, toNumber((manga as any).view_count ?? manga.views));
};

const getMangaDexPopularityFallbackScore = (manga: Manga): number =>
  Math.max(
    0,
    toNumber(
      (manga as any).popularityScore ??
      (manga as any).popularity_score ??
      (manga as any).mangadex_popularity_score ??
      0,
    ),
  );

const getMangaDexPopularityDisplayViews = (
  item: MangaDexCatalogItem,
  popularityScore: number,
): number => {
  const rank = Math.floor(toNumber(item.mangadex_popularity_rank));
  if (rank > 0) {
    return Math.max(25_000, 1_000_000 - rank * 1_250);
  }
  if (popularityScore > 0) {
    return Math.max(25_000, Math.round(popularityScore / 10));
  }
  return 0;
};

const getPopularSortScore = (manga: Manga): number => {
  const views = getRealViewSortScore(manga);
  if (views > 0) return views;
  return getMangaDexPopularityFallbackScore(manga);
};

const compareByPopular = (a: Manga, b: Manga): number => {
  const realViewsA = getRealViewSortScore(a);
  const realViewsB = getRealViewSortScore(b);
  const hasRealViewsA = realViewsA > 0;
  const hasRealViewsB = realViewsB > 0;

  // DB/ranking views are authoritative; MangaDex popularity is only fallback.
  if (hasRealViewsA || hasRealViewsB) {
    if (hasRealViewsA !== hasRealViewsB) return hasRealViewsB ? 1 : -1;
    const realViewsDiff = realViewsB - realViewsA;
    if (realViewsDiff !== 0) return realViewsDiff;
  }

  const viewsA = getMangaDexPopularityFallbackScore(a);
  const viewsB = getMangaDexPopularityFallbackScore(b);
  const hasViewsA = viewsA > 0;
  const hasViewsB = viewsB > 0;

  if (hasViewsA !== hasViewsB) return hasViewsB ? 1 : -1;

  if (hasViewsA && hasViewsB) {
    const viewsDiff = viewsB - viewsA;
    if (viewsDiff !== 0) return viewsDiff;
  }

  const updatedDiff = getLatestSortTimestamp(b) - getLatestSortTimestamp(a);
  if (updatedDiff !== 0) return updatedDiff;

  return String(a.title || '').localeCompare(String(b.title || ''), 'vi');
};

const ALPHABETICAL_COLLATOR = new Intl.Collator('vi', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true,
});

const getAlphabeticalSortTitle = (manga: Manga): string => {
  const slug = String(manga.id || '').trim().toLowerCase();
  const display = pickDisplayTitle(slug, manga.altTitle, manga.title);
  return repairMojibakeText(display || manga.title || slug).trim();
};

const sortAlphabeticalItems = (items: Manga[]): Manga[] => {
  if (items.length <= 1) return [...items];

  const decorated = items.map((item) => ({
    item,
    title: getAlphabeticalSortTitle(item),
    updatedTs: getLatestSortTimestamp(item),
    id: String(item.id || '').trim().toLowerCase(),
  }));

  decorated.sort((a, b) => {
    const titleDiff = ALPHABETICAL_COLLATOR.compare(a.title, b.title);
    if (titleDiff !== 0) return titleDiff;

    const updatedDiff = b.updatedTs - a.updatedTs;
    if (updatedDiff !== 0) return updatedDiff;

    return a.id.localeCompare(b.id, 'vi');
  });

  return decorated.map((entry) => entry.item);
};

const compareByAlphabetical = (a: Manga, b: Manga): number => {
  const titleA = getAlphabeticalSortTitle(a);
  const titleB = getAlphabeticalSortTitle(b);
  const titleDiff = ALPHABETICAL_COLLATOR.compare(titleA, titleB);
  if (titleDiff !== 0) return titleDiff;

  const updatedDiff = getLatestSortTimestamp(b) - getLatestSortTimestamp(a);
  if (updatedDiff !== 0) return updatedDiff;

  return String(a.id || '').localeCompare(String(b.id || ''), 'vi');
};

const sortBrowseWindowItems = (items: Manga[], sort: SortOption): Manga[] => {
  if (items.length <= 1) return [...items];

  const next = [...items];
  switch (sort) {
    case 'latest':
      next.sort((a, b) => getLatestSortTimestamp(b) - getLatestSortTimestamp(a));
      return next;
    case 'rating':
      next.sort(compareByRating);
      return next;
    case 'alphabetical':
      return sortAlphabeticalItems(next);
    case 'popular':
      next.sort(compareByPopular);
      return next;
    default:
      return next;
  }
};

const dedupeMangaById = (items: Manga[]): Manga[] => {
  const seen = new Set<string>();
  return items.filter((m) => {
    const id = String(m.id || '').trim().toLowerCase();
    if (isInvalidPublicMangaSlug(id) || isUnresolvedPublicManga(m) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const getStableBrowseItemKey = (item: Partial<Manga>): string => {
  const alias = getBrowseAliasKeys(item)[0];
  return alias || String(item.id || '').trim().toLowerCase();
};

const assertOTruyenPayload = (payload: any) => {
  if (String(payload?.status || '').trim().toLowerCase() !== 'error') return;
  throw new Error(String(payload?.message || 'OTruyen unavailable'));
};

const applyBatchRatingToManga = (
  manga: Manga,
  ratingMap: Record<string, any>,
  myScoreMap: Record<string, any>,
): Manga => {
  const rawId = String(manga.id || '').trim();
  const normId = rawId.toLowerCase();
  const agg = ratingMap[rawId] || ratingMap[normId] || ratingMap[`mdx-${normId}`];
  const myScoreRaw =
    myScoreMap[rawId] ??
    myScoreMap[normId] ??
    myScoreMap[`mdx-${normId}`];
  const hasMyScore =
    myScoreRaw !== null &&
    myScoreRaw !== undefined &&
    Number.isFinite(Number(myScoreRaw));
  const aggAverage = toNumber(agg?.average);
  const aggCount = toNumber(agg?.count);
  const hasAggregate =
    !!agg &&
    Number.isFinite(aggAverage) &&
    Number.isFinite(aggCount) &&
    (aggCount > 0 || aggAverage > 0);

  if (!hasAggregate && !hasMyScore) return manga;

  return {
    ...manga,
    rating: hasAggregate ? aggAverage : toNumber(manga.rating),
    ratingCount: hasAggregate ? aggCount : toNumber(manga.ratingCount),
    myRating: hasMyScore ? toNumber(myScoreRaw) : manga.myRating,
  };
};

const needsRatingBatchEnrichment = (manga: Manga): boolean => {
  const ratingCount = toNumber((manga as any).ratingCount);
  const rating = toNumber((manga as any).rating);
  return ratingCount <= 0 || rating <= 0;
};

const hasTrustedRatingSignal = (manga: Manga): boolean => {
  const ratingCount = toNumber((manga as any).ratingCount);
  const rating = toNumber((manga as any).rating);
  const myRating = toNumber((manga as any).myRating);
  return ratingCount > 0 || rating > 0 || myRating > 0;
};

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
  if (!uniqueSlugs.length) {
    return { ratings: {}, my_scores: {} };
  }

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

/**
 * Tag aliases — groups of slugs that mean the same genre across sources.
 * Selecting ANY slug in a group will match ALL slugs in that group.
 */
const TAG_ALIAS_GROUPS: string[][] = [
  // Isekai / Xuyên không / Dị giới — specifically "transported to another world"
  // NOTE: 'reincarnation' is intentionally excluded — on MangaDex it's a separate tag
  // meaning "reborn" which can happen in the SAME world (not another world)
  ['isekai', 'di-gioi', 'xuyen-khong'],
  // Shounen / Thiếu niên
  ['shounen', 'thieu-nien', 'shonen'],
  // Shoujo / Thiếu nữ
  ['shoujo', 'thieu-nu', 'shojo'],
  // Seinen / Thanh niên
  ['seinen', 'thanh-nien'],
  // Josei / Phụ nữ
  ['josei', 'phu-nu'],
  // Action / Hành động
  ['action', 'hanh-dong'],
  // Comedy / Hài hước
  ['comedy', 'hai-huoc', 'ham-huoc'],
  // Romance / Tình cảm / Ngôn tình
  ['romance', 'tinh-cam', 'ngon-tinh', 'lang-man'],
  // Fantasy / Huyền huyễn / Giả tưởng
  ['fantasy', 'huyen-huyen', 'gia-tuong'],
  // Adventure / Phiêu lưu
  ['adventure', 'phieu-luu'],
  // Horror / Kinh dị
  ['horror', 'kinh-di'],
  // Mystery / Bí ẩn
  ['mystery', 'bi-an'],
  // Drama / Kịch tính
  ['drama', 'kich-tinh'],
  // Slice of life / Đời thường
  ['slice-of-life', 'doi-thuong', 'cuoc-song-hang-ngay'],
  // Martial arts / Võ thuật / Hành động võ thuật
  ['martial-arts', 'vo-thuat'],
  // Magic / Phép thuật / Ma thuật
  ['magic', 'phep-thuat', 'ma-thuat'],
  // Supernatural / Siêu nhiên
  ['supernatural', 'sieu-nhien'],
  // School life / Học đường
  ['school-life', 'hoc-duong'],
  // Harem / Đa thê / Hậu cung
  ['harem', 'da-the', 'hau-cung'],
  // Mecha / Robot
  ['mecha', 'robot'],
  // Sci-fi / Khoa học viễn tưởng
  ['sci-fi', 'khoa-hoc-vien-tuong', 'science-fiction'],
  // Psychological / Tâm lý
  ['psychological', 'tam-ly'],
  // Historical / Lịch sử
  ['historical', 'lich-su'],
  // Sports / Thể thao
  ['sports', 'the-thao'],
  // Cooking / Ẩm thực
  ['cooking', 'am-thuc'],
];

/** Build a fast lookup: slug → set of equivalent slugs (including itself) */
const TAG_ALIAS_MAP = new Map<string, Set<string>>();
for (const group of TAG_ALIAS_GROUPS) {
  const s = new Set(group);
  for (const slug of group) TAG_ALIAS_MAP.set(slug, s);
}

/** Expand a selected slug to all its aliases */
const expandAliases = (slug: string): string[] => {
  const group = TAG_ALIAS_MAP.get(slug);
  return group ? Array.from(group) : [slug];
};

const toSlugSet = (values: string[]): Set<string> => {
  const set = new Set<string>();
  for (const value of values) {
    const slug = toSlug(value);
    if (slug) set.add(slug);
  }
  return set;
};

const buildSelectedGenreAliasGroups = (selectedGenres: string[]): string[][] =>
  selectedGenres
    .map((value) => toSlug(value))
    .filter(Boolean)
    .map((slug) => Array.from(new Set(expandAliases(slug).map((alias) => toSlug(alias)).filter(Boolean))));

const matchesSelectedGenreAliasGroups = (
  itemSlugs: ReadonlySet<string>,
  selectedAliasGroups: string[][],
): boolean => {
  if (!selectedAliasGroups.length) return true;
  if (!itemSlugs.size) return false;
  return selectedAliasGroups.every((aliases) => aliases.some((alias) => itemSlugs.has(alias)));
};

const pickChapterDate = (chapter?: MangaDexCatalogItem['chapters'][number], mangaUpdatedAt?: string) => {
  const candidates = [chapter?.publish_at, chapter?.readable_at, chapter?.created_at, chapter?.updated_at, mangaUpdatedAt];
  for (const candidate of candidates) {
    if (parseTime(candidate) > 0) return String(candidate);
  }
  return '';
};

const getMangaDexChapterNumber = (chapter?: MangaDexCatalogItem['chapters'][number]): number => {
  if (!chapter) return 0;
  return (
    parseChapterNumberFromText(chapter?.chapter) ||
    parseChapterNumberFromText(chapter?.chapter_with_groups)
  );
};

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

const getMangaDexCatalogItemKey = (item: MangaDexCatalogItem): string =>
  String(item?.id || '').trim().toLowerCase();

const mergeMangaDexCatalogItem = (
  previous: MangaDexCatalogItem | undefined,
  incoming: MangaDexCatalogItem,
): MangaDexCatalogItem => {
  if (!previous) return incoming;

  const previousChapters = Array.isArray(previous.chapters) ? previous.chapters : [];
  const incomingChapters = Array.isArray(incoming.chapters) ? incoming.chapters : [];

  return {
    ...previous,
    ...incoming,
    title: String(incoming.title || '').trim() || previous.title,
    cover_url: String(incoming.cover_url || '').trim() || previous.cover_url,
    authors_text: String(incoming.authors_text || '').trim() || previous.authors_text,
    updated_at: String(incoming.updated_at || '').trim() || previous.updated_at,
    genres: Array.isArray(incoming.genres) && incoming.genres.length ? incoming.genres : previous.genres,
    chapters: incomingChapters.length ? incomingChapters : previousChapters,
  };
};

const mergeMangaDexCatalogSnapshots = (
  previous: MangaDexCatalogItem[] | undefined,
  incoming: MangaDexCatalogItem[],
): MangaDexCatalogItem[] => {
  const previousItems = Array.isArray(previous) ? previous : [];
  const incomingItems = Array.isArray(incoming) ? incoming : [];
  if (!previousItems.length) return incomingItems;
  if (!incomingItems.length) return previousItems;

  const previousById = new Map<string, MangaDexCatalogItem>();
  for (const item of previousItems) {
    const key = getMangaDexCatalogItemKey(item);
    if (key && !previousById.has(key)) previousById.set(key, item);
  }

  const seen = new Set<string>();
  const merged: MangaDexCatalogItem[] = [];

  for (const item of incomingItems) {
    const key = getMangaDexCatalogItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(mergeMangaDexCatalogItem(previousById.get(key), item));
  }

  for (const item of previousItems) {
    const key = getMangaDexCatalogItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
};

const getMangaDexDemandLimitForPage = (targetPage: number): number => {
  const safePage = Math.max(MANGADEX_DEMAND_INITIAL_PAGES, Math.floor(Number(targetPage) || 1));
  const desiredItems = (safePage + MANGADEX_DEMAND_PREFETCH_PAGES) * BROWSE_PAGE_SIZE;
  return Math.max(
    MANGADEX_DEMAND_INITIAL_LIMIT,
    Math.ceil((desiredItems * 1.35) / 100) * 100,
  );
};

const getNextMangaDexDemandLimit = (
  currentLimit: number,
  targetPage: number,
  baseLimit: number,
  aggressive = false,
): number => {
  const requestedPageLimit = getMangaDexDemandLimitForPage(targetPage);
  const step = aggressive
    ? Math.max(MANGADEX_DEMAND_FILTERED_LIMIT_STEP, MANGADEX_DEMAND_LIMIT_STEP)
    : MANGADEX_DEMAND_LIMIT_STEP;
  const steppedLimit = currentLimit + step;
  return Math.min(
    baseLimit,
    Math.max(currentLimit, steppedLimit, requestedPageLimit),
  );
};

const BrowseManga = () => {
  const { filters, setFilter } = useMangaStore();
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const ratingViewerKey = useUserStore((s) => {
    const raw = String(s.user?.id || s.user?.email || '').trim().toLowerCase();
    return raw || 'auth';
  });
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const [searchParams, setSearchParams] = useSearchParams();
  const page = useMemo(
    () => parseBrowsePageParam(searchParams.get('page')),
    [searchParams],
  );
  const setPage = (nextPage: number) => {
    const safePage = Math.max(1, Math.floor(Number(nextPage) || 1));
    const nextParams = new URLSearchParams(searchParams);
    if (filters.sort && filters.sort !== 'popular') {
      nextParams.set('sort', filters.sort);
    } else {
      nextParams.delete('sort');
    }
    if (safePage <= 1) {
      nextParams.delete('page');
    } else {
      nextParams.set('page', String(safePage));
    }

    if (nextParams.toString() === searchParams.toString()) {
      return;
    }

    setSearchParams(nextParams, { replace: false });
  };
  const [showFilter, setShowFilter] = useState(false);
  const [isGlobalSortBackgroundFetching, setIsGlobalSortBackgroundFetching] = useState(false);
  const [mangaDexDemandLimit, setMangaDexDemandLimit] = useState(MANGADEX_DEMAND_INITIAL_LIMIT);
  const queryClient = useQueryClient();
  const normalizedSearch = String(filters.search || '').trim();
  const hasSearch = normalizedSearch.length > 0;
  const lastNonEmptyMangaDexRef = useRef<Record<string, MangaDexCatalogItem[]>>({});
  const lastNonEmptyTrendingRowsRef = useRef<TrendingMangaItem[]>([]);
  const warmMangaDexCatalogLimitsRef = useRef<Set<number | 'all'>>(new Set());
  const mangaDexDemandAdvanceStateRef = useRef({ key: '', at: 0 });
  const mangaDexEdgeRefetchStateRef = useRef({ key: '', at: 0 });
  const mangadexMissingCoverRetryRef = useRef(0);
  const mangadexPopularityRefetchRetryRef = useRef(0);
  const mangaDexSearchSnapshotRef = useRef<{ key: string; items: Manga[] }>({ key: '', items: [] });
  const defaultSortInitializedRef = useRef(false);
  const globalSortBackgroundKeyRef = useRef('');
  const globalSortBackgroundTokenRef = useRef(0);
  const lastAppliedBrowseUrlStateRef = useRef<string>('');
  const genreParam = searchParams.get('genre');
  const sortParam = searchParams.get('sort');
  const sourceParam = searchParams.get('source');
  const activeSource: BrowseSourceTab = sourceParam === 'mangadex' ? 'mangadex' : 'otruyen';
  const isOTruyenSourceTab = activeSource === 'otruyen';
  const isMangaDexSourceTab = activeSource === 'mangadex';
  const browsePageMemoryKey = useMemo(
    () => buildBrowsePageMemoryKey(activeSource, filters),
    [activeSource, filters.genres, filters.minRating, filters.search, filters.sort, filters.status, filters.year],
  );
  const lastBrowsePageStateRef = useRef<{ key: string; page: number }>({ key: browsePageMemoryKey, page });
  const mangaDexCatalogMode = isMangaDexSourceTab && filters.sort === 'latest' ? 'latest' : 'default';
  const getMangaDexCatalogQueryKey = (limit: number | 'all', mode = mangaDexCatalogMode) =>
    ['manga', 'mangadex-catalog', MANGADEX_CATALOG_QUERY_VERSION, mode, limit] as const;
  const baseMangaDexCatalogLimit = isMangaDexSourceTab
    ? (showMatureContent ? MANGADEX_CATALOG_LIMIT_TAB_WITH_MATURE : MANGADEX_CATALOG_LIMIT_TAB_DEFAULT)
    : (showMatureContent ? MANGADEX_CATALOG_LIMIT_WITH_MATURE : MANGADEX_CATALOG_LIMIT_DEFAULT);
  const { data: categories = [] } = useCategories();

  const setBrowseSource = (nextSource: BrowseSourceTab) => {
    if (nextSource === activeSource) return;

    const nextParams = new URLSearchParams(searchParams);
    if (nextSource === 'otruyen') {
      nextParams.delete('source');
    } else {
      nextParams.set('source', nextSource);
    }
    if (filters.sort && filters.sort !== 'popular') {
      nextParams.set('sort', filters.sort);
    } else {
      nextParams.delete('sort');
    }
    const rememberedPage = getRememberedBrowsePage(buildBrowsePageMemoryKey(nextSource, filters));
    if (rememberedPage > 1) {
      nextParams.set('page', String(rememberedPage));
    } else {
      nextParams.delete('page');
    }
    setSearchParams(nextParams, { replace: false });
  };

  // Determine active genre slug (single select)
  const genreSlug = filters.genres[0] || '';
  const selectedGenreAliasGroups = useMemo(
    () => buildSelectedGenreAliasGroups(filters.genres),
    [filters.genres],
  );

  // Map status/sort to OTruyen list type (only used when no genre is selected)
  const listType = useMemo(() => {
    if (filters.status === 'completed') return 'hoan-thanh';
    if (filters.status === 'ongoing') return 'dang-phat-hanh';
    if (filters.status === 'hiatus') return 'sap-ra-mat';
    switch (filters.sort) {
      case 'latest': return 'truyen-moi';
      case 'popular': return 'truyen-moi';
      default: return 'truyen-moi';
    }
  }, [filters.sort, filters.status]);

  const selectedGenreSource = categories.find((cat) => cat.slug === genreSlug)?.source;
  const useCategory = !!genreSlug && selectedGenreSource !== 'mangadex';
  const isMangaDexGenre = !!genreSlug && selectedGenreSource === 'mangadex';

  // For MangaDex genres (e.g. 'isekai'), find the OTruyen equivalent via alias expansion.
  // e.g. 'isekai' → expandAliases → ['isekai','chuyen-sinh','xuyen-khong',...]
  //   → first alias that is an actual OTruyen category slug = 'xuyen-khong'
  const otruyenEquivSlug = useMemo(() => {
    if (!isMangaDexGenre || !categories.length) return '';
    const aliases = expandAliases(genreSlug);
    return aliases.find((alias) =>
      categories.some((c) => c.slug === alias && c.source !== 'mangadex')
    ) || '';
  }, [isMangaDexGenre, genreSlug, categories]);

  // Use OTruyen category API when:
  // 1. Direct OTruyen genre selected, OR
  // 2. MangaDex genre that has an OTruyen alias (e.g. isekai → xuyen-khong)
  const useOTruyenCategory =
    isOTruyenSourceTab && (useCategory || (isMangaDexGenre && !!otruyenEquivSlug));
  const activeCategorySlug = useCategory ? genreSlug : otruyenEquivSlug;

  const shouldFetchTrendingForPopular =
    isOTruyenSourceTab && filters.sort === 'popular' && !hasSearch;
  const popularTrendingSource: 'all' | BrowseSourceTab = isOTruyenSourceTab
    ? 'otruyen'
    : isMangaDexSourceTab
      ? 'mangadex'
      : 'all';
  const popularTrendingQueryKey = useMemo(
    () => ['manga', 'trending', 'browse-popular', popularTrendingSource, POPULAR_TRENDING_LIMIT] as const,
    [popularTrendingSource],
  );

  const useTrendingPopularMode =
    shouldFetchTrendingForPopular &&
    !filters.status &&
    filters.genres.length === 0 &&
    !filters.year &&
    filters.minRating <= 0 &&
    !useOTruyenCategory;

  const useGlobalTopRatedMode = filters.sort === 'rating';

  // Local-only filters (year/minRating) are client-side; pagination must follow filtered results.
  const hasLocalClientFilters = Boolean(filters.year) || filters.minRating > 0;
  const mangaDexHasNarrowClientFilters =
    isMangaDexSourceTab &&
    (
      hasSearch ||
      selectedGenreAliasGroups.length > 0 ||
      hasLocalClientFilters ||
      Boolean(filters.status)
    );
  const useMangaDexServerSearchMode =
    isMangaDexSourceTab &&
    filters.sort !== 'rating' &&
    !hasLocalClientFilters;
  const mangaDexServerSearchGenreSlugs = useMemo(
    () => Array.from(new Set(filters.genres.map((slug) => toSlug(slug)).filter(Boolean))),
    [filters.genres],
  );
  const mangaDexServerSearchSort = useMemo(
    () =>
      filters.sort === 'popular'
        ? 'popular'
        : filters.sort === 'alphabetical'
          ? 'title'
          : 'latest',
    [filters.sort],
  );
  const getMangaDexServerSearchQueryKey = useCallback(
    (targetPage: number) => [
      'manga',
      'mangadex',
      'server-search',
      normalizedSearch,
      mangaDexServerSearchGenreSlugs,
      filters.status,
      mangaDexServerSearchSort,
      targetPage,
      showMatureContent,
    ] as const,
    [
      normalizedSearch,
      mangaDexServerSearchGenreSlugs,
      filters.status,
      mangaDexServerSearchSort,
      showMatureContent,
    ],
  );
  const fetchMangaDexServerSearchPage = useCallback(
    async (targetPage: number) => {
      const payload = await mangaApi.searchMangaDex({
        keyword: normalizedSearch,
        page: targetPage,
        limit: BROWSE_PAGE_SIZE,
        genreSlugs: mangaDexServerSearchGenreSlugs,
        status: filters.status || '',
        sort: mangaDexServerSearchSort,
        showMature: showMatureContent,
        attachRatings: false,
        filterHidden: true,
        timeoutMs: 12_000,
      });
      return adaptListData(payload);
    },
    [
      normalizedSearch,
      mangaDexServerSearchGenreSlugs,
      filters.status,
      mangaDexServerSearchSort,
      showMatureContent,
    ],
  );
  const mangaDexInitialDemandLimit = mangaDexHasNarrowClientFilters
    ? MANGADEX_DEMAND_FILTERED_INITIAL_LIMIT
    : MANGADEX_DEMAND_INITIAL_LIMIT;

  // Keep first 20 pages globally continuous for non-popular tabs.
  const wantsGlobalClientSortMode =
    isOTruyenSourceTab &&
    !hasSearch &&
    !hasLocalClientFilters &&
    !useOTruyenCategory &&
    filters.sort === 'alphabetical' &&
    page <= CONTINUOUS_SORT_WINDOW_PAGES;

  const globalSortProbeQuery = useQuery({
    queryKey: ['manga', 'list-global-sort-probe', listType, filters.sort],
    queryFn: async () => {
      const firstPageQueryKey = ['manga', 'list', listType, 1] as const;
      const cachedFirstPage = queryClient.getQueryData(firstPageQueryKey) as OTruyenListData | undefined;
      const firstPage =
        cachedFirstPage && cachedFirstPage.items.length > 0
          ? cachedFirstPage
          : await (async () => {
              const payload = await mangaApi.getList(listType, 1);
              assertOTruyenPayload(payload);
              return adaptListData(payload);
            })();

      queryClient.setQueryData(firstPageQueryKey, firstPage);
      return {
        totalPages: Math.max(1, Number(firstPage?.totalPages || 1)),
        totalItems: Math.max(0, Number(firstPage?.totalItems || 0)),
      };
    },
    enabled: wantsGlobalClientSortMode,
    staleTime: 10 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const useGlobalClientSortMode = wantsGlobalClientSortMode;

  const shouldUseLightMangaDexCatalog =
    !isMangaDexSourceTab &&
    !hasSearch &&
    !useOTruyenCategory &&
    !filters.status &&
    filters.genres.length === 0 &&
    !filters.year &&
    filters.minRating <= 0;

  const lightCatalogLimit = showMatureContent
    ? MANGADEX_CATALOG_LIMIT_LIGHT_WITH_MATURE
    : MANGADEX_CATALOG_LIMIT_LIGHT_DEFAULT;

  const mangadexCatalogLimit = useTrendingPopularMode
    ? Math.min(baseMangaDexCatalogLimit, POPULAR_MANGADEX_CATALOG_LIMIT_CAP)
    : shouldUseLightMangaDexCatalog
      ? Math.min(baseMangaDexCatalogLimit, lightCatalogLimit)
      : isMangaDexSourceTab
        ? Math.min(baseMangaDexCatalogLimit, Math.max(mangaDexInitialDemandLimit, mangaDexDemandLimit))
        : baseMangaDexCatalogLimit;
  const mangadexCatalogRequestLimit: number | 'all' = mangadexCatalogLimit;

  // Client pagination when: text search, local-only filters, OR MangaDex genre with NO OTruyen equivalent
  const isClientPaginationMode =
    isMangaDexSourceTab ||
    hasSearch ||
    hasLocalClientFilters ||
    (isMangaDexGenre && !otruyenEquivSlug) ||
    useGlobalClientSortMode;
  const serverPage = isClientPaginationMode ? 1 : page;
  // Combined endpoint is heavier and can hurt tab responsiveness on large datasets.
  // Keep browse tabs on lightweight list + cached MangaDex catalog flow.
  const useCombinedList = false;

  const combinedListQuery = useQuery({
    queryKey: ['manga', 'list-combined', listType, serverPage, mangadexCatalogLimit],
    queryFn: async () => {
      try {
        const payload = await mangaApi.getCombinedList(listType, serverPage, mangadexCatalogLimit);
        const listData = adaptListData(payload?.list || {});
        const mangadex = (payload?.mangadex?.mangas || []) as MangaDexCatalogItem[];
        if (mangadex.length) {
          queryClient.setQueryData(getMangaDexCatalogQueryKey(mangadexCatalogLimit), mangadex);
        }
        return { listData, mangadex };
      } catch (combinedError) {
        let listData: OTruyenListData | null = null;
        try {
          listData = adaptListData(await mangaApi.getList(listType, serverPage));
        } catch {
          const previous = queryClient.getQueryData(
            ['manga', 'list-combined', listType, serverPage, mangadexCatalogLimit],
          ) as { listData?: OTruyenListData } | undefined;
          if (previous?.listData && previous.listData.items.length > 0) {
            listData = previous.listData;
          }

          if (!listData) {
            const fallbackList = queryClient.getQueryData(
              ['manga', 'list', listType, serverPage],
            ) as OTruyenListData | undefined;
            if (fallbackList && fallbackList.items.length > 0) {
              listData = fallbackList;
            }
          }
        }

        if (!listData) {
          throw combinedError;
        }

        const cachedCatalog = queryClient.getQueryData(getMangaDexCatalogQueryKey(mangadexCatalogLimit));
        const cachedViCatalog = queryClient.getQueryData(['manga', 'mangadex', 'vi-catalog', mangadexCatalogLimit]);
        const mangadex = (
          (Array.isArray(cachedCatalog) ? cachedCatalog : undefined) ||
          (Array.isArray(cachedViCatalog) ? cachedViCatalog : undefined) ||
          lastNonEmptyMangaDexRef.current[mangaDexCatalogMode] ||
          []
        ) as MangaDexCatalogItem[];

        return { listData, mangadex };
      }
    },
    enabled: useCombinedList,
    staleTime: 2 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Always-on MangaDex catalog — never disabled, so MangaDex items appear for ALL tag types
  const mangadexCatalogQuery = useQuery({
    queryKey: getMangaDexCatalogQueryKey(mangadexCatalogRequestLimit),
    queryFn: async () => {
      let mangas: MangaDexCatalogItem[] = [];
      try {
        const directPayload = await mangaApi.getMangaDexViCatalog(mangadexCatalogRequestLimit, {
          attachRatings: false,
          attachOverrides: false,
          filterHidden: true,
          preferLatest: isMangaDexSourceTab && filters.sort === 'latest',
        });
        mangas = (directPayload?.mangas || []) as MangaDexCatalogItem[];
      } catch {
        // Keep cache fallback below. For MangaDex tab, do not fallback to list-combined
        // because that path can return truncated snapshots and collapse pagination.
      }
      if (mangas.length) {
        const previous =
          (
            queryClient.getQueryData(getMangaDexCatalogQueryKey(mangadexCatalogRequestLimit)) as
              | MangaDexCatalogItem[]
              | undefined
          ) || lastNonEmptyMangaDexRef.current[mangaDexCatalogMode];
        const merged = mergeMangaDexCatalogSnapshots(previous, mangas);
        queryClient.setQueryData(getMangaDexCatalogQueryKey(mangadexCatalogRequestLimit), merged);
        return merged;
      }

      const cached = queryClient.getQueryData(getMangaDexCatalogQueryKey(mangadexCatalogRequestLimit));
      const cachedViCatalog = queryClient.getQueryData(['manga', 'mangadex', 'vi-catalog', mangadexCatalogRequestLimit]);
      return (
        (Array.isArray(cached) ? cached : undefined) ||
        (Array.isArray(cachedViCatalog) ? cachedViCatalog : undefined) ||
        lastNonEmptyMangaDexRef.current[mangaDexCatalogMode] ||
        []
      ) as MangaDexCatalogItem[];
    },
    staleTime: isMangaDexSourceTab ? 45 * 1000 : 10 * 60 * 1000,
    gcTime: isMangaDexSourceTab ? 5 * 60 * 1000 : 8 * 60 * 1000,
    enabled: isMangaDexSourceTab && !useCombinedList && !useTrendingPopularMode && !useMangaDexServerSearchMode,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (prev) => prev,
    retry: (failureCount) => failureCount < 2,
    retryDelay: 3000,
  });

  const mangaDexServerSearchQuery = useQuery({
    queryKey: getMangaDexServerSearchQueryKey(page),
    queryFn: () => fetchMangaDexServerSearchPage(page),
    enabled: useMangaDexServerSearchMode,
    staleTime: 2 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    retryDelay: 1200,
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    setMangaDexDemandLimit(mangaDexInitialDemandLimit);
    mangaDexDemandAdvanceStateRef.current = { key: '', at: 0 };
    mangaDexEdgeRefetchStateRef.current = { key: '', at: 0 };
  }, [
    isMangaDexSourceTab,
    mangaDexInitialDemandLimit,
    showMatureContent,
    filters.search,
    filters.genres,
    filters.status,
    filters.sort,
    filters.year,
    filters.minRating,
  ]);

  useEffect(() => {
    if (!isMangaDexSourceTab) return;
    if (!useTrendingPopularMode || useCombinedList) return;
    if (warmMangaDexCatalogLimitsRef.current.has(mangadexCatalogLimit)) return;

    const cached = queryClient.getQueryData(getMangaDexCatalogQueryKey(mangadexCatalogLimit));
    if (Array.isArray(cached) && cached.length > 0) return;

    warmMangaDexCatalogLimitsRef.current.add(mangadexCatalogLimit);
    const timer = window.setTimeout(() => {
      mangadexCatalogQuery.refetch().catch(() => {
        // warm-up is best effort
      });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [
    isMangaDexSourceTab,
    useTrendingPopularMode,
    useCombinedList,
    mangadexCatalogLimit,
    queryClient,
    mangadexCatalogQuery.refetch,
  ]);

  const listQuery = useQuery({
    queryKey: ['manga', 'list', listType, serverPage],
    queryFn: async () => {
      try {
        const payload = await mangaApi.getList(listType, serverPage);
        assertOTruyenPayload(payload);
        return adaptListData(payload);
      } catch (listError) {
        const cachedList = queryClient.getQueryData(
          ['manga', 'list', listType, serverPage],
        ) as OTruyenListData | undefined;
        if (cachedList?.items?.length) {
          return cachedList;
        }

        const cachedCombined = queryClient.getQueryData(
          ['manga', 'list-combined', listType, serverPage, mangadexCatalogLimit],
        ) as { listData?: OTruyenListData } | undefined;
        if (cachedCombined?.listData?.items?.length) {
          return cachedCombined.listData;
        }

        throw listError;
      }
    },
    enabled: isOTruyenSourceTab && !useOTruyenCategory && !useCombinedList && !useGlobalClientSortMode,
    staleTime: 10 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const globalSortedListQuery = useQuery({
    queryKey: ['manga', 'list-global-sort', listType, filters.sort],
    queryFn: async () => {
      const firstPageQueryKey = ['manga', 'list', listType, 1] as const;
      const cachedFirstPage = queryClient.getQueryData(firstPageQueryKey) as OTruyenListData | undefined;
      const firstPage =
        cachedFirstPage && cachedFirstPage.items.length > 0
          ? cachedFirstPage
          : await (async () => {
              const payload = await mangaApi.getList(listType, 1);
              assertOTruyenPayload(payload);
              return adaptListData(payload);
            })();

      queryClient.setQueryData(firstPageQueryKey, firstPage);

      const totalPages = Math.max(1, Number(firstPage?.totalPages || 1));
      const seenIds = new Set<string>();
      const firstPageItems: Manga[] = [];
      const appendUniqueItems = (items: Manga[]) => {
        for (const item of items || []) {
          const key = String(item?.id || '').trim().toLowerCase();
          if (!key || seenIds.has(key)) continue;
          seenIds.add(key);
          firstPageItems.push(item);
        }
      };

      appendUniqueItems(firstPage.items || []);
      return {
        items: sortBrowseWindowItems(firstPageItems, filters.sort),
        totalPages,
        fetchedPages: 1,
      };
    },
    enabled: useGlobalClientSortMode,
    staleTime: 10 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!useGlobalClientSortMode) {
      globalSortBackgroundKeyRef.current = '';
      setIsGlobalSortBackgroundFetching(false);
      return;
    }

    const snapshot = globalSortedListQuery.data as
      | { items?: Manga[]; totalPages?: number; fetchedPages?: number }
      | undefined;
    const totalPages = Math.min(
      GLOBAL_SORT_FETCH_MAX_PAGES,
      CONTINUOUS_SORT_WINDOW_PAGES,
      Math.max(1, Number(snapshot?.totalPages || 1)),
    );
    const fetchedPages = Math.max(1, Number(snapshot?.fetchedPages || 1));

    if (!snapshot?.items?.length || fetchedPages >= totalPages) {
      setIsGlobalSortBackgroundFetching(false);
      return;
    }

    const runKey = `${listType}:${filters.sort}`;
    if (globalSortBackgroundKeyRef.current === runKey) return;
    globalSortBackgroundKeyRef.current = runKey;

    let cancelled = false;
    const token = globalSortBackgroundTokenRef.current + 1;
    globalSortBackgroundTokenRef.current = token;
    setIsGlobalSortBackgroundFetching(true);

    const seenIds = new Set<string>();
    const allItems: Manga[] = [];
    for (const item of snapshot.items || []) {
      const key = String(item?.id || '').trim().toLowerCase();
      if (!key || seenIds.has(key)) continue;
      seenIds.add(key);
      allItems.push(item);
    }

    const appendUniqueItems = (items: Manga[]) => {
      for (const item of items || []) {
        const key = String(item?.id || '').trim().toLowerCase();
        if (!key || seenIds.has(key)) continue;
        seenIds.add(key);
        allItems.push(item);
      }
    };

    const run = async () => {
      for (
        let startPage = Math.max(2, fetchedPages + 1);
        startPage <= totalPages;
        startPage += GLOBAL_SORT_FETCH_CHUNK
      ) {
        if (cancelled || globalSortBackgroundTokenRef.current !== token) return;

        const endPage = Math.min(totalPages, startPage + GLOBAL_SORT_FETCH_CHUNK - 1);
        const pageNumbers = Array.from(
          { length: endPage - startPage + 1 },
          (_, index) => startPage + index,
        );

        const pageResults = await Promise.allSettled(
          pageNumbers.map(async (targetPage) => {
            const pageQueryKey = ['manga', 'list', listType, targetPage] as const;
            const cachedPage = queryClient.getQueryData(pageQueryKey) as OTruyenListData | undefined;
            if (cachedPage && cachedPage.items.length > 0) {
              return cachedPage;
            }

            const payload = await mangaApi.getList(listType, targetPage);
            assertOTruyenPayload(payload);
            const freshPage = adaptListData(payload);
            queryClient.setQueryData(pageQueryKey, freshPage);
            return freshPage;
          }),
        );

        if (cancelled || globalSortBackgroundTokenRef.current !== token) return;

        for (const result of pageResults) {
          if (result.status !== 'fulfilled') continue;
          if (result.value.items?.length) {
            appendUniqueItems(result.value.items);
          }
        }

        queryClient.setQueryData(['manga', 'list-global-sort', listType, filters.sort], {
          items: sortBrowseWindowItems(allItems, filters.sort),
          totalPages,
          fetchedPages: endPage,
        });
      }
    };

    run()
      .catch(() => {
        // keep first-page snapshot visible even if later background chunks fail
      })
      .finally(() => {
        if (cancelled || globalSortBackgroundTokenRef.current !== token) return;
        setIsGlobalSortBackgroundFetching(false);
        globalSortBackgroundKeyRef.current = '';
      });

    return () => {
      cancelled = true;
      if (globalSortBackgroundTokenRef.current === token) {
        setIsGlobalSortBackgroundFetching(false);
      }
      if (globalSortBackgroundKeyRef.current === runKey) {
        globalSortBackgroundKeyRef.current = '';
      }
    };
  }, [useGlobalClientSortMode, globalSortedListQuery.data, listType, filters.sort, queryClient]);

  const activeMangaDexCatalog = useMemo(
    () => {
      if (!isMangaDexSourceTab) return [] as MangaDexCatalogItem[];
      if (useMangaDexServerSearchMode) return [] as MangaDexCatalogItem[];
      return useCombinedList ? (combinedListQuery.data?.mangadex || []) : (mangadexCatalogQuery.data || []);
    },
    [isMangaDexSourceTab, useMangaDexServerSearchMode, useCombinedList, combinedListQuery.data?.mangadex, mangadexCatalogQuery.data],
  );

  useEffect(() => {
    if (activeMangaDexCatalog.length) {
      lastNonEmptyMangaDexRef.current[mangaDexCatalogMode] = activeMangaDexCatalog;
    }
  }, [activeMangaDexCatalog, mangaDexCatalogMode]);

  // Refetch if MangaDex catalog came back empty (backend still building cache)
  const activeMangaDexLoading = useCombinedList
    ? combinedListQuery.isLoading
    : useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.isLoading
      : mangadexCatalogQuery.isLoading;
  const activeMangaDexFetching = useCombinedList
    ? combinedListQuery.isFetching
    : useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.isFetching
      : mangadexCatalogQuery.isFetching;
  const activeMangaDexSuccess = useCombinedList
    ? combinedListQuery.isSuccess
    : useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.isSuccess
      : mangadexCatalogQuery.isSuccess;
  const refetchActiveMangaDex = useCombinedList
    ? combinedListQuery.refetch
    : useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.refetch
      : mangadexCatalogQuery.refetch;

  const mangadexIsEmpty =
    isMangaDexSourceTab &&
    !useMangaDexServerSearchMode &&
    !activeMangaDexLoading &&
    !activeMangaDexFetching &&
    activeMangaDexSuccess &&
    activeMangaDexCatalog.length === 0;

  useEffect(() => {
    if (!mangadexIsEmpty) return;
    const timer = setTimeout(() => {
      refetchActiveMangaDex();
    }, 4000);
    return () => clearTimeout(timer);
  }, [mangadexIsEmpty, refetchActiveMangaDex]);

  const mangadexCoverHealth = useMemo(() => {
    const items = activeMangaDexCatalog;
    const total = items.length;
    if (!total) return { total: 0, missing: 0, severe: false };

    const missing = items.reduce((acc, item) => {
      const cover = String((item as any)?.cover_url || '').trim();
      return acc + (cover ? 0 : 1);
    }, 0);
    const severe = missing >= Math.max(5, Math.floor(total * 0.7));
    return { total, missing, severe };
  }, [activeMangaDexCatalog]);

  // Auto-refetch when most MangaDex items are missing covers to avoid manual reloads.
  useEffect(() => {
    if (!mangadexCoverHealth.severe) {
      mangadexMissingCoverRetryRef.current = 0;
      return;
    }
    if (activeMangaDexLoading || activeMangaDexFetching) return;
    if (mangadexMissingCoverRetryRef.current >= 3) return;

    const attempt = mangadexMissingCoverRetryRef.current + 1;
    mangadexMissingCoverRetryRef.current = attempt;
    const delay = 1200 * attempt;
    const timer = setTimeout(() => {
      refetchActiveMangaDex();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    mangadexCoverHealth,
    activeMangaDexLoading,
    activeMangaDexFetching,
    refetchActiveMangaDex,
  ]);

  const mangadexPopularityNeedsRefresh = useMemo(() => {
    if (!isMangaDexSourceTab || filters.sort !== 'popular') return false;
    if (!activeMangaDexCatalog.length) return false;
    return !activeMangaDexCatalog.some((item) =>
      toNumber(
        (item as any).mangadex_popularity_score ??
        (item as any).popularity_score ??
        (item as any).popularityScore ??
        0,
      ) > 0,
    );
  }, [isMangaDexSourceTab, filters.sort, activeMangaDexCatalog]);

  useEffect(() => {
    if (!mangadexPopularityNeedsRefresh) {
      mangadexPopularityRefetchRetryRef.current = 0;
      return;
    }
    if (activeMangaDexLoading || activeMangaDexFetching) return;
    if (mangadexPopularityRefetchRetryRef.current >= 6) return;

    const attempt = mangadexPopularityRefetchRetryRef.current + 1;
    mangadexPopularityRefetchRetryRef.current = attempt;
    const timer = window.setTimeout(() => {
      refetchActiveMangaDex().catch(() => {
        // best effort: backend may still be building popularity cache
      });
    }, 2200 * attempt);

    return () => window.clearTimeout(timer);
  }, [
    mangadexPopularityNeedsRefresh,
    activeMangaDexLoading,
    activeMangaDexFetching,
    refetchActiveMangaDex,
  ]);

  const categoryQuery = useCategoryManga(useOTruyenCategory ? activeCategorySlug : '', serverPage);
  const data = useCombinedList
    ? combinedListQuery.data?.listData
    : (useOTruyenCategory ? categoryQuery.data : listQuery.data);
  const stableListData = data;

  const globalSortedItems = useMemo(() => {
    if (!useGlobalClientSortMode) return [] as Manga[];
    if (globalSortedListQuery.data?.items?.length) {
      return globalSortedListQuery.data.items;
    }
    return [] as Manga[];
  }, [useGlobalClientSortMode, globalSortedListQuery.data?.items]);

  const sourceGenreSlugMap = useMemo(() => {
    if (useOTruyenCategory || selectedGenreAliasGroups.length === 0) {
      return new Map<string, Set<string>>();
    }

    const sourceItems = useGlobalClientSortMode ? globalSortedItems : (stableListData?.items || []);
    const map = new Map<string, Set<string>>();

    for (const item of sourceItems) {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key) continue;
      map.set(key, toSlugSet([...(item.tags || []), ...(item.genres || [])]));
    }

    return map;
  }, [
    useOTruyenCategory,
    selectedGenreAliasGroups,
    useGlobalClientSortMode,
    globalSortedItems,
    stableListData?.items,
  ]);

  const isLoading =
    (useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.isLoading
      : useCombinedList
        ? combinedListQuery.isLoading
        : (useOTruyenCategory ? categoryQuery.isLoading : listQuery.isLoading)) ||
    (useGlobalClientSortMode && globalSortedListQuery.isLoading);
  const isFetching =
    (useMangaDexServerSearchMode
      ? mangaDexServerSearchQuery.isFetching
      : useCombinedList
        ? combinedListQuery.isFetching
        : (useOTruyenCategory ? categoryQuery.isFetching : listQuery.isFetching)) ||
    (useGlobalClientSortMode && (globalSortedListQuery.isFetching || isGlobalSortBackgroundFetching));
  const isMangaDexServerPageTransition =
    useMangaDexServerSearchMode &&
    mangaDexServerSearchQuery.isFetching &&
    Boolean(mangaDexServerSearchQuery.data) &&
    Boolean(mangaDexServerSearchQuery.isPlaceholderData);

  // MangaDex is ALWAYS available — from dedicated catalog query (works for ALL tag types)
  const mangaDexMangas = useMemo<MangaDexCatalogItem[]>(() => {
    if (!isMangaDexSourceTab) return [];
    if (useMangaDexServerSearchMode) return [];
    if (useTrendingPopularMode) return [];
    const catalogItems = activeMangaDexCatalog;
    if (catalogItems.length) return catalogItems;
    return lastNonEmptyMangaDexRef.current[mangaDexCatalogMode] || [];
  }, [isMangaDexSourceTab, useMangaDexServerSearchMode, activeMangaDexCatalog, useTrendingPopularMode, mangaDexCatalogMode]);

  const mangaDexServerItems = useMemo<Manga[]>(
    () => useMangaDexServerSearchMode ? (mangaDexServerSearchQuery.data?.items || []) : [],
    [useMangaDexServerSearchMode, mangaDexServerSearchQuery.data?.items],
  );

  const popularTrendingState = queryClient.getQueryState(popularTrendingQueryKey);
  const popularTrendingCachedRows = Array.isArray(popularTrendingState?.data)
    ? (popularTrendingState?.data as TrendingMangaItem[])
    : [];
  const hasPopularSeedRows =
    popularTrendingCachedRows.length > 0 ||
    lastNonEmptyTrendingRowsRef.current.length > 0;
  const isPopularSeedLoading =
    shouldFetchTrendingForPopular &&
    popularTrendingState?.fetchStatus === 'fetching' &&
    !hasPopularSeedRows;
  const globalSortedItemsLength = globalSortedListQuery.data?.items?.length ?? 0;

  // In default list mode, render both sources from one combined payload (no front/back stagger).
  const isInitialMergedLoading = useCombinedList
    ? (combinedListQuery.isLoading && !combinedListQuery.data)
    : useMangaDexServerSearchMode
      ? (mangaDexServerSearchQuery.isLoading && !mangaDexServerSearchQuery.data)
    : useGlobalClientSortMode
      ? (globalSortedListQuery.isLoading && globalSortedItemsLength === 0)
      : useTrendingPopularMode
        ? (listQuery.isLoading && !stableListData?.items?.length)
        : (useOTruyenCategory ? (isLoading && !data) : (listQuery.isLoading && !stableListData?.items?.length));

  const mangaDexItems = useMemo<Manga[]>(() => {
    return (mangaDexMangas || []).map((item: MangaDexCatalogItem) => {
      const ratingRaw = Number((item as any).rating_average ?? (item as any).average_rating ?? (item as any).rating ?? 0);
      const ratingCountRaw = Number((item as any).rating_count ?? (item as any).ratings_count ?? (item as any).ratingCount ?? 0);
      const mappedRating = Number.isFinite(ratingRaw) ? ratingRaw : 0;
      const mappedRatingCount = Number.isFinite(ratingCountRaw) ? ratingCountRaw : 0;
      const chapter = pickLatestChapter(item);
      const chapterNumber = getMangaDexChapterNumber(chapter);
      const hasReadableChapterNumber =
        Boolean(chapter) && isValidChapterNumber(chapterNumber);
      const localLastPublishedAt = String(item.local_last_published_at || '').trim();
      const chapterDate = hasReadableChapterNumber
        ? pickChapterDate(chapter, localLastPublishedAt || item.updated_at)
        : '';
      const latestChapterPublishedAt = pickStableDate(chapterDate, localLastPublishedAt);
      const newestMangaDexPublishedAt =
        parseTime(localLastPublishedAt) > parseTime(latestChapterPublishedAt)
          ? localLastPublishedAt
          : latestChapterPublishedAt;
      const itemLastUpdated = newestMangaDexPublishedAt || String(item.updated_at || '').trim();
      const mappedLocalViews = Math.max(0, toNumber(item.local_view_count ?? item.view_count ?? item.views ?? 0));
      const mappedPopularityScore = Math.max(
        0,
        toNumber(
          item.mangadex_popularity_score ??
          item.popularity_score ??
          (item as any).popularityScore ??
          0,
        ),
      );
      const mappedViews = mappedLocalViews;
      const mappedYear = resolveMangaDexYear(item);
      const mappedContentRating = String(
        (item as any).content_rating ||
        (item as any).contentRating ||
        ''
      ).trim().toLowerCase();
      const mappedIsMature = Boolean(
        (item as any).is_mature ||
        (item as any).isMature ||
        ['erotica', 'pornographic', 'mature', 'adult', 'explicit'].includes(mappedContentRating) ||
        isMatureManga({
          contentRating: mappedContentRating,
          genres: item.genres || [],
          tags: (item.genres || []).map(toSlug),
        })
      );
      // Build chapter entry — use -1 sentinel when no chapter info available
      let chapterEntry: Manga['chapters'] = [];
      if (chapter && hasReadableChapterNumber) {
        chapterEntry = [{
          id: String(chapter.id || `ch-${item.id}`),
          mangaId: item.id,
          number: chapterNumber,
          title: chapterLabelFromNumber(chapterNumber),
          pages: [],
          uploadDate: latestChapterPublishedAt,
          scanlationGroup: '',
        }];
      } else {
        // Keep a sentinel for display only; MangaDex latest sort must not use metadata updated_at as chapter time.
        chapterEntry = [{
          id: `mdx-ch-${item.id}-placeholder`,
          mangaId: item.id,
          number: -1,
          title: 'Chưa có dữ liệu chương',
          pages: [],
          uploadDate: localLastPublishedAt,
          scanlationGroup: '',
        }];
      }
      const coverDirect = toMangaDexCoverDirect(item.cover_url);
      const coverProxy = toMangaDexCoverProxy(item.cover_url, item.id);
      // Keep MangaDex covers on the local proxy so hotlink placeholders never reach cards.
      return {
        id: String(item.id || '').trim().toLowerCase(),
        title: pickDisplayTitle(item.id, item.title) || 'Chưa có tiêu đề',
        author: item.authors_text || 'MangaDex',
        artist: item.authors_text || 'MangaDex',
        description: '',
        cover: coverProxy || coverDirect,
        coverProxy: DEFAULT_CARD_COVER_FALLBACK,
        status: 'ongoing' as const,
        type: 'manga' as const,
        genres: item.genres || [],
        tags: (item.genres || []).map(toSlug),
        rating: mappedRating,
        ratingCount: mappedRatingCount,
        myRating: null,
        follows: 0,
        views: mappedViews,
        localViewCount: mappedLocalViews,
        popularityScore: mappedPopularityScore,
        mangadexPopularityScore: mappedPopularityScore,
        mangadex_popularity_score: mappedPopularityScore,
        year: mappedYear,
        chapters: chapterEntry,
        lastUpdated: itemLastUpdated,
        localLastPublishedAt,
        local_last_published_at: localLastPublishedAt,
        mangaDexLatestPublishedAt: newestMangaDexPublishedAt,
        contentRating: mappedContentRating,
        isMature: mappedIsMature,
        is_mature: mappedIsMature,
      };
    });
  }, [mangaDexMangas]);

  const mangaDexGenreSlugMap = useMemo(() => {
    if (selectedGenreAliasGroups.length === 0) return new Map<string, Set<string>>();

    const map = new Map<string, Set<string>>();
    for (const item of mangaDexItems) {
      const key = String(item.id || '').trim().toLowerCase();
      if (!key) continue;
      map.set(key, toSlugSet(item.genres || []));
    }
    return map;
  }, [mangaDexItems, selectedGenreAliasGroups]);

  // Keep browse page per source/filter/search tab. New contexts still start at page 1.
  useEffect(() => {
    const previous = lastBrowsePageStateRef.current;
    if (previous.key && previous.key !== browsePageMemoryKey) {
      rememberBrowsePage(previous.key, previous.page);
      const rememberedPage = getRememberedBrowsePage(browsePageMemoryKey);
      lastBrowsePageStateRef.current = { key: browsePageMemoryKey, page: rememberedPage };
      if (rememberedPage !== page) {
        setPage(rememberedPage);
      }
      return;
    }

    lastBrowsePageStateRef.current = { key: browsePageMemoryKey, page };
    rememberBrowsePage(browsePageMemoryKey, page);
  }, [browsePageMemoryKey, page]);

  useEffect(() => {
    if (defaultSortInitializedRef.current) return;
    defaultSortInitializedRef.current = true;
    if (!sortParam && filters.sort !== 'popular') {
      setFilter('sort', 'popular');
    }
  }, [sortParam, filters.sort, setFilter]);

  useEffect(() => {
    const normalizedGenre = String(genreParam || '').trim().toLowerCase();
    const normalizedSort =
      sortParam && ['popular', 'latest', 'rating', 'alphabetical'].includes(sortParam)
        ? String(sortParam)
        : '';
    const urlStateKey = `${normalizedGenre}|${normalizedSort}`;

    // Only apply URL -> store sync when URL query state actually changes.
    // This prevents stale URL sort (e.g. ?sort=rating) from locking sort buttons.
    if (lastAppliedBrowseUrlStateRef.current === urlStateKey) {
      return;
    }
    lastAppliedBrowseUrlStateRef.current = urlStateKey;

    if (normalizedGenre && filters.genres[0] !== normalizedGenre) {
      setFilter('genres', [normalizedGenre]);
    }
    if (normalizedSort && filters.sort !== normalizedSort) {
      setFilter('sort', normalizedSort as SortOption);
    }
  }, [genreParam, sortParam, filters.genres, filters.sort, setFilter]);

  // Prefetch the 'latest' list in the background when page first loads with popular sort
  // so switching to 'Mới nhất' tab is instant
  useEffect(() => {
    if (!isOTruyenSourceTab || filters.sort !== 'popular' || useOTruyenCategory || useCombinedList) return;
    const prefetchKey = ['manga', 'list', 'truyen-moi', 1] as const;
    const existing = queryClient.getQueryData(prefetchKey);
    if (existing) return;
    const timer = window.setTimeout(() => {
      queryClient.prefetchQuery({
        queryKey: prefetchKey,
        queryFn: async () => adaptListData(await mangaApi.getList('truyen-moi', 1)),
        staleTime: 10 * 60 * 1000,
        gcTime: 2 * 60 * 1000,
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [isOTruyenSourceTab, filters.sort, useOTruyenCategory, useCombinedList, queryClient]);

  // Client-side filter on loaded data
  const filtered = useMemo(() => {
    const sourceItems = useGlobalClientSortMode ? globalSortedItems : (stableListData?.items || []);
    if (!sourceItems.length) return [];
    let items = [...sourceItems];
    if (!showMatureContent) {
      items = items.filter((m) => !isMatureManga(m));
    }
    // Status filter (client-side only when using list API without status)
    if (filters.status && listType === 'truyen-moi') {
      items = items.filter(m => m.status === filters.status);
    }
    // Genre filter: apply when NOT using an OTruyen category API (category API already filters server-side)
    if (!useOTruyenCategory && selectedGenreAliasGroups.length > 0) {
      items = items.filter((m) => {
        const key = String(m.id || '').trim().toLowerCase();
        const slugSet = sourceGenreSlugMap.get(key) || toSlugSet([...(m.tags || []), ...(m.genres || [])]);
        return matchesSelectedGenreAliasGroups(slugSet, selectedGenreAliasGroups);
      });
    }
    // Year filter
    if (filters.year) {
      items = items.filter(m => m.year === filters.year);
    }
    // Rating filter
    if (filters.minRating > 0) {
      items = items.filter(m => m.rating >= filters.minRating);
    }
    if (hasSearch) {
      const q = normalizedSearch.toLowerCase();
      items = items.filter(m => m.title.toLowerCase().includes(q) || m.author.toLowerCase().includes(q));
    }
    switch (filters.sort) {
      case 'popular': items.sort(compareByPopular); break;
      case 'latest': items.sort((a, b) => getLatestSortTimestamp(b) - getLatestSortTimestamp(a)); break;
      case 'rating': items.sort((a, b) => b.rating - a.rating); break;
      case 'alphabetical':
        if (!useGlobalClientSortMode) {
          items = sortAlphabeticalItems(items);
        }
        break;
    }
    return items;
  }, [
    useGlobalClientSortMode,
    globalSortedItems,
    stableListData?.items,
    showMatureContent,
    filters,
    listType,
    useOTruyenCategory,
    selectedGenreAliasGroups,
    sourceGenreSlugMap,
    hasSearch,
    normalizedSearch,
  ]);

  const mangaDexFiltered = useMemo(() => {
    if (useMangaDexServerSearchMode) {
      let serverItems = [...mangaDexServerItems];
      if (!showMatureContent) {
        serverItems = serverItems.filter((m) => !isMatureManga(m));
      }
      return serverItems;
    }
    if (!mangaDexItems.length) return [];
    let items = [...mangaDexItems];
    if (!showMatureContent) {
      items = items.filter((m) => !isMatureManga(m));
    }
    if (filters.status) {
      items = items.filter((m) => m.status === filters.status);
    }
    if (selectedGenreAliasGroups.length > 0) {
      items = items.filter((m) => {
        const key = String(m.id || '').trim().toLowerCase();
        const slugSet = mangaDexGenreSlugMap.get(key) || toSlugSet(m.genres || []);
        return matchesSelectedGenreAliasGroups(slugSet, selectedGenreAliasGroups);
      });
    }
    if (filters.minRating > 0) {
      items = items.filter((m) => Number(m.rating || 0) >= filters.minRating);
    }
    if (filters.year) {
      items = items.filter((m) => toValidYear(m.year) === filters.year);
    }
    if (hasSearch) {
      const q = normalizeTag(normalizedSearch);
      items = items.filter(
        (m) =>
          normalizeTag(m.title).includes(q) ||
          normalizeTag(m.author).includes(q) ||
          (m.genres || []).some((g) => normalizeTag(g).includes(q)),
      );
    }
    return items;
  }, [
    useMangaDexServerSearchMode,
    mangaDexServerItems,
    mangaDexItems,
    showMatureContent,
    filters.status,
    filters.minRating,
    filters.year,
    selectedGenreAliasGroups,
    mangaDexGenreSlugMap,
    hasSearch,
    normalizedSearch,
  ]);

  const mangaDexCatalogThumbById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of mangaDexMangas || []) {
      const key = String(item.id || '').trim().toLowerCase();
      const cover = String(item.cover_url || '').trim();
      if (!key || !cover) continue;
      map.set(key, cover);
      map.set(`mdx-${key}`, cover);
    }
    return map;
  }, [mangaDexMangas]);

  // Skip expensive per-page enrichment on rating tab to keep sort-by-rating responsive.
  const shouldRunHeavyBrowseEnrich = filters.sort !== 'rating';

  const popularTrendingQuery = useQuery({
    queryKey: popularTrendingQueryKey,
    queryFn: async () => {
      const parseTrendingRows = (payload: any): TrendingMangaItem[] =>
        Array.isArray(payload?.trending)
          ? (payload.trending as TrendingMangaItem[])
          : [];

      const fetchTrendingRows = async (targetLimit: number, timeoutMs: number): Promise<TrendingMangaItem[]> => {
        try {
          const payload = await withTimeout(
            mangaApi.getTrending(targetLimit, popularTrendingSource),
            timeoutMs,
          );
          return parseTrendingRows(payload);
        } catch {
          return [];
        }
      };

      const primaryPromise = fetchTrendingRows(POPULAR_TRENDING_LIMIT, POPULAR_TRENDING_TIMEOUT_MS);
      const fallbackPromise = fetchTrendingRows(
        POPULAR_TRENDING_FALLBACK_LIMIT,
        POPULAR_TRENDING_FALLBACK_TIMEOUT_MS,
      );

      const firstSettled = await Promise.race([
        primaryPromise.then((rows) => ({ source: 'primary' as const, rows })),
        fallbackPromise.then((rows) => ({ source: 'fallback' as const, rows })),
      ]);

      if (firstSettled.rows.length > 0) {
        if (firstSettled.source === 'fallback') {
          primaryPromise
            .then((rows) => {
              if (rows.length > 0) {
                queryClient.setQueryData(
                  popularTrendingQueryKey,
                  rows,
                );
              }
            })
            .catch(() => {
              // best effort
            });
        }
        return firstSettled.rows;
      }

      const [primaryRows, fallbackRows] = await Promise.all([primaryPromise, fallbackPromise]);
      if (primaryRows.length > 0) return primaryRows;
      if (fallbackRows.length > 0) return fallbackRows;

      const cachedRows = queryClient.getQueryData(
        popularTrendingQueryKey,
      ) as TrendingMangaItem[] | undefined;
      if (Array.isArray(cachedRows) && cachedRows.length > 0) {
        return cachedRows;
      }

      const historicalRows = queryClient
        .getQueriesData<TrendingMangaItem[]>({ queryKey: ['manga', 'trending', 'browse-popular', popularTrendingSource] })
        .map(([, value]) => (Array.isArray(value) ? value : []))
        .find((rows) => rows.length > 0);
      if (historicalRows?.length) {
        return historicalRows;
      }

      if (lastNonEmptyTrendingRowsRef.current.length > 0) {
        return lastNonEmptyTrendingRowsRef.current;
      }

      return [] as TrendingMangaItem[];
    },
    enabled: shouldFetchTrendingForPopular,
    staleTime: 10 * 60 * 1000,
    gcTime: 8 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    retryDelay: 1200,
    placeholderData: (previousData) => previousData,
  });

  const popularTrendingRows = popularTrendingQuery.data || [];

  useEffect(() => {
    if (popularTrendingRows.length > 0) {
      lastNonEmptyTrendingRowsRef.current = popularTrendingRows;
    }
  }, [popularTrendingRows]);

  const popularTrendingOrderMap = useMemo(() => {
    const order = new Map<string, number>();
    if (!shouldFetchTrendingForPopular || !popularTrendingRows.length) return order;

    popularTrendingRows.forEach((row, index) => {
      const slug = String(row.slug || '').trim().toLowerCase();
      const aliasKeys = getBrowseAliasKeys(slug);
      if (!aliasKeys.length || aliasKeys.some((key) => order.has(key))) return;

      const rowViews = Math.max(0, toNumber(row.views));
      if (rowViews <= 0) return;

      aliasKeys.forEach((key) => {
        if (!order.has(key)) order.set(key, index);
      });
    });

    return order;
  }, [shouldFetchTrendingForPopular, popularTrendingRows]);

  const popularTrendingViewsMap = useMemo(() => {
    const viewsMap = new Map<string, number>();
    if (!shouldFetchTrendingForPopular || !popularTrendingRows.length) return viewsMap;

    popularTrendingRows.forEach((row) => {
      const slug = String(row.slug || '').trim().toLowerCase();
      const aliasKeys = getBrowseAliasKeys(slug);
      if (!aliasKeys.length) return;

      const rowViews = Math.max(0, toNumber(row.views));
      if (rowViews <= 0) return;

      const register = (key: string) => {
        if (!key) return;
        const current = viewsMap.get(key) ?? 0;
        if (rowViews > current) viewsMap.set(key, rowViews);
      };

      aliasKeys.forEach(register);
    });

    return viewsMap;
  }, [shouldFetchTrendingForPopular, popularTrendingRows]);

  const popularTrendingItems = useMemo<Manga[]>(() => {
    if (!useTrendingPopularMode || !popularTrendingRows.length) return [];

    const cachedListItems = queryClient
      .getQueriesData<OTruyenListData>({ queryKey: ['manga', 'list'] })
      .flatMap(([, payload]) => payload?.items || []);
    const cachedCategoryItems = queryClient
      .getQueriesData<OTruyenListData>({ queryKey: ['manga', 'category'] })
      .flatMap(([, payload]) => payload?.items || []);
    const cachedCombinedItems = queryClient
      .getQueriesData<{ listData?: OTruyenListData }>({ queryKey: ['manga', 'list-combined'] })
      .flatMap(([, payload]) => payload?.listData?.items || []);

    const knownLookup = new Map<string, Manga>();
    for (const item of [
      ...(stableListData?.items || []),
      ...mangaDexItems,
      ...filtered,
      ...mangaDexFiltered,
      ...cachedListItems,
      ...cachedCategoryItems,
      ...cachedCombinedItems,
    ]) {
      if (!showMatureContent && isMatureManga(item)) continue;
      const aliasKeys = getBrowseAliasKeys(item);
      if (!aliasKeys.length || isUnresolvedPublicManga(item)) continue;
      const existing = aliasKeys.map((key) => knownLookup.get(key)).find(Boolean);
      if (existing) {
        aliasKeys.forEach((key) => {
          if (!knownLookup.has(key)) knownLookup.set(key, existing);
        });
        continue;
      }
      aliasKeys.forEach((key) => knownLookup.set(key, item));
    }

    const overlays: Manga[] = [];

    for (const row of popularTrendingRows) {
      const slug = String(row.slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug)) continue;

      const views = Math.max(0, toNumber(row.views));
      if (views <= 0) continue;

      const rowGenres = normalizeTrendingList(row.genres);
      const rawRowTags = normalizeTrendingList(row.tags).map(toSlug).filter(Boolean);
      const rowTags = rawRowTags.length ? rawRowTags : rowGenres.map(toSlug).filter(Boolean);
      const rowStatus = mapTrendingStatus(row.status);
      const rowContentRating = getTrendingContentRating(row);

      if (!showMatureContent && isMatureManga({
        contentRating: rowContentRating,
        genres: rowGenres,
        tags: rowTags,
        title: row.title,
        is_mature: row.is_mature,
        isMature: row.isMature,
      })) {
        continue;
      }

      const existing = getBrowseAliasKeys(slug)
        .map((key) => knownLookup.get(key))
        .find((item): item is Manga => Boolean(item));
      if (existing) {
        const fallbackTitle = repairMojibakeText(existing.title).trim();
        const rowTitle = repairMojibakeText(row.title).trim();
        const safeTitle = pickDisplayTitle(slug, fallbackTitle, rowTitle);
        const existingCover = String(existing.cover || '').trim();
        const existingFallbackCover = String(existing.coverProxy || '').trim();
        if (!safeTitle && !existingCover && !existingFallbackCover) {
          continue;
        }

        const catalogThumb = mangaDexCatalogThumbById.get(slug) || '';
        const inferredCovers = getTrendingCoverSources({ slug, thumb: String(row.thumb || catalogThumb) });
        const safeCover = isNoCoverValue(existingCover)
          ? inferredCovers.cover
          : existingCover;
        const inferredProxyTarget =
          extractImageProxyTargetUrl(existingCover) ||
          extractImageProxyTargetUrl(inferredCovers.cover);
        const safeCoverProxy = isNoCoverValue(existingFallbackCover)
          ? (inferredCovers.coverProxy || inferredProxyTarget || DEFAULT_CARD_COVER_FALLBACK)
          : existingFallbackCover;

        const safeChapters =
          Array.isArray(existing.chapters) && existing.chapters.length > 0
            ? existing.chapters
            : buildTrendingChapterFallback(slug, row, existing.status || rowStatus, existing.lastUpdated);

        overlays.push({
          ...existing,
          title: safeTitle || fallbackTitle || 'Chưa có tiêu đề',
          cover: safeCover,
          coverProxy: safeCoverProxy,
          status: existing.status || rowStatus,
          genres: (existing.genres && existing.genres.length) ? existing.genres : rowGenres,
          tags: (existing.tags && existing.tags.length) ? existing.tags : rowTags,
          chapters: safeChapters,
          views: Math.max(views, toNumber(existing.views)),
          contentRating: String(existing.contentRating || rowContentRating || '').trim().toLowerCase(),
        });
        continue;
      }

      const isMdx = isMangaDexSlug(slug);
      const rowTitle = repairMojibakeText(row.title).trim();
      const resolvedTitle = pickDisplayTitle(slug, rowTitle);
      const catalogThumb = mangaDexCatalogThumbById.get(slug) || '';
      const { cover, coverProxy } = getTrendingCoverSources({
        slug,
        thumb: String(row.thumb || catalogThumb),
      });

      if (!resolvedTitle && isNoCoverValue(cover) && isNoCoverValue(coverProxy)) {
        continue;
      }

      overlays.push({
        id: slug,
        title: resolvedTitle || 'Chưa có tiêu đề',
        author: isMdx ? 'MangaDex' : 'OTruyen',
        artist: isMdx ? 'MangaDex' : 'OTruyen',
        description: '',
        cover,
        coverProxy,
        status: rowStatus,
        type: 'manga',
        genres: rowGenres,
        tags: rowTags,
        rating: 0,
        ratingCount: 0,
        myRating: null,
        follows: 0,
        views,
        year: new Date().getFullYear(),
        chapters: buildTrendingChapterFallback(slug, row, rowStatus),
        lastUpdated: resolveTrendingTimestamp(row) || '',
        contentRating: rowContentRating,
      });
    }

    return dedupeMangaById(overlays);
  }, [
    useTrendingPopularMode,
    popularTrendingRows,
    stableListData?.items,
    mangaDexItems,
    filtered,
    mangaDexFiltered,
    mangaDexCatalogThumbById,
    showMatureContent,
    queryClient,
  ]);

  const popularTrendingItemsBySource = useMemo(
    () =>
      popularTrendingItems.filter((item) =>
        isItemInBrowseSource(item, activeSource)
      ),
    [popularTrendingItems, activeSource],
  );

  const popularTrendingItemsForServerPage = useMemo(() => {
    if (filters.sort !== 'popular' || !isOTruyenSourceTab) return [] as Manga[];
    if (!useTrendingPopularMode || !popularTrendingItemsBySource.length) return [] as Manga[];
    const start = (Math.max(1, page) - 1) * BROWSE_PAGE_SIZE;
    return popularTrendingItemsBySource.slice(start, start + BROWSE_PAGE_SIZE);
  }, [
    filters.sort,
    isOTruyenSourceTab,
    useTrendingPopularMode,
    page,
    popularTrendingItemsBySource,
  ]);

  const { data: myRatedMangaData } = useQuery({
    queryKey: ['rating', 'me', 'browse', ratingViewerKey, MY_RATED_BATCH_MAX],
    queryFn: async () => {
      try {
        return await ratingApi.getMyRatedManga(MY_RATED_BATCH_MAX);
      } catch {
        return { items: [] };
      }
    },
    enabled: isLoggedIn,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const myRatedScoreMap = useMemo(() => {
    const map = new Map<string, number>();
    const ratedItems = ((myRatedMangaData as any)?.items || []) as MyRatedMangaItem[];
    for (const record of ratedItems) {
      const slug = String(record.manga_slug || '').trim().toLowerCase();
      const score = Number(record.score);
      if (isInvalidPublicMangaSlug(slug) || !Number.isFinite(score)) continue;

      map.set(slug, score);
      if (isMangaDexSlug(slug)) {
        const detailId = toMangaDexDetailId(slug);
        if (!detailId) continue;
        map.set(detailId, score);
        map.set(`mdx-${detailId}`, score);
      }
    }
    return map;
  }, [myRatedMangaData]);

  const { data: guestTopRatedData, isLoading: guestTopRatedLoading } = useQuery({
    queryKey: ['rating', 'top', 'browse', 'guest', GUEST_TOP_RATED_LIMIT],
    queryFn: async () => {
      try {
        return await ratingApi.getTopRatedManga(GUEST_TOP_RATED_LIMIT);
      } catch {
        return { items: [] };
      }
    },
    enabled: useGlobalTopRatedMode,
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedRows = useMemo<TopRatedGlobalItem[]>(
    () => (((guestTopRatedData as any)?.items || []) as TopRatedGlobalItem[]),
    [guestTopRatedData],
  );

  const guestTopRatedKnownLookup = useMemo(() => {
    const lookup = new Map<string, Manga>();
    for (const item of [
      ...(stableListData?.items || []),
      ...(data?.items || []),
      ...mangaDexItems,
      ...mangaDexFiltered,
      ...filtered,
    ]) {
      const key = String(item.id || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(key) || isUnresolvedPublicManga(item) || lookup.has(key)) continue;
      lookup.set(key, item);
    }
    return lookup;
  }, [stableListData?.items, data?.items, mangaDexItems, mangaDexFiltered, filtered]);

  const guestTopRatedMissingSlugs = useMemo(() => {
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug) || seen.has(slug)) continue;
      seen.add(slug);
      if (guestTopRatedKnownLookup.has(slug)) continue;
      missing.push(slug);
      if (missing.length >= GUEST_TOP_RATED_RESOLVE_MAX) break;
    }

    return missing;
  }, [guestTopRatedRows, guestTopRatedKnownLookup]);

  const { data: guestTopRatedResolvedMap = {} } = useQuery({
    queryKey: ['rating', 'top', 'browse', 'guest', 'details-v1', guestTopRatedMissingSlugs],
    queryFn: async () => {
      const result: Record<string, Manga> = {};

      await Promise.allSettled(
        guestTopRatedMissingSlugs.map(async (slug) => {
          const detailId = toMangaDexDetailId(slug);

          if (detailId) {
            const payload = await mangaApi.getMangaDexDetail(detailId, 120);
            const item = (payload?.manga || {}) as any;
            const chapterRows = Array.isArray(item.chapters) ? item.chapters : [];

            const best = chapterRows
              .map((chapter: any) => {
                const chapterNum =
                  parseChapterNumberFromText(chapter?.chapter) ||
                  parseChapterNumberFromText(chapter?.chapter_with_groups) ||
                  parseChapterNumberFromText(chapter?.title);
                const chapterDate = String(
                  chapter?.publish_at ||
                    chapter?.readable_at ||
                    chapter?.created_at ||
                    chapter?.updated_at ||
                    item?.updated_at ||
                    '',
                ).trim();

                return {
                  chapterNum,
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

            const uploadDate =
              best?.chapterDate ||
              String(item?.updated_at || '').trim() ||
              new Date().toISOString();
            const rawGenres = Array.isArray(item.genres)
              ? item.genres.map((genre: unknown) => repairMojibakeText(genre).trim()).filter(Boolean)
              : [];

            result[slug] = {
              id: slug,
              title: pickDisplayTitle(slug, item.title) || 'Chưa có tiêu đề',
              author: repairMojibakeText(item.authors_text) || 'MangaDex',
              artist: repairMojibakeText(item.authors_text) || 'MangaDex',
              description: '',
              cover: toMangaDexCoverProxy(item.cover_url, detailId),
              coverProxy: DEFAULT_CARD_COVER_FALLBACK,
              status: mapTrendingStatus(String(item.status || 'ongoing')),
              type: 'manga',
              genres: rawGenres,
              tags: rawGenres
                .map((genre) => genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
                .filter(Boolean),
              rating: 0,
              ratingCount: 0,
              myRating: null,
              follows: 0,
              views: Number(item.view_count || item.views || 0),
              year: Number(item.year) || new Date().getFullYear(),
              chapters: best
                ? [{
                    id: best.id || `mdx-ch-${detailId}-top`,
                    mangaId: detailId,
                    number: best.chapterNum,
                    title: chapterLabelFromNumber(best.chapterNum),
                    pages: [],
                    uploadDate,
                    scanlationGroup: '',
                  }]
                : [],
              lastUpdated: uploadDate,
              contentRating: String(item.content_rating || item.contentRating || '').trim().toLowerCase(),
            };
            return;
          }

          const raw = await mangaApi.getDetail(slug);
          const adapted = adaptMangaDetail(raw);
          result[slug] = {
            ...adapted,
            id: slug,
          };
        }),
      );

      return result;
    },
    enabled: useGlobalTopRatedMode && guestTopRatedMissingSlugs.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedItems = useMemo<Manga[]>(() => {
    if (!useGlobalTopRatedMode) return [];

    const resolvedLookup = (guestTopRatedResolvedMap || {}) as Record<string, Manga>;
    const ordered: Manga[] = [];

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug)) continue;

      const trustedAverage = Number(row?.average || 0);
      const trustedCount = Number(row?.count || 0);
      const known = guestTopRatedKnownLookup.get(slug);
      const resolved = resolvedLookup[slug];
      const base = resolved || known;

      if (base) {
        ordered.push({
          ...base,
          id: slug,
          rating: Number.isFinite(trustedAverage) ? trustedAverage : 0,
          ratingCount: Number.isFinite(trustedCount) ? trustedCount : 0,
          myRating: null,
          lastUpdated: String(row?.updated_at || base.lastUpdated || '').trim() || base.lastUpdated,
        });
        continue;
      }

      ordered.push({
        id: slug,
        title: pickDisplayTitle(slug) || 'Chưa có tiêu đề',
        author: isMangaDexSlug(slug) ? 'MangaDex' : 'OTruyen',
        artist: isMangaDexSlug(slug) ? 'MangaDex' : 'OTruyen',
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
      });
    }

    return dedupeMangaById(ordered);
  }, [
    useGlobalTopRatedMode,
    guestTopRatedResolvedMap,
    guestTopRatedRows,
    guestTopRatedKnownLookup,
  ]);

  const guestTopRatedFiltered = useMemo<Manga[]>(() => {
    if (!useGlobalTopRatedMode) return [];

    let items = [...guestTopRatedItems];

    if (!showMatureContent) {
      items = items.filter((m) => !isMatureManga(m));
    }

    if (filters.status) {
      items = items.filter((m) => m.status === filters.status);
    }

    if (selectedGenreAliasGroups.length > 0) {
      items = items.filter((m) => {
        const slugSet = toSlugSet([...(m.tags || []), ...(m.genres || [])]);
        return matchesSelectedGenreAliasGroups(slugSet, selectedGenreAliasGroups);
      });
    }

    if (filters.year) {
      items = items.filter((m) => toValidYear(m.year) === filters.year);
    }

    if (filters.minRating > 0) {
      items = items.filter((m) => Number(m.rating || 0) >= filters.minRating);
    }

    if (hasSearch) {
      const q = normalizedSearch.toLowerCase();
      items = items.filter(
        (m) =>
          String(m.title || '').toLowerCase().includes(q) ||
          String(m.author || '').toLowerCase().includes(q),
      );
    }

    items.sort(compareByRating);
    return items;
  }, [
    useGlobalTopRatedMode,
    guestTopRatedItems,
    showMatureContent,
    filters.status,
    filters.year,
    filters.minRating,
    selectedGenreAliasGroups,
    hasSearch,
    normalizedSearch,
  ]);

  const guestTopRatedFilteredBySource = useMemo(
    () =>
      guestTopRatedFiltered.filter((item) =>
        isItemInBrowseSource(item, activeSource)
      ),
    [guestTopRatedFiltered, activeSource],
  );

  const myRatedOverlayItems = useMemo<Manga[]>(() => {
    if (filters.sort !== 'rating') return [];

    const ratedItems = ((myRatedMangaData as any)?.items || []) as MyRatedMangaItem[];
    if (!ratedItems.length) return [];

    const knownLookup = new Map<string, Manga>();
    for (const item of [
      ...(data?.items || []),
      ...mangaDexItems,
      ...filtered,
      ...mangaDexFiltered,
    ]) {
      const key = String(item.id || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(key) || isUnresolvedPublicManga(item) || knownLookup.has(key)) continue;
      knownLookup.set(key, item);
    }

    const overlays: Manga[] = [];
    const matchesGenreFilter = (genres: string[], tags: string[]): boolean => {
      if (selectedGenreAliasGroups.length === 0) return true;
      const slugSet = toSlugSet([...(tags || []), ...(genres || [])]);
      return matchesSelectedGenreAliasGroups(slugSet, selectedGenreAliasGroups);
    };

    for (const record of ratedItems) {
      const slug = String(record.manga_slug || '').trim().toLowerCase();
      if (isInvalidPublicMangaSlug(slug)) continue;

      const recordYear = toValidYear(record.year);

      const myScore = Number(record.score);
      if (!Number.isFinite(myScore)) continue;

      const rowGenres = Array.isArray(record.genres)
        ? record.genres.map((genre) => String(genre || '').trim()).filter(Boolean)
        : [];
      let rowTags = Array.isArray(record.tags)
        ? record.tags.map((tag) => String(tag || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!rowTags.length && rowGenres.length) {
        rowTags = rowGenres
          .map((genre) => genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
          .filter(Boolean);
      }

      const existing = knownLookup.get(slug);
      if (existing) {
        const nextGenres = (existing.genres && existing.genres.length) ? existing.genres : rowGenres;
        const nextTags = (existing.tags && existing.tags.length) ? existing.tags : rowTags;
        if (!matchesGenreFilter(nextGenres, nextTags)) {
          continue;
        }
        if (filters.year && toValidYear(existing.year) !== filters.year) {
          continue;
        }

        const fallbackTitle = String(existing.title || '').trim();
        const safeTitle =
          fallbackTitle && !isSlugLikeTitle(fallbackTitle, slug)
            ? fallbackTitle
            : humanizeSlugTitle(slug);
        const existingCover = String(existing.cover || '').trim();
        const existingFallbackCover = String(existing.coverProxy || '').trim();
        if (!safeTitle && !existingCover && !existingFallbackCover) {
          continue;
        }
        const existingHasRealChapter = hasRealChapterData(existing.chapters || []);
        const ratedChapters = buildMyRatedChapters(slug, record);
        if (!existingHasRealChapter && ratedChapters.length === 0) {
          continue;
        }
        overlays.push({
          ...existing,
          title: safeTitle || fallbackTitle || 'Chưa có tiêu đề',
          coverProxy: existing.coverProxy || DEFAULT_CARD_COVER_FALLBACK,
          genres: nextGenres,
          tags: nextTags,
          chapters: existingHasRealChapter ? existing.chapters : ratedChapters,
          myRating: myScore,
          rating: Number(existing.rating || 0) > 0 ? Number(existing.rating || 0) : myScore,
          ratingCount: Number(existing.ratingCount || 0) > 0 ? Number(existing.ratingCount || 0) : 1,
          lastUpdated: String(
            getMyRatedLatestChapterUpdatedAt(record) ||
              record.updated_at ||
              existing.lastUpdated ||
              new Date().toISOString(),
          ),
        });
        continue;
      }

      if (!matchesGenreFilter(rowGenres, rowTags)) {
        continue;
      }
      if (filters.year && recordYear !== filters.year) {
        continue;
      }

      const isMdx = isMangaDexSlug(slug);
      const rawThumb = toAbsoluteThumbUrl(String(record.thumb || '').trim());
      const recordTitle = String(record.title || '').trim();
      const resolvedTitle =
        recordTitle && !isSlugLikeTitle(recordTitle, slug)
          ? recordTitle
          : humanizeSlugTitle(slug);

      // Skip unresolved placeholders (generic title + no real cover) to avoid showing
      // "MangaDex" or raw slug labels in rating sort results.
      if (!resolvedTitle && !rawThumb) {
        continue;
      }
      if (isMdx && !rawThumb) {
        continue;
      }

      const ratedChapters = buildMyRatedChapters(slug, record);
      if (!hasRealChapterData(ratedChapters)) {
        continue;
      }

      const cover = rawThumb
        ? (isMdx ? toMangaDexCoverProxy(rawThumb, slug) : thumbUrl(rawThumb, slug))
        : DEFAULT_CARD_COVER_FALLBACK;
      const coverProxy = rawThumb
        ? (
            isMdx
              ? DEFAULT_CARD_COVER_FALLBACK
              : (thumbFallbackUrl(rawThumb, slug) || DEFAULT_CARD_COVER_FALLBACK)
          )
        : DEFAULT_CARD_COVER_FALLBACK;

      overlays.push({
        id: slug,
        title: resolvedTitle || 'Chưa có tiêu đề',
        author: isMdx ? 'MangaDex' : 'OTruyen',
        artist: isMdx ? 'MangaDex' : 'OTruyen',
        description: '',
        cover,
        coverProxy,
        status: 'ongoing',
        type: 'manga',
        genres: rowGenres,
        tags: rowTags,
        rating: myScore,
        ratingCount: 1,
        myRating: myScore,
        follows: 0,
        views: 0,
        year: recordYear,
        chapters: ratedChapters,
        lastUpdated: String(getMyRatedLatestChapterUpdatedAt(record) || record.updated_at || new Date().toISOString()),
        contentRating: '',
      });
    }

    return dedupeMangaById(overlays).slice(0, MY_RATED_BATCH_MAX);
  }, [
    filters.sort,
    myRatedMangaData,
    data?.items,
    mangaDexItems,
    filtered,
    mangaDexFiltered,
    filters.year,
    selectedGenreAliasGroups,
  ]);

  const myRatedOverlayItemsForSource = useMemo(
    () =>
      myRatedOverlayItems.filter((item) =>
        isItemInBrowseSource(item, activeSource)
      ),
    [myRatedOverlayItems, activeSource],
  );

  const mdxSlotPerPage =
    filters.sort !== 'latest' && filters.sort !== 'rating' && page <= CONTINUOUS_SORT_WINDOW_PAGES
    ? MDX_SLOT_FIRST_WINDOW
    : MDX_SLOT_DEFAULT;

  // Keep rating tab load behavior close to latest: render fast with current page data,
  // then hydrate only visible card ratings in the background.
  const useLatestLikeRatingLoad = filters.sort === 'rating';

  const ratingSortCandidates = useMemo(() => {
    if (filters.sort !== 'rating') return [];
    if (useGlobalTopRatedMode) return guestTopRatedFilteredBySource;

    const sourceItems = isMangaDexSourceTab ? mangaDexFiltered : filtered;

    if (isClientPaginationMode) {
      return dedupeMangaById([...sourceItems, ...myRatedOverlayItemsForSource]);
    }
    return dedupeMangaById([...sourceItems, ...myRatedOverlayItemsForSource]);
  }, [
    filters.sort,
    useGlobalTopRatedMode,
    guestTopRatedFilteredBySource,
    isMangaDexSourceTab,
    isClientPaginationMode,
    filtered,
    mangaDexFiltered,
    myRatedOverlayItemsForSource,
  ]);

  const ratingSortBatchCandidates = useMemo(
    () => ratingSortCandidates.filter(needsRatingBatchEnrichment),
    [ratingSortCandidates],
  );

  const ratingSortSlugs = useMemo(
    () => {
      if (useLatestLikeRatingLoad) return [];

      return ratingSortBatchCandidates
        .map((m) => String(m.id || '').trim().toLowerCase())
        .filter((slug) => !isInvalidPublicMangaSlug(slug))
        .slice(0, RATING_SORT_BATCH_MAX);
    },
    [ratingSortBatchCandidates, useLatestLikeRatingLoad],
  );

  const { data: ratingSortBatchData } = useQuery({
    queryKey: ['rating', 'batch', 'browse', ratingViewerKey, isClientPaginationMode ? 'client' : `server:${page}`, ratingSortSlugs],
    queryFn: async () => {
      if (!ratingSortSlugs.length) return { ratings: {}, my_scores: {} };
      try {
        return await fetchBatchRatingsParallel(ratingSortSlugs);
      } catch {
        return { ratings: {}, my_scores: {} };
      }
    },
    enabled:
      filters.sort === 'rating' &&
      !useGlobalTopRatedMode &&
      !useLatestLikeRatingLoad &&
      ratingSortSlugs.length > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const ratingSortMap = useMemo(
    () => ((ratingSortBatchData as any)?.ratings || {}) as Record<string, any>,
    [ratingSortBatchData],
  );

  const ratingSortMyScores = useMemo(
    () => ((ratingSortBatchData as any)?.my_scores || {}) as Record<string, any>,
    [ratingSortBatchData],
  );

  const mergedFiltered = useMemo(() => {
    // In server pagination mode this merged full-list result is never used.
    // Skip expensive dedupe/sort work to keep genre switching responsive.
    if (!isClientPaginationMode) return [] as Manga[];

    if (useGlobalTopRatedMode && filters.sort === 'rating') {
      return guestTopRatedFilteredBySource;
    }

    if (useMangaDexServerSearchMode) {
      return mangaDexFiltered;
    }

    const sourceItems = isMangaDexSourceTab ? mangaDexFiltered : filtered;

    const merged =
      filters.sort === 'rating'
        ? [...sourceItems, ...myRatedOverlayItemsForSource]
        : filters.sort === 'popular'
          ? [
              ...(isOTruyenSourceTab && isClientPaginationMode ? popularTrendingItemsBySource : []),
              ...sourceItems,
            ]
        : [...sourceItems];
    const deduped = dedupeMangaById(merged);
    const withTrendingViews =
      filters.sort === 'popular' && isOTruyenSourceTab && popularTrendingViewsMap.size > 0
        ? deduped.map((item) => {
            const trendingViews = getMappedNumberByAlias(popularTrendingViewsMap, item);
            if (trendingViews === undefined) return item;
            const currentViews = Math.max(0, toNumber(item.views));
            if (currentViews >= trendingViews) return item;
            return { ...item, views: trendingViews };
          })
        : deduped;
    let sortable =
      filters.sort === 'rating' && !useLatestLikeRatingLoad
        ? withTrendingViews.map((m) => applyBatchRatingToManga(m, ratingSortMap, ratingSortMyScores))
        : withTrendingViews;

    switch (filters.sort) {
      case 'popular':
        if (isOTruyenSourceTab) {
          sortable.sort((a, b) => compareByPopularWithPriority(a, b, popularTrendingOrderMap));
        } else {
          sortable.sort(compareByPopular);
        }
        break;
      case 'latest':
        sortable.sort((a, b) => getLatestSortTimestamp(b) - getLatestSortTimestamp(a));
        break;
      case 'rating':
        sortable.sort(compareByRating);
        break;
      case 'alphabetical':
        sortable = sortAlphabeticalItems(sortable);
        break;
    }
    return sortable;
  }, [
    isMangaDexSourceTab,
    isOTruyenSourceTab,
    filtered,
    mangaDexFiltered,
    useMangaDexServerSearchMode,
    myRatedOverlayItemsForSource,
    popularTrendingItemsBySource,
    isClientPaginationMode,
    filters.sort,
    useLatestLikeRatingLoad,
    ratingSortMap,
    ratingSortMyScores,
    popularTrendingOrderMap,
    popularTrendingViewsMap,
    useGlobalTopRatedMode,
    guestTopRatedFilteredBySource,
  ]);

  const mangaDexSearchSnapshotKey = `${browsePageMemoryKey}|mature:${showMatureContent ? 1 : 0}`;
  const stableMergedFiltered = useMemo(() => {
    if (useMangaDexServerSearchMode || !isMangaDexSourceTab || !hasSearch || !isClientPaginationMode) {
      return mergedFiltered;
    }

    const currentByKey = new Map<string, Manga>();
    const currentKeys: string[] = [];
    for (const item of mergedFiltered) {
      const key = getStableBrowseItemKey(item);
      if (!key || currentByKey.has(key)) continue;
      currentByKey.set(key, item);
      currentKeys.push(key);
    }

    const previous =
      mangaDexSearchSnapshotRef.current.key === mangaDexSearchSnapshotKey
        ? mangaDexSearchSnapshotRef.current.items
        : [];
    const seen = new Set<string>();
    const stableItems: Manga[] = [];

    for (const previousItem of previous) {
      const key = getStableBrowseItemKey(previousItem);
      if (!key || seen.has(key)) continue;
      const freshItem = currentByKey.get(key);
      stableItems.push(freshItem || previousItem);
      seen.add(key);
    }

    for (const key of currentKeys) {
      if (seen.has(key)) continue;
      const item = currentByKey.get(key);
      if (!item) continue;
      stableItems.push(item);
      seen.add(key);
    }

    mangaDexSearchSnapshotRef.current = {
      key: mangaDexSearchSnapshotKey,
      items: stableItems,
    };
    return stableItems;
  }, [
    isMangaDexSourceTab,
    useMangaDexServerSearchMode,
    hasSearch,
    isClientPaginationMode,
    mergedFiltered,
    mangaDexSearchSnapshotKey,
  ]);

  // Smaller page size keeps initial render and image loading lighter.
  const pageSize = BROWSE_PAGE_SIZE;

  const otruyenServerPages = isClientPaginationMode ? 0 : (data?.totalPages || 1);
  const canExpandMangaDexCatalog =
    isMangaDexSourceTab &&
    !useMangaDexServerSearchMode &&
    !useGlobalTopRatedMode &&
    typeof mangadexCatalogRequestLimit === 'number' &&
    mangadexCatalogRequestLimit < baseMangaDexCatalogLimit;
  const mangaDexLoadedFilteredPages = Math.max(
    1,
    Math.ceil(stableMergedFiltered.length / pageSize),
  );
  const isMangaDexDemandPagePending =
    mangaDexHasNarrowClientFilters &&
    canExpandMangaDexCatalog &&
    stableMergedFiltered.length > 0 &&
    page > mangaDexLoadedFilteredPages;
  const estimatedClientTotalPages = useMemo(() => {
    if (!isClientPaginationMode) return 1;

    let estimatedItems = stableMergedFiltered.length;

    if (useGlobalClientSortMode) {
      const probeTotalItems = Math.max(0, Number((globalSortProbeQuery.data as any)?.totalItems || 0));
      if (probeTotalItems > estimatedItems) {
        estimatedItems = probeTotalItems;
      }
    }

    let estimatedPages = Math.max(1, Math.ceil(estimatedItems / pageSize));

    // MangaDex search/genre filtering happens on the loaded catalog snapshot.
    // If the backend can still expand that snapshot, keep one extra page open so
    // moving forward triggers a deeper catalog fetch instead of looking "stuck".
    if (
      mangaDexHasNarrowClientFilters &&
      canExpandMangaDexCatalog &&
      estimatedItems > 0
    ) {
      estimatedPages = Math.max(estimatedPages, Math.ceil(estimatedItems / pageSize) + 1);
    }

    return estimatedPages;
  }, [
    isClientPaginationMode,
    stableMergedFiltered.length,
    useGlobalClientSortMode,
    filters.sort,
    globalSortProbeQuery.data,
    mangaDexHasNarrowClientFilters,
    canExpandMangaDexCatalog,
    pageSize,
  ]);

  const guestTopRatedTotalPages = useMemo(
    () => Math.max(1, Math.ceil(guestTopRatedFilteredBySource.length / pageSize)),
    [guestTopRatedFilteredBySource.length, pageSize],
  );
  const mangaDexServerTotalPages = Math.max(
    1,
    Number(mangaDexServerSearchQuery.data?.totalPages || 1),
  );

  const totalPages = useGlobalTopRatedMode
    ? guestTopRatedTotalPages
    : useMangaDexServerSearchMode
      ? mangaDexServerTotalPages
    : isClientPaginationMode
      ? estimatedClientTotalPages
      : otruyenServerPages;
  const currentPage = Math.min(page, totalPages);
  const canExpandMangaDexDemand = canExpandMangaDexCatalog;
  const isAtMangaDexLoadedLimit =
    canExpandMangaDexDemand &&
    totalPages > 0 &&
    currentPage >= totalPages;
  const isNearMangaDexLoadedLimit =
    canExpandMangaDexDemand &&
    totalPages > 0 &&
    (
      page > totalPages ||
      isAtMangaDexLoadedLimit ||
      page >= Math.max(1, totalPages - MANGADEX_DEMAND_PREFETCH_PAGES)
    );
  const mangaDexLoadedItemCount = isMangaDexSourceTab ? stableMergedFiltered.length : 0;
  const mangaDexRemainingLoadedItems = Math.max(0, mangaDexLoadedItemCount - (page * pageSize));
  const isMangaDexLoadedItemBufferLow =
    canExpandMangaDexDemand &&
    mangaDexLoadedItemCount > 0 &&
    mangaDexRemainingLoadedItems <= MANGADEX_DEMAND_PREFETCH_ITEMS;
  const shouldExpandMangaDexDemand =
    isNearMangaDexLoadedLimit || isMangaDexLoadedItemBufferLow;
  const isNearMangaDexRefetchEdge =
    isMangaDexSourceTab &&
    !useGlobalTopRatedMode &&
    totalPages > 0 &&
    page >= Math.max(1, totalPages - MANGADEX_DEMAND_EDGE_REFETCH_PAGES);
  const isMangaDexRefetchItemBufferLow =
    isMangaDexSourceTab &&
    !useGlobalTopRatedMode &&
    mangaDexLoadedItemCount > 0 &&
    mangaDexRemainingLoadedItems <= MANGADEX_DEMAND_EDGE_REFETCH_ITEMS;
  const shouldRefetchMangaDexEdge =
    !canExpandMangaDexDemand &&
    (isNearMangaDexRefetchEdge || isMangaDexRefetchItemBufferLow) &&
    activeMangaDexSuccess &&
    !activeMangaDexLoading &&
    !activeMangaDexFetching;

  useEffect(() => {
    if (!shouldExpandMangaDexDemand) return;
    if (activeMangaDexLoading || activeMangaDexFetching) return;
    if (
      typeof mangadexCatalogRequestLimit !== 'number' ||
      mangadexCatalogRequestLimit >= baseMangaDexCatalogLimit
    ) {
      return;
    }

    const targetPage = Math.max(page, currentPage, totalPages) + MANGADEX_DEMAND_PREFETCH_PAGES;
    const advanceKey = [
      mangadexCatalogRequestLimit,
      targetPage,
      baseMangaDexCatalogLimit,
      mangaDexLoadedItemCount,
    ].join(':');
    const previous = mangaDexDemandAdvanceStateRef.current;
    const now = Date.now();
    if (now - previous.at < MANGADEX_DEMAND_ADVANCE_COOLDOWN_MS) {
      return;
    }
    mangaDexDemandAdvanceStateRef.current = { key: advanceKey, at: now };

    const advanceDemandLimit = () => {
      setMangaDexDemandLimit((currentLimit) => {
        if (currentLimit >= baseMangaDexCatalogLimit) return currentLimit;
        const nextLimit = getNextMangaDexDemandLimit(
          currentLimit,
          targetPage,
          baseMangaDexCatalogLimit,
          mangaDexHasNarrowClientFilters,
        );
        return nextLimit > currentLimit ? nextLimit : currentLimit;
      });
    };

    const timer = window.setTimeout(advanceDemandLimit, MANGADEX_DEMAND_EDGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    shouldExpandMangaDexDemand,
    activeMangaDexLoading,
    activeMangaDexFetching,
    page,
    currentPage,
    totalPages,
    mangaDexLoadedItemCount,
    mangaDexRemainingLoadedItems,
    mangadexCatalogRequestLimit,
    baseMangaDexCatalogLimit,
    mangaDexHasNarrowClientFilters,
  ]);

  useEffect(() => {
    if (!shouldRefetchMangaDexEdge) return;
    const refetchKey = [
      mangadexCatalogRequestLimit,
      totalPages,
      mangaDexLoadedItemCount,
    ].join(':');
    const previous = mangaDexEdgeRefetchStateRef.current;
    if (
      previous.key === refetchKey &&
      Date.now() - previous.at < MANGADEX_DEMAND_EDGE_REFETCH_COOLDOWN_MS
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const latest = mangaDexEdgeRefetchStateRef.current;
      const now = Date.now();
      if (
        latest.key === refetchKey &&
        now - latest.at < MANGADEX_DEMAND_EDGE_REFETCH_COOLDOWN_MS
      ) {
        return;
      }
      mangaDexEdgeRefetchStateRef.current = { key: refetchKey, at: now };
      refetchActiveMangaDex().catch(() => {
        // Backend may still be refreshing MangaDex; keep the current snapshot visible.
      });
    }, MANGADEX_DEMAND_EDGE_REFETCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    shouldRefetchMangaDexEdge,
    refetchActiveMangaDex,
    page,
    totalPages,
    mangaDexLoadedItemCount,
    mangaDexRemainingLoadedItems,
    mangadexCatalogRequestLimit,
  ]);

  useEffect(() => {
    if (!isMangaDexSourceTab || useGlobalTopRatedMode) return;
    if (shouldExpandMangaDexDemand) return;
    if (activeMangaDexLoading || activeMangaDexFetching) return;
    if (!activeMangaDexCatalog.length) return;
    const backgroundLimit = Math.min(baseMangaDexCatalogLimit, MANGADEX_DEMAND_BACKGROUND_LIMIT);
    if (
      typeof mangadexCatalogRequestLimit !== 'number' ||
      mangadexCatalogRequestLimit >= backgroundLimit
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setMangaDexDemandLimit((currentLimit) => {
        if (currentLimit >= backgroundLimit) return currentLimit;
        const targetPage = Math.max(page, currentPage) + MANGADEX_DEMAND_PREFETCH_PAGES;
        const nextLimit = getNextMangaDexDemandLimit(
          currentLimit,
          targetPage,
          backgroundLimit,
          mangaDexHasNarrowClientFilters,
        );
        return nextLimit > currentLimit ? nextLimit : currentLimit;
      });
    }, MANGADEX_DEMAND_BACKGROUND_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    isMangaDexSourceTab,
    useGlobalTopRatedMode,
    shouldExpandMangaDexDemand,
    activeMangaDexLoading,
    activeMangaDexFetching,
    activeMangaDexCatalog.length,
    mangadexCatalogRequestLimit,
    baseMangaDexCatalogLimit,
    page,
    currentPage,
    mangaDexHasNarrowClientFilters,
  ]);

  const pagedItems = useMemo(() => {
    if (useGlobalTopRatedMode) {
      return guestTopRatedFilteredBySource.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    }

    if (useMangaDexServerSearchMode) {
      return stableMergedFiltered;
    }

    if (isClientPaginationMode) {
      return stableMergedFiltered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    }

    // Server mode: OTruyen items only (active source tab = OTruyen)
    const combined =
      filters.sort === 'rating'
        ? [...filtered, ...myRatedOverlayItemsForSource]
        : filters.sort === 'popular'
          ? [...popularTrendingItemsForServerPage, ...filtered]
          : [...filtered];
    const deduped = dedupeMangaById(combined);
    const withTrendingViews =
      filters.sort === 'popular' && popularTrendingViewsMap.size > 0
        ? deduped.map((item) => {
            const trendingViews = getMappedNumberByAlias(popularTrendingViewsMap, item);
            if (trendingViews === undefined) return item;
            const currentViews = Math.max(0, toNumber(item.views));
            if (currentViews >= trendingViews) return item;
            return { ...item, views: trendingViews };
          })
        : deduped;
    let sortable =
      filters.sort === 'rating' && !useLatestLikeRatingLoad
        ? withTrendingViews.map((m) => applyBatchRatingToManga(m, ratingSortMap, ratingSortMyScores))
        : withTrendingViews;

    // Re-sort OTruyen server-page dataset by active sort.
    switch (filters.sort) {
      case 'popular':
        sortable.sort((a, b) => compareByPopularWithPriority(a, b, popularTrendingOrderMap));
        break;
      case 'latest':
        sortable.sort((a, b) => getLatestSortTimestamp(b) - getLatestSortTimestamp(a));
        break;
      case 'rating':
        sortable.sort(compareByRating);
        break;
      case 'alphabetical':
        sortable = sortAlphabeticalItems(sortable);
        break;
    }
    return filters.sort === 'popular' && isOTruyenSourceTab
      ? sortable.slice(0, pageSize)
      : sortable;
  }, [
    isClientPaginationMode,
    useMangaDexServerSearchMode,
    stableMergedFiltered,
    currentPage,
    pageSize,
    filters.sort,
    filtered,
    myRatedOverlayItemsForSource,
    isOTruyenSourceTab,
    popularTrendingItemsForServerPage,
    popularTrendingViewsMap,
    useLatestLikeRatingLoad,
    ratingSortMap,
    ratingSortMyScores,
    popularTrendingOrderMap,
    useGlobalTopRatedMode,
    guestTopRatedFilteredBySource,
  ]);

  const shouldRunVisibleRatingHydrate =
    (shouldRunHeavyBrowseEnrich || useLatestLikeRatingLoad) && !useGlobalTopRatedMode;
  const visibleRatingBatchLimit = useLatestLikeRatingLoad ? pageSize : 48;

  const visibleRatingBatchSlugs = useMemo(() => {
    if (!shouldRunVisibleRatingHydrate) return [];

    return dedupeMangaById(pagedItems)
      .filter((item) => isLoggedIn || needsRatingBatchEnrichment(item))
      .map((item) => String(item.id || '').trim().toLowerCase())
      .filter((slug) => !isInvalidPublicMangaSlug(slug))
      .slice(0, visibleRatingBatchLimit);
  }, [pagedItems, shouldRunVisibleRatingHydrate, visibleRatingBatchLimit, isLoggedIn]);

  const { data: visibleRatingBatchData } = useQuery({
    queryKey: [
      'rating',
      'batch',
      'browse-visible',
      ratingViewerKey,
      filters.sort,
      isClientPaginationMode ? 'client' : `server:${page}`,
      visibleRatingBatchSlugs,
    ],
    queryFn: async () => {
      if (!visibleRatingBatchSlugs.length) return { ratings: {}, my_scores: {} };
      try {
        return await fetchBatchRatingsParallel(visibleRatingBatchSlugs);
      } catch {
        return { ratings: {}, my_scores: {} };
      }
    },
    enabled: shouldRunVisibleRatingHydrate && visibleRatingBatchSlugs.length > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const visibleRatingMap = useMemo(
    () => ((visibleRatingBatchData as any)?.ratings || {}) as Record<string, any>,
    [visibleRatingBatchData],
  );

  const visibleRatingMyScores = useMemo(
    () => ((visibleRatingBatchData as any)?.my_scores || {}) as Record<string, any>,
    [visibleRatingBatchData],
  );

  // Avoid detail burst on MangaDex tab: chapter freshness is already handled by latest-chapters API.
  const shouldEnrichVisibleMangaDex = (shouldRunHeavyBrowseEnrich || useLatestLikeRatingLoad) && !isMangaDexSourceTab;

  const visibleMangaDexIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of pagedItems) {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!isMangaDexSlug(slug)) continue;

      const detailId = toMangaDexDetailId(slug);
      if (!detailId) continue;

      ids.add(detailId);
      if (ids.size >= pageSize) break;
    }

    return Array.from(ids);
  }, [pagedItems, pageSize]);

  const visibleMangaDexChapterSeedMap = useMemo(() => {
    const result: Record<string, { latestChapter?: Manga['chapters'][number]; lastUpdated?: string }> = {};

    for (const item of pagedItems) {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!isMangaDexSlug(slug)) continue;

      const detailId = toMangaDexDetailId(slug);
      if (!detailId) continue;

      const latestChapter = pickLatestReadableChapter(item.chapters || []);
      if (!latestChapter || !hasReadableChapter(latestChapter)) continue;

      const meta = {
        latestChapter,
        lastUpdated: latestChapter.uploadDate || item.lastUpdated || undefined,
      };
      result[slug] = meta;
      result[detailId] = meta;
      result[`mdx-${detailId}`] = meta;
    }

    return result;
  }, [pagedItems]);

  const mangaDexLatestChaptersQuery = useQuery({
    queryKey: ['manga', 'mangadex', 'latest-chapters', 'browse-fast-v1', visibleMangaDexIds],
    queryFn: async () => {
      const result: Record<string, { latestChapter?: Manga['chapters'][number]; lastUpdated?: string }> = {
        ...visibleMangaDexChapterSeedMap,
      };
      const payload = await mangaApi.getMangaDexLatestChapters(visibleMangaDexIds, {
        fast: true,
      });
      const latestMap = (payload?.items || {}) as Record<string, any>;

      for (const detailId of visibleMangaDexIds) {
        const latest = latestMap[detailId] || latestMap[`mdx-${detailId}`];
        const latestChapterText = String(latest?.chapter_name || latest?.chapter_title || '').trim();
        const chapterNum =
          parseChapterNumberFromText(latest?.chapter_name) ||
          parseChapterNumberFromText(latest?.chapter_title);
        if (!latestChapterText || !isValidChapterNumber(chapterNum)) continue;

        const uploadDate = String(latest?.publish_at || '').trim() || new Date().toISOString();
        const latestChapter: Manga['chapters'][number] = {
          id: `mdx-ch-${detailId}-latest`,
          mangaId: detailId,
          number: chapterNum,
          title: chapterLabelFromNumber(chapterNum),
          pages: [],
          uploadDate,
          scanlationGroup: '',
        };

        const meta = {
          latestChapter,
          lastUpdated: String(latest?.publish_at || '').trim() || undefined,
        };
        result[detailId] = meta;
        result[`mdx-${detailId}`] = meta;
      }

      return result;
    },
    enabled: visibleMangaDexIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => ({
      ...visibleMangaDexChapterSeedMap,
      ...(previousData || {}),
    }),
  });

  const mangaDexLatestChapterMap = mangaDexLatestChaptersQuery.data || visibleMangaDexChapterSeedMap;

  const mangaDexMissingVisibleChapterIds = useMemo(() => {
    if (!isMangaDexSourceTab) return [];
    if (!mangaDexLatestChaptersQuery.isFetched) return [];

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of pagedItems) {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!isMangaDexSlug(slug)) continue;

      const detailId = toMangaDexDetailId(slug);
      if (!detailId || seen.has(detailId)) continue;

      const meta =
        mangaDexLatestChapterMap[slug] ||
        mangaDexLatestChapterMap[detailId] ||
        mangaDexLatestChapterMap[`mdx-${detailId}`];
      const seededLatest = pickLatestReadableChapter(item.chapters || []);
      if (
        (meta?.latestChapter && hasReadableChapter(meta.latestChapter)) ||
        (seededLatest && hasReadableChapter(seededLatest))
      ) {
        continue;
      }

      seen.add(detailId);
      ids.push(detailId);
      if (ids.length >= MANGADEX_VISIBLE_CHAPTER_FALLBACK_MAX) break;
    }

    return ids;
  }, [
    isMangaDexSourceTab,
    mangaDexLatestChaptersQuery.isFetched,
    mangaDexLatestChapterMap,
    pagedItems,
  ]);

  const { data: mangaDexVisibleChapterFallbackMap = {} } = useQuery({
    queryKey: ['manga', 'mangadex', 'visible-chapter-fallback-v1', mangaDexMissingVisibleChapterIds],
    queryFn: async () => {
      const result: Record<string, { latestChapter?: Manga['chapters'][number]; lastUpdated?: string }> = {};
      const queue = [...mangaDexMissingVisibleChapterIds];
      const workerCount = Math.min(MANGADEX_VISIBLE_CHAPTER_FALLBACK_CONCURRENCY, queue.length);

      const fetchOne = async (detailId: string) => {
        const payload = await withTimeout(
          mangaApi.getMangaDexDetail(
            detailId,
            MANGADEX_VISIBLE_CHAPTER_FALLBACK_CHAPTERS,
            'vi',
            { timeoutMs: MANGADEX_VISIBLE_CHAPTER_FALLBACK_TIMEOUT_MS },
          ),
          MANGADEX_VISIBLE_CHAPTER_FALLBACK_TIMEOUT_MS,
        );
        const item = (payload?.manga || {}) as any;
        const chapterRows = Array.isArray(item.chapters) ? item.chapters : [];
        const latestRaw = chapterRows
          .filter(isReadableMangaDexDetailChapter)
          .map((chapter: any) => {
            const chapterText = String(chapter.chapter || '').trim();
            const chapterWithGroupsText = String(chapter.chapter_with_groups || '').trim();
            const chapterNum =
              parseChapterNumberFromText(chapterText) ||
              parseChapterNumberFromText(chapterWithGroupsText);
            const chapterDate = String(
              chapter.publish_at ||
              chapter.readable_at ||
              chapter.created_at ||
              chapter.updated_at ||
              item.updated_at ||
              ''
            ).trim();

            return {
              chapterNum,
              chapterDate,
              id: String(chapter.id || '').trim(),
            };
          })
          .sort((a, b) => {
            const numberDiff = toNumber(a.chapterNum) - toNumber(b.chapterNum);
            if (numberDiff !== 0) return numberDiff;
            return parseTime(a.chapterDate) - parseTime(b.chapterDate);
          })
          .filter((chapter) => isValidChapterNumber(chapter.chapterNum))
          .pop();

        if (!latestRaw) return;

        const uploadDate = latestRaw.chapterDate || String(item.updated_at || new Date().toISOString());
        const latestChapter: Manga['chapters'][number] = {
          id: latestRaw.id || `mdx-ch-${detailId}-detail-fallback`,
          mangaId: detailId,
          number: latestRaw.chapterNum,
          title: chapterLabelFromNumber(latestRaw.chapterNum),
          pages: [],
          uploadDate,
          scanlationGroup: '',
        };
        const meta = {
          latestChapter,
          lastUpdated: String(item.updated_at || uploadDate || '').trim() || undefined,
        };

        result[detailId] = meta;
        result[`mdx-${detailId}`] = meta;
      };

      await Promise.allSettled(
        Array.from({ length: workerCount }, async () => {
          while (queue.length) {
            const detailId = queue.shift();
            if (!detailId) continue;
            try {
              await fetchOne(detailId);
            } catch {
              // Keep other visible cards moving even if one MangaDex detail is slow.
            }
          }
        }),
      );

      return result;
    },
    enabled: isMangaDexSourceTab && mangaDexMissingVisibleChapterIds.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const mangaDexEnrichIds = useMemo(() => {
    if (!shouldEnrichVisibleMangaDex) return [];
    const candidates = new Map<string, number>();
    for (const item of pagedItems) {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!isMangaDexSlug(slug)) continue;

      const lastChapter = pickLatestReadableChapter(item.chapters || []);
      const missingCover = isNoCoverValue(item.cover) && isNoCoverValue(item.coverProxy);
      const missingChapter = !hasReadableChapter(lastChapter);
      const missingGenres = !(item.genres && item.genres.length > 0);
      const singleChapterSnapshot = (item.chapters || []).length <= 1;
      const key = toMangaDexDetailId(slug);
      if (!key) continue;
      const score =
        (missingCover ? 4 : 0) +
        (missingChapter ? 2 : 0) +
        (singleChapterSnapshot ? 2 : 0) +
        (missingGenres ? 1 : 0);
      if (score <= 0) continue;
      const previous = candidates.get(key) ?? -1;
      if (score > previous) {
        candidates.set(key, score);
      }
    }
    return Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MANGADEX_ENRICH_MAX)
      .map(([id]) => id);
  }, [pagedItems, shouldEnrichVisibleMangaDex]);

  const realChapterSyncSlugs = useMemo(() => {
    if (!shouldRunHeavyBrowseEnrich) return [];

    const candidates = new Map<string, number>();
    for (const item of pagedItems) {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!slug) continue;
      if (!shouldSyncRealChapterForBrowse(item)) continue;

      const latest = pickLatestReadableChapter(item.chapters || []);
      const missingReadableChapter = !latest || !hasReadableChapter(latest);
      const syntheticLatest = !!latest && isSyntheticChapterId(String(latest.id || ''), slug);
      const missingRealChapterData = !hasRealChapterData(item.chapters || []);
      const needsSync = missingReadableChapter || syntheticLatest || missingRealChapterData;
      if (!needsSync) continue;

      const score =
        (missingReadableChapter ? 3 : 0) +
        (syntheticLatest ? 2 : 0) +
        (missingRealChapterData ? 1 : 0);
      const previous = candidates.get(slug) ?? -1;
      if (score > previous) {
        candidates.set(slug, score);
      }
    }

    return Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, REAL_CHAPTER_SYNC_MAX)
      .map(([slug]) => slug);
  }, [pagedItems, shouldRunHeavyBrowseEnrich]);

  const { data: realChapterSyncMap = {} } = useQuery({
    queryKey: ['manga', 'browse', 'real-chapter-sync', realChapterSyncSlugs],
    queryFn: async () => {
      const result: Record<string, RealChapterSyncMeta> = {};

      await Promise.allSettled(
        realChapterSyncSlugs.map(async (slug) => {
          const payload = await withTimeout(mangaApi.getDetail(slug), REAL_CHAPTER_SYNC_TIMEOUT_MS);
          const detail = adaptMangaDetail(payload);
          const latest = pickLatestReadableChapter(detail.chapters || []);
          if (!latest || !hasReadableChapter(latest)) return;

          const normalizedNumber = toNumber(latest.number);
          result[slug] = {
            latestChapter: {
              ...latest,
              mangaId: slug,
              number: normalizedNumber,
              title: chapterLabelFromNumber(normalizedNumber),
            },
            lastUpdated: String(
              detail.lastUpdated || latest.uploadDate || ''
            ).trim() || undefined,
          };
        })
      );

      return result;
    },
    enabled: shouldRunHeavyBrowseEnrich && realChapterSyncSlugs.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const { data: mangaDexEnrichMap = {} } = useQuery({
    queryKey: ['manga', 'mangadex', 'browse-enrich-v2', mangaDexEnrichIds],
    queryFn: async () => {
      const result: Record<string, MangaDexEnrichMeta> = {};

      await Promise.allSettled(
        mangaDexEnrichIds.map(async (detailId) => {
          const payload = await mangaApi.getMangaDexDetail(detailId, 1);
          const item = (payload?.manga || {}) as any;
          const coverUrl = String(item.cover_url || '').trim();

          const genres = Array.isArray(item.genres)
            ? item.genres.map((genre: unknown) => repairMojibakeText(genre).trim()).filter(Boolean)
            : [];
          const tags = genres.map(toSlug).filter(Boolean);

          const status = mapTrendingStatus(String(item.status || ''));
          const chapterRows = Array.isArray(item.chapters) ? item.chapters : [];
          const latestRaw = chapterRows
            .filter(isReadableMangaDexDetailChapter)
            .map((chapter: any) => {
              const chapterText = String(chapter.chapter || '').trim();
              const chapterWithGroupsText = String(chapter.chapter_with_groups || '').trim();
              const chapterNum =
                parseChapterNumberFromText(chapterText) ||
                parseChapterNumberFromText(chapterWithGroupsText);
              const chapterDate = String(
                chapter.publish_at ||
                chapter.readable_at ||
                chapter.created_at ||
                chapter.updated_at ||
                item.updated_at ||
                ''
              ).trim();

              return {
                chapterNum,
                chapterDate,
                id: String(chapter.id || '').trim(),
              };
            })
            .sort((a, b) => {
              const numberDiff = toNumber(a.chapterNum) - toNumber(b.chapterNum);
              if (numberDiff !== 0) return numberDiff;
              return parseTime(a.chapterDate) - parseTime(b.chapterDate);
            })
            .filter((chapter) => isValidChapterNumber(chapter.chapterNum))
            .pop();

          let latestChapter: Manga['chapters'][number] | undefined;
          if (latestRaw) {
            const uploadDate = latestRaw.chapterDate || String(item.updated_at || new Date().toISOString());
            latestChapter = {
              id: latestRaw.id || `mdx-ch-${detailId}-latest`,
              mangaId: detailId,
              number: latestRaw.chapterNum,
              title: chapterLabelFromNumber(latestRaw.chapterNum),
              pages: [],
              uploadDate,
              scanlationGroup: '',
            };
          }

          const meta: MangaDexEnrichMeta = {
            cover: coverUrl ? toMangaDexCoverProxy(coverUrl, detailId) : undefined,
            coverProxy: coverUrl ? DEFAULT_CARD_COVER_FALLBACK : undefined,
            genres,
            tags,
            status,
            latestChapter,
            lastUpdated: String(item.updated_at || '').trim() || undefined,
            contentRating: String(item.content_rating || item.contentRating || '').trim().toLowerCase() || undefined,
          };

          result[detailId] = meta;
          result[`mdx-${detailId}`] = meta;
        })
      );

      return result;
    },
    enabled: shouldEnrichVisibleMangaDex && mangaDexEnrichIds.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const displayItems = useMemo(() => {
    const mapped = pagedItems.map((item) => {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!isMangaDexSlug(slug)) return item;

      const detailId = toMangaDexDetailId(slug);
      if (!detailId) return item;

      const latestMeta =
        mangaDexVisibleChapterFallbackMap[slug] ||
        mangaDexVisibleChapterFallbackMap[detailId] ||
        mangaDexVisibleChapterFallbackMap[`mdx-${detailId}`] ||
        mangaDexLatestChapterMap[slug] ||
        mangaDexLatestChapterMap[detailId] ||
        mangaDexLatestChapterMap[`mdx-${detailId}`];
      const next = { ...item };

      if (latestMeta?.latestChapter && hasReadableChapter(latestMeta.latestChapter)) {
        const currentLatest = pickLatestReadableChapter(next.chapters || []);
        const currentChapterNumber = toNumber(currentLatest?.number);
        const syncedChapterNumber = toNumber(latestMeta.latestChapter.number);
        const currentUploadTs = parseTime(currentLatest?.uploadDate);
        const syncedUploadTs = parseTime(latestMeta.latestChapter.uploadDate);

        const shouldReplaceLatest =
          !currentLatest ||
          !hasReadableChapter(currentLatest) ||
          syncedChapterNumber > currentChapterNumber ||
          (syncedChapterNumber === currentChapterNumber && syncedUploadTs > currentUploadTs);

        if (shouldReplaceLatest) {
          next.chapters = [latestMeta.latestChapter];
        }

        if (
          latestMeta.lastUpdated &&
          (
            parseTime(next.lastUpdated) === 0 ||
            !currentLatest ||
            !hasReadableChapter(currentLatest) ||
            isPlaceholderChapterTitle(currentLatest?.title) ||
            parseTime(latestMeta.lastUpdated) > parseTime(next.lastUpdated)
          )
        ) {
          next.lastUpdated = latestMeta.lastUpdated;
        }
      }

      if (!shouldEnrichVisibleMangaDex) return next;

      const meta =
        mangaDexEnrichMap[slug] ||
        mangaDexEnrichMap[detailId] ||
        mangaDexEnrichMap[`mdx-${detailId}`];
      if (!meta) return next;

      if (isNoCoverValue(next.cover) && meta.cover) {
        next.cover = meta.cover;
      }
      if (isNoCoverValue(next.coverProxy) && meta.coverProxy) {
        next.coverProxy = meta.coverProxy;
      }

      if (meta.latestChapter && hasReadableChapter(meta.latestChapter)) {
        const currentLatest = pickLatestReadableChapter(next.chapters || []);
        const currentChapterNumber = toNumber(currentLatest?.number);
        const syncedChapterNumber = toNumber(meta.latestChapter.number);
        const currentUploadTs = parseTime(currentLatest?.uploadDate);
        const syncedUploadTs = parseTime(meta.latestChapter.uploadDate);

        const shouldReplaceLatest =
          !currentLatest ||
          !hasReadableChapter(currentLatest) ||
          syncedChapterNumber > currentChapterNumber ||
          (syncedChapterNumber === currentChapterNumber && syncedUploadTs > currentUploadTs);

        if (shouldReplaceLatest) {
          next.chapters = [meta.latestChapter];
        }
      }

      if ((!next.genres || next.genres.length === 0) && meta.genres && meta.genres.length > 0) {
        next.genres = meta.genres;
      }
      if ((!next.tags || next.tags.length === 0) && meta.tags && meta.tags.length > 0) {
        next.tags = meta.tags;
      }
      if (meta.status && next.status === 'ongoing') {
        next.status = meta.status;
      }
      if (
        meta.lastUpdated &&
        (
          parseTime(next.lastUpdated) === 0 ||
          parseTime(meta.lastUpdated) > parseTime(next.lastUpdated)
        )
      ) {
        next.lastUpdated = meta.lastUpdated;
      }
      if (!String(next.contentRating || '').trim() && meta.contentRating) {
        next.contentRating = meta.contentRating;
      }

      return next;
    });

    const withRealChapterData = mapped.map((item) => {
      const slug = String(item.id || '').trim().toLowerCase();
      if (!slug || isMangaDexSlug(slug)) return item;

      const meta = realChapterSyncMap[slug];
      if (!meta?.latestChapter || !hasReadableChapter(meta.latestChapter)) return item;

      const currentLatest = pickLatestReadableChapter(item.chapters || []);
      const currentChapterNumber = toNumber(currentLatest?.number);
      const syncedChapterNumber = toNumber(meta.latestChapter.number);
      const currentUploadTs = parseTime(currentLatest?.uploadDate);
      const syncedUploadTs = parseTime(meta.latestChapter.uploadDate);

      const shouldReplace =
        !currentLatest ||
        !hasReadableChapter(currentLatest) ||
        isSyntheticChapterId(String(currentLatest.id || ''), slug) ||
        currentChapterNumber !== syncedChapterNumber ||
        (syncedUploadTs > 0 && syncedUploadTs >= currentUploadTs);

      if (!shouldReplace) return item;

      return {
        ...item,
        chapters: [meta.latestChapter],
        lastUpdated: meta.lastUpdated || item.lastUpdated,
      };
    });

    const withResolvedTitles = withRealChapterData.map((item) => {
      const slug = String(item.id || '').trim().toLowerCase();
      const resolvedTitle = pickDisplayTitle(slug, item.altTitle, item.title);
      if (!resolvedTitle || resolvedTitle === item.title) return item;
      return { ...item, title: resolvedTitle };
    });

    const withCoverFallback = withResolvedTitles.map((item) => {
      const fallbackFromProxy = extractImageProxyTargetUrl(item.cover);
      if (!fallbackFromProxy) return item;

      const existingFallback = String(item.coverProxy || '').trim();
      if (existingFallback && existingFallback !== item.cover && !isNoCoverValue(existingFallback)) {
        return item;
      }

      return { ...item, coverProxy: fallbackFromProxy };
    });

    const withVisibleRatings = withCoverFallback.map((item) =>
      applyBatchRatingToManga(item, visibleRatingMap, visibleRatingMyScores)
    );

    const withMyRatings =
      isLoggedIn && myRatedScoreMap.size > 0
        ? withVisibleRatings.map((item) => {
            const key = String(item.id || '').trim().toLowerCase();
            const score = myRatedScoreMap.get(key);
            if (score === undefined || item.myRating === score) return item;
            return { ...item, myRating: score };
          })
        : withVisibleRatings;

    const ratingModeItems =
      filters.sort === 'rating' && isLoggedIn
        ? withMyRatings.filter(hasTrustedRatingSignal)
        : withMyRatings;

    const safeItems = ratingModeItems.filter((item) => !isUnresolvedPublicManga(item));
    if (showMatureContent) return safeItems;
    return safeItems.filter((item) => !isMatureManga(item));
  }, [
    pagedItems,
    mangaDexEnrichMap,
    mangaDexLatestChapterMap,
    mangaDexVisibleChapterFallbackMap,
    realChapterSyncMap,
    visibleRatingMap,
    visibleRatingMyScores,
    shouldEnrichVisibleMangaDex,
    showMatureContent,
    filters.sort,
    isLoggedIn,
    myRatedScoreMap,
  ]);

  // ── Browser-level preload (limited) ───────────────────────────────────────
  // Avoid preloading the whole page; only warm the first visible covers.
  useEffect(() => {
    const urls = displayItems
      .slice(0, 6)
      .map(m => m.cover)
      .filter((u): u is string => !!u && u.includes('/api/images/'));
    urls.forEach(url => {
      const img = new window.Image();
      img.src = url;
    });
  }, [displayItems]);

  useEffect(() => {
    if (isNearMangaDexLoadedLimit) return;
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages, isNearMangaDexLoadedLimit]);

  // Prefetch adjacent MangaDex search pages so pagination feels instant.
  useEffect(() => {
    if (!useMangaDexServerSearchMode) return;
    const total = Math.max(1, mangaDexServerTotalPages);
    const targetPages = Array.from(new Set([page + 1, page - 1]))
      .filter((targetPage) => targetPage >= 1 && targetPage <= total);

    targetPages.forEach((targetPage) => {
      queryClient.prefetchQuery({
        queryKey: getMangaDexServerSearchQueryKey(targetPage),
        queryFn: () => fetchMangaDexServerSearchPage(targetPage),
        staleTime: 2 * 60 * 1000,
        gcTime: 8 * 60 * 1000,
      }).catch(() => {
        // Best-effort warmup only; normal navigation still handles errors.
      });
    });
  }, [
    useMangaDexServerSearchMode,
    page,
    mangaDexServerTotalPages,
    queryClient,
    getMangaDexServerSearchQueryKey,
    fetchMangaDexServerSearchPage,
  ]);

  // Prefetch next OTruyen page
  useEffect(() => {
    if (isClientPaginationMode) return;
    const nextPage = page + 1;
    if (nextPage > otruyenServerPages) return;
    if (useCombinedList) {
      queryClient.prefetchQuery({
        queryKey: ['manga', 'list-combined', listType, nextPage, mangadexCatalogLimit],
        queryFn: async () => {
          const payload = await mangaApi.getCombinedList(listType, nextPage, mangadexCatalogLimit);
          return {
            listData: adaptListData(payload?.list || {}),
            mangadex: (payload?.mangadex?.mangas || []) as MangaDexCatalogItem[],
          };
        },
        staleTime: 5 * 60 * 1000,
        gcTime: 2 * 60 * 1000,
      });
      return;
    }
    if (useOTruyenCategory) {
      queryClient.prefetchQuery({
        queryKey: ['manga', 'category', activeCategorySlug, nextPage],
        queryFn: async () => adaptListData(await mangaApi.getCategoryManga(activeCategorySlug, nextPage)),
        staleTime: 5 * 60 * 1000,
        gcTime: 2 * 60 * 1000,
      });
      return;
    }
    queryClient.prefetchQuery({
    queryKey: ['manga', 'list', listType, nextPage],
    queryFn: async () => adaptListData(await mangaApi.getList(listType, nextPage)),
    staleTime: 5 * 60 * 1000,
    gcTime: 2 * 60 * 1000,
  });
  }, [
    page,
    otruyenServerPages,
    useCombinedList,
    useOTruyenCategory,
    activeCategorySlug,
    listType,
    mangadexCatalogLimit,
    queryClient,
    isClientPaginationMode,
  ]);

  const isTabLoadingState =
    isInitialMergedLoading ||
    isMangaDexDemandPagePending ||
    (
      displayItems.length === 0 &&
      (
        isFetching ||
        isLoading ||
        activeMangaDexLoading ||
        activeMangaDexFetching ||
        (useGlobalTopRatedMode && guestTopRatedLoading) ||
        isPopularSeedLoading
      )
    );

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="accent-line" />
          <h1 className="ed-heading text-2xl">Khám Phá Truyện</h1>
        </div>
        <button
          onClick={() => setShowFilter(!showFilter)}
          className="lg:hidden flex items-center gap-2 px-3 py-2 rounded-lg bg-muted text-sm font-medium text-muted-foreground hover:text-foreground transition-colors border border-border"
        >
          {showFilter ? <X className="w-4 h-4" /> : <SlidersHorizontal className="w-4 h-4" />}
          Bộ lọc
        </button>
      </div>

      <div className="mb-6 flex items-center gap-2">
        <button
          onClick={() => setBrowseSource('otruyen')}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
            isOTruyenSourceTab
              ? 'bg-primary text-primary-foreground comic-shadow'
              : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
          }`}
        >
          OTruyen
        </button>
        <button
          onClick={() => setBrowseSource('mangadex')}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
            isMangaDexSourceTab
              ? 'bg-primary text-primary-foreground comic-shadow'
              : 'bg-secondary text-muted-foreground hover:text-foreground border border-border/50'
          }`}
        >
          MangaDex
        </button>
      </div>

      <div className="flex gap-8">
        <div className="hidden lg:block w-64 shrink-0">
          <div className="sticky top-20 ed-card p-4">
            <FilterPanel />
          </div>
        </div>

        <AnimatePresence>
          {showFilter && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="lg:hidden fixed inset-x-0 top-0 z-40 bg-card/95 backdrop-blur-md border-b border-border p-4 overflow-y-auto max-h-[70vh] pt-16"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-bold">Bộ lọc</span>
                <button onClick={() => setShowFilter(false)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <FilterPanel />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 min-w-0">
          {isTabLoadingState ? (
            <div className="space-y-4 py-3">
              <div className="flex items-center justify-center gap-2 text-primary/90">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm font-semibold">Đang tải dữ liệu truyện...</span>
              </div>
              <MangaGridSkeleton count={18} />
              <div className="h-10 rounded-xl bg-muted/40 animate-pulse" />
              {isMangaDexDemandPagePending && totalPages > 1 && (
                <MangaPagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
              )}
            </div>
          ) : (
            <>
              {isFetching && displayItems.length > 0 && !isMangaDexServerPageTransition && (
                <div className="flex justify-center mb-3">
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                </div>
              )}
              <p className="text-sm text-muted-foreground mb-4 font-medium">
                {displayItems.length} kết quả trang này
                {isClientPaginationMode && stableMergedFiltered.length > pageSize && (
                  <span className="ml-1 opacity-60">/ {stableMergedFiltered.length} tổng</span>
                )}
              </p>
              {displayItems.length > 0 ? (
                <>
                  <MangaGrid
                    manga={displayItems}
                    lazyBatch
                    initialBatchSize={12}
                    batchStep={6}
                    batchDelayMs={120}
                  />
                  <MangaPagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
                </>
              ) : (
                <div className="text-center py-20">
                  <BookOpen className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
                  {totalPages > 1 && (
                    <div className="mb-6">
                      <MangaPagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
                    </div>
                  )}
                  <p className="text-muted-foreground font-medium">Không tìm thấy truyện nào phù hợp.</p>
                </div>
              )}

            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BrowseManga;
