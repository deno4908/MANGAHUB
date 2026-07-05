import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMangaDexViCatalog, useMangaList, useTrending } from "@/hooks/useApi";
import { useSettingsStore } from "@/store/settingsStore";
import { useUserStore } from "@/store/userStore";
import MangaGrid from "@/components/manga/MangaGrid";
import OptimizedImage from "@/components/ui/OptimizedImage";
import { Trophy, TrendingUp, Clock, Star, Loader2, Flame } from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { mangaApi, ratingApi } from "@/lib/api";
import { adaptMangaDetail, thumbFallbackUrl, thumbUrl } from "@/lib/adapters";
import { isMatureManga } from "@/lib/contentFilter";
import { getMangaDetailPath, normalizeMangaDexId } from "@/lib/mangaLinks";
import type { Manga } from "@/types/manga";

type Tab = "trending" | "latest" | "rating" | "completed";

type MangaDexCatalogItem = {
  id: string;
  url?: string;
  title: string;
  cover_url?: string;
  authors_text?: string;
  updated_at?: string;
  view_count?: number | string;
  views?: number | string;
  local_view_count?: number | string;
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

const tabConfig: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "trending", label: "Xu hướng", icon: Flame },
  { key: "latest", label: "Mới nhất", icon: Clock },
  { key: "rating", label: "Đánh giá cao", icon: Star },
  { key: "completed", label: "Hoàn thành", icon: Trophy },
];

const RANKING_MANGADEX_LIMIT = 80;
const RANKINGS_TRENDING_LIMIT = 100;
const RANKINGS_TRENDING_FALLBACK_LIMIT = 100;
const RANKINGS_GRID_LIMIT = 100;
const RATING_BATCH_MAX = 180;
const MY_RATED_RANKING_LIMIT = 240;
const RATING_BATCH_CHUNK_SIZE = 40;
const RATING_BATCH_WAVE_SIZE = 3;
const RATING_BATCH_TIMEOUT_MS = 8_500;
const RANKING_MANGADEX_DETAIL_FALLBACK_MAX = 4;
const RANKING_MANGADEX_DETAIL_FALLBACK_CHAPTER_LIMIT = 120;
const GUEST_TOP_RATED_LIMIT = 100;
const GUEST_TOP_RATED_RESOLVE_MAX = 40;
const RATING_BAYESIAN_PRIOR_AVERAGE = 3.5;
const RATING_BAYESIAN_PRIOR_COUNT = 5;

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
  weighted_score?: number;
  updated_at?: string;
};

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const DEFAULT_CARD_COVER_FALLBACK = "/no-cover.svg";
const DEFAULT_TRENDING_THUMB_FALLBACK = "/no-cover.svg";
const MOJIBAKE_RE = /[ÃÂÄÅÆÐ]/;
const NON_ASCII_RE = /[^\x00-\x7f]/;

const mojibakeScore = (value: string): number =>
  (String(value || "").match(MOJIBAKE_RE) || []).length;

const repairMojibakeText = (value: unknown): string => {
  const text = String(value || "");
  if (!text || mojibakeScore(text) === 0) return text;

  const candidates = [text];
  try {
    const bytes = Uint8Array.from(Array.from(text).map((ch) => ch.charCodeAt(0) & 0xff));
    const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
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
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseChapterNumberFromText = (value: unknown): number => {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;

  const direct = Number(raw.replace(",", "."));
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const normalized = normalizeLooseText(raw);
  if (!normalized) return 0;

  const keywordMatch = normalized.match(/\b(?:chapter|chuong|ch)\.?\s*(\d+(?:[.,]\d+)?)/i);
  if (keywordMatch) {
    const parsed = Number(keywordMatch[1].replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const looksLikeRelativeTime = /\b(ago|truoc|trc|gio|phut|ngay|tuan|thang|nam|h)\b/.test(normalized);
  if (looksLikeRelativeTime) return 0;

  const leadingMatch = normalized.match(/^(\d+(?:[.,]\d+)?)(?=$|[\s)\]-])/);
  if (!leadingMatch) return 0;

  const parsed = Number(leadingMatch[1].replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const isValidChapterNumber = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const formatChapterNumber = (value: number): string => {
  if (!isValidChapterNumber(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(value)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
};

const chapterLabelFromNumber = (value: number): string => {
  const formatted = formatChapterNumber(value);
  return formatted ? `Chương ${formatted}` : "";
};

const isSlugLikeTitle = (title: string, slug: string): boolean => {
  const rawTitle = String(title || "").trim();
  const normalizedTitle = normalizeLooseText(rawTitle);
  const normalizedSlug = normalizeLooseText(slug).replace(/\s+/g, "-");
  if (!normalizedTitle) return !NON_ASCII_RE.test(rawTitle);
  if (
    normalizedTitle === normalizedSlug.replace(/-/g, " ") &&
    !NON_ASCII_RE.test(rawTitle)
  ) {
    return true;
  }
  if (normalizedTitle === `mdx ${normalizedSlug.replace(/-/g, " ")}`) return true;
  if (extractMangaDexId(normalizedTitle.replace(/\s+/g, "-"))) return true;
  return (
    normalizedTitle === "mangadex" ||
    normalizedTitle === "untitled" ||
    normalizedTitle === "dang cap nhat tieu de" ||
    normalizedTitle === "chua co tieu de" ||
    normalizedTitle === "khong co tieu de" ||
    normalizedTitle === "khong co ten" ||
    normalizedTitle === "no title"
  );
};

const humanizeSlugTitle = (slug: string): string => {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!normalized || extractMangaDexId(normalized)) return "";
  if (!normalized.includes("-")) return "";
  const words = normalized
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.length ? words.join(" ") : "";
};

const isGenericPlaceholderTitle = (value: string): boolean => {
  const normalized = normalizeLooseText(value);
  return (
    normalized === "mangadex" ||
    normalized === "untitled" ||
    normalized === "dang cap nhat tieu de" ||
    normalized === "chua co tieu de" ||
    normalized === "khong co tieu de" ||
    normalized === "khong co ten" ||
    normalized === "no title"
  );
};

const titleQualityScore = (slug: string, value: unknown, index = 0): number => {
  const text = repairMojibakeText(value).trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  if (isGenericPlaceholderTitle(text) || isSlugLikeTitle(text, slug)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (NON_ASCII_RE.test(text)) score += 4;
  score -= mojibakeScore(text) * 2;
  score += Math.min(text.length, 80) / 80;
  score += Math.max(0, 0.8 - index * 0.08);
  return score;
};

const pickDisplayTitle = (slug: string, ...candidates: Array<string | undefined>): string => {
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const text = repairMojibakeText(candidate).trim();
    const score = titleQualityScore(slug, text, index);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  });

  return best || humanizeSlugTitle(slug);
};

const toAbsoluteThumbUrl = (value?: string): string => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${API_BASE}${raw}`;
  return raw;
};

function extractMangaDexId(value?: string): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  const direct = normalizeMangaDexId(normalized);
  if (direct) return direct;

  const embedded = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return embedded ? normalizeMangaDexId(embedded[0]) : null;
}

function isMangaDexCoverUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith("uploads.mangadex.org") || host.endsWith("mangadex.network");
  } catch {
    return false;
  }
}

function getTitleLookupKeys(...values: Array<unknown>): string[] {
  const keys = new Set<string>();

  for (const value of values) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) continue;
    keys.add(raw);

    const mangaDexId = extractMangaDexId(raw);
    if (mangaDexId) {
      keys.add(mangaDexId);
      keys.add(`mdx-${mangaDexId}`);
    }
  }

  return Array.from(keys);
}

function getTrendingTitleCandidates(
  item: { slug?: string; id?: string; _id?: string },
  lookup: Map<string, string>,
): string[] {
  return getTitleLookupKeys(item?.slug, item?.id, item?._id)
    .map((key) => lookup.get(key))
    .filter((value): value is string => Boolean(value));
}

function normalizeTrendingTitle(
  item: { slug?: string; title?: string },
  ...extraTitles: Array<string | undefined>
): string {
  const slug = String(item?.slug || "").trim();
  return pickDisplayTitle(slug, ...extraTitles, item?.title) || "Chưa có tiêu đề";
}

function getTrendingImageSources(item: { slug?: string; thumb?: string }) {
  const slug = String(item?.slug || "").trim();
  const rawThumb = String(item?.thumb || "").trim();

  if (rawThumb) {
    if (/^https?:\/\//i.test(rawThumb)) {
      if (isMangaDexCoverUrl(rawThumb)) {
        return {
          src: toMangaDexCoverProxy(rawThumb),
          fallbackSrc: DEFAULT_TRENDING_THUMB_FALLBACK,
        };
      }
      return { src: rawThumb, fallbackSrc: DEFAULT_TRENDING_THUMB_FALLBACK };
    }
    return {
      src: thumbUrl(rawThumb, slug),
      fallbackSrc: thumbFallbackUrl(rawThumb, slug) || DEFAULT_TRENDING_THUMB_FALLBACK,
    };
  }

  if (extractMangaDexId(slug)) {
    return { src: DEFAULT_TRENDING_THUMB_FALLBACK, fallbackSrc: DEFAULT_TRENDING_THUMB_FALLBACK };
  }

  return { src: thumbUrl("", slug), fallbackSrc: DEFAULT_TRENDING_THUMB_FALLBACK };
}

const toMangaDexCoverProxy = (coverUrl?: string): string => {
  const raw = String(coverUrl || "").trim();
  try {
    const parsed = new URL(raw, API_BASE);
    if (parsed.pathname === "/api/images/img") {
      return /^https?:\/\//i.test(raw) ? raw : `${API_BASE}${raw}`;
    }
  } catch {
    // Fall through to the regular cover handling.
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
  }
  return DEFAULT_CARD_COVER_FALLBACK;
};

const toMangaDexCoverDirect = (coverUrl?: string): string => {
  const raw = String(coverUrl || "").trim();
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  return "";
};

const parseTime = (value?: string) => {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return 0;
  const maxFuture = Date.now() + 2 * 24 * 60 * 60 * 1000;
  return ts > maxFuture ? 0 : ts;
};

const toNumber = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const ratingRankScore = (manga: Manga): number => {
  const rating = Math.max(0, toNumber(manga.rating));
  const count = Math.max(0, toNumber(manga.ratingCount));
  if (rating <= 0 && count <= 0) return 0;

  const effectiveCount = Math.max(1, count);
  return (
    rating * effectiveCount +
    RATING_BAYESIAN_PRIOR_AVERAGE * RATING_BAYESIAN_PRIOR_COUNT
  ) / (effectiveCount + RATING_BAYESIAN_PRIOR_COUNT);
};

const compareByRating = (a: Manga, b: Manga): number => {
  const rankScoreDiff = ratingRankScore(b) - ratingRankScore(a);
  if (Math.abs(rankScoreDiff) > 0.0001) return rankScoreDiff;
  const ratingDiff = toNumber(b.rating) - toNumber(a.rating);
  if (ratingDiff !== 0) return ratingDiff;
  const countDiff = toNumber(b.ratingCount) - toNumber(a.ratingCount);
  if (countDiff !== 0) return countDiff;
  const viewsDiff = toNumber(b.views) - toNumber(a.views);
  if (viewsDiff !== 0) return viewsDiff;
  const updatedDiff = parseTime(b.lastUpdated) - parseTime(a.lastUpdated);
  if (updatedDiff !== 0) return updatedDiff;
  return String(a.title || "").localeCompare(String(b.title || ""), "vi");
};

const pickChapterDate = (
  chapter?: MangaDexCatalogItem["chapters"][number],
  mangaUpdatedAt?: string,
) => {
  const candidates = [
    chapter?.publish_at,
    chapter?.readable_at,
    chapter?.created_at,
    chapter?.updated_at,
    mangaUpdatedAt,
  ];
  for (const candidate of candidates) {
    if (parseTime(candidate) > 0) return String(candidate);
  }
  return "";
};

const pickLatestChapter = (item: MangaDexCatalogItem) => {
  const chapters = item.chapters || [];
  if (!chapters.length) return undefined;
  return [...chapters].sort((a, b) => {
    const numberDiff =
      parseChapterNumberFromText(b?.chapter) -
      parseChapterNumberFromText(a?.chapter) ||
      parseChapterNumberFromText(b?.chapter_with_groups) -
      parseChapterNumberFromText(a?.chapter_with_groups);
    if (numberDiff !== 0) return numberDiff;

    return (
      parseTime(pickChapterDate(b, item.updated_at)) -
      parseTime(pickChapterDate(a, item.updated_at))
    );
  })[0];
};

const pickStableDate = (chapterDate?: string, mangaUpdatedAt?: string) => {
  const chapterTs = parseTime(chapterDate);
  if (chapterTs > 0) return chapterDate as string;
  const mangaTs = parseTime(mangaUpdatedAt);
  if (mangaTs > 0) return mangaUpdatedAt as string;
  return "";
};

const getMyRatedLatestChapter = (record: MyRatedMangaItem): string =>
  String(record.latest_chapter || record.latestChapter || "").trim();

const getMyRatedLatestChapterUpdatedAt = (record: MyRatedMangaItem): string =>
  String(
    record.latest_chapter_updated_at ||
      record.latestChapterUpdatedAt ||
      record.updated_at ||
      "",
  ).trim();

const buildMyRatedChapters = (slug: string, record: MyRatedMangaItem): Manga["chapters"] => {
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
      scanlationGroup: "",
    },
  ];
};

const hasReadableChapter = (chapters: Manga["chapters"] | undefined): boolean =>
  Array.isArray(chapters) &&
  chapters.some((chapter) => (
    chapter?.number !== null &&
    chapter?.number !== undefined &&
    isValidChapterNumber(Number(chapter.number))
  ));

type MangaDexLatestChapterMeta = {
  latestChapter?: Manga["chapters"][number];
  lastUpdated?: string;
};

const pickLatestReadableChapter = (
  chapters: Manga["chapters"] | undefined,
): Manga["chapters"][number] | null => {
  const readable = (chapters || []).filter((chapter) => (
    chapter?.number !== null &&
    chapter?.number !== undefined &&
    isValidChapterNumber(Number(chapter.number))
  ));
  if (!readable.length) return null;
  return [...readable].sort((a, b) => {
    const numberDiff = Number(b?.number || 0) - Number(a?.number || 0);
    if (numberDiff !== 0) return numberDiff;
    return parseTime(String(b?.uploadDate || "")) - parseTime(String(a?.uploadDate || ""));
  })[0] || null;
};

const applyMangaDexLatestChapterMap = (
  items: Manga[],
  latestChapterMap: Record<string, MangaDexLatestChapterMeta>,
): Manga[] => {
  if (!items.length || !latestChapterMap || Object.keys(latestChapterMap).length === 0) {
    return items;
  }

  return items.map((item) => {
    const slug = String(item.id || "").trim().toLowerCase();
    const detailId = extractMangaDexId(slug);
    if (!detailId) return item;

    const meta =
      latestChapterMap[slug] ||
      latestChapterMap[detailId] ||
      latestChapterMap[`mdx-${detailId}`];
    if (!meta?.latestChapter) return item;

    const currentLatest = pickLatestReadableChapter(item.chapters || []);
    const currentNum =
      Number(currentLatest?.number || 0) ||
      parseChapterNumberFromText(currentLatest?.title);
    const syncedNum = Number(meta.latestChapter.number || 0);
    const currentTs = parseTime(currentLatest?.uploadDate);
    const syncedTs = parseTime(meta.latestChapter.uploadDate);

    const shouldReplace =
      !currentLatest ||
      !(currentNum > 0) ||
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
    new Set(slugs.map((slug) => String(slug || "").trim().toLowerCase()).filter(Boolean)),
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
      if (result.status !== "fulfilled") continue;
      mergeBatchRatingsPayload(merged, result.value);
    }
  }

  return merged;
};

const mapMangaDexCatalogToManga = (item: MangaDexCatalogItem): Manga => {
  const chapter = pickLatestChapter(item);
  const chapterNumber =
    parseChapterNumberFromText(chapter?.chapter) ||
    parseChapterNumberFromText(chapter?.chapter_with_groups);
  const ratingRaw = Number((item as any).rating_average ?? (item as any).average_rating ?? (item as any).rating ?? 0);
  const ratingCountRaw = Number((item as any).rating_count ?? (item as any).ratings_count ?? (item as any).ratingCount ?? 0);
  const mappedRating = Number.isFinite(ratingRaw) ? ratingRaw : 0;
  const mappedRatingCount = Number.isFinite(ratingCountRaw) ? ratingCountRaw : 0;
  const mappedViews = Math.max(0, toNumber(item.local_view_count ?? item.view_count ?? item.views ?? 0));
  const mappedPopularityScore = Math.max(
    0,
    toNumber(item.mangadex_popularity_score ?? item.popularity_score ?? 0),
  );
  const stableDate = pickStableDate(
    pickChapterDate(chapter, item.updated_at),
    item.updated_at,
  );
  const coverProxy = toMangaDexCoverProxy(item.cover_url);
  const coverDirect = toMangaDexCoverDirect(item.cover_url);
  const chapterEntry: Manga["chapters"] = chapter
    ? [
        {
          id: String(chapter.id || `ch-${item.id}`),
          mangaId: item.id,
          number: isValidChapterNumber(chapterNumber) ? chapterNumber : 0,
          title: isValidChapterNumber(chapterNumber) ? chapterLabelFromNumber(chapterNumber) : "Chương mới",
          pages: [],
          uploadDate: stableDate,
          scanlationGroup: "",
        },
      ]
    : [
        {
          id: `mdx-ch-${item.id}-placeholder`,
          mangaId: item.id,
          number: -1,
          title: "MangaDex",
          pages: [],
          uploadDate: stableDate || new Date().toISOString(),
          scanlationGroup: "",
        },
      ];

  return {
    id: String(item.id || "").trim().toLowerCase(),
    title: pickDisplayTitle(item.id, repairMojibakeText(item.title)) || "Chưa có tiêu đề",
    author: repairMojibakeText(item.authors_text) || "MangaDex",
    artist: repairMojibakeText(item.authors_text) || "MangaDex",
    description: "",
    cover: coverProxy,
    coverProxy: coverDirect || undefined,
    status: "ongoing",
    type: "manga",
    genres: item.genres || [],
    tags: (item.genres || []).map((g) =>
      String(g || "")
        .toLowerCase()
        .replace(/\s+/g, "-"),
    ),
    rating: mappedRating,
    ratingCount: mappedRatingCount,
    myRating: null,
    follows: 0,
    views: mappedViews,
    localViewCount: mappedViews,
    popularityScore: mappedPopularityScore,
    mangadexPopularityScore: mappedPopularityScore,
    year: new Date().getFullYear(),
    chapters: chapterEntry,
    lastUpdated: stableDate,
    contentRating: String((item as any).content_rating || (item as any).contentRating || "").trim().toLowerCase(),
  };
};

const RankingsPage = () => {
  const showMatureContent = useSettingsStore((s) => s.settings.privacy.showMatureContent);
  const isLoggedIn = useUserStore((s) => s.isLoggedIn);
  const authUser = useUserStore((s) => s.user);
  const isRestoringSession = useUserStore((s) => s.isRestoringSession);
  const canUseUserRatings = isLoggedIn && !!authUser && !isRestoringSession;
  const ratingViewerKey = useUserStore((s) => {
    const raw = String(s.user?.id || s.user?.email || '').trim().toLowerCase();
    return raw || 'auth';
  });
  const [activeTab, setActiveTab] = useState<Tab>("trending");
  const isTrendingTab = activeTab === "trending";

  const {
    data: trendingData,
    isLoading: trendingLoading,
    isError: trendingError,
  } = useTrending(RANKINGS_TRENDING_LIMIT);

  const hasTrendingRows = Array.isArray(trendingData) && trendingData.length > 0;

  const shouldLoadLatest =
    activeTab === "latest" ||
    activeTab === "rating" ||
    isTrendingTab ||
    (isTrendingTab && trendingError);
  const shouldLoadOngoing =
    activeTab === "rating" ||
    isTrendingTab ||
    (isTrendingTab && trendingError);
  const shouldLoadCompleted = activeTab === "completed" || activeTab === "rating";
  // Preload MangaDex catalog from first paint so Rating tab does not show OTruyen first.
  const shouldLoadMangaDex =
    activeTab === "trending" ||
    activeTab === "latest" ||
    activeTab === "rating";

  const { data: latestData, isLoading: latestLoading } = useMangaList(
    "truyen-moi",
    1,
    shouldLoadLatest,
  );
  const { data: completedData, isLoading: completedLoading } = useMangaList(
    "hoan-thanh",
    1,
    shouldLoadCompleted,
  );
  const { data: ongoingData, isLoading: ongoingLoading } = useMangaList(
    "dang-phat-hanh",
    1,
    shouldLoadOngoing,
  );

  const {
    data: mangaDexCatalog = [],
    isLoading: mangaDexLoading,
  } = useMangaDexViCatalog(RANKING_MANGADEX_LIMIT, shouldLoadMangaDex);

  const mangaDexItems = useMemo<Manga[]>(
    () => (mangaDexCatalog as MangaDexCatalogItem[]).map(mapMangaDexCatalogToManga),
    [mangaDexCatalog],
  );

  const visibleMangaDexItems = useMemo(
    () => (showMatureContent ? mangaDexItems : mangaDexItems.filter((m) => !isMatureManga(m))),
    [mangaDexItems, showMatureContent],
  );

  const rankingTitleLookup = useMemo(() => {
    const lookup = new Map<string, string>();

    const put = (key: unknown, title: unknown) => {
      const text = repairMojibakeText(title).trim();
      if (!text) return;

      for (const lookupKey of getTitleLookupKeys(key)) {
        const current = lookup.get(lookupKey);
        if (!current || titleQualityScore(lookupKey, text) > titleQualityScore(lookupKey, current)) {
          lookup.set(lookupKey, text);
        }
      }
    };

    const putManga = (item?: Manga) => {
      if (!item) return;
      for (const title of [item.title, item.altTitle]) {
        put(item.id, title);
        put(item.slug, title);
      }
    };

    for (const item of [
      ...(ongoingData?.items || []),
      ...(latestData?.items || []),
      ...(completedData?.items || []),
      ...visibleMangaDexItems,
    ]) {
      putManga(item);
    }

    return lookup;
  }, [ongoingData?.items, latestData?.items, completedData?.items, visibleMangaDexItems]);

  const { data: myRatedRankingData } = useQuery({
    queryKey: ["rating", "me", "rankings", ratingViewerKey, MY_RATED_RANKING_LIMIT],
    queryFn: async () => {
      try {
        return await ratingApi.getMyRatedManga(MY_RATED_RANKING_LIMIT);
      } catch {
        return { items: [] };
      }
    },
    enabled: canUseUserRatings && activeTab === "rating",
    staleTime: 2 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const ratingBaseLookup = useMemo(() => {
    const lookup = new Map<string, Manga>();
    const sources = [
      ...(ongoingData?.items || []),
      ...(latestData?.items || []),
      ...(completedData?.items || []),
      ...visibleMangaDexItems,
    ];
    for (const item of sources) {
      const key = String(item.id || "").trim().toLowerCase();
      if (!key || lookup.has(key)) continue;
      lookup.set(key, item);
    }
    return lookup;
  }, [ongoingData?.items, latestData?.items, completedData?.items, visibleMangaDexItems]);

  const { data: guestTopRatedData, isLoading: guestTopRatedLoading } = useQuery({
    queryKey: ["rating", "top", "rankings", "guest", GUEST_TOP_RATED_LIMIT],
    queryFn: async () => {
      try {
        return await ratingApi.getTopRatedManga(GUEST_TOP_RATED_LIMIT);
      } catch {
        return { items: [] };
      }
    },
    enabled: activeTab === "rating",
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedRows = useMemo<TopRatedGlobalItem[]>(
    () => (((guestTopRatedData as any)?.items || []) as TopRatedGlobalItem[]),
    [guestTopRatedData],
  );

  const guestTopRatedMissingSlugs = useMemo(() => {
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || "").trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      if (ratingBaseLookup.has(slug)) continue;
      missing.push(slug);
      if (missing.length >= GUEST_TOP_RATED_RESOLVE_MAX) break;
    }

    return missing;
  }, [guestTopRatedRows, ratingBaseLookup]);

  const { data: guestTopRatedResolvedMap = {} } = useQuery({
    queryKey: ["rating", "top", "rankings", "guest", "details-v1", guestTopRatedMissingSlugs],
    queryFn: async () => {
      const result: Record<string, Manga> = {};

      await Promise.allSettled(
        guestTopRatedMissingSlugs.map(async (slug) => {
          const detailId = extractMangaDexId(slug);

          if (detailId) {
            const payload = await mangaApi.getMangaDexDetail(
              detailId,
              RANKING_MANGADEX_DETAIL_FALLBACK_CHAPTER_LIMIT,
            );
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
                    "",
                ).trim();

                return {
                  chapterNum,
                  chapterDate,
                  id: String(chapter?.id || "").trim(),
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
              String(item?.updated_at || "").trim() ||
              new Date().toISOString();

            const chapters = best
              ? [
                  {
                    id: best.id || `mdx-ch-${detailId}-top`,
                    mangaId: detailId,
                    number: best.chapterNum,
                    title: chapterLabelFromNumber(best.chapterNum),
                    pages: [],
                    uploadDate,
                    scanlationGroup: "",
                  },
                ]
              : [];

            const rawGenres = Array.isArray(item.genres)
              ? item.genres.map((genre: unknown) => repairMojibakeText(genre).trim()).filter(Boolean)
              : [];

            result[slug] = {
              id: slug,
              title: pickDisplayTitle(slug, item.title) || "Chưa có tiêu đề",
              author: repairMojibakeText(item.authors_text) || "MangaDex",
              artist: repairMojibakeText(item.authors_text) || "MangaDex",
              description: "",
              cover: toMangaDexCoverProxy(item.cover_url),
              coverProxy: toMangaDexCoverDirect(item.cover_url) || undefined,
              status:
                String(item.status || "").trim().toLowerCase() === "completed"
                  ? "completed"
                  : "ongoing",
              type: "manga",
              genres: rawGenres,
              tags: rawGenres
                .map((genre) =>
                  genre
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, ""),
                )
                .filter(Boolean),
              rating: 0,
              ratingCount: 0,
              myRating: null,
              follows: 0,
              views: Number(item.view_count || item.views || 0),
              year: Number(item.year) || new Date().getFullYear(),
              chapters,
              lastUpdated: uploadDate,
              contentRating: String(item.content_rating || item.contentRating || "")
                .trim()
                .toLowerCase(),
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
    enabled: activeTab === "rating" && guestTopRatedMissingSlugs.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const guestTopRatedVisibleItems = useMemo<Manga[]>(() => {
    if (activeTab !== "rating") return [];

    const resolvedLookup = (guestTopRatedResolvedMap || {}) as Record<string, Manga>;
    const ordered: Manga[] = [];

    for (const row of guestTopRatedRows) {
      const slug = String(row?.manga_slug || "").trim().toLowerCase();
      if (!slug) continue;

      const trustedAverage = Number(row?.average || 0);
      const trustedCount = Number(row?.count || 0);
      const known = ratingBaseLookup.get(slug);
      const resolved = resolvedLookup[slug];
      const base = resolved || known;

      if (base) {
        ordered.push({
          ...base,
          id: slug,
          rating: Number.isFinite(trustedAverage) ? trustedAverage : 0,
          ratingCount: Number.isFinite(trustedCount) ? trustedCount : 0,
          myRating: null,
          lastUpdated:
            String(row?.updated_at || base.lastUpdated || "").trim() ||
            base.lastUpdated,
        });
        continue;
      }

      ordered.push({
        id: slug,
        title: pickDisplayTitle(slug) || "Chưa có tiêu đề",
        author: extractMangaDexId(slug) ? "MangaDex" : "OTruyen",
        artist: extractMangaDexId(slug) ? "MangaDex" : "OTruyen",
        description: "",
        cover: DEFAULT_CARD_COVER_FALLBACK,
        coverProxy: DEFAULT_CARD_COVER_FALLBACK,
        status: "ongoing",
        type: "manga",
        genres: [],
        tags: [],
        rating: Number.isFinite(trustedAverage) ? trustedAverage : 0,
        ratingCount: Number.isFinite(trustedCount) ? trustedCount : 0,
        myRating: null,
        follows: 0,
        views: 0,
        year: new Date().getFullYear(),
        chapters: [],
        lastUpdated:
          String(row?.updated_at || "").trim() || new Date().toISOString(),
        contentRating: "",
      });
    }

    const deduped = Array.from(
      ordered
        .reduce((acc, item) => {
          const key = String(item.id || "").trim().toLowerCase();
          if (!key || acc.has(key)) return acc;
          acc.set(key, item);
          return acc;
        }, new Map<string, Manga>())
        .values(),
    );

    const visible = showMatureContent
      ? deduped
      : deduped.filter((item) => !isMatureManga(item));

    return visible.sort(compareByRating).slice(0, RANKINGS_GRID_LIMIT);
  }, [
    isLoggedIn,
    activeTab,
    guestTopRatedResolvedMap,
    guestTopRatedRows,
    ratingBaseLookup,
    showMatureContent,
  ]);

  const myRatedOverlayItems = useMemo<Manga[]>(() => {
    if (activeTab !== "rating") return [];
    const rows = ((myRatedRankingData as any)?.items || []) as MyRatedMangaItem[];
    if (!rows.length) return [];

    const overlays: Manga[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const slug = String(row.manga_slug || "").trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const score = Number(row.score);
      if (!Number.isFinite(score)) continue;
      const ratedChapters = buildMyRatedChapters(slug, row);

      const rowGenres = Array.isArray(row.genres)
        ? row.genres.map((genre) => String(genre || "").trim()).filter(Boolean)
        : [];
      let rowTags = Array.isArray(row.tags)
        ? row.tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
        : [];
      if (!rowTags.length && rowGenres.length) {
        rowTags = rowGenres
          .map((genre) => genre.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
          .filter(Boolean);
      }

      const existing = ratingBaseLookup.get(slug);
      if (existing) {
        const safeTitle = pickDisplayTitle(slug, existing.title, row.title);
        const existingCover = String(existing.cover || "").trim();
        const existingFallbackCover = String(existing.coverProxy || "").trim();
        if (!safeTitle && !existingCover && !existingFallbackCover) {
          continue;
        }
        overlays.push({
          ...existing,
          title: safeTitle || String(existing.title || "").trim() || "Chưa có tiêu đề",
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

      const isMdx = !!extractMangaDexId(slug);
      const rawThumb = toAbsoluteThumbUrl(row.thumb);
      const safeTitle = pickDisplayTitle(slug, row.title);
      if (!safeTitle && !rawThumb) {
        continue;
      }
      if (isMdx && !rawThumb) {
        continue;
      }
      const cover = rawThumb
        ? (isMdx ? toMangaDexCoverProxy(rawThumb) : thumbUrl(rawThumb, slug))
        : DEFAULT_CARD_COVER_FALLBACK;
      const coverProxy = rawThumb
        ? (isMdx ? DEFAULT_CARD_COVER_FALLBACK : (thumbFallbackUrl(rawThumb, slug) || rawThumb || DEFAULT_CARD_COVER_FALLBACK))
        : DEFAULT_CARD_COVER_FALLBACK;

      overlays.push({
        id: slug,
        title: safeTitle || "Chưa có tiêu đề",
        author: isMdx ? "MangaDex" : "OTruyen",
        artist: isMdx ? "MangaDex" : "OTruyen",
        description: "",
        cover,
        coverProxy,
        status: "ongoing",
        type: "manga",
        genres: rowGenres,
        tags: rowTags,
        rating: score,
        ratingCount: 1,
        myRating: score,
        follows: 0,
        views: 0,
        year: new Date().getFullYear(),
        chapters: ratedChapters,
        lastUpdated: String(
          getMyRatedLatestChapterUpdatedAt(row) ||
            row.updated_at ||
            new Date().toISOString(),
        ),
        contentRating: "",
      });
    }

    return overlays.slice(0, MY_RATED_RANKING_LIMIT);
  }, [activeTab, myRatedRankingData, ratingBaseLookup]);

  const latestItems = useMemo(() => {
    const mergedRaw = [...(latestData?.items || []), ...visibleMangaDexItems];
    const merged = showMatureContent ? mergedRaw : mergedRaw.filter((m) => !isMatureManga(m));
    const seen = new Set<string>();
    const deduped = merged.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    deduped.sort(
      (a, b) =>
        parseTime(b.lastUpdated) - parseTime(a.lastUpdated) ||
        Number(b.views || 0) - Number(a.views || 0),
    );

    const top = deduped.slice(0, RANKINGS_GRID_LIMIT);
    if (top.some((m) => !!extractMangaDexId(m.id)) || visibleMangaDexItems.length === 0) {
      return top;
    }

    const bestMangaDex = [...visibleMangaDexItems].sort(
      (a, b) =>
        parseTime(b.lastUpdated) - parseTime(a.lastUpdated) ||
        Number(b.views || 0) - Number(a.views || 0),
    )[0];
    if (!bestMangaDex) return top;
    if (top.length === 0) return [bestMangaDex];
    return [...top.slice(0, -1), bestMangaDex];
  }, [latestData?.items, visibleMangaDexItems, showMatureContent]);

  const ratingCandidates = useMemo(() => {
    const mergedRaw = [
      ...(isLoggedIn ? myRatedOverlayItems : []),
      ...(ongoingData?.items || []),
      ...(latestData?.items || []),
      ...(completedData?.items || []),
      ...visibleMangaDexItems,
    ];
    const merged = showMatureContent ? mergedRaw : mergedRaw.filter((m) => !isMatureManga(m));
    const byId = new Map<string, Manga>();
    for (const item of merged) {
      const key = String(item.id || "").trim().toLowerCase();
      if (!key) continue;

      const existing = byId.get(key);
      if (!existing) {
        byId.set(key, item);
        continue;
      }

      const existingHasMyScore = Number(existing.myRating || 0) > 0;
      const incomingHasMyScore = Number(item.myRating || 0) > 0;

      if (incomingHasMyScore && !existingHasMyScore) {
        byId.set(key, item);
        continue;
      }

      if (incomingHasMyScore === existingHasMyScore) {
        const existingSignal = Number(existing.ratingCount || 0) > 0 || Number(existing.rating || 0) > 0;
        const incomingSignal = Number(item.ratingCount || 0) > 0 || Number(item.rating || 0) > 0;
        if (incomingSignal && !existingSignal) {
          byId.set(key, item);
        }
      }
    }

    const deduped = Array.from(byId.values());
    const preRanked = [...deduped].sort(compareByRating);
    return preRanked.slice(0, RATING_BATCH_MAX);
  }, [
    isLoggedIn,
    myRatedOverlayItems,
    ongoingData?.items,
    latestData?.items,
    completedData?.items,
    visibleMangaDexItems,
    showMatureContent,
  ]);

  const ratingCandidateSlugs = useMemo(
    () => ratingCandidates
      .map((m) => String(m.id || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, RATING_BATCH_MAX),
    [ratingCandidates],
  );

  const { data: batchRatingData, isLoading: batchRatingLoading } = useQuery({
    queryKey: ["rating", "batch", "rankings", ratingViewerKey, ratingCandidateSlugs],
    queryFn: async () => {
      if (!ratingCandidateSlugs.length) return { ratings: {}, my_scores: {} };
      try {
        return await fetchBatchRatingsParallel(ratingCandidateSlugs);
      } catch {
        return { ratings: {}, my_scores: {} };
      }
    },
    enabled: activeTab === "rating" && ratingCandidateSlugs.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const ratedItems = useMemo(() => {
    const ratingMap = (batchRatingData as any)?.ratings || {};
    const myScoreMap = (batchRatingData as any)?.my_scores || {};
    const enriched = ratingCandidates.map((m) => {
      const rawId = String(m.id || "").trim();
      const normId = rawId.toLowerCase();
      const agg = ratingMap[rawId] || ratingMap[normId] || ratingMap[`mdx-${normId}`];
      const myScoreRaw =
        myScoreMap[rawId] ??
        myScoreMap[normId] ??
        myScoreMap[`mdx-${normId}`];
      const hasMyScore = myScoreRaw !== null && myScoreRaw !== undefined && Number.isFinite(Number(myScoreRaw));
      const myRating = hasMyScore ? Number(myScoreRaw) : (m.myRating ?? null);
      const aggAverage = Number(agg?.average ?? 0);
      const aggCount = Number(agg?.count ?? 0);
      const hasAggregate = Number.isFinite(aggAverage) && Number.isFinite(aggCount) && (aggCount > 0 || aggAverage > 0);

      if (!hasAggregate && !hasMyScore) return m;

      return {
        ...m,
        rating: hasAggregate ? aggAverage : Number(m.rating || 0),
        ratingCount: hasAggregate ? aggCount : Number(m.ratingCount || 0),
        myRating,
      };
    });

    const mergedById = new Map<string, Manga>();
    for (const item of [...myRatedOverlayItems, ...enriched]) {
      const key = String(item.id || "").trim().toLowerCase();
      if (!key) continue;

      const existing = mergedById.get(key);
      if (!existing) {
        mergedById.set(key, item);
        continue;
      }

      const existingHasMyScore = Number(existing.myRating || 0) > 0;
      const incomingHasMyScore = Number(item.myRating || 0) > 0;
      if (incomingHasMyScore && !existingHasMyScore) {
        mergedById.set(key, item);
      }
    }

    const mergedEnriched = Array.from(mergedById.values());

    const ratedOnly = mergedEnriched.filter(
      (m) => Number(m.ratingCount || 0) > 0 || Number(m.rating || 0) > 0,
    );

    const localRated = ratedOnly.length > 0
      ? [...ratedOnly].sort(compareByRating)
      : [...mergedEnriched].sort(compareByRating);

    if (guestTopRatedVisibleItems.length > 0) {
      const merged = new Map<string, Manga>();
      for (const item of [...guestTopRatedVisibleItems, ...localRated]) {
        const key = String(item.id || "").trim().toLowerCase();
        if (!key || merged.has(key)) continue;
        merged.set(key, item);
      }
      return Array.from(merged.values()).slice(0, RANKINGS_GRID_LIMIT);
    }

    return localRated.slice(0, RANKINGS_GRID_LIMIT);
  }, [
    isLoggedIn,
    guestTopRatedVisibleItems,
    ratingCandidates,
    batchRatingData,
    myRatedOverlayItems,
  ]);

  const rankingVisibleItems = useMemo(() => {
    if (activeTab === "latest") return latestItems.slice(0, RANKINGS_GRID_LIMIT);
    if (activeTab === "rating") return ratedItems.slice(0, RANKINGS_GRID_LIMIT);
    return [] as Manga[];
  }, [activeTab, latestItems, ratedItems]);

  const rankingVisibleMangaDexIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of rankingVisibleItems) {
      const detailId = extractMangaDexId(String(item.id || "").trim().toLowerCase());
      if (!detailId) continue;
      ids.add(detailId);
      if (ids.size >= 72) break;
    }
    return Array.from(ids);
  }, [rankingVisibleItems]);

  const { data: rankingMangaDexLatestChapterMap = {}, isLoading: rankingMangaDexLatestChapterLoading } = useQuery({
    queryKey: [
      "manga",
      "rankings",
      "mangadex",
      "latest-chapters-v2",
      activeTab,
      rankingVisibleMangaDexIds,
    ],
    queryFn: async () => {
      const result: Record<string, MangaDexLatestChapterMeta> = {};
      const payload = await mangaApi.getMangaDexLatestChapters(rankingVisibleMangaDexIds);
      const latestMap = (payload?.items || {}) as Record<string, any>;

      for (const detailId of rankingVisibleMangaDexIds) {
        const latest = latestMap[detailId] || latestMap[`mdx-${detailId}`];
        const latestChapterText = String(latest?.chapter_name || latest?.chapter_title || "").trim();
        const chapterNum =
          parseChapterNumberFromText(latest?.chapter_name) ||
          parseChapterNumberFromText(latest?.chapter_title);
        if (!latestChapterText || !isValidChapterNumber(chapterNum)) continue;

        const uploadDate = String(latest?.publish_at || "").trim() || new Date().toISOString();
        const latestChapter: Manga["chapters"][number] = {
          id: `mdx-ch-${detailId}-latest`,
          mangaId: detailId,
          number: chapterNum,
          title: chapterLabelFromNumber(chapterNum),
          pages: [],
          uploadDate,
          scanlationGroup: "",
        };

        const meta: MangaDexLatestChapterMeta = {
          latestChapter,
          lastUpdated: String(latest?.publish_at || "").trim() || undefined,
        };

        result[detailId] = meta;
        result[`mdx-${detailId}`] = meta;
      }

      return result;
    },
    enabled:
      (activeTab === "latest" || activeTab === "rating") &&
      rankingVisibleMangaDexIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });

  const latestDisplaySeed = useMemo(
    () =>
      applyMangaDexLatestChapterMap(
        latestItems,
        (rankingMangaDexLatestChapterMap || {}) as Record<string, MangaDexLatestChapterMeta>,
      ),
    [latestItems, rankingMangaDexLatestChapterMap],
  );

  const ratedDisplaySeed = useMemo(
    () =>
      applyMangaDexLatestChapterMap(
        ratedItems,
        (rankingMangaDexLatestChapterMap || {}) as Record<string, MangaDexLatestChapterMeta>,
      ),
    [ratedItems, rankingMangaDexLatestChapterMap],
  );

  const rankingDisplaySeed = useMemo(() => {
    if (activeTab === "latest") return latestDisplaySeed;
    if (activeTab === "rating") return ratedDisplaySeed;
    return [] as Manga[];
  }, [activeTab, latestDisplaySeed, ratedDisplaySeed]);

  const lowChapterMangaDexIds = useMemo(() => {
    const ids = new Set<string>();

    for (const item of rankingDisplaySeed) {
      const detailId = extractMangaDexId(String(item.id || "").trim().toLowerCase());
      if (!detailId) continue;

      const latest = pickLatestReadableChapter(item.chapters || []);
      const latestNum =
        Number(latest?.number || 0) ||
        parseChapterNumberFromText(latest?.title);
      if (latestNum > 1) continue;

      ids.add(detailId);
      if (ids.size >= RANKING_MANGADEX_DETAIL_FALLBACK_MAX) break;
    }

    return Array.from(ids);
  }, [rankingDisplaySeed]);

  const { data: rankingMangaDexDetailFallbackMap = {} } = useQuery({
    queryKey: [
      "manga",
      "rankings",
      "mangadex",
      "latest-chapters-detail-fallback-v1",
      activeTab,
      lowChapterMangaDexIds,
    ],
    queryFn: async () => {
      const result: Record<string, MangaDexLatestChapterMeta> = {};

      await Promise.allSettled(
        lowChapterMangaDexIds.map(async (detailId) => {
          const payload = await mangaApi.getMangaDexDetail(
            detailId,
            RANKING_MANGADEX_DETAIL_FALLBACK_CHAPTER_LIMIT,
          );
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
                "",
              ).trim();

              return {
                chapterNum,
                chapterDate,
                id: String(chapter?.id || "").trim(),
              };
            })
            .filter((chapter) => isValidChapterNumber(chapter.chapterNum))
            .sort((a, b) => {
              const numberDiff = b.chapterNum - a.chapterNum;
              if (numberDiff !== 0) return numberDiff;
              return parseTime(b.chapterDate) - parseTime(a.chapterDate);
            })[0];

          if (!best) return;

          const uploadDate =
            best.chapterDate ||
            String(item?.updated_at || "").trim() ||
            new Date().toISOString();
          const latestChapter: Manga["chapters"][number] = {
            id: best.id || `mdx-ch-${detailId}-latest-fallback`,
            mangaId: detailId,
            number: best.chapterNum,
            title: chapterLabelFromNumber(best.chapterNum),
            pages: [],
            uploadDate,
            scanlationGroup: "",
          };

          const current = result[detailId] || result[`mdx-${detailId}`];
          const currentNum = Number(current?.latestChapter?.number || 0);
          const currentTs = parseTime(current?.latestChapter?.uploadDate);
          const nextTs = parseTime(uploadDate);

          const shouldReplace =
            !current?.latestChapter ||
            best.chapterNum > currentNum ||
            (best.chapterNum === currentNum && nextTs > currentTs);
          if (!shouldReplace) return;

          const meta: MangaDexLatestChapterMeta = {
            latestChapter,
            lastUpdated: uploadDate || undefined,
          };

          result[detailId] = meta;
          result[`mdx-${detailId}`] = meta;
        }),
      );

      return result;
    },
    enabled:
      (activeTab === "latest" || activeTab === "rating") &&
      !rankingMangaDexLatestChapterLoading &&
      lowChapterMangaDexIds.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    placeholderData: (previousData) => previousData,
  });

  const latestDisplayItems = useMemo(
    () =>
      applyMangaDexLatestChapterMap(
        latestDisplaySeed,
        (rankingMangaDexDetailFallbackMap || {}) as Record<string, MangaDexLatestChapterMeta>,
      ),
    [latestDisplaySeed, rankingMangaDexDetailFallbackMap],
  );

  const ratedDisplayItems = useMemo(
    () =>
      applyMangaDexLatestChapterMap(
        ratedDisplaySeed,
        (rankingMangaDexDetailFallbackMap || {}) as Record<string, MangaDexLatestChapterMeta>,
      ),
    [ratedDisplaySeed, rankingMangaDexDetailFallbackMap],
  );

  const fallbackTrendingItems = useMemo(() => {
    const itemsRaw = [...(ongoingData?.items || []), ...(latestData?.items || [])];
    const items = showMatureContent ? itemsRaw : itemsRaw.filter((m) => !isMatureManga(m));
    const seen = new Set<string>();
    return items
      .filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, RANKINGS_TRENDING_FALLBACK_LIMIT)
      .map((m) => ({
        slug: m.id,
        title: m.title,
        thumb: m.cover || thumbUrl("", m.id),
        views: m.views || 0,
      }));
  }, [ongoingData, latestData, showMatureContent]);

  const canUseFallbackTrending =
    !hasTrendingRows && !trendingLoading && (trendingError || fallbackTrendingItems.length > 0);

  const trendingItems = useMemo(() => {
    const sourceItems = hasTrendingRows
      ? (trendingData as any[])
      : canUseFallbackTrending
        ? fallbackTrendingItems
        : [];
    const seen = new Set<string>();
    return sourceItems
      .filter((item) => {
        const key = String(item?.slug || item?.id || item?._id || "").trim().toLowerCase();
        const views = Number(item?.views || item?.view_count || 0);
        if (!Number.isFinite(views) || views <= 0) return false;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, RANKINGS_TRENDING_LIMIT);
  }, [hasTrendingRows, trendingData, canUseFallbackTrending, fallbackTrendingItems]);

  const isLoading =
    (activeTab === "trending" &&
      ((trendingLoading && !hasTrendingRows) ||
        (canUseFallbackTrending && trendingItems.length === 0 && (latestLoading || ongoingLoading)))) ||
    (activeTab === "latest" && latestItems.length === 0 && latestLoading) ||
    (activeTab === "completed" && completedLoading) ||
    (activeTab === "rating" &&
      ratedItems.length === 0 &&
      ((ongoingLoading || latestLoading || completedLoading || (mangaDexLoading && visibleMangaDexItems.length === 0)) ||
        guestTopRatedLoading));

  return (
    <div className="container mx-auto px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="accent-line" />
          <Trophy className="w-6 h-6 text-primary" />
          <h1 className="ed-heading text-2xl">Bảng Xếp Hạng</h1>
        </div>

        <div className="flex gap-2 mb-6 flex-wrap">
          {tabConfig.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                activeTab === tab.key
                  ? "bg-primary text-primary-foreground comic-shadow"
                  : "bg-secondary text-muted-foreground hover:text-foreground border border-border/50"
              }`}
            >
              <tab.icon className="w-4 h-4" /> {tab.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : activeTab === "trending" ? (
          trendingItems && trendingItems.length > 0 ? (
            <div className="space-y-2">
              {trendingItems.map((item: any, idx: number) => {
                const displayTitle = normalizeTrendingTitle(
                  item,
                  ...getTrendingTitleCandidates(item, rankingTitleLookup),
                );
                const { src, fallbackSrc } = getTrendingImageSources(item);
                return (
                  <motion.div
                    key={String(item.slug || item.id || item._id || idx)}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.45) }}
                  >
                    <Link
                      to={getMangaDetailPath(item.id || item._id || item.slug)}
                      className="flex items-center gap-4 p-3 rounded-xl bg-card border border-border/50 hover:border-primary/30 transition-all group"
                    >
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 ${
                          idx === 0
                            ? "bg-yellow-500/20 text-yellow-500"
                            : idx === 1
                              ? "bg-slate-400/20 text-slate-400"
                              : idx === 2
                                ? "bg-orange-500/20 text-orange-500"
                                : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {idx + 1}
                      </span>
                      {src ? (
                        <OptimizedImage
                          src={src}
                          fallbackSrc={fallbackSrc}
                          fallbackDelayMs={2500}
                          alt={displayTitle}
                          className="w-10 h-14 object-cover rounded-lg shrink-0"
                          priority={idx < 10}
                        />
                      ) : (
                        <div className="w-10 h-14 bg-secondary rounded-lg shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm group-hover:text-primary transition-colors line-clamp-1">
                          {displayTitle}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" />{" "}
                          {Number(item.views || 0).toLocaleString()} lượt xem
                        </p>
                      </div>
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-16">
              <Flame className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-muted-foreground">
                Chưa có dữ liệu xu hướng. Hãy đọc nhiều truyện hơn!
              </p>
            </div>
          )
        ) : activeTab === "latest" ? (
          <MangaGrid manga={latestDisplayItems} />
        ) : activeTab === "completed" ? (
          <MangaGrid manga={completedData?.items || []} />
        ) : ratedDisplayItems.length > 0 ? (
          <MangaGrid manga={ratedDisplayItems} />
        ) : batchRatingLoading ? (
          <div className="flex flex-col items-center py-16 gap-2 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <p className="text-sm">Đang tổng hợp điểm đánh giá...</p>
          </div>
        ) : (
          <div className="text-center py-16">
            <Star className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-muted-foreground">Chưa có dữ liệu đánh giá để xếp hạng.</p>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default RankingsPage;
