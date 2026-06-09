import type { Manga } from "@/types/manga";
import { isOTruyenRouteId } from "@/lib/mangaLinks";

const MATURE_CONTENT_RATINGS = new Set([
  "erotica",
  "pornographic",
  "mature",
  "adult",
  "explicit",
  "18+",
  "r18",
  "x18",
  "adults-only",
]);
const MANGADEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATURE_TEXT_TERMS = [
  "adult",
  "mature",
  "erotica",
  "pornographic",
  "explicit",
  "hentai",
  "ecchi",
  "smut",
  "nsfw",
  "r18",
  "nguoi lon",
  "noi dung nguoi lon",
  "noi dung nhay cam",
  "tinh duc",
  "bao luc tinh duc",
  "sexual violence",
  "sexual-violence",
  "sexual assault",
  "sexual-assault",
  "sexual abuse",
  "sexual-abuse",
  "truong thanh",
  "adults only",
  "adult only",
  "for adults",
  "18 plus",
  "18-plus",
  "+18",
  "r-18",
];
const ECCHI_TEXT_TERMS = ["ecchi"];

function normalizeLooseText(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9+\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toStringList(entry));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const direct = [obj.slug, obj.name, obj.title, obj.label]
      .flatMap((entry) => toStringList(entry))
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);

    const attributes = obj.attributes && typeof obj.attributes === "object"
      ? (obj.attributes as Record<string, unknown>)
      : null;
    const nested = attributes
      ? [attributes.name, attributes.title, attributes.description]
        .flatMap((entry) => toStringList(entry))
      : [];

    return [...direct, ...nested];
  }

  const text = String(value || "").trim();
  return text ? [text] : [];
}

function hasMatureMarker(value: unknown): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;

  if (/(^|[^0-9a-z])(18\+|\+18|18\s*plus|18[-_\s]*plus|r[-_\s]*18|x[-_\s]*18)([^0-9a-z]|$)/i.test(raw.toLowerCase())) {
    return true;
  }

  const normalized = normalizeLooseText(raw);
  if (!normalized) return false;

  return MATURE_TEXT_TERMS.some((term) => normalized.includes(term));
}

function hasEcchiMarker(value: unknown): boolean {
  const normalized = normalizeLooseText(value);
  if (!normalized) return false;

  return ECCHI_TEXT_TERMS.some((term) => new RegExp(`(^|\\s)${term}(\\s|$)`).test(normalized));
}

export function normalizeContentRating(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function isMatureContentRating(value: unknown): boolean {
  const normalized = normalizeContentRating(value);
  return !!normalized && MATURE_CONTENT_RATINGS.has(normalized);
}

export function getMangaContentRating(item: Partial<Manga> | Record<string, unknown> | null | undefined): string {
  if (!item || typeof item !== "object") return "";
  const candidate = (item as any).contentRating ?? (item as any).content_rating;
  return normalizeContentRating(candidate);
}

function isLikelyMangaDexItem(item: Partial<Manga> | Record<string, unknown>): boolean {
  const id = String((item as any).id || "").trim().toLowerCase();
  const source = String((item as any).source || (item as any).provider || "").trim().toLowerCase();
  const url = String((item as any).url || "").trim().toLowerCase();
  const author = String((item as any).author || "").trim().toLowerCase();
  const artist = String((item as any).artist || "").trim().toLowerCase();

  return (
    source.includes("mangadex") ||
    url.includes("mangadex.org") ||
    author === "mangadex" ||
    artist === "mangadex" ||
    id.startsWith("mdx-") ||
    (MANGADEX_ID_RE.test(id) && !isOTruyenRouteId(id))
  );
}

export function isMatureManga(item: Partial<Manga> | Record<string, unknown> | null | undefined): boolean {
  if (!item || typeof item !== "object") return false;
  const contentRating = getMangaContentRating(item);

  // Trust explicit content-rating first for every source.
  if (isMatureContentRating(contentRating)) return true;

  if (
    contentRating === "18+" ||
    contentRating === "+18" ||
    contentRating === "r18" ||
    contentRating === "r-18" ||
    contentRating === "18plus"
  ) {
    return true;
  }

  if (
    (item as any).isMature === true ||
    (item as any).is_mature === true ||
    (item as any).isAdult === true ||
    (item as any).adult === true ||
    String((item as any).isMature || "").toLowerCase() === "true" ||
    String((item as any).is_mature || "").toLowerCase() === "true" ||
    String((item as any).isAdult || "").toLowerCase() === "true" ||
    String((item as any).adult || "").toLowerCase() === "true"
  ) {
    return true;
  }

  const candidates = [
    (item as any).content_warning,
    (item as any).contentWarning,
    (item as any).age_rating,
    (item as any).ageRating,
    (item as any).demographic,
    (item as any).publication_demographic,
    (item as any).publicationDemographic,
    (item as any).description,
    (item as any).title,
    ...toStringList((item as any).tags),
    ...toStringList((item as any).genres),
    ...toStringList((item as any).genre),
    ...toStringList((item as any).category),
    ...toStringList((item as any).categories),
  ];

  return candidates.some((entry) => hasMatureMarker(entry));
}

export function isEcchiManga(item: Partial<Manga> | Record<string, unknown> | null | undefined): boolean {
  if (!item || typeof item !== "object") return false;

  const contentRating = getMangaContentRating(item);
  if (contentRating === "ecchi") return true;

  const candidates = [
    (item as any).content_warning,
    (item as any).contentWarning,
    ...toStringList((item as any).tags),
    ...toStringList((item as any).genres),
    ...toStringList((item as any).genre),
    ...toStringList((item as any).category),
    ...toStringList((item as any).categories),
  ];

  return candidates.some((entry) => hasEcchiMarker(entry));
}

export function filteredContentWarningMessage(title: string): string {
  const safeTitle = String(title || "Untitled").trim() || "Untitled";
  return [
    `\"${safeTitle}\" chứa nội dung đang bị bạn lọc:`,
    "",
    "Phân loại nội dung",
    "Truyện này có phân loại nội dung đang bị ẩn:",
    "",
    "Mature",
    "",
    "Nhấn OK để tiếp tục truy cập hoặc Cancel để quay lại.",
  ].join("\n");
}
