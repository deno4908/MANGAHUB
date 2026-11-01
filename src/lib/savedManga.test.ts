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
  expect(new URL(cover.primary).pathname).toBe('/api/images/img');
  expect(new URL(cover.primary).searchParams.get('url')).toBe(url);
  expect(cover.fallback).toContain(`/api/manga/mangadex-cover/${mdx}`);
  expect(resolveSavedMangaCover('local-book', 'https://own.supabase.co/storage/v1/object/public/covers/own.jpg').primary)
    .toContain('https://own.supabase.co/storage/');
});

it('loads direct MangaDex covers through the proxy immediately and keeps proxy URLs stable', () => {
  const source = `https://uploads.mangadex.org/covers/${mdx}/current.jpg.512.jpg`;
  const first = resolveSavedMangaCover(mdx, source);
  const second = resolveSavedMangaCover(mdx, first.primary, first.fallback);
  expect(first.primary).toContain('/api/images/img?url=');
  expect(new URL(first.primary).searchParams.get('url')).toBe(source);
  expect(second).toEqual(first);
  expect(first.fallback).toContain(`/api/manga/mangadex-cover/${mdx}`);
});

it('shares the small cover URL between card rendering and page prefetch while retaining full size by default', () => {
  const source = `https://uploads.mangadex.org/covers/${mdx}/current.png.512.jpg`;
  const small = source.replace('.512.jpg', '.256.jpg');
  const fullCover = resolveSavedMangaCover(mdx, source);
  const card = resolveSavedMangaCover(mdx, fullCover.primary, fullCover.fallback, 256);
  const prefetch = resolveSavedMangaCover(mdx, source, undefined, 256);
  expect(new URL(fullCover.primary).searchParams.get('url')).toBe(source);
  expect(new URL(card.primary).searchParams.get('url')).toBe(small);
  expect(card).toEqual(prefetch);
  expect(resolveSavedMangaCover(mdx, card.primary, card.fallback, 256)).toEqual(card);
});

it('does not resize reader pages or other source images', () => {
  const page = 'https://node.mangadex.network/data/hash/page.512.jpg';
  for (const source of [page]) {
    expect(new URL(resolveSavedMangaCover(mdx, source, undefined, 256).primary).searchParams.get('url')).toBe(source);
  }
  const ownCover = 'https://own.supabase.co/storage/v1/object/public/covers/own.512.jpg';
  expect(resolveSavedMangaCover('own-book', ownCover, undefined, 256).primary).toBe(ownCover);
});

it.each(['original.jpg', 'original.png', 'original.webp', 'original.png.256.jpg', 'original.jpg.512.jpg'])(
  'uses a small thumbnail even for an original saved cover and keeps recovery small: %s', filename => {
    const source = `https://uploads.mangadex.org/covers/${mdx}/${filename}`;
    const result = resolveSavedMangaCover(mdx, source, undefined, 256);
    expect(new URL(result.primary).searchParams.get('url')).toBe(source.replace(/\.(?:256|512)\.jpg$/, '') + '.256.jpg');
    expect(new URL(result.fallback).searchParams.get('size')).toBe('256');
    expect(resolveSavedMangaCover(mdx, result.primary, result.fallback, 256)).toEqual(result);
    expect(resolveSavedMangaCover(mdx, '', undefined, 256).primary).toContain('?size=256');
    expect(new URL(resolveSavedMangaCover(mdx, source).primary).searchParams.get('url')).toBe(source);
  },
);
