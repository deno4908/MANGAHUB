/**
 * Adapters — transform OTruyenAPI responses into frontend types.
 */
import type { Manga, Chapter } from "@/types/manga";
import { toOTruyenRouteId } from "@/lib/mangaLinks";

const IMG_CDN = "https://img.otruyenapi.com/uploads/comics/";
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_PLACEHOLDERS = new Set([
  "dang cap nhat",
  "dang cap nhat tieu de",
  "hien dang cap nhat",
  "chua co tieu de",
  "khong co tieu de",
  "khong co ten",
  "no title",
  "mangadex",
  "untitled",
  "unknown",
]);
const MOJIBAKE_RE = /[ÃÂÄÅÆÐ]/;
const MOJIBAKE_RE_SAFE = /(?:\u00c3.|\u00c4.|\u00c6.|\u00e1[\u00ba\u00bb].)/g;
const BAD_DECODE_RE = /[\uFFFD\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\u009f]/;
const NON_ASCII_RE = /[^\x00-\x7f]/;

function mojibakeScore(value: string): number {
  const text = String(value || "");
  return Math.max(
    (text.match(MOJIBAKE_RE_SAFE) || []).length,
    (text.match(MOJIBAKE_RE) || []).length,
  );
}

function decodeIssueScore(value: string): number {
  const text = String(value || "");
  return mojibakeScore(text) + ((text.match(BAD_DECODE_RE) || []).length * 4);
}

export function repairMojibakeText(value: unknown): string {
  const text = String(value || "");
  if (!text || decodeIssueScore(text) === 0) return text;

  const candidates = [text];
  try {
    const bytes = Uint8Array.from(Array.from(text).map((ch) => ch.charCodeAt(0) & 0xff));
    const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (fixed) candidates.push(fixed);
  } catch {
    // ignore and keep original candidate
  }

  let best = text;
  let bestScore = decodeIssueScore(text);
  for (const candidate of candidates.slice(1)) {
    const score = decodeIssueScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function cleanReadableText(value: unknown): string {
  const text = repairMojibakeText(value);
  return BAD_DECODE_RE.test(text) ? "" : text;
}

function normalizeLooseText(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Đ/g, "D")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeSlugTitle(slug: string): string {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!normalized) return "";
  if (UUID_RE.test(normalized) || normalized.startsWith("mdx-")) return "";
  if (!normalized.includes("-")) return "";
  const words = normalized
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return words.join(" ");
}

function isInvalidDisplayTitle(title: string, slug: string): boolean {
  const rawTitle = String(title || "").trim();
  const normalizedTitle = normalizeLooseText(title);
  if (BAD_DECODE_RE.test(rawTitle)) return true;
  if (!normalizedTitle) return !NON_ASCII_RE.test(rawTitle);
  if (TITLE_PLACEHOLDERS.has(normalizedTitle)) return true;

  const normalizedSlug = normalizeLooseText(slug).replace(/\s+/g, "-");
  if (!normalizedSlug) return false;

  if (normalizedTitle === normalizedSlug.replace(/-/g, " ") && !NON_ASCII_RE.test(rawTitle)) {
    return true;
  }
  if (normalizedTitle === `mdx ${normalizedSlug.replace(/-/g, " ")}`) return true;
  const compactTitle = normalizedTitle.replace(/\s+/g, "-");
  return UUID_RE.test(compactTitle);
}

function titlePreferenceScore(title: string): number {
  const text = String(title || "").trim();
  if (!text) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (NON_ASCII_RE.test(text)) score += 4;
  score += decodeIssueScore(text) === 0 ? 2 : -Math.min(6, decodeIssueScore(text));
  score += Math.min(text.length, 80) / 80;
  return score;
}

function collectTitleCandidates(...values: Array<unknown>): Array<unknown> {
  const candidates: Array<unknown> = [];

  const collect = (value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number") {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(collect);
    }
  };

  values.forEach(collect);
  return candidates;
}

export function pickBestTitle(slug: string, ...candidates: Array<unknown>): string {
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  let fallback = "";

  for (const candidate of candidates) {
    const title = repairMojibakeText(candidate).trim();
    if (!title) continue;

    const normalized = normalizeLooseText(title);
    const isInvalid = isInvalidDisplayTitle(title, slug);
    if (!fallback && normalized && !TITLE_PLACEHOLDERS.has(normalized) && !isInvalid) {
      fallback = title;
    }

    if (isInvalid) continue;

    const score = titlePreferenceScore(title);
    if (score > bestScore) {
      best = title;
      bestScore = score;
    }
  }

  return best || fallback || humanizeSlugTitle(slug);
}

function isMangaDexImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host.endsWith("uploads.mangadex.org") || host.endsWith("mangadex.network");
  } catch {
    return false;
  }
}

function isOTruyenImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host.endsWith("img.otruyenapi.com") || host.endsWith("otruyencdn.com");
  } catch {
    return false;
  }
}

function toProxyImageUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
}

function isValidTimestamp(value: unknown): value is string {
  const text = String(value || "").trim();
  if (!text) return false;
  return Number.isFinite(Date.parse(text));
}

function pickFirstValidTimestamp(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (isValidTimestamp(candidate)) {
      return String(candidate).trim();
    }
  }
  return "";
}

function extractObjectIdTimestamp(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const tail = raw.split("/").pop() || raw;
  const normalized = tail.trim().toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(normalized)) return "";

  const seconds = Number.parseInt(normalized.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

function parseMangaYear(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  const year = Math.trunc(parsed);
  const maxYear = new Date().getFullYear() + 1;
  if (year < 1900 || year > maxYear) return 0;
  return year;
}

function yearFromTimestamp(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return 0;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return 0;
  return parseMangaYear(new Date(ts).getFullYear());
}

function resolveItemYear(item: any): number {
  const explicitYear =
    parseMangaYear(item?.year) ||
    parseMangaYear(item?.release_year) ||
    parseMangaYear(item?.releaseYear) ||
    parseMangaYear(item?.published_year) ||
    parseMangaYear(item?.publishedYear);
  if (explicitYear) return explicitYear;

  return (
    yearFromTimestamp(item?.local_last_published_at) ||
    yearFromTimestamp(item?.updatedAt) ||
    yearFromTimestamp(item?.createdAt) ||
    0
  );
}

function pickChapterTime(ch: any, item?: any): string {
  const chapterTimestamp = pickFirstValidTimestamp(
    ch?.local_published_at,
    ch?.publish_at,
    ch?.readable_at,
    ch?.chapter_updated_at,
    ch?.updatedAt,
    ch?.createdAt,
    extractObjectIdTimestamp(ch?.chapter_api_data),
    extractObjectIdTimestamp(ch?.id),
  );
  if (chapterTimestamp) return chapterTimestamp;

  // Fallback to explicit local chapter publish metadata when available.
  // Avoid item.updatedAt/item.createdAt because they often represent crawl/update time,
  // not the chapter publish time shown to users.
  return pickFirstValidTimestamp(
    item?.local_last_published_at,
    item?.last_chapter_updated_at,
    item?.chapter_updated_at,
  );
}

/** Build full thumbnail URL from OTruyen thumb path */
export function thumbUrl(thumb: string, slug: string): string {
  const raw = (thumb || "").trim();
  if (!raw) return `${IMG_CDN}${slug}-thumb.jpg`;
  if (/^https?:\/\//i.test(raw)) {
    if (isMangaDexImageUrl(raw)) {
      return `${API_BASE}/api/images/img?url=${encodeURIComponent(raw)}`;
    }
    return raw;
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("/uploads/")) return `https://img.otruyenapi.com${raw}`;
  if (raw.startsWith("uploads/")) return `https://img.otruyenapi.com/${raw}`;
  // Some OTruyen payloads return `comics/<file>.jpg`.
  // Prefix with `/uploads/` instead of duplicating `comics/`.
  if (raw.startsWith("/comics/")) return `https://img.otruyenapi.com/uploads${raw}`;
  if (raw.startsWith("comics/")) return `https://img.otruyenapi.com/uploads/${raw}`;
  // Plain filename (most common for OTruyen API)
  return `${IMG_CDN}${raw}`;
}

/** Build alternate OTruyen thumbnail URL when API returns plain filename only. */
export function thumbFallbackUrl(thumb: string, slug: string): string {
  const raw = (thumb || "").trim();
  const normalizedSlug = (slug || "").trim();
  if (!raw || !normalizedSlug) return "";

  if (raw.startsWith("/uploads/comics/")) {
    const tail = raw.slice("/uploads/comics/".length);
    if (tail && !tail.includes("/")) {
      return `https://img.otruyenapi.com/uploads/comics/${normalizedSlug}/${tail}`;
    }
    return "";
  }

  if (raw.startsWith("uploads/comics/")) {
    const tail = raw.slice("uploads/comics/".length);
    if (tail && !tail.includes("/")) {
      return `https://img.otruyenapi.com/uploads/comics/${normalizedSlug}/${tail}`;
    }
    return "";
  }

  if (raw.startsWith("/") || raw.includes("/")) return "";
  return `https://img.otruyenapi.com/uploads/comics/${normalizedSlug}/${raw}`;
}

/** Map OTruyen status → frontend status */
function mapStatus(status: string): Manga["status"] {
  const s = (status || "").toLowerCase().trim();
  // Completed
  if (s.includes("hoàn") || s.includes("completed") || s === "hoan-thanh")
    return "completed";
  // Ongoing
  if (
    s.includes("tiến hành") ||
    s.includes("cập nhật") ||
    s.includes("phát hành") ||
    s.includes("đang ra") ||
    s === "ongoing" ||
    s === "dang-phat-hanh"
  )
    return "ongoing";
  // Hiatus / coming soon
  if (
    s.includes("tạm") ||
    s.includes("ngưng") ||
    s.includes("sắp") ||
    s === "hiatus" ||
    s === "sap-ra-mat" ||
    s === "coming_soon"
  )
    return "hiatus";
  // Fallback — log unknown
  if (s) console.warn("[mapStatus] Unknown status:", status);
  return "ongoing";
}

/** Adapt a single OTruyen manga item (from list/home) → frontend Manga */
export function adaptMangaItem(item: any): Manga {
  const slug = item.slug || "";
  const isMangaDexSource = item.source === "mangadex";
  const isUserUpload = Boolean(item.is_user_upload);
  const sourceId = isMangaDexSource || isUserUpload
    ? String(item.id || item._id || slug || "").trim()
    : toOTruyenRouteId(item._id || item.id) || slug;
  const originNameCandidate = Array.isArray(item.origin_name)
    ? item.origin_name.find((value: unknown) => String(repairMojibakeText(value) || "").trim())
    : item.origin_name;

  let displayTitle: string;
  let altTitleCandidate: string;

  if (isUserUpload) {
    displayTitle = String(item.name || item.title || "").trim() || "Chưa có tiêu đề";
    altTitleCandidate = "";
  } else {
    const titleCandidates = collectTitleCandidates(
      item.title,
      item.manga_title,
      item.name,
      originNameCandidate,
      item.original_title,
      item.originalTitle,
      item.alt_titles,
      item.altTitles,
    );
    displayTitle =
      pickBestTitle(slug, ...titleCandidates) || "Chưa có tiêu đề";
    altTitleCandidate = pickBestTitle(
      slug,
      ...collectTitleCandidates(originNameCandidate, item.title, item.manga_title, item.name),
    );
  }
  const coverRaw = String(item.cover_url || item.cover || "").trim();
  const thumbRaw = coverRaw || String(item.thumb_url || "").trim();
  const coverDirect = thumbRaw ? thumbUrl(thumbRaw, slug) : thumbUrl("", slug);
  const cover = isOTruyenImageUrl(coverDirect) ? toProxyImageUrl(coverDirect) : coverDirect;
  const coverProxy = thumbFallbackUrl(thumbRaw, slug) || (isOTruyenImageUrl(coverDirect) ? coverDirect : "");
  const categories = item.category || [];
  const ratingRaw = item.rating_average ?? item.average_rating ?? item.rating;
  const rating = Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : 0;
  const ratingCountRaw =
    item.rating_count ?? item.ratings_count ?? item.ratingCount;
  const ratingCount = Number.isFinite(Number(ratingCountRaw))
    ? Number(ratingCountRaw)
    : 0;
  const myRatingRaw = item.my_rating ?? item.user_rating;
  const myRating = Number.isFinite(Number(myRatingRaw))
    ? Number(myRatingRaw)
    : null;

  // Extract latest chapter info from chaptersLatest
  const latestChapters: Chapter[] = [];
  const chaptersLatest = item.chaptersLatest || item.chapters_latest || [];
  if (Array.isArray(chaptersLatest) && chaptersLatest.length > 0) {
    chaptersLatest.forEach((ch: any) => {
      if (ch.chapter_name) {
        const chapterApiData = String(ch.chapter_api_data || "").trim();
        const chapterIdFromApi = chapterApiData ? chapterApiData.split("/").pop() : "";
        const chapterName = repairMojibakeText(ch.chapter_name).trim();
        const chapterTitle = repairMojibakeText(ch.chapter_title).trim();
        latestChapters.push({
          id: chapterIdFromApi || (isMangaDexSource ? `mdx-ch-${slug}-${chapterName}` : `ch-${chapterName}`),
          mangaId: slug,
          number: parseFloat(chapterName) || 0,
          title: chapterTitle || `Chương ${chapterName}`,
          pages: [],
          uploadDate: pickChapterTime(ch, item),
          scanlationGroup: "",
        });
      }
    });
  }
  if (latestChapters.length === 0 && !isMangaDexSource) {
    const lastChapterRaw = String(item.last_chapter || item.chapter_newest || "").trim();
    if (lastChapterRaw) {
      const parsed = parseFloat(lastChapterRaw);
      latestChapters.push({
        id: `ch-${slug}-latest`,
        mangaId: slug,
        number: Number.isFinite(parsed) ? parsed : 0,
        title: `Chương ${lastChapterRaw}`,
        pages: [],
        uploadDate: pickChapterTime(undefined, item),
        scanlationGroup: "",
      });
    } else if (mapStatus(item.status || "") === "hiatus") {
      latestChapters.push({
        id: `ch-${slug}-coming-soon`,
        mangaId: slug,
        number: -2,
        title: "Sắp ra mắt",
        pages: [],
        uploadDate: pickChapterTime(undefined, item),
        scanlationGroup: "",
      });
    }
  }
  // Fallback: create chapter entry from last_chapter metadata (MangaDex items)
  if (latestChapters.length === 0 && isMangaDexSource) {
    const lastChapterRaw = String(item.last_chapter || "").trim();
    if (lastChapterRaw) {
      const lastChNum = parseFloat(lastChapterRaw) || 0;
      latestChapters.push({
        id: `mdx-ch-${slug}-latest`,
        mangaId: slug,
        number: lastChNum,
        title: `Chương ${lastChapterRaw}`,
        pages: [],
        uploadDate: item.updatedAt || item.local_last_published_at || new Date().toISOString(),
        scanlationGroup: "",
      });
    } else {
      // No chapter info at all — push placeholder so card shows 'MangaDex' not 'Đang cập nhật'
      latestChapters.push({
        id: `mdx-ch-${slug}-placeholder`,
        mangaId: slug,
        number: -1, // sentinel: no known chapter
        title: 'MangaDex',
        pages: [],
        uploadDate: item.updatedAt || item.local_last_published_at || new Date().toISOString(),
        scanlationGroup: "",
      });
    }
  }

  latestChapters.sort((a, b) => {
    const tsA = Number.isFinite(Date.parse(String(a.uploadDate || "")))
      ? Date.parse(String(a.uploadDate || ""))
      : 0;
    const tsB = Number.isFinite(Date.parse(String(b.uploadDate || "")))
      ? Date.parse(String(b.uploadDate || ""))
      : 0;
    if (tsA !== tsB) return tsA - tsB;

    const numA = Number(a.number || 0);
    const numB = Number(b.number || 0);
    if (numA !== numB) return numA - numB;

    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  const latestChapterUpdatedAt = latestChapters.reduce((best, chapter) => {
    const candidate = String(chapter.uploadDate || "").trim();
    if (!isValidTimestamp(candidate)) return best;
    if (!best) return candidate;
    return Date.parse(candidate) > Date.parse(best) ? candidate : best;
  }, "");

  const resolvedLastUpdated =
    pickFirstValidTimestamp(
      latestChapterUpdatedAt,
      item.local_last_published_at,
      item.updatedAt,
      item.createdAt,
    ) || new Date().toISOString();

  return {
    id: sourceId || slug,
    slug,
    source: isUserUpload ? "uploaded" : (isMangaDexSource ? "mangadex" : "otruyen"),
    title: displayTitle,
    altTitle: altTitleCandidate && altTitleCandidate !== displayTitle
      ? altTitleCandidate
      : "",
    author: Array.isArray(item.author)
      ? item.author.map((value: unknown) => repairMojibakeText(value)).join(", ")
      : repairMojibakeText(item.author) || "Unknown",
    artist: Array.isArray(item.author)
      ? item.author.map((value: unknown) => repairMojibakeText(value)).join(", ")
      : repairMojibakeText(item.author) || "Unknown",
    description: cleanReadableText(item.content).replace(/<[^>]*>/g, ""), // strip HTML
    cover,
    coverProxy: coverProxy && coverProxy !== cover ? coverProxy : undefined,
    status: mapStatus(item.status || ""),
    type: "manga",
    genres: Array.isArray(categories)
      ? categories.map((c: any) => repairMojibakeText(c.name || c))
      : [],
    tags: Array.isArray(categories)
      ? categories.map((c: any) => c.slug || "")
      : [],
    rating,
    ratingCount,
    myRating,
    follows: 0,
    views: item.view_count || item.views || 0,
    year: resolveItemYear(item),
    chapters: latestChapters,
    lastUpdated: resolvedLastUpdated,
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
  };
}

/** Adapt full OTruyen manga detail → frontend Manga (with chapters) */
export function adaptMangaDetail(data: any): Manga {
  const item = data?.data?.item || data?.item || data;
  const seoData = data?.data?.seoOnPage || {};
  const slug = item.slug || "";

  // For user-uploaded manga, use the title directly without validation heuristics
  const isUserUpload = Boolean(item.is_user_upload);
  const sourceId = isUserUpload
    ? String(item.id || item._id || slug || "").trim()
    : toOTruyenRouteId(item._id || item.id) || slug;

  const originNameCandidate = Array.isArray(item.origin_name)
    ? item.origin_name.find((value: unknown) => String(repairMojibakeText(value) || "").trim())
    : item.origin_name;
  const seoTitle = String(seoData?.titleHead || "")
    .replace(/\s*-\s*$/, "")
    .trim();

  let displayTitle: string;
  let altTitleCandidate: string;

  if (isUserUpload) {
    // User uploads: trust the title as-is
    displayTitle = String(item.name || item.title || seoTitle || "").trim() || "Chưa có tiêu đề";
    altTitleCandidate = "";
  } else {
    const titleCandidates = collectTitleCandidates(
      item.title,
      item.manga_title,
      item.name,
      originNameCandidate,
      seoTitle,
      item.original_title,
      item.originalTitle,
      item.alt_titles,
      item.altTitles,
    );
    displayTitle =
      pickBestTitle(slug, ...titleCandidates) || "Chưa có tiêu đề";
    altTitleCandidate = pickBestTitle(
      slug,
      ...collectTitleCandidates(originNameCandidate, item.title, item.manga_title, item.name, seoTitle),
    );
  }
  const coverRaw = String(item.cover_url || item.cover || "").trim();
  const thumbRaw = coverRaw || String(item.thumb_url || "").trim();
  const coverDirect = thumbRaw ? thumbUrl(thumbRaw, slug) : thumbUrl("", slug);
  const cover = isOTruyenImageUrl(coverDirect) ? toProxyImageUrl(coverDirect) : coverDirect;
  const coverProxy = thumbFallbackUrl(thumbRaw, slug) || (isOTruyenImageUrl(coverDirect) ? coverDirect : "");
  const categories = item.category || [];

  // Build chapters from server_data
  const serverChapters = item.chapters?.[0]?.server_data || [];
  const chapters: Chapter[] = serverChapters.map((ch: any, idx: number) => ({
    id: ch.chapter_api_data?.split("/").pop() || repairMojibakeText(ch.chapter_name) || `ch-${idx}`,
    mangaId: slug,
    number: parseFloat(repairMojibakeText(ch.chapter_name)) || idx + 1,
    title: repairMojibakeText(ch.chapter_title) || `Chương ${repairMojibakeText(ch.chapter_name)}`,
    pages: [], // loaded on chapter open
    uploadDate: pickChapterTime(ch, item),
    scanlationGroup: "",
  }));

  // Reverse so newest first for display, oldest first for reading
  let chaptersForReading = [...chapters].reverse();
  if (chaptersForReading.length === 0) {
    const lastChapterRaw = String(item.last_chapter || item.chapter_newest || "").trim();
    if (lastChapterRaw) {
      const parsed = parseFloat(lastChapterRaw);
      chaptersForReading = [{
        id: `ch-${slug}-latest`,
        mangaId: slug,
        number: Number.isFinite(parsed) ? parsed : 0,
        title: `Chương ${lastChapterRaw}`,
        pages: [],
        uploadDate: pickChapterTime(undefined, item),
        scanlationGroup: "",
      }];
    } else if (mapStatus(item.status || "") === "hiatus") {
      chaptersForReading = [{
        id: `ch-${slug}-coming-soon`,
        mangaId: slug,
        number: -2,
        title: "Sắp ra mắt",
        pages: [],
        uploadDate: pickChapterTime(undefined, item),
        scanlationGroup: "",
      }];
    }
  }

  const ratingRaw = item.rating_average ?? item.average_rating ?? item.rating;
  const rating = Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : 0;
  const ratingCountRaw =
    item.rating_count ?? item.ratings_count ?? item.ratingCount;
  const ratingCount = Number.isFinite(Number(ratingCountRaw))
    ? Number(ratingCountRaw)
    : 0;
  const myRatingRaw = item.my_rating ?? item.user_rating;
  const myRating = Number.isFinite(Number(myRatingRaw))
    ? Number(myRatingRaw)
    : null;

  return {
    id: sourceId || slug,
    slug,
    source: isUserUpload ? "uploaded" : "otruyen",
    title: displayTitle,
    altTitle: altTitleCandidate && altTitleCandidate !== displayTitle
      ? altTitleCandidate
      : "",
    author: Array.isArray(item.author)
      ? item.author.map((value: unknown) => repairMojibakeText(value)).join(", ")
      : repairMojibakeText(item.author) || "Unknown",
    artist: Array.isArray(item.author)
      ? item.author.map((value: unknown) => repairMojibakeText(value)).join(", ")
      : repairMojibakeText(item.author) || "Unknown",
    description: cleanReadableText(item.content).replace(/<[^>]*>/g, ""),
    cover,
    coverProxy: coverProxy && coverProxy !== cover ? coverProxy : undefined,
    status: mapStatus(item.status || ""),
    type: "manga",
    genres: Array.isArray(categories)
      ? categories.map((c: any) => repairMojibakeText(c.name || c))
      : [],
    tags: Array.isArray(categories)
      ? categories.map((c: any) => c.slug || "")
      : [],
    rating,
    ratingCount,
    myRating,
    follows: 0,
    views: item.view_count || 0,
    year: resolveItemYear(item),
    chapters: chaptersForReading,
    lastUpdated:
      item.local_last_published_at ||
      item.updatedAt ||
      new Date().toISOString(),
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
  };
}

/** Adapt OTruyen chapter detail → pages array (proxied through backend for caching) */
export function adaptChapterPages(data: any): string[] {
  const items = data?.data?.item?.chapter_image || [];
  const domain = data?.data?.domain_cdn || "https://sv1.otruyencdn.com";
  const chapterPath = data?.data?.item?.chapter_path || "";
  const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

  return items.map((img: any) => {
    const filename = img.image_file || "";
    const cdnUrl = `${domain}/${chapterPath}/${filename}`;
    // Route through backend proxy for caching
    return `${API_BASE}/api/images/img?url=${encodeURIComponent(cdnUrl)}`;
  });
}

/** Adapt OTruyen home response → Manga[] */
export function adaptHomeData(data: any): {
  items: Manga[];
  seoOnPage?: any;
} {
  const items = data?.data?.items || [];
  return {
    items: items.map(adaptMangaItem),
    seoOnPage: data?.data?.seoOnPage,
  };
}

/** Adapt OTruyen list/search response → Manga[] with pagination */
export function adaptListData(data: any): {
  items: Manga[];
  totalItems: number;
  currentPage: number;
  totalPages: number;
} {
  const items = data?.data?.items || [];
  const params = data?.data?.params || {};

  const totalItems = parseInt(params.pagination?.totalItems) || items.length;
  const itemsPerPage = parseInt(params.pagination?.totalItemsPerPage) || 24;
  const currentPage = parseInt(params.pagination?.currentPage) || 1;

  return {
    items: items.map(adaptMangaItem),
    totalItems,
    currentPage,
    totalPages: itemsPerPage > 0 ? Math.ceil(totalItems / itemsPerPage) : 1,
  };
}

/** Adapt OTruyen categories → { slug, name, source }[] */
export function adaptCategories(data: any): { slug: string; name: string; source?: string }[] {
  const items = data?.data?.items || [];
  return items.map((c: any) => ({ slug: c.slug || "", name: c.name || "", source: 'otruyen' }));
}

/** MangaDex genres that may not appear in OTruyen */
export const MANGADEX_EXTRA_GENRES: { slug: string; name: string; source: string }[] = [
  // 'isekai' added separately with merged label below — skip duplicate here
  { slug: 'isekai', name: 'Isekai / Chuyển sinh', source: 'mangadex' },
  { slug: 'villainess', name: 'Villainess', source: 'mangadex' },
  { slug: 'time-travel', name: 'Du hành thời gian', source: 'mangadex' },
  { slug: 'reverse-harem', name: 'Harem ngược', source: 'mangadex' },
  { slug: 'monster-girls', name: 'Cô gái quái vật', source: 'mangadex' },
  { slug: 'survival', name: 'Sinh tồn', source: 'mangadex' },
  { slug: 'post-apocalyptic', name: 'Hậu tận thế', source: 'mangadex' },
  { slug: 'virtual-reality', name: 'Thực tế ảo', source: 'mangadex' },
  { slug: 'gyaru', name: 'Gyaru', source: 'mangadex' },
  { slug: 'military', name: 'Quân sự', source: 'mangadex' },
  { slug: 'medical', name: 'Y học', source: 'mangadex' },
  { slug: 'philosophical', name: 'Triết học', source: 'mangadex' },
  { slug: 'crime', name: 'Tội phạm', source: 'mangadex' },
  { slug: 'mafia', name: 'Mafia', source: 'mangadex' },
];
