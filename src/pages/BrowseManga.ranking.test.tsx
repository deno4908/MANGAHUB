import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><BrowseManga /><Location /></MemoryRouter></QueryClientProvider>);
}
function Location() { return <span data-testid="location">{useLocation().search}</span>; }

it('warms only the next QQ page with identical filters and reuses it after clicking', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockImplementation(async options => ({ data: {
    items: [{ slug: `ready-${options.page}`, name: `Page ${options.page}`, source: 'truyenqq',
      local_view_count: 0, thumb_url: '/no-cover.svg' }], params: { pagination: {
        currentPage: options.page, totalItemsPerPage: 42, totalItems: 126, totalPages: 3,
      } },
  } }));
  show('/manga?source=truyenqq&sort=popular');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Page 1'));
  await waitFor(() => expect(vi.mocked(mangaApi.getOTruyenFiltered).mock.calls.some(([arg]) => arg.page === 2)).toBe(true), { timeout: 5000 });
  const calls = vi.mocked(mangaApi.getOTruyenFiltered).mock.calls.map(([arg]) => arg);
  const first = calls.find(arg => arg.page === 1)!;
  expect(calls.filter(arg => arg.page === 2)).toHaveLength(1);
  expect(calls.find(arg => arg.page === 2)).toMatchObject({ ...first, page: 2, signal: expect.any(AbortSignal) });
  expect(calls.some(arg => arg.page === 3)).toBe(false);
  fireEvent.click(screen.getAllByRole('button', { name: 'Trang 2', exact: true })[0]);
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Page 2'));
  expect(vi.mocked(mangaApi.getOTruyenFiltered).mock.calls.filter(([arg]) => arg.page === 2)).toHaveLength(1);
});

it('sorts QQ popularity by the displayed local views rather than the source page order', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([
    { slug: 'low-1', name: 'Low views', source: 'truyenqq', local_view_count: 2, view_count: 2, thumb_url: '/api/manga/truyenqq/cover/low-1' },
    { slug: 'high-2', name: 'High views', source: 'truyenqq', local_view_count: 90, view_count: 90, thumb_url: '/api/manga/truyenqq/cover/high-2' },
  ]));
  show('/manga?source=truyenqq&sort=popular');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('High views:90|Low views:2|'));
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({ limit: 42 }));
});

it('keeps native QQ popularity order for zero-view titles after promoting local views', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([
    { slug: 'qq-first-1', name: 'QQ first', source: 'truyenqq', local_view_count: 0,
      chaptersLatest: [{ chapter_name: '1', publish_at: '2026-01-01T00:00:00Z' }] },
    { slug: 'local-top-2', name: 'Local top', source: 'truyenqq', local_view_count: 90 },
    { slug: 'qq-next-3', name: 'QQ next', source: 'truyenqq', local_view_count: 0,
      chaptersLatest: [{ chapter_name: '2', publish_at: '2026-10-23T00:00:00Z' }] },
  ]));
  show('/manga?source=truyenqq&sort=popular');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Local top:90|QQ first:0|QQ next:0|'));
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

it('stops automatically polling a QQ ranking that cannot finish and offers a manual retry', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue({ data: {
      ...page([{ slug: 'ready-1', name: 'Verified QQ', source: 'truyenqq', local_view_count: 50 }]).data,
      ranking_pending: true,
    } });
    show('/manga?source=truyenqq&sort=popular');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledTimes(3);
    const retry = screen.getByRole('button', { name: 'Thử lại' });
    expect(screen.getByRole('status').querySelector('.animate-spin')).toBeNull();
    fireEvent.click(retry);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
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

it('uses release order with status and genre filters without highest-chapter hydration', async () => {
  const second = '77777777-7777-4777-8777-777777777777';
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockResolvedValue(page([
    { id: second, slug: second, name: 'Just published', source: 'mangadex', status: 'ongoing',
      chaptersLatest: [{ chapter_api_data: '22222222-2222-4222-8222-222222222222', chapter_name: '2', publish_at: '2026-10-22T12:00:00Z' }] },
    { id: mdx, slug: mdx, name: 'One day old', source: 'mangadex', status: 'ongoing',
      chaptersLatest: [{ chapter_api_data: '11111111-1111-4111-8111-111111111111', chapter_name: '9', publish_at: '2026-10-21T12:00:00Z' }] },
  ]));
  vi.mocked(mangaApi.getMangaDexLatestChapters).mockResolvedValue({ items: {
    [second]: { id: '22222222-2222-4222-8222-222222222222', chapter_name: '2', publish_at: '2026-10-22T12:00:00Z' },
  } });
  show('/manga?source=mangadex&sort=latest&status=ongoing&genre=action');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Just published:0|One day old:0|'));
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({
    genreSlugs: ['action'], status: 'ongoing', translatedLanguage: 'vi',
  }));
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
  expect(mangaApi.getMangaDexLatestChapters).not.toHaveBeenCalled();
});

it('keeps release filters, ordering and snapshot on next pages and after remounting', async () => {
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockImplementation(async options => ({ data: {
    items: [{ id: mdx, slug: mdx, name: `Release page ${options.page}`, source: 'mangadex', status: 'ongoing',
      chaptersLatest: [{ chapter_api_data: '22222222-2222-4222-8222-222222222222', chapter_name: '2', publish_at: '2026-10-22T12:00:00Z' }] }],
    feed_snapshot: '12345', params: { pagination: { currentPage: options.page, totalItemsPerPage: 24, totalItems: 96 } },
  } }));
  const filters = '/manga?source=mangadex&sort=latest&status=ongoing&genre=action,romance&lang=en';
  show(filters);
  await screen.findByText('Release page 1:0|');
  fireEvent.click(screen.getAllByRole('button', { name: 'Trang 2', exact: true })[0]);
  await screen.findByText('Release page 2:0|');
  const second = vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.find(([options]) => options.page === 2)![0];
  expect(second).toMatchObject({ genreSlugs: ['action', 'romance'], status: 'ongoing', translatedLanguage: 'en', feedSnapshot: '12345' });
  const url = new URLSearchParams(screen.getByTestId('location').textContent!);
  expect(url.get('sort')).toBe('latest');
  expect(url.get('status')).toBe('ongoing');
  expect(url.get('genre')).toBe('action,romance');
  expect(url.get('lang')).toBe('en');
  expect(url.get('page')).toBe('2');
  cleanup();
  show(filters + '&page=3');
  await screen.findByText('Release page 3:0|');
  expect(vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.find(([options]) => options.page === 3)![0])
    .toMatchObject({ ...second, page: 3, signal: expect.any(AbortSignal) });
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
});
