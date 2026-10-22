import { repairMojibakeText, thumbUrl } from './adapters';
import { getMangaDetailPath, normalizeMangaDexId, normalizeOTruyenObjectId } from './mangaLinks';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const PLACEHOLDER = '/no-cover.svg';
type SavedRecord = Record<string, any>;

export function savedMangaId(record: SavedRecord): string {
  const raw = String(record.manga_slug || record.slug || record.manga_id || record.id || '').trim().toLowerCase();
  return normalizeMangaDexId(raw) || raw;
}

/** A Mongo ID has no meaning on QQ; resolve its saved title through exact source matching. */
export function savedMangaLookupId(record: SavedRecord): string {
  const id = savedMangaId(record);
  if (!normalizeOTruyenObjectId(id) || record.source === 'uploaded' || record.is_user_upload) return id;
  const title = repairMojibakeText(record.manga_title || record.title || record.name).trim();
  if (!title || normalizeOTruyenObjectId(title) || normalizeMangaDexId(title)
      || /^(?:unknown|untitled|mangadex|chưa có tiêu đề|đang cập nhật)$/i.test(title)) return '';
  const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.length <= 200 ? slug : '';
}

function usable(value: string): boolean {
  return Boolean(value) && !/(?:^|\/)(?:no-cover(?:-dark)?\.svg)(?:[?#]|$)/i.test(value);
}

function legacyCover(value: string, depth = 0): boolean {
  if (depth > 4) return true;
  if (/^(?:\/?uploads\/|\/?comics\/|[^/?]+\.(?:jpe?g|png|webp|avif)(?:[?#]|$))/i.test(value)) return true;
  try {
    const url = new URL(value, API_BASE);
    if (url.pathname === '/api/images/img') return legacyCover(url.searchParams.get('url') || '', depth + 1);
    return /(?:^|\.)(?:otruyenapi\.com|otruyencdn\.com)$/i.test(url.hostname);
  } catch { return false; }
}

export function needsSavedCover(value: unknown): boolean {
  const raw = String(value || '').trim();
  return !usable(raw) || legacyCover(raw);
}

/** Prefer fresh source metadata; recover stale filenames with the current cover endpoint. */
export function resolveSavedMangaCover(identifier: string, cover?: string, storedFallback?: string): { primary: string; fallback: string } {
  const id = normalizeMangaDexId(identifier) || String(identifier || '').trim();
  const current = id ? thumbUrl('', id) : PLACEHOLDER;
  const raw = String(cover || '').trim();
  let primary = usable(raw) && !legacyCover(raw) ? raw : current;
  if (!usable(primary)) return { primary: PLACEHOLDER, fallback: PLACEHOLDER };
  if (primary.startsWith('//')) primary = `https:${primary}`;
  try {
    const url = new URL(primary, API_BASE);
    // Rebase stored backend URLs and let an outdated MDX filename recover by manga ID.
    if (/^\/api\/manga\/(?:mangadex-cover|truyenqq\/cover)\//.test(url.pathname)) primary = current;
    else if (url.pathname === '/api/images/img') {
      const target = url.searchParams.get('url') || '';
      primary = /^https?:\/\//i.test(target) && /^(?:uploads\.mangadex\.org|.+\.mangadex\.network)$/i.test(new URL(target).hostname)
        ? target : `${API_BASE}${url.pathname}${url.search}`;
    } else if (!/^https?:\/\//i.test(primary)) primary = thumbUrl(primary, id);
  } catch { primary = current; }
  const previous = String(storedFallback || '').trim();
  return { primary, fallback: current !== primary ? current : (usable(previous) && !legacyCover(previous) && previous !== primary ? previous : PLACEHOLDER) };
}

export function getSavedMangaDetailPath(record: SavedRecord): string {
  const original = savedMangaId(record);
  return getMangaDetailPath(normalizeOTruyenObjectId(original) && record.manga_source_slug ? record.manga_source_slug : original);
}
