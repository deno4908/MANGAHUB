import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi, ratingApi } from '@/lib/api';
import { useMangaStore } from '@/store/mangaStore';
import BrowseManga from './BrowseManga';
import { useSettingsStore } from '@/store/settingsStore';

vi.mock('@/components/manga/FilterPanel', () => ({ default: () => null }));
vi.mock('@/components/manga/MangaGrid', () => ({ default: ({ manga }: any) =>
  <div data-testid="ranked-cards">{manga.map((item: any) => <span key={item.id} data-cover={item.cover}>{item.title}:{item.views}|</span>)}</div> }));
const viewer = vi.hoisted(() => ({ loggedIn: false }));
vi.mock('@/store/userStore', () => ({ useUserStore: (select: (state: any) => unknown) =>
  select({ isLoggedIn: viewer.loggedIn, user: viewer.loggedIn ? { id: 'viewer' } : null, isRestoringSession: false }) }));
const mdx = '66666666-6666-4666-8666-666666666666';
const page = (items: any[]) => ({ data: { items, params: { pagination: {
  currentPage: 1, totalItemsPerPage: 24, totalItems: items.length,
} } } });
let client: QueryClient;
beforeEach(() => {
  viewer.loggedIn = false;
  useSettingsStore.setState(state => ({ settings: { ...state.settings,
    privacy: { ...state.settings.privacy, showMatureContent: false } } }));
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
  fireEvent.click(screen.getAllByRole('button', { name: 'Trang 2' })[0]);
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Page 2'));
  expect(vi.mocked(mangaApi.getOTruyenFiltered).mock.calls.filter(([arg]) => arg.page === 2)).toHaveLength(1);
});

it.each([
  { saveData: false, effectiveType: '4g', expectedPages: [1, 2] },
  { saveData: true, effectiveType: '4g', expectedPages: [1] },
  { saveData: false, effectiveType: '2g', expectedPages: [1] },
])('warms the adjacent QQ page within a second while respecting $saveData/$effectiveType', async connection => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'connection');
  Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
  vi.useFakeTimers();
  try {
    vi.mocked(mangaApi.getOTruyenFiltered).mockImplementation(async options => ({ data: {
      items: [{ slug: `ready-${options.page}`, name: `Page ${options.page}`, source: 'truyenqq' }],
      params: { pagination: { currentPage: options.page, totalItemsPerPage: 42, totalItems: 126, totalPages: 3 } },
    } }));
    show('/manga?source=truyenqq&sort=popular');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Page 1');
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(vi.mocked(mangaApi.getOTruyenFiltered).mock.calls.map(([options]) => options.page)).toEqual(connection.expectedPages);
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'connection', descriptor);
    else Reflect.deleteProperty(navigator, 'connection');
    vi.useRealTimers();
  }
});

it('sorts QQ popularity by the displayed local views rather than the source page order', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([
    { slug: 'low-1', name: 'Low views', source: 'truyenqq', local_view_count: 2, view_count: 2, thumb_url: '/api/manga/truyenqq/cover/low-1' },
    { slug: 'high-2', name: 'High views', source: 'truyenqq', local_view_count: 90, view_count: 90, thumb_url: '/api/manga/truyenqq/cover/high-2' },
  ]));
  show('/manga?source=truyenqq&sort=popular');
  await waitFor(() => expect(screen.getByTestId('ranked-cards')).toHaveTextContent('High views:90|Low views:2|'));
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({ limit: 24 }));
});

it.each([false, true])('keeps 24 QQ rating cards and their latest tail in server order when loggedIn=%s', async loggedIn => {
  viewer.loggedIn = loggedIn;
  vi.spyOn(ratingApi, 'getMyRatedManga').mockResolvedValue({ items: [] });
  const rated = { slug: 'rated-1', name: 'Weighted rating first', source: 'truyenqq',
    rating_average: 4.5, rating_count: 20, thumb_url: '/no-cover.svg' };
  const nextRated = { slug: 'rated-2', name: 'Higher average fewer votes', source: 'truyenqq',
    rating_average: 5, rating_count: 1, thumb_url: '/no-cover.svg' };
  const tail = Array.from({ length: 22 }, (_, index) => ({
    slug: `latest-${index + 3}`, name: `Latest ${index + 3}`, source: 'truyenqq',
    thumb_url: '/no-cover.svg', rating_average: 0, rating_count: 0,
  }));
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([rated, nextRated, ...tail]));
  show('/manga?source=truyenqq&sort=rating');
  await waitFor(() => expect(screen.getByTestId('ranked-cards').children).toHaveLength(24));
  const cards = screen.getByTestId('ranked-cards');
  expect(cards.children[0]).toHaveTextContent('Weighted rating first');
  expect(cards.children[1]).toHaveTextContent('Higher average fewer votes');
  expect(cards.children[2]).toHaveTextContent('Latest 3');
  expect(cards.children[23]).toHaveTextContent('Latest 24');
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({ sort: 'rating', limit: 24 }));
  expect(ratingApi.getTopRatedManga).not.toHaveBeenCalled();
  expect(mangaApi.getList).not.toHaveBeenCalled();
});

it('keeps an entirely unrated second QQ rating page for a signed-in reader', async () => {
  viewer.loggedIn = true;
  vi.spyOn(ratingApi, 'getMyRatedManga').mockResolvedValue({ items: [] });
  vi.mocked(mangaApi.getOTruyenFiltered).mockImplementation(async options => ({ data: {
    items: Array.from({ length: 24 }, (_, index) => ({
      slug: `tail-${options.page}-${index}`, name: `Page ${options.page} latest ${index + 1}`,
      source: 'truyenqq', thumb_url: '/no-cover.svg', rating_average: 0, rating_count: 0,
    })),
    params: { pagination: { currentPage: options.page, totalItemsPerPage: 24, totalItems: 240, totalPages: 10 } },
  } }));
  show('/manga?source=truyenqq&sort=rating&page=2');
  await waitFor(() => expect(screen.getByTestId('ranked-cards').children).toHaveLength(24));
  expect(screen.getByTestId('ranked-cards').children[0]).toHaveTextContent('Page 2 latest 1');
  expect(screen.getByTestId('ranked-cards').children[23]).toHaveTextContent('Page 2 latest 24');
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({ page: 2, sort: 'rating', limit: 24 }));
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

it('shows a retry for an incomplete QQ rating page instead of treating two rated titles as the whole catalog', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue({ data: {
    ...page([{ slug: 'rated-1', name: 'Cached rated title', source: 'truyenqq' }]).data,
    ranking_pending: true, source_error: { status: 503, code: 'http-403' },
  } });
  show('/manga?source=truyenqq&sort=rating');
  await screen.findByText('Cached rated title:0|');
  expect(screen.getByRole('alert')).toHaveTextContent('Chưa tải đủ danh sách từ TruyenQQ');
  expect(screen.getByRole('button', { name: 'Thử lại danh sách' })).toBeEnabled();
});

it('uses the complete canonical catalog for rating order and receives its covers in the page', async () => {
  const cover = `https://uploads.mangadex.org/covers/${mdx}/fast.jpg.256.jpg`;
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockResolvedValue(page([{
    slug: mdx, name: 'Rated MangaDex', source: 'mangadex', thumb_url: cover,
    content_rating: 'safe', rating_average: 5, rating_count: 2,
  }]));
  const detail = vi.spyOn(mangaApi, 'getMangaDexDetail');
  show('/manga?source=mangadex&sort=rating');
  await screen.findByText('Rated MangaDex:0|');
  expect(screen.getByText('Rated MangaDex:0|')).toHaveAttribute('data-cover', cover);
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({ sort: 'rating' }));
  expect(ratingApi.getTopRatedManga).not.toHaveBeenCalled();
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
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

it('renders 24 distinct Vietnamese titles on a deep indexed page', async () => {
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockImplementation(async options => ({ data: {
    items: Array.from({ length: 24 }, (_, n) => {
      const id = `${String(n + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
      return { id, slug: id, name: `Vietnamese indexed book ${n + 1}`, source: 'mangadex',
        thumb_url: `https://uploads.mangadex.org/covers/${id}/cover.jpg.512.jpg` };
    }),
    feed_snapshot: 'a'.repeat(32), params: { pagination: { currentPage: options.page,
      totalItemsPerPage: 24, totalItems: 6206, unit: 'manga' } },
  } }));
  show('/manga?source=mangadex&sort=latest&page=70');
  await waitFor(() => expect(screen.getByTestId('ranked-cards').textContent?.split('|').filter(Boolean)).toHaveLength(24));
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({ page: 70, translatedLanguage: 'vi' }));
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
});

it('shows index preparation instead of an empty result and retries automatically', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(mangaApi.getMangaDexLatestFeed).mockResolvedValueOnce({ data: { items: [], index_pending: true,
      params: { pagination: { currentPage: 1, totalItemsPerPage: 24, totalItems: 24 } } } })
      .mockResolvedValue(page([{ id: mdx, slug: mdx, name: 'Prepared Vietnamese title', source: 'mangadex' }]));
    show('/manga?source=mangadex&sort=latest');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('Đang chuẩn bị danh sách truyện tiếng Việt…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Prepared Vietnamese title');
  } finally {
    vi.useRealTimers();
  }
});

it('keeps status and genre filters on the Vietnamese release index', async () => {
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

it.each(['latest', 'popular', 'rating', 'alphabetical'])('sends every Vietnamese filter to the same catalog for %s', async sort => {
  viewer.loggedIn = true;
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockImplementation(async options => ({ data: {
    items: Array.from({ length: 24 }, (_, n) => ({ slug: `${String(n + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      name: `Canonical ${n + 1}`, source: 'mangadex', status: 'ongoing', year: 2025,
      rating_average: 4.5, rating_count: 3, thumb_url: '/no-cover.svg', content_rating: 'safe',
      category: [{ name: 'Action', slug: 'action' }] })),
    params: { pagination: { currentPage: options.page, totalItemsPerPage: 24, totalItems: 73 } },
  } }));
  show(`/manga?source=mangadex&sort=${sort}&genres=action&status=ongoing&year=2025&minRating=4`);
  await waitFor(() => expect(screen.getByTestId('ranked-cards').children).toHaveLength(24));
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({
    sort, genreSlugs: ['action'], status: 'ongoing', year: 2025, minRating: 4, translatedLanguage: 'vi',
  }));
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
  expect(mangaApi.getMangaDexViCatalog).not.toHaveBeenCalled();
  expect(ratingApi.getTopRatedManga).not.toHaveBeenCalled();
});

it('keeps all 24 unrated titles in rating order for a signed-in reader', async () => {
  viewer.loggedIn = true;
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockResolvedValue(page(Array.from({ length: 24 }, (_, n) => ({
    slug: `${String(n + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `Unrated ${n + 1}`,
    source: 'mangadex', rating_average: 0, rating_count: 0, thumb_url: '/no-cover.svg', content_rating: 'safe',
  }))));
  show('/manga?source=mangadex&sort=rating');
  await waitFor(() => expect(screen.getByTestId('ranked-cards').children).toHaveLength(24));
  expect(mangaApi.searchMangaDex).not.toHaveBeenCalled();
  expect(ratingApi.getTopRatedManga).not.toHaveBeenCalled();
});

it('warms the next MangaDex page with identical filters and reuses it immediately after clicking', async () => {
  vi.mocked(mangaApi.getMangaDexLatestFeed).mockImplementation(async options => ({ data: {
    items: [{ slug: mdx, name: `Fast page ${options.page}`, source: 'mangadex', status: 'ongoing',
      year: 2025, rating_average: 4.5, rating_count: 2, thumb_url: '/no-cover.svg' }],
    feed_snapshot: 'b'.repeat(32), params: { pagination: { currentPage: options.page, totalItemsPerPage: 24, totalItems: 72 } },
  } }));
  show('/manga?source=mangadex&sort=popular&genre=action&status=ongoing&year=2025&minRating=4');
  await screen.findByText('Fast page 1:0|');
  await waitFor(() => expect(vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.some(([arg]) => arg.page === 2)).toBe(true));
  const first = vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.find(([arg]) => arg.page === 1)![0];
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({
    ...first, page: 2, feedSnapshot: 'b'.repeat(32), signal: expect.any(AbortSignal),
  }));
  expect(vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.some(([arg]) => arg.page === 3)).toBe(false);
  fireEvent.click(screen.getAllByRole('button', { name: 'Trang 2' })[0]);
  expect(screen.getByTestId('ranked-cards')).toHaveTextContent('Fast page 2');
  expect(vi.mocked(mangaApi.getMangaDexLatestFeed).mock.calls.filter(([arg]) => arg.page === 2)).toHaveLength(1);
});

it('removes a hidden Mature tag from the URL without losing the other filters', async () => {
  show('/manga?source=mangadex&genre=action,sexual-violence&sort=latest&status=ongoing');
  await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('sexual-violence'));
  expect(mangaApi.getMangaDexLatestFeed).toHaveBeenCalledWith(expect.objectContaining({
    genreSlugs: ['action'], status: 'ongoing', sort: 'latest', showMature: false,
  }));
});

it('keeps source filters and ordering on direct next pages and after remounting', async () => {
  vi.mocked(mangaApi.searchMangaDex).mockImplementation(async options => ({ data: {
    items: [{ id: mdx, slug: mdx, name: `Release page ${options.page}`, source: 'mangadex', status: 'ongoing',
      chaptersLatest: [{ chapter_api_data: '22222222-2222-4222-8222-222222222222', chapter_name: '2', publish_at: '2026-10-22T12:00:00Z' }] }],
    feed_snapshot: '12345', params: { pagination: { currentPage: options.page, totalItemsPerPage: 24, totalItems: 96 } },
  } }));
  const filters = '/manga?source=mangadex&sort=latest&status=ongoing&genre=action,romance&lang=en';
  show(filters);
  await screen.findByText('Release page 1:0|');
  fireEvent.click(screen.getAllByRole('button', { name: 'Trang 2' })[0]);
  await screen.findByText('Release page 2:0|');
  const second = vi.mocked(mangaApi.searchMangaDex).mock.calls.find(([options]) => options.page === 2)![0];
  expect(second).toMatchObject({ genreSlugs: ['action', 'romance'], status: 'ongoing', translatedLanguage: 'en', sort: 'latest' });
  const url = new URLSearchParams(screen.getByTestId('location').textContent!);
  expect(url.get('sort')).toBe('latest');
  expect(url.get('status')).toBe('ongoing');
  expect(url.get('genre')).toBe('action,romance');
  expect(url.get('lang')).toBe('en');
  expect(url.get('page')).toBe('2');
  cleanup();
  show(filters + '&page=3');
  await screen.findByText('Release page 3:0|');
  expect(vi.mocked(mangaApi.searchMangaDex).mock.calls.find(([options]) => options.page === 3)![0])
    .toMatchObject({ ...second, page: 3, signal: expect.any(AbortSignal) });
  expect(mangaApi.getMangaDexLatestFeed).not.toHaveBeenCalled();
});
