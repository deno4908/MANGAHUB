import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { normalizeMangaDexId } from '@/lib/mangaLinks';

type PlainRecord = Record<string, any>;

type MangaCachePatchOptions = {
  queryKeyPrefixes?: string[];
};

const DEFAULT_MANGA_CACHE_PREFIXES = [
  'manga',
  'rating',
  'history',
  'bookmarks',
  'follows',
  'public-profile',
];

function normalizeIdentifier(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function toIdentifierSet(values: Array<unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const normalized = normalizeIdentifier(value);
    if (!normalized) continue;
    ids.add(normalized);
    const mdx = normalizeMangaDexId(normalized);
    if (mdx) {
      ids.add(mdx.toLowerCase());
      ids.add(`mdx-${mdx.toLowerCase()}`);
    }
  }
  return ids;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function recordLooksLikeManga(record: PlainRecord): boolean {
  return (
    'views' in record ||
    'view_count' in record ||
    'localViewCount' in record ||
    'local_view_count' in record ||
    'chapters' in record ||
    'genres' in record ||
    'cover' in record ||
    'cover_url' in record ||
    'thumb' in record ||
    'thumb_url' in record ||
    'manga_thumb' in record ||
    'manga_title' in record
  );
}

function recordMatchesManga(record: PlainRecord, identifiers: Set<string>): boolean {
  if (!recordLooksLikeManga(record)) return false;
  const candidates = [
    record.id,
    record.slug,
    record.manga_slug,
    record.mangaSlug,
    record.manga_id,
    record.mangaId,
    record._id,
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeIdentifier(candidate);
    if (!normalized) return false;
    if (identifiers.has(normalized)) return true;
    const mdx = normalizeMangaDexId(normalized);
    return !!mdx && identifiers.has(mdx.toLowerCase());
  });
}

function shouldPatchQuery(queryKey: QueryKey, prefixes: string[]): boolean {
  const first = Array.isArray(queryKey) ? String(queryKey[0] || '') : '';
  return prefixes.includes(first);
}

function patchNestedMangaRecords(
  value: any,
  identifiers: Set<string>,
  patchRecord: (record: PlainRecord) => PlainRecord,
  depth = 0,
): [any, boolean] {
  if (depth > 8 || value == null) return [value, false];

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const [patched, itemChanged] = patchNestedMangaRecords(item, identifiers, patchRecord, depth + 1);
      changed = changed || itemChanged;
      return patched;
    });
    return changed ? [next, true] : [value, false];
  }

  if (!isPlainRecord(value)) return [value, false];

  let nextRecord: PlainRecord = value;
  let changed = false;

  if (recordMatchesManga(value, identifiers)) {
    nextRecord = patchRecord(value);
    changed = nextRecord !== value;
  }

  for (const [key, child] of Object.entries(nextRecord)) {
    if (child == null || typeof child !== 'object') continue;
    const [patchedChild, childChanged] = patchNestedMangaRecords(child, identifiers, patchRecord, depth + 1);
    if (!childChanged) continue;
    if (!changed) {
      nextRecord = { ...nextRecord };
      changed = true;
    }
    nextRecord[key] = patchedChild;
  }

  return changed ? [nextRecord, true] : [value, false];
}

export function patchMangaInQueryCache(
  queryClient: QueryClient,
  identifiersInput: Array<unknown>,
  patchRecord: (record: PlainRecord) => PlainRecord,
  options: MangaCachePatchOptions = {},
) {
  const identifiers = toIdentifierSet(identifiersInput);
  if (!identifiers.size) return;

  const prefixes = options.queryKeyPrefixes || DEFAULT_MANGA_CACHE_PREFIXES;
  const cache = queryClient.getQueryCache();
  for (const query of cache.getAll()) {
    if (!shouldPatchQuery(query.queryKey, prefixes)) continue;
    queryClient.setQueryData(query.queryKey, (old: any) => {
      const [next, changed] = patchNestedMangaRecords(old, identifiers, patchRecord);
      return changed ? next : old;
    });
  }
}

export function incrementMangaViewsInQueryCache(
  queryClient: QueryClient,
  identifiers: Array<unknown>,
  amount = 1,
) {
  const increment = Math.max(1, Math.floor(Number(amount) || 1));
  patchMangaInQueryCache(queryClient, identifiers, (record) => {
    const current = Math.max(
      0,
      Number(
        record.localViewCount ??
        record.local_view_count ??
        record.views ??
        record.view_count ??
        0,
      ) || 0,
    );
    const next = current + increment;
    return {
      ...record,
      views: next,
      localViewCount: 'localViewCount' in record ? next : record.localViewCount,
      local_view_count: 'local_view_count' in record ? next : record.local_view_count,
      view_count: 'view_count' in record ? next : record.view_count,
    };
  });
  const ids = toIdentifierSet(identifiers);
  queryClient.setQueriesData({ queryKey: ['rating', 'batch'] }, (old: any) => {
    if (!old?.views || typeof old.views !== 'object') return old;
    let changed = false;
    const views = { ...old.views };
    for (const key of Object.keys(views)) {
      const normalized = normalizeIdentifier(key);
      if (!ids.has(normalized) && !ids.has(normalizeMangaDexId(normalized) || '')) continue;
      views[key] = Math.max(0, Number(views[key]) || 0) + increment;
      changed = true;
    }
    return changed ? { ...old, views } : old;
  });
}

export function invalidateMangaRealtimeQueries(queryClient: QueryClient) {
  const keys: QueryKey[] = [
    ['manga', 'detail'],
    ['manga', 'home'],
    ['manga', 'list'],
    ['manga', 'homepage'],
    ['manga', 'homepage', 'combined'],
    ['manga', 'featured'],
    ['manga', 'trending'],
    ['manga', 'category'],
    ['manga', 'mangadex'],
    ['manga', 'mangadex-catalog'],
    ['rating'],
    ['history'],
    ['public-profile'],
  ];
  for (const queryKey of keys) {
    queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
  }
}
