import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi, ratingApi } from '@/lib/api';
import { useMangaStore } from '@/store/mangaStore';
import BrowseManga from './BrowseManga';

vi.mock('@/components/manga/FilterPanel', () => ({ default: () => null }));
vi.mock('@/components/manga/MangaGrid', () => ({ default: ({ manga }: any) =>
  <div data-testid="ranked-cards">{manga.map((item: any) => <span key={item.id} data-cover={item.cover}>{item.title}:{item.views}|</span>)}</div> }));
vi.mock('@/store/userStore', () => ({ useUserStore: (select: (state: any) => unknown) =>
  select({ isLoggedIn: false, user: null, isRestoringSession: false }) }));
const mdx = '66666666-6666-4666-8666-666666666666';
const page = (items: any[]) => ({ data: { items, params: { pagination: {
  currentPage: 1, totalItemsPerPage: 24, totalItems: items.length,
} } } });
let client: QueryClient;
beforeEach(() => {
  useMangaStore.getState().resetFilters();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(mangaApi, 'getCategories').mockResolvedValue({ data: { items: [] } });
  vi.spyOn(mangaApi, 'getList').mockResolvedValue(page([]));
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockResolvedValue(page([]));
  vi.spyOn(mangaApi, 'searchMangaDex').mockResolvedValue(page([]));
  vi.spyOn(mangaApi, 'getMangaDexLatestFeed').mockResolvedValue(page([]));
  vi.spyOn(mangaApi, 'getMangaDexViCatalog').mockResolvedValue({ mangas: [] });
  vi.spyOn(mangaApi, 'getMangaDexLatestChapters').mockResolvedValue({ items: {} });
  vi.spyOn(ratingApi, 'getTopRatedManga').mockResolvedValue({ items: [] });
  vi.spyOn(ratingApi, 'getBatchRatings').mockResolvedValue({ ratings: {}, my_scores: {} });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });
function show(url: string) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><BrowseManga /></MemoryRouter></QueryClientProvider>);
}

it('sorts QQ popularity by the displayed local views rather than the source page order', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([
    { slug: 'low-1', name: 'Low views', source: 'truyenqq', local_view_count: 2, view_count: 2, thumb_url: '/api/manga/truyenqq/cover/low-1' },
    { slug: 'high-2', name: 'High views', source: 'truyenqq', local_view_count: 90, view_count: 90, thumb_url: '/api/manga/truyenqq/cover/high-2' },
  ]));
  show('/manga?source=truyenqq&sort=popular');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('High views:90|Low views:2|'));
});

it('resolves rated MangaDex covers in a metadata batch without fetching individual details', async () => {
  const cover = `https://uploads.mangadex.org/covers/${mdx}/fast.jpg.256.jpg`;
  vi.mocked(ratingApi.getTopRatedManga).mockResolvedValue({ items: [{ manga_slug: mdx, average: 5, count: 2 }] });
  const batch = vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { [mdx]: {
    id: mdx, slug: mdx, title: 'Rated MangaDex', source: 'mangadex', cover_url: cover, content_rating: 'safe',
  } } });
  const detail = vi.spyOn(mangaApi, 'getMangaDexDetail');
  show('/manga?source=mangadex&sort=rating');
  await screen.findByText('Rated MangaDex:0|');
  expect(screen.getByText('Rated MangaDex:0|')).toHaveAttribute('data-cover', cover);
  expect(batch).toHaveBeenCalledWith([mdx]);
  expect(detail).not.toHaveBeenCalled();
});

it('keeps QQ popularity visible while a legacy alias is still being resolved', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue({ data: {
    ...page([{ slug: 'ready-1', name: 'Verified QQ', source: 'truyenqq', local_view_count: 50 }]).data,
    ranking_pending: true,
  } });
  show('/manga?source=truyenqq&sort=popular');
  await screen.findByText('Verified QQ:50|');
  expect(screen.getByRole('status')).toHaveTextContent('Đang cập nhật xếp hạng lượt xem');
  expect(screen.getByRole('status').querySelector('.animate-spin')).toBeNull();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('uses the Vietnamese chapter feed for latest browsing without narrow filters', async () => {
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockResolvedValue(page([
    { id: mdx, slug: mdx, name: 'Recent Vietnamese release', source: 'mangadex',
      chaptersLatest: [{ id: '11111111-1111-4111-8111-111111111111', chapter_name: '1', publish_at: '2026-10-22T12:00:00Z' }] },
  ]));
  show('/manga?source=mangadex&sort=latest');
  await screen.findByText('Recent Vietnamese release:0|');
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalled();
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
});

it('reorders latest results when hydrated chapter dates change, using the displayed chapter date', async () => {
  const second = '77777777-7777-4777-8777-777777777777';
  vi.mocked(mangaApi.searchMangaDex).mockResolvedValue(page([
    { id: mdx, slug: mdx, name: 'One day old', source: 'mangadex',
      chaptersLatest: [{ chapter_name: '1', publish_at: '2026-10-21T12:00:00Z' }] },
    { id: second, slug: second, name: 'Just published', source: 'mangadex',
      chaptersLatest: [{ chapter_name: '1', publish_at: '2026-10-20T12:00:00Z' }] },
  ]));
  vi.mocked(mangaApi.getMangaDexLatestChapters).mockResolvedValue({ items: {
    [second]: { id: '22222222-2222-4222-8222-222222222222', chapter_name: '2', publish_at: '2026-10-22T12:00:00Z' },
  } });
  show('/manga?source=mangadex&sort=latest&status=ongoing');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Just published:0|One day old:0|'));
});
