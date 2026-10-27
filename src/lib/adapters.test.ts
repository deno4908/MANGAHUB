import { describe, expect, it } from 'vitest';

import { adaptMangaItem, thumbFallbackUrl, thumbUrl } from '@/lib/adapters';

describe('OTruyen cover fallback', () => {
  it('keeps an unnumbered MangaDex release with its native ID, title and date', () => {
    const chapterId = '22222222-2222-4222-8222-222222222222';
    const item = adaptMangaItem({ source: 'mangadex', slug: '11111111-1111-4111-8111-111111111111', name: 'One shot',
      chaptersLatest: [{ chapter_name: '', chapter_title: 'One shot', chapter_api_data: chapterId, publish_at: '2026-10-27T00:00:00Z' }] });
    expect(item.chapters[0]).toMatchObject({ id: chapterId, number: -1, title: 'One shot',
      uploadDate: '2026-10-27T00:00:00Z', translationSource: 'mangadex' });
  });
  it('shows only local views for QQ, including legacy source payloads', () => {
    const source = { id: 'book-123', slug: 'book-123', source: 'truyenqq', name: 'Book', view_count: 90000000 };
    expect(adaptMangaItem(source).views).toBe(0);
    expect(adaptMangaItem({ ...source, local_view_count: 7 }).views).toBe(7);
  });
  it('uses the backend image proxy for the canonical CDN cover URL', () => {
    const slug = 'yeu-than-ky';
    const thumb = 'yeu-than-ky-thumb.jpg';
    const direct = thumbUrl(thumb, slug);
    const fallback = thumbFallbackUrl(thumb, slug);
    const parsedFallback = new URL(fallback);

    expect(direct).toBe('https://img.otruyenapi.com/uploads/comics/yeu-than-ky-thumb.jpg');
    expect(parsedFallback.pathname).toBe('/api/images/img');
    expect(parsedFallback.searchParams.get('url')).toBe(direct);
    expect(fallback).not.toContain('/yeu-than-ky/yeu-than-ky-thumb.jpg');
  });

  it('exposes the cached proxy URL on adapted OTruyen manga cards', () => {
    const manga = adaptMangaItem({
      _id: '65b1234567890abcdef12345',
      slug: 'yeu-than-ky',
      name: 'Yêu Thần Ký',
      thumb_url: 'yeu-than-ky-thumb.jpg',
      status: 'ongoing',
    });

    expect(manga.cover).toBe('https://img.otruyenapi.com/uploads/comics/yeu-than-ky-thumb.jpg');
    expect(new URL(String(manga.coverProxy)).searchParams.get('url')).toBe(manga.cover);
  });
});
