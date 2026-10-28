import { expect, it } from 'vitest';
import { adaptListData, adaptMangaDetail, adaptChapterPages, thumbUrl } from './adapters';
import { getMangaDetailPath, getMangaSource, normalizeMoeId } from './mangaLinks';
import { isLegacyQQIdentifier } from './cardMetadata';
import { needsCardChapter } from './cardChapters';
import { resolveSavedMangaCover } from './savedManga';

const chapter = { chapter_name: '9.5', chapter_title: 'Ngoại truyện', chapter_api_data: 'moe--1048--9.5',
  publish_at: '2026-10-01T10:00:00Z', translation_source: 'moetruyen', scanlation_group: 'Team Mòe' };
const item = { id: 'moe-1048', slug: 'moe-1048', source: 'moetruyen', name: 'Bữa cơm làm hòa',
  cover_url: '/api/manga/moetruyen/cover/moe-1048', status: 'ongoing', category: [{ name: 'Comedy', slug: 'comedy' }],
  chaptersLatest: [chapter], chapters: [{ server_name: 'Mòe Truyện', server_data: [chapter] }] };

it('keeps the Moe source on cards, details and saved covers without QQ matching', () => {
  const list = adaptListData({ data: { items: [item] } }).items[0];
  const detail = adaptMangaDetail({ data: { item } });
  expect(list.source).toBe('moetruyen');
  expect(detail.source).toBe('moetruyen');
  expect(detail.id).toBe('moe-1048');
  expect(getMangaSource(detail.id)).toBe('moetruyen');
  expect(getMangaDetailPath(detail.id)).toBe('/manga/moe-1048');
  expect(normalizeMoeId('moe-1048-old-title')).toBe('moe-1048');
  expect(isLegacyQQIdentifier(detail.id)).toBe(false);
  expect(thumbUrl('', detail.id)).toContain('/moetruyen/cover/moe-1048');
  expect(resolveSavedMangaCover(detail.id).primary).toContain('/moetruyen/cover/');
  expect(needsCardChapter(list)).toBe(false);
  expect(detail.chapters[0]).toMatchObject({ id: 'moe--1048--9.5', number: 9.5,
    translationSource: 'moetruyen', scanlationGroup: 'Team Mòe' });
});

it('adapts IMGX proxy pages and direct images in their source order', () => {
  const pages = adaptChapterPages({ data: { domain_cdn: '', item: { chapter_image: [
    { image_page: 0, image_file: '/api/manga/moetruyen/image/moe-1048/9.5/0' },
    { image_page: 1, image_file: 'https://u.truyen.moe/direct.jpg' },
  ] } } });
  expect(pages[0]).toContain('/api/manga/moetruyen/image/moe-1048/9.5/0');
  expect(pages[1]).toBe('https://u.truyen.moe/direct.jpg');
});

it('does not manufacture a current chapter date when source cards omit it', () => {
  const card = adaptListData({ data: { items: [{ ...item, chaptersLatest: [] }] } }).items[0];
  expect(card.lastUpdated).toBe('');
  expect(card.chapters).toEqual([]);
});
