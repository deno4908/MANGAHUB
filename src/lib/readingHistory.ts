import type { QueryClient } from '@tanstack/react-query';
import { normalizeMangaDexId, normalizeOTruyenObjectId } from './mangaLinks';

export type ReadingHistory = {
  manga_slug: string; manga_source_slug?: string; manga_title?: string; manga_thumb?: string;
  chapter_id: string; chapter_name?: string; page: number; progress: number;
  client_read_at?: string; read_at?: string; created_at?: string;
  scrollY?: number; pageOffset?: number; synced?: boolean;
};

export function historyIdentity(value: unknown): string {
  const id = String(value || '').trim().toLowerCase();
  return normalizeMangaDexId(id) || normalizeOTruyenObjectId(id) || id;
}

export function historyMatches(row: ReadingHistory, identifiers: string[]): boolean {
  const keys = new Set(identifiers.map(historyIdentity).filter(Boolean));
  return [row.manga_slug, row.manga_source_slug].some(value => keys.has(historyIdentity(value)));
}

export function historyTime(row?: ReadingHistory | null): number {
  return Date.parse(row?.client_read_at || row?.read_at || row?.created_at || '') || 0;
}

export function latestReadingHistory(rows: ReadingHistory[], identifiers: string[]): ReadingHistory | null {
  return rows.filter(row => historyMatches(row, identifiers))
    .reduce<ReadingHistory | null>((latest, row) => !latest || historyTime(row) > historyTime(latest) ? row : latest, null);
}

export function upsertReadingHistory(client: QueryClient, entry: ReadingHistory, viewer: string) {
  const aliases = [entry.manga_slug, entry.manga_source_slug || ''];
  for (const query of client.getQueryCache().findAll({ queryKey: ['history'] })) {
    if (query.queryKey[1] === 'manga') {
      if (query.queryKey[2] !== viewer) continue;
      const identifiers = query.queryKey[3] as string[];
      if (!historyMatches(entry, identifiers)) continue;
      client.setQueryData(query.queryKey, (old: ReadingHistory | null | undefined) =>
        historyTime(old) > historyTime(entry) ? old : entry);
    } else if (Array.isArray(query.state.data)) {
      client.setQueryData(query.queryKey, (old: ReadingHistory[]) => {
        const previous = latestReadingHistory(old, aliases);
        if (historyTime(previous) > historyTime(entry)) return old;
        return [entry, ...old.filter(row => !historyMatches(row, aliases))];
      });
    }
  }
}

export function removeReadingHistoryCache(client: QueryClient, viewer: string, identifiers?: string[]) {
  for (const query of client.getQueryCache().findAll({ queryKey: ['history'] })) {
    if (query.queryKey[1] === 'manga') {
      if (query.queryKey[2] !== viewer) continue;
      const row = query.state.data as ReadingHistory | null;
      if (!identifiers || (row && historyMatches(row, identifiers))) client.setQueryData(query.queryKey, null);
    } else if (Array.isArray(query.state.data)) {
      client.setQueryData(query.queryKey, (rows: ReadingHistory[]) => identifiers ? rows.filter(row => !historyMatches(row, identifiers)) : []);
    }
  }
}

export function historyChapterNumber(value: unknown): number | undefined {
  const text = String(value ?? '').replace(',', '.');
  const match = text.match(/(?:ch(?:apter)?|chương|chuong|chap)\s*[:.#-]?\s*(\d+(?:\.\d+)?)/i)
    || text.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  return match ? Number(match[1]) : undefined;
}

export function resolveResumeChapter<T extends { id: string; number: number; title?: string }>(
  history: ReadingHistory | null | undefined, chapters: T[], mangaSlug: string,
): T | { id: string; number: number; title: string } | undefined {
  if (!history?.chapter_id) return undefined;
  const chapterKey = historyIdentity(history.chapter_id);
  const exact = chapters.find(chapter => historyIdentity(chapter.id) === chapterKey);
  if (exact) return exact;
  const number = historyChapterNumber(history.chapter_name);
  // A saved MDX chapter may be outside the initial, short detail response.
  // Its stable ID can open directly while the full chapter list loads.
  const mdxId = normalizeMangaDexId(history.chapter_id);
  if (mdxId || history.chapter_id.startsWith(`qq--${mangaSlug}--`)) {
    return { id: mdxId || history.chapter_id, number: number ?? 0, title: history.chapter_name || '' };
  }
  // Only migrate a retired chapter ID within an already matched manga. Never
  // guess another manga from a similar title or strip QQ numeric comic IDs.
  return number === undefined ? undefined : chapters.find(chapter => chapter.number === number);
}
