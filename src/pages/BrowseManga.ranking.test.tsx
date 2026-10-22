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
