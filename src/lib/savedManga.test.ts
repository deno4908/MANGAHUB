import { expect, it } from 'vitest';
import { getSavedMangaDetailPath, needsSavedCover, resolveSavedMangaCover, savedMangaLookupId } from './savedManga';
import { toOTruyenRouteId } from './mangaLinks';
const mdx = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
const objectId = '65b1234567890abcdef12345';

it('uses the manga identifier rather than a bookmark or follow row UUID', () => {
  expect(getSavedMangaDetailPath({ id: mdx, manga_slug: 'old-book' })).toBe('/manga/old-book');
  expect(getSavedMangaDetailPath({ id: 'row', manga_slug: `mdx-${mdx}` })).toBe(`/manga/${mdx}`);
  expect(getSavedMangaDetailPath({ id: 'row', manga_slug: `mangadex:${mdx}` })).toBe(`/manga/${mdx}`);
  expect(resolveSavedMangaCover(`mangadex:${mdx}`, `/api/manga/mangadex-cover/${mdx}`).primary).toContain(`/api/manga/mangadex-cover/${mdx}`);
  expect(getSavedMangaDetailPath({ manga_slug: objectId, manga_source_slug: 'matched-book-123' })).toBe('/manga/matched-book-123');
});

it('recovers Mongo and encoded OTruyen IDs only from a usable stored title', () => {
  for (const id of [objectId, toOTruyenRouteId(objectId)]) {
    expect(savedMangaLookupId({ manga_slug: id, manga_title: 'Đảo Hải Tặc' })).toBe('dao-hai-tac');
    expect(savedMangaLookupId({ manga_slug: id, manga_title: 'Chưa có tiêu đề' })).toBe('');
    expect(savedMangaLookupId({ manga_slug: id, manga_title: objectId })).toBe('');
  }
  expect(savedMangaLookupId({ manga_slug: `mdx-${mdx}` })).toBe(mdx);
});

it('replaces old CDN filenames, old proxies and placeholders with current source cover endpoints', () => {
  expect(resolveSavedMangaCover('', '')).toEqual({ primary: '/no-cover.svg', fallback: '/no-cover.svg' });
  for (const value of ['', '/no-cover.svg', 'old-thumb.jpg', '/uploads/comics/old.jpg',
    'https://img.otruyenapi.com/uploads/comics/old.jpg',
    'https://old.example/api/images/img?url=https%3A%2F%2Fimg.otruyenapi.com%2Fuploads%2Fcomics%2Fold.jpg']) {
    expect(needsSavedCover(value)).toBe(true);
    expect(resolveSavedMangaCover('book-123', value).primary).toContain('/api/manga/truyenqq/cover/book-123');
  }
  expect(resolveSavedMangaCover(`mdx-${mdx}`, `/api/manga/truyenqq/cover/mdx-${mdx}`).primary).toContain(`/api/manga/mangadex-cover/${mdx}`);
});

it('lets expired MangaDex cover filenames fall back to the current cover by manga ID', () => {
  const url = `https://uploads.mangadex.org/covers/${mdx}/outdated.jpg.256.jpg`;
  const cover = resolveSavedMangaCover(mdx, `https://old-backend.example/api/images/img?url=${encodeURIComponent(url)}`);
  expect(cover.primary).toBe(url);
  expect(cover.fallback).toContain(`/api/manga/mangadex-cover/${mdx}`);
  expect(resolveSavedMangaCover('local-book', 'https://own.supabase.co/storage/v1/object/public/covers/own.jpg').primary)
    .toContain('https://own.supabase.co/storage/');
});
