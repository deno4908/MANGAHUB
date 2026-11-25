import { beforeEach, expect, it, vi, afterEach } from 'vitest';
import { parseQQChapter, formatChapterNumber, mergeReaderChapters, readReaderMetaFromStorage, writeReaderMetaToStorage } from './readerMetadata';

const slug = 'book--special-123';
const id = (number: string | number) => `qq--${slug}--${number}`;
const chapter = (number: number) => ({ id: id(number), number, title: `Chapter ${number}` });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('recovers comic identity and exact decimal/zero chapter from a cold QQ URL', () => {
  expect(parseQQChapter(id('45-5'))).toEqual({ slug, label: '45-5', number: 45.5 });
  expect(parseQQChapter(id('45_5'))?.number).toBe(45.5);
  expect(parseQQChapter(id(0))?.number).toBe(0);
  expect(formatChapterNumber(0)).toBe('0');
  expect(formatChapterNumber(undefined)).toBe('?');
  expect(parseQQChapter(id('oneshot'))).toEqual({ slug, label: 'oneshot', number: undefined });
  for (const value of ['qq--other--1', 'https://example.com/qq--book-1--2', 'qq--book-1--2/3', 'upload-abc']) expect(parseQQChapter(value)).toBeUndefined();
});

it('restores the shared chapter list without navigation state or a per-chapter index', () => {
  writeReaderMetaToStorage([id(1)], { mangaSlug: slug, mangaTitle: 'Book', chapters: [chapter(0), chapter(1), chapter(2)] });
  sessionStorage.clear();
  expect(localStorage.getItem(`reader:chapter-index:${id(2)}`)).toBeNull();
  const restored = readReaderMetaFromStorage([id(2)]);
  expect(restored.mangaTitle).toBe('Book');
  expect(restored.chapters?.map(row => row.number)).toEqual([0, 1, 2]);
  expect(JSON.parse(localStorage.getItem(`reader:chapter-meta:${id(1)}`)!).chapters).toBeUndefined();
});

it('does not let an old usable per-chapter record hide a newer shared next chapter', () => {
  localStorage.setItem(`reader:chapter-meta:${id(1)}`, JSON.stringify({ mangaSlug: slug, chapters: [chapter(0), chapter(1)], savedAt: Date.now() }));
  writeReaderMetaToStorage([id(2)], { mangaSlug: slug, chapters: [chapter(1), chapter(2)] });
  expect(readReaderMetaFromStorage([id(1)]).chapters?.map(row => row.number).sort()).toEqual([0, 1, 2]);
  writeReaderMetaToStorage([id(1)], { mangaSlug: slug, chapters: [] });
  expect(readReaderMetaFromStorage([id(2)]).chapters?.map(row => row.number)).toEqual([1, 2]);
});

it('merges a refreshed list of the same length instead of keeping stale navigation forever', () => {
  const rows = mergeReaderChapters([[chapter(0), chapter(1)], [chapter(1), chapter(2)], [{ id: 'qq--other-456--3', number: 3, title: 'Wrong book' }]], id(1));
  expect(rows.map(row => row.number)).toEqual([0, 1, 2]);
  // Only verified list entries are used; never guess a nonexistent next chapter.
  expect(rows.some(row => row.id === id(3))).toBe(false);
});

it('preserves local translations and deduplicates legacy MangaDex identifiers', () => {
  const upload = { id: 'upload-local-chapter', number: 1, title: 'Local translation', isUserUpload: true };
  expect(mergeReaderChapters([[chapter(1), upload]], id(1))).toEqual([chapter(1), upload]);
  const uuid = '0121587d-69ee-40d7-8488-f2ef66e293ce';
  const fresh = { id: uuid, number: 2, title: 'Fresh' };
  expect(mergeReaderChapters([[{ ...fresh, id: `mdx-${uuid}` }], [fresh]], uuid)).toEqual([fresh]);
});

it('ignores expired/cross-comic metadata and tolerates disabled browser storage', () => {
  localStorage.setItem(`reader:manga-meta:${slug}`, JSON.stringify({ mangaSlug: slug, chapters: [chapter(1)], savedAt: Date.now() - 31 * 86400_000 }));
  localStorage.setItem(`reader:chapter-meta:${id(1)}`, JSON.stringify({ mangaSlug: 'wrong-456', chapters: [{ id: 'qq--wrong-456--1', number: 1 }] }));
  expect(readReaderMetaFromStorage([id(1)])).toEqual({});
  vi.stubGlobal('window', Object.defineProperties({}, {
    localStorage: { get() { throw new DOMException('Denied', 'SecurityError'); } },
    sessionStorage: { get() { throw new DOMException('Denied', 'SecurityError'); } },
  }));
  expect(readReaderMetaFromStorage([id(1)])).toEqual({});
  expect(() => writeReaderMetaToStorage([id(1)], { mangaSlug: slug, chapters: [chapter(1)] })).not.toThrow();
});
