import type { Manga, Chapter } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import { normalizeMangaDexId } from '@/lib/mangaLinks';

export type CardChapter = { id: string; chapter_name: string; chapter_title?: string; publish_at?: string;
  source: 'mangadex' | 'truyenqq'; slug: string };
export type CardChapterResult = { chapter: CardChapter | null; pending: boolean;
  state?: 'empty' | 'unavailable' | 'retry'; retry_after?: number };

function nativeChapter(manga: Manga, chapter: Chapter): boolean {
  if (chapter.translationSource === 'local' || chapter.isUserUpload) return true;
  const mdx = normalizeMangaDexId(manga.id);
  return mdx ? Boolean(normalizeMangaDexId(chapter.id)) && chapter.id !== mdx
    : /^qq--.+--[^/]+$/.test(chapter.id);
}

function canHydrateChapter(manga: Manga): boolean {
  if (manga.source === 'uploaded') return false;
  if (normalizeMangaDexId(manga.id) && manga.availableTranslatedLanguages?.length
      && !manga.availableTranslatedLanguages.includes('vi')) return false;
  const languages = (manga.chapters || []).map(chapter => chapter.translatedLanguage).filter(Boolean);
  if (languages.length && !languages.includes('vi') && normalizeMangaDexId(manga.id)) return false;
  return true;
}

export function needsCardChapter(manga: Manga): boolean {
  if (!canHydrateChapter(manga)) return false;
  return !(manga.chapters || []).some(chapter => nativeChapter(manga, chapter)
    && ((Number.isFinite(chapter.number) && chapter.number >= 0)
      || (chapter.number !== -1 && Boolean(chapter.title?.trim())))
    && (Boolean(normalizeMangaDexId(manga.id)) || Number.isFinite(Date.parse(chapter.uploadDate))));
}

export function applyCardChapter(manga: Manga, latest: CardChapter): Manga {
  if (!canHydrateChapter(manga)) return manga;
  const value = String(latest.chapter_name || '').trim();
  const number = value ? Number(value.replace(',', '.')) : Number.NaN;
  const chapter: Chapter = { id: latest.id, mangaId: manga.id,
    number: Number.isFinite(number) ? number : -1,
    title: value ? `Chương ${value}` : (latest.chapter_title || 'Chương đặc biệt'),
    pages: [], uploadDate: latest.publish_at || '', scanlationGroup: '',
    translationSource: latest.source, translatedLanguage: latest.source === 'mangadex' ? 'vi' : undefined };
  const chapters = (manga.chapters || []).filter(old => old.id !== chapter.id && nativeChapter(manga, old));
  return { ...manga, chapters: [chapter, ...chapters], chapterAvailability: undefined };
}

type Waiter = { resolve: (result: CardChapterResult) => void; reject: (error: unknown) => void };
let queued = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  const batch = queued; queued = new Map(); timer = undefined;
  await Promise.all([true, false].map(async mdx => {
    const ids = [...batch.keys()].filter(id => Boolean(normalizeMangaDexId(id)) === mdx);
    for (let offset = 0; offset < ids.length; offset += 48) {
      const group = ids.slice(offset, offset + 48);
      try {
        const response = await mangaApi.getLatestCardChapters(group);
        for (const id of group) {
          const result = response.items[id];
          if (!result) throw new Error('Latest chapter temporarily unavailable');
          batch.get(id)?.forEach(waiter => waiter.resolve(result));
        }
      } catch (error) {
        group.forEach(id => batch.get(id)?.forEach(waiter => waiter.reject(error)));
      }
    }
  }));
}

export function requestCardChapter(identifier: string): Promise<CardChapterResult> {
  const id = identifier.trim().toLowerCase();
  if (id.length > 200 || !/^[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(id)) return Promise.resolve({ chapter: null, pending: false });
  return new Promise((resolve, reject) => {
    queued.set(id, [...(queued.get(id) || []), { resolve, reject }]);
    if (!timer) timer = setTimeout(() => void flush(), 30);
  });
}
