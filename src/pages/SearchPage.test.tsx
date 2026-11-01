import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import SearchPage from './SearchPage';

vi.mock('@/hooks/useApi', async original => ({ ...await original<any>(),
  useCategories: () => ({ data: [{ name: 'Action', slug: 'action' }] }),
  useHomepage: () => ({ data: undefined }),
}));
vi.mock('@/components/manga/MangaGrid', () => ({ default: ({ manga }: any) =>
  <div>{manga.map((m: any) => <span data-testid="result" key={m.id}>{m.title}</span>)}</div> }));
vi.mock('framer-motion', () => ({ motion: { div: ({ children }: any) => <div>{children}</div> } }));
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSettingsStore.setState(state => ({ settings: { ...state.settings,
    privacy: { ...state.settings.privacy, showMatureContent: false } } }));
  vi.spyOn(mangaApi, 'search').mockImplementation(async (_q, number = 1) => payload(number));
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
