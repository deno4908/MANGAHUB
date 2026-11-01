import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { warmCovers } from '@/lib/coverCache';
import { searchPageOptions } from '@/lib/searchQuery';
import { useSettingsStore } from '@/store/settingsStore';
import SearchPage from './SearchPage';

vi.mock('@/hooks/useApi', async original => ({ ...await original<any>(),
  useCategories: () => ({ data: [{ name: 'Action', slug: 'action' }] }),
  useHomepage: () => ({ data: undefined }),
}));
vi.mock('@/components/manga/MangaGrid', () => ({ default: ({ manga }: any) =>
  <div>{manga.map((m: any) => <span data-testid="result" key={m.id}>{m.title}</span>)}</div> }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: any) => <div>{children}</div> } }));
vi.mock('@/lib/coverCache', () => ({ warmCovers: vi.fn(() => () => {}) }));
let client: QueryClient;
const payload = (number: number, count = 24) => ({ data: {
  items: Array.from({ length: count }, (_, n) => ({ slug: `book-${number}-${n}`, name: `Book page ${number} row ${n}`, source: 'truyenqq' })),
  params: { pagination: { totalItems: 2774, totalItemsPerPage: 24, currentPage: number, totalPages: 116 } },
} });
function Location() {
  const location = useLocation(), navigate = useNavigate();
  return <><output data-testid="location">{location.search}</output><button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button></>;
}
function show(url = '/search?q=O') {
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><Location /><SearchPage /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  vi.mocked(warmCovers).mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSettingsStore.setState(state => ({ settings: { ...state.settings,
    privacy: { ...state.settings.privacy, showMatureContent: false } } }));
  vi.spyOn(mangaApi, 'search').mockImplementation(async (_q, number = 1) => payload(number));
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); Reflect.deleteProperty(navigator, 'connection'); });

it('stays on pages two and three beyond the input debounce, with 24 distinct results per page', async () => {
  show();
  await screen.findByText('Book page 1 row 0');
  expect(screen.getAllByTestId('result')).toHaveLength(24);
  fireEvent.click(screen.getByRole('button', { name: 'Trang 2' }));
  await screen.findByText('Book page 2 row 0');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  expect(screen.getByTestId('location')).toHaveTextContent('?q=O&page=2');
  expect(screen.queryByText('Book page 1 row 0')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Trang 3' }));
  await screen.findByText('Book page 3 row 0');
  expect(screen.getAllByTestId('result')).toHaveLength(24);
  expect(mangaApi.search).toHaveBeenLastCalledWith('O', 3, expect.objectContaining({ limit: 24, showMature: false }));
  fireEvent.click(screen.getByText('Back'));
  await screen.findByText('Book page 2 row 0');
  fireEvent.click(screen.getByText('Forward'));
  await screen.findByText('Book page 3 row 0');
  fireEvent.change(screen.getByPlaceholderText(/Nhập tên truyện/), { target: { value: 'unsubmitted text' } });
  fireEvent.click(screen.getByText('Back'));
  await screen.findByText('Book page 2 row 0');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  expect(screen.getByTestId('location')).toHaveTextContent('?q=O&page=2');
});

it('keeps a shared deep link and can jump directly to page 116', async () => {
  show('/search?q=O&page=3');
  await screen.findByText('Book page 3 row 0');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  expect(screen.getByTestId('location')).toHaveTextContent('page=3');
  fireEvent.change(screen.getByRole('textbox', { name: /Đến trang, từ 1/ }), { target: { value: '116' } });
  fireEvent.click(screen.getByRole('button', { name: 'Đến trang' }));
  await screen.findByText('Book page 116 row 0');
  expect(screen.getByTestId('location')).toHaveTextContent('page=116');
});

it('resets the page only when typing a new query and sends genres to the same paginated search', async () => {
  show('/search?q=O&page=3');
  await screen.findByText('Book page 3 row 0');
  fireEvent.change(screen.getByPlaceholderText(/Nhập tên truyện/), { target: { value: 'One Piece' } });
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?q=One+Piece'));
  expect(screen.getByTestId('location')).not.toHaveTextContent('page=');
  await screen.findByText('Book page 1 row 0');
  fireEvent.click(screen.getByText('Action'));
  await waitFor(() => expect(mangaApi.search).toHaveBeenLastCalledWith('One Piece', 1, expect.objectContaining({ genreSlugs: ['action'], limit: 24 })));
});

it('never renders more than 24 cards even with an oversized older server response', async () => {
  vi.mocked(mangaApi.search).mockResolvedValue(payload(1, 44));
  show();
  await screen.findByText('Book page 1 row 0');
  expect(screen.getAllByTestId('result')).toHaveLength(24);
});

it('loads exactly one adjacent page ahead and switches to its cached results without another request', async () => {
  let finish!: (value: any) => void;
  const nextPage = new Promise(resolve => { finish = resolve; });
  vi.mocked(mangaApi.search).mockImplementation(async (_q, number = 1) => number === 2 ? nextPage : payload(number));
  show();
  await screen.findByText('Book page 1 row 0');
  await waitFor(() => expect(mangaApi.search).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Book page 1 row 0')).toBeInTheDocument();
  expect(vi.mocked(mangaApi.search).mock.calls.map(call => call[1])).toEqual([1, 2]);
  await act(async () => { finish(payload(2)); });
  await waitFor(() => expect(client.getQueryData(searchPageOptions('O', 2, [], false).queryKey)).toBeDefined());
  expect(warmCovers).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('book-2-0')]));
  expect(vi.mocked(warmCovers).mock.lastCall?.[0]).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
  // Cached results render in the click itself, without waiting for the API.
  expect(screen.getByText('Book page 2 row 0')).toBeInTheDocument();
  expect(vi.mocked(mangaApi.search).mock.calls.filter(call => call[1] === 2)).toHaveLength(1);
  expect(screen.getAllByTestId('result')).toHaveLength(24);
});

it.each([{ saveData: true, effectiveType: '4g' }, { saveData: false, effectiveType: '2g' }])(
  'does not speculate on constrained connections: %s', async connection => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    show();
    await screen.findByText('Book page 1 row 0');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(mangaApi.search).toHaveBeenCalledTimes(1);
    expect(warmCovers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await screen.findByText('Book page 2 row 0');
  },
);

it('warms an intended distant page with the exact current genre and mature filters', async () => {
  show();
  await screen.findByText('Book page 1 row 0');
  fireEvent.click(screen.getByText('Action'));
  await waitFor(() => expect(mangaApi.search).toHaveBeenCalledWith('O', 1, expect.objectContaining({ genreSlugs: ['action'] })));
  await screen.findByText('Book page 1 row 0');
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'Trang 116' }));
  await waitFor(() => expect(mangaApi.search).toHaveBeenCalledWith('O', 116,
    expect.objectContaining({ limit: 24, genreSlugs: ['action'], showMature: false })));
});

it('cancels the adjacent-page timer as soon as the visitor starts typing a new query', async () => {
  show();
  await screen.findByText('Book page 1 row 0');
  fireEvent.change(screen.getByPlaceholderText(/Nhập tên truyện/), { target: { value: 'Naruto' } });
  await waitFor(() => expect(mangaApi.search).toHaveBeenCalledWith('Naruto', 1, expect.anything()));
  expect(vi.mocked(mangaApi.search).mock.calls.filter(call => call[0] === 'O' && call[1] === 2)).toHaveLength(0);
});

it('refetches a partial speculative response on navigation rather than caching an outage for five minutes', async () => {
  let reads = 0;
  vi.mocked(mangaApi.search).mockImplementation(async (_q, number = 1) => number === 2 && ++reads === 1
    ? { ...payload(2, 2), meta: { unavailable_sources: ['mangadex'] } } : payload(number));
  show();
  await screen.findByText('Book page 1 row 0');
  await waitFor(() => expect(client.getQueryData<any>(searchPageOptions('O', 2, [], false).queryKey)?.unavailableSources).toEqual(['mangadex']));
  expect(warmCovers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
  await screen.findByText('Book page 2 row 23');
  expect(vi.mocked(mangaApi.search).mock.calls.filter(call => call[1] === 2)).toHaveLength(2);
});

it('never publishes old prefetch results after access loss clears the query cache', async () => {
  let finish!: (value: any) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.mocked(mangaApi.search).mockImplementation(async (_q, number = 1) => number === 2 ? pending : payload(number));
  const view = show();
  await screen.findByText('Book page 1 row 0');
  await waitFor(() => expect(mangaApi.search).toHaveBeenCalledTimes(2));
  const signal = vi.mocked(mangaApi.search).mock.calls[1][2]?.signal;
  view.unmount();
  await act(async () => { await client.cancelQueries(); client.removeQueries(); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(payload(2)); });
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(warmCovers).not.toHaveBeenCalled();
});
