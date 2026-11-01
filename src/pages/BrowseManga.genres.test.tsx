import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useMangaStore } from '@/store/mangaStore';
import BrowseManga from './BrowseManga';

vi.mock('@/components/manga/FilterPanel', () => ({ default: () => null }));
vi.mock('@/components/manga/MangaGrid', () => ({ default: () => null }));
vi.mock('@/store/userStore', () => ({ useUserStore: (select: (state: any) => unknown) =>
  select({ isLoggedIn: false, user: null, isRestoringSession: false }) }));
const emptyPage = { status: 'success', data: { items: [], params: {
  pagination: { currentPage: 1, totalItemsPerPage: 24, totalItems: 0 },
} } };
let client: QueryClient;
beforeEach(() => {
  useMangaStore.getState().resetFilters();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(mangaApi, 'getCategories').mockResolvedValue({ data: { items: [
    { slug: 'action', name: 'Action' }, { slug: 'xuyen-khong', name: 'Xuyên không' },
  ] } });
  vi.spyOn(mangaApi, 'getList').mockResolvedValue(emptyPage);
  vi.spyOn(mangaApi, 'getCategoryManga').mockResolvedValue(emptyPage);
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockResolvedValue(emptyPage);
  vi.spyOn(mangaApi, 'searchMangaDex').mockResolvedValue(emptyPage);
  vi.spyOn(mangaApi, 'getMangaDexLatestFeed').mockResolvedValue(emptyPage);
  vi.spyOn(mangaApi, 'getMangaDexViCatalog').mockResolvedValue({ mangas: [] });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });
function Location() { return <span data-testid="location">{useLocation().search}</span>; }
function show(url: string) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}>
    <BrowseManga /><Location />
  </MemoryRouter></QueryClientProvider>);
}

it('offers a quiet unsupported-genre state without issuing an invalid QQ request, and switches source with all filters intact', async () => {
  show('/manga?genre=action,villainess&sort=latest&status=ongoing');
  await screen.findByRole('heading', { name: 'Thể loại này chưa có trên TruyenQQ' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(mangaApi.getCategoryManga).not.toHaveBeenCalled();
  expect(mangaApi.getList).not.toHaveBeenCalled();
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Tìm trên MangaDex' }));
  await waitFor(() => expect(mangaApi.searchMangaDex).toHaveBeenCalledWith(expect.objectContaining({
    genreSlugs: ['action', 'villainess'], status: 'ongoing', translatedLanguage: 'vi',
  })));
  expect(screen.getByTestId('location')).toHaveTextContent('source=mangadex');
  expect(screen.queryByRole('heading', { name: 'Thể loại này chưa có trên TruyenQQ' })).not.toBeInTheDocument();
});

it('removes only unsupported genres while retaining supported genres and other filters', async () => {
  show('/manga?genre=action,villainess&sort=latest&status=ongoing');
  fireEvent.click(await screen.findByRole('button', { name: 'Bỏ thể loại không hỗ trợ' }));
  await waitFor(() => expect(useMangaStore.getState().filters.genres).toEqual(['action']));
  expect(useMangaStore.getState().filters).toMatchObject({ status: 'ongoing', sort: 'latest' });
  await waitFor(() => expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({ genreSlugs: ['action'] })));
  expect(screen.queryByRole('heading', { name: 'Thể loại này chưa có trên TruyenQQ' })).not.toBeInTheDocument();
});

it('accepts QQ genre aliases instead of incorrectly marking Isekai unsupported', async () => {
  show('/manga?genre=isekai&sort=latest');
  await waitFor(() => expect(mangaApi.getCategoryManga).toHaveBeenCalledWith('xuyen-khong', 1));
  expect(screen.queryByRole('heading', { name: 'Thể loại này chưa có trên TruyenQQ' })).not.toBeInTheDocument();
});

it('retains a retry for real upstream failures on a supported QQ genre', async () => {
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('Source unavailable'));
  show('/manga?genre=action');
  expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Chưa tải được danh sách truyện từ TruyenQQ');
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Thể loại này chưa có trên TruyenQQ' })).not.toBeInTheDocument();
});
