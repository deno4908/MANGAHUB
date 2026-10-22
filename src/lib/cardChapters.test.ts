import { afterEach, expect, it, vi } from 'vitest';
import type { Manga } from '@/types/manga';
import { mangaApi } from '@/lib/api';
import { applyCardChapter, needsCardChapter, requestCardChapter } from './cardChapters';

const mdx = '16800ea3-d7cb-4a03-801e-bfbb4dc12bea';
const chapter = '22222222-2222-4222-8222-222222222222';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('recognizes missing or obsolete chapters and keeps real source chapters', () => {
  const manga = { id: 'legacy-book', source: 'truyenqq', chapters: [] } as unknown as Manga;
  expect(needsCardChapter(manga)).toBe(true);
  expect(needsCardChapter({ ...manga, chapters: [{ id: 'old-otruyen-object-id', number: 99 }] as any })).toBe(true);
  expect(needsCardChapter({ ...manga, chapters: [{ id: 'qq--book-123--46', number: 46 }] as any })).toBe(true);
  expect(needsCardChapter({ ...manga, chapters: [{ id: 'qq--book-123--46', number: 46,
    uploadDate: '2026-10-23T00:00:00Z' }] as any })).toBe(false);
  expect(needsCardChapter({ ...manga, source: 'uploaded' })).toBe(false);
  expect(needsCardChapter({ ...manga, id: mdx, availableTranslatedLanguages: ['en'] })).toBe(false);
  const english = { ...manga, id: mdx, chapters: [{ id: chapter, number: 44, translatedLanguage: 'en' }] as any };
  expect(needsCardChapter(english)).toBe(false);
  expect(applyCardChapter(english, { id: chapter, slug: mdx, source: 'mangadex', chapter_name: '46' })).toBe(english);
});

it('uses the native QQ chapter instead of a stale OTruyen ID without changing local stats', () => {
  const manga = { id: 'legacy-book', source: 'truyenqq', title: 'Tên truyện', views: 50, rating: 4.5,
    chapters: [{ id: 'old-otruyen-chapter', number: 999 }] } as unknown as Manga;
  const result = applyCardChapter(manga, { id: 'qq--book-123--46', slug: 'book-123', source: 'truyenqq', chapter_name: '46' });
  expect(result.chapters.map(ch => ch.number)).toEqual([46]);
  expect(result.chapters[0].id).toBe('qq--book-123--46');
  expect([result.id, result.title, result.views, result.rating]).toEqual(['legacy-book', 'Tên truyện', 50, 4.5]);
  expect(manga.chapters[0].id).toBe('old-otruyen-chapter');
});

it('handles fractional chapters and zero without inventing a chapter number for specials', () => {
  const manga = { id: mdx, chapters: [] } as unknown as Manga;
  const latest = { id: chapter, slug: mdx, source: 'mangadex' as const, chapter_name: '0' };
  expect(applyCardChapter(manga, latest).chapters[0].number).toBe(0);
  expect(applyCardChapter(manga, { ...latest, chapter_name: '45.5' }).chapters[0].number).toBe(45.5);
  expect(applyCardChapter(manga, { ...latest, chapter_name: '', chapter_title: 'Oneshot' }).chapters[0].title).toBe('Oneshot');
});

it('batches duplicated cards separately for each source', async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(mangaApi, 'getLatestCardChapters').mockImplementation(async ids => ({
    items: Object.fromEntries(ids.map(id => [id, { chapter: null, pending: true }])),
  }));
  const waiting = [requestCardChapter(mdx), requestCardChapter('legacy-book'), requestCardChapter(mdx)];
  await vi.advanceTimersByTimeAsync(35);
  expect(await Promise.all(waiting)).toEqual(Array(3).fill({ chapter: null, pending: true }));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith([mdx]);
  expect(request).toHaveBeenCalledWith(['legacy-book']);
});
