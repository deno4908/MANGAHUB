import { normalizeMangaDexId } from './mangaLinks';

const READER_META_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** QQ URLs carry stable comic identity even after navigation state/cache expire. */
export function parseQQChapter(value?: string | null) {
  const match = /^qq--([a-zA-Z0-9][a-zA-Z0-9-]*-\d+)--([a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*)$/.exec(value || '');
  if (!match) return undefined;
  const label = match[2];
  const numeric = /^\d+(?:[._-]\d+)?$/.test(label) ? Number(label.replace(/[_-]/g, '.')) : undefined;
  return { slug: match[1].toLowerCase(), label, number: numeric };
}

export function mergeReaderChapters(lists: ReaderChapter[][], currentId: string): ReaderChapter[] {
  const comic = parseQQChapter(currentId)?.slug;
  const chapters = new Map<string, ReaderChapter>();
  for (const list of lists) for (const chapter of list) {
    const sourceComic = parseQQChapter(chapter.id)?.slug;
    if (!chapter.id || (comic && sourceComic && sourceComic !== comic)) continue;
    // Keep local uploads/other translation sources and normalize legacy mdx-
    // prefixes, so merging cached and refreshed lists never duplicates a chapter.
    chapters.set(normalizeMangaDexId(chapter.id) || chapter.id, chapter);
  }
  return [...chapters.values()];
}

export interface ReaderChapter {
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

export interface PersistedChapterMeta {
  mangaId?: string;
  mangaSlug?: string;
  mangaTitle?: string;
  mangaThumb?: string;
  chapters?: ReaderChapter[];
  chapterSourceFilter?: string;
  savedAt?: number;
}

function readerMetaKey(chapterId: string): string {
  return `reader:chapter-meta:${chapterId}`;
}

function readerMangaMetaKey(mangaKey: string): string {
  return `reader:manga-meta:${mangaKey}`;
}

function readerChapterIndexKey(chapterId: string): string {
  return `reader:chapter-index:${chapterId}`;
}

function readerStores(): Storage[] {
  if (typeof window === 'undefined') return [];
  const stores: Storage[] = [];
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { stores.push(window[name]); } catch { /* Disabled storage must not break reading. */ }
  }
  return stores;
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

export function readReaderMetaFromStorage(chapterIds: Array<string | undefined | null>): PersistedChapterMeta {
  if (typeof window === 'undefined') return {};
  const normalizedIds = Array.from(
    new Set(chapterIds.map((chapterId) => String(chapterId || '').trim()).filter(Boolean)),
  );
  const keys = normalizedIds.map(readerMetaKey);
  const stores = readerStores();
  const candidates: PersistedChapterMeta[] = [];
  const comic = normalizedIds.map(parseQQChapter).find(Boolean)?.slug;
  const accept = (parsed: PersistedChapterMeta) => {
    if (!isUsableReaderMeta(parsed)) return;
    if (comic && parsed.mangaSlug !== comic && parsed.mangaId !== comic &&
        !parsed.chapters?.some(chapter => parseQQChapter(chapter.id)?.slug === comic)) return;
    candidates.push(parsed);
  };
  for (const key of keys) {
    for (const store of stores) {
      try {
        const parsed = parseStoredReaderMeta(store.getItem(key), store, key);
        accept(parsed);
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
        accept(parsed);
      } catch {
        // Ignore storage errors.
      }
    }
  }

  // Native QQ links need no per-chapter index (including a cold deep link).
  if (comic) for (const store of stores) {
    try { accept(parseStoredReaderMeta(store.getItem(readerMangaMetaKey(comic)), store, readerMangaMetaKey(comic))); }
    catch { /* Storage may be unavailable in private browsing. */ }
  }
  candidates.sort((a, b) => (b.chapters?.length || 0) - (a.chapters?.length || 0) || (b.savedAt || 0) - (a.savedAt || 0));
  if (!candidates.length) return {};
  return { ...candidates[0], chapters: mergeReaderChapters(candidates.slice().reverse().map(meta => meta.chapters || []), normalizedIds[0] || '') };
}

export function writeReaderMetaToStorage(
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
  // Store one chapter list per comic. Duplicating it for each visited chapter
  // filled localStorage and made later resume metadata silently fail to save.
  const chapterValue = JSON.stringify({ ...payload, chapters: undefined, savedAt });
  const stores = readerStores();
  for (const key of keys) for (const store of stores) {
    try { store.setItem(key, chapterValue); } catch { /* Storage can be full. */ }
  }

  const mangaKey = String(payload.mangaId || payload.mangaSlug || '').trim();
  if (!mangaKey) return;
  const metaKey = readerMangaMetaKey(mangaKey);
  const indexValue = JSON.stringify({ mangaKey, savedAt });
  const indexedChapterIds = Array.from(
    new Set([
      ...normalizedIds,
      ...(payload.chapters || []).map((chapter) => String(chapter?.id || '').trim()).filter(chapterId => chapterId && !parseQQChapter(chapterId)),
    ]),
  );

  for (const store of stores) {
    try {
      const previous = parseStoredReaderMeta(store.getItem(metaKey), store, metaKey);
      const chapters = mergeReaderChapters([previous.chapters || [], payload.chapters || []], normalizedIds[0] || '');
      store.setItem(metaKey, JSON.stringify({ ...previous, ...payload, chapters, savedAt }));
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

export function parseChapterNumber(value: unknown): number | undefined {
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

export function formatChapterNumber(value: number | undefined): string {
  if (!Number.isFinite(value) || Number(value) < 0) return '?';
  return Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

export function isInvalidMangaSlug(slug?: string | null): boolean {
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

export function cleanSlug(value?: string | null): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]/g, '');
}

