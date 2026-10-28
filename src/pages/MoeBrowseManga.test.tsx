import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import BrowseManga from './BrowseManga';

vi.mock('@/components/manga/MangaGrid', () => ({ default: ({ manga }: any) => <div>{manga.map((row: any) => <p key={row.id}>{row.title}</p>)}</div> }));
const page = (number: number) => ({ data: { items: [{ slug: 'moe-' + number, source: 'moetruyen', name: 'Truyện Mòe ' + number }],
  params: { pagination: { currentPage: number, totalItemsPerPage: 24, totalItems: 70, totalPages: 3 } } } });
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(mangaApi, 'getMoeCategories').mockResolvedValue({ data: { items: [{ name: 'Comedy', slug: 'comedy' }] } });
  vi.spyOn(mangaApi, 'getMoeFiltered').mockImplementation(async options => page(options?.page || 1));
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockRejectedValue(new Error('wrong source'));
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });
function Location() { return <span data-testid="location">{useLocation().search}</span>; }
function show(url: string) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><BrowseManga /><Location /></MemoryRouter></QueryClientProvider>);
}

it('loads a deep Moe page directly, preserves filters and never queries QQ', async () => {
  show('/manga?source=moetruyen&page=3&genre=comedy&sort=alphabetical&status=completed');
  expect(await screen.findByText('Truyện Mòe 3')).toBeInTheDocument();
  expect(mangaApi.getMoeFiltered).toHaveBeenCalledWith(expect.objectContaining({ page: 3, genreSlugs: ['comedy'], sort: 'alphabetical', status: 'completed' }));
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Trang trước' }));
  expect(await screen.findByText('Truyện Mòe 2')).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('page=2');
  expect(screen.getByTestId('location')).toHaveTextContent('genre=comedy');
});

it('resets pagination when filters change and offers all three sources', async () => {
  show('/manga?source=moetruyen&page=3');
  await screen.findByText('Truyện Mòe 3');
  fireEvent.click(screen.getByRole('button', { name: 'Phổ biến' }));
  await waitFor(() => expect(mangaApi.getMoeFiltered).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, sort: 'popular' })));
  expect(screen.getByRole('link', { name: 'TruyenQQ' })).toHaveAttribute('href', '/manga');
  expect(screen.getByRole('link', { name: 'MangaDex' })).toHaveAttribute('href', '/manga?source=mangadex');
  expect(screen.getByRole('link', { name: 'Mòe Truyện' })).toHaveAttribute('aria-current', 'page');
});
