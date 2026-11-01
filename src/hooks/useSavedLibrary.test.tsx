import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { bookmarkApi, followApi, historyApi, mangaApi } from '@/lib/api';
import { useBookmarks, useFollows, useHistory } from './useApi';
import { getSavedMangaDetailPath } from '@/lib/savedManga';
vi.mock('@/store/userStore', () => ({ useUserStore: (select: (value: any) => any) =>
  select({ isLoggedIn: true, isRestoringSession: false, user: { id: 'library-reader' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mdx = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
const legacy = 'toi-tro-thanh-nguoi-duoc-nu-phan-dien-yeu-thich-nhat';

it('refreshes stale covers with valid titles across bookmarks, follows and history in shared source batches', async () => {
  const client = new QueryClient();
  const rows = [
    { id: 'row-mdx', manga_slug: `mdx-${mdx}`, manga_title: 'A valid saved title', manga_thumb: `https://uploads.mangadex.org/covers/${mdx}/old.jpg`, chapter_id: 'saved-chapter', progress: 62 },
    { id: mdx, manga_slug: legacy, manga_title: 'Tên truyện đã lưu', manga_thumb: 'https://img.otruyenapi.com/uploads/comics/old.jpg' },
    { id: 'row-object', manga_slug: '65b1234567890abcdef12345', manga_title: 'Đảo Hải Tặc', manga_thumb: 'old-thumb.jpg' },
  ];
  vi.spyOn(bookmarkApi, 'getAll').mockResolvedValue({ bookmarks: rows });
  vi.spyOn(followApi, 'getAll').mockResolvedValue({ follows: rows });
  vi.spyOn(historyApi, 'getAll').mockResolvedValue({ history: rows });
  const metadata: Record<string, any> = {
    [mdx]: { id: mdx, slug: mdx, source: 'mangadex', title: 'Source title', cover_url: `https://uploads.mangadex.org/covers/${mdx}/fresh.jpg` },
    [legacy]: { id: legacy+'-23163', slug: legacy+'-23163', source: 'truyenqq', title: 'Source QQ title', cover_url: `/api/manga/truyenqq/cover/${legacy}-23163` },
    'dao-hai-tac': { id: 'one-piece-1-128', slug: 'one-piece-1-128', source: 'truyenqq', title: 'Đảo Hải Tặc', cover_url: '/api/manga/truyenqq/cover/one-piece-1-128' },
  };
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockImplementation(async ids => ({ items: Object.fromEntries(ids.map(id => [id, metadata[id]])) }));
  const { result } = renderHook(() => [useBookmarks(), useFollows(), useHistory()], {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => {
    for (const query of result.current) {
      expect(decodeURIComponent(query.data?.[0].manga_thumb || '')).toContain('/fresh.jpg');
      expect(query.data?.[1].manga_thumb).toContain(`${legacy}-23163`);
      expect(query.data?.[2].manga_thumb).toContain('one-piece-1-128');
    }
  });
  for (const query of result.current) {
    expect(query.data?.[0]).toMatchObject({ manga_slug: `mdx-${mdx}`, chapter_id: 'saved-chapter', progress: 62, manga_title: 'A valid saved title' });
    expect(getSavedMangaDetailPath(query.data![1])).toBe('/manga/'+legacy);
    expect(getSavedMangaDetailPath(query.data![2])).toBe('/manga/one-piece-1-128');
    expect(query.data?.[0].manga_thumb_fallback).toContain(`/api/manga/mangadex-cover/${mdx}`);
  }
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith(expect.arrayContaining(['dao-hai-tac']), expect.objectContaining({ 'dao-hai-tac': 'Đảo Hải Tặc' }));
  expect(decodeURIComponent(rows[0].manga_thumb)).toContain('/old.jpg');
  expect(rows[2].manga_slug).toBe('65b1234567890abcdef12345');
  client.clear();
});

it('hides unsynchronized OTruyen records on every private library without deleting saved progress', async () => {
  const client = new QueryClient();
  const rows = [
    { manga_slug: 'hundred', manga_title: 'Chưa có tiêu đề', progress: 1, manga_thumb: 'old.jpg' },
    { manga_slug: 'old-otruyen-volume-2', manga_title: 'Old volume', progress: 15, manga_thumb: 'old.jpg' },
    { manga_slug: 'ma-kiem-si', manga_title: 'Ma Kiếm Sĩ - An English Alternative', progress: 81, manga_thumb: 'old.jpg' },
    { manga_slug: '65b1234567890abcdef12345', manga_title: 'Chưa có tiêu đề', progress: 50 },
    { manga_slug: mdx, manga_title: 'A MangaDex title', manga_thumb: 'old.jpg' },
  ];
  vi.spyOn(bookmarkApi, 'getAll').mockResolvedValue({ bookmarks: rows });
  vi.spyOn(followApi, 'getAll').mockResolvedValue({ follows: rows });
  vi.spyOn(historyApi, 'getAll').mockResolvedValue({ history: rows });
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockImplementation(async ids => ({ items:
    Object.fromEntries(ids.map(id => [id, ['hundred', 'old-otruyen-volume-2'].includes(id) ? null : { id: id === mdx ? mdx : 'ma-kiem-si-123',
      slug: id === mdx ? mdx : 'ma-kiem-si-123', source: id === mdx ? 'mangadex' : 'truyenqq', title: 'Source title',
      cover_url: id === mdx ? `https://uploads.mangadex.org/covers/${mdx}/fresh.jpg` : '/api/manga/truyenqq/cover/ma-kiem-si-123' }])) }));
  const { result } = renderHook(() => [useBookmarks(), useFollows(), useHistory()], {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => {
    for (const query of result.current) expect(query.data?.map(row => row.manga_slug)).toEqual(['ma-kiem-si', mdx]);
  });
  expect(request).toHaveBeenCalledWith(expect.arrayContaining(['ma-kiem-si']), { 'ma-kiem-si': 'Ma Kiếm Sĩ' });
  expect(rows).toHaveLength(5);
  expect(rows[0].progress).toBe(1);
  for (const query of result.current) expect(query.data?.[0]).toMatchObject({ progress: 81, manga_slug: 'ma-kiem-si' });
  client.clear();
});

it('rechecks an earlier negative lookup when the saved library supplies a verified title hint', async () => {
  const client = new QueryClient();
  client.setQueryData(['manga', 'card-metadata', 'dao-hai-tac'], null);
  vi.spyOn(bookmarkApi, 'getAll').mockResolvedValue({ bookmarks: [{ manga_slug: 'dao-hai-tac',
    manga_title: 'Đảo Hải Tặc - One Piece', manga_thumb: 'old.jpg' }] });
  const request = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { 'dao-hai-tac': {
    id: 'one-piece-1-128', slug: 'one-piece-1-128', source: 'truyenqq', title: 'One Piece',
    cover_url: '/api/manga/truyenqq/cover/one-piece-1-128',
  } } });
  const { result } = renderHook(() => useBookmarks(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.data?.[0].manga_thumb).toContain('one-piece-1-128'));
  expect(request).toHaveBeenCalledWith(['dao-hai-tac'], { 'dao-hai-tac': 'Đảo Hải Tặc' });
  client.clear();
});
