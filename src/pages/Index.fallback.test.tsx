import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi, ratingApi, announcementApi } from '@/lib/api';
import { useSettingsStore } from '@/store/settingsStore';
import Index from './Index';
import HeroSlider from '@/components/manga/HeroSlider';
import { adaptListData } from '@/lib/adapters';

vi.mock('@/store/userStore', () => ({ useUserStore: (select: (state: unknown) => unknown) =>
  select({ isLoggedIn: false, user: null, isRestoringSession: false }) }));
vi.mock('@/hooks/useCardMetadata', () => ({ useCardMetadata: (item: unknown) => item,
  useCanonicalMangaRecords: (items: unknown) => items }));
vi.mock('@/hooks/useCardChapter', () => ({ useCardChapter: (item: unknown) => item }));
vi.mock('@/components/manga/GenreCloud', () => ({ default: () => null }));
vi.mock('framer-motion', async () => {
  const { forwardRef } = await import('react');
  const component = (tag: string) => forwardRef(({ initial, animate, exit, transition, whileInView, viewport, ...props }: any, ref: any) => {
    const Tag = tag as any;
    return <Tag {...props} ref={ref} />;
  });
  return { motion: { div: component('div'), section: component('section'), img: component('img') },
    AnimatePresence: ({ children }: any) => children };
});

const mdxId = 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938';
const row = (slug: string, name: string, extra = {}) => ({ slug, name, title: name,
  thumb_url: `https://qq.example/${slug}.jpg`, source: 'truyenqq', category: [], ...extra });
const qq = row('qq-readable', 'Truyện QQ đang đọc');
const mdx = row(mdxId, 'Truyện MangaDex bảo trì', { source: 'mangadex',
  thumb_url: `https://uploads.mangadex.org/covers/${mdxId}/outage.jpg`, is_featured: true });
const page = (items: unknown[]) => ({ data: { items,
  params: { pagination: { currentPage: 1, totalItemsPerPage: 24, totalItems: items.length } } } });
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSettingsStore.setState(state => ({ settings: { ...state.settings,
    privacy: { ...state.settings.privacy, showMatureContent: false } } }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: any) {}
    observe(target: unknown) { this.callback([{ isIntersecting: true, target }]); }
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue({ latest: page([qq]), ongoing: page([qq]) });
  vi.spyOn(mangaApi, 'getFeatured').mockResolvedValue(page([mdx]));
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockRejectedValue(new Error('MangaDex maintenance'));
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockResolvedValue(page([qq]));
  vi.spyOn(mangaApi, 'getMoeFiltered').mockResolvedValue(page([]));
  vi.spyOn(mangaApi, 'getTrending').mockResolvedValue({ trending: [{ slug: mdxId, title: mdx.name,
    thumb: mdx.thumb_url, views: 100 }] });
  vi.spyOn(ratingApi, 'getTopRatedManga').mockResolvedValue({ items: [{ manga_slug: mdxId, average: 9, count: 1 }] });
  vi.spyOn(ratingApi, 'getBatchRatings').mockResolvedValue({ ratings: {}, my_scores: {} });
  vi.spyOn(mangaApi, 'getCardMetadata').mockResolvedValue({ items: { [mdxId]: {
    id: mdxId, slug: mdxId, title: mdx.name, source: 'mangadex', cover_url: mdx.thumb_url, content_rating: 'safe',
  } } });
  vi.spyOn(mangaApi, 'getMangaDexLatestChapters').mockResolvedValue({ items: {} });
  vi.spyOn(announcementApi, 'getActive').mockResolvedValue({ announcements: [] });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function show() {
  return render(<QueryClientProvider client={client}><MemoryRouter><Index /></MemoryRouter></QueryClientProvider>);
}
function section(title: string) { return screen.getByRole('heading', { name: title }).closest('section')!; }

it('uses QQ for the banner and every home section when MangaDex fails, including stale pinned/rated/trending titles', async () => {
  show();
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  for (const title of ['Mới cập nhật', 'Phổ biến nhất', 'Đánh giá cao', 'Mới thêm gần đây']) {
    await waitFor(() => expect(within(section(title)).getAllByText(qq.name).length).toBeGreaterThan(0));
  }
  await waitFor(() => expect(screen.queryByText(mdx.name)).not.toBeInTheDocument());
  expect(screen.queryByText(/Chưa tải được truyện/)).not.toBeInTheDocument();
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Chi tiết' })).toHaveAttribute('href', '/manga/qq-readable');
});

it('requests QQ independently if the combined home catalog also fails or contains no items', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page([]), ongoing: page([]) });
  show();
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledTimes(1);
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({
    showMature: false, attachRatings: false, page: 1, sort: 'latest',
  }));
});

it('replaces MangaDex cards with QQ when data loads but both cover sources fail', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  expect(await screen.findByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  const image = screen.getAllByRole('img', { name: mdx.name })[0];
  fireEvent.error(image);
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  fireEvent.error(image);
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(mdx.name)).not.toBeInTheDocument());
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
});

it('keeps MangaDex when its fallback image succeeds and does not mistake a QQ image error for a MangaDex outage', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  expect(await screen.findByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  const image = screen.getAllByRole('img', { name: mdx.name })[0];
  fireEvent.error(image);
  fireEvent.load(image);
  const qqImage = screen.getAllByRole('img', { name: qq.name })[0];
  fireEvent.error(qqImage);
  fireEvent.error(qqImage);
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
});

it('preserves mature-content filtering on the independent QQ fallback', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page([]), ongoing: page([]) });
  vi.mocked(mangaApi.getOTruyenFiltered).mockResolvedValue(page([qq, row('qq-adult', 'Truyện người lớn QQ', { content_rating: 'pornographic' })]));
  show();
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  expect(screen.queryByText('Truyện người lớn QQ')).not.toBeInTheDocument();
});

it('keeps a banner visible when the selected MangaDex slide disappears into a smaller QQ selection', () => {
  const items = adaptListData(page(Array.from({ length: 5 }, (_, i) => row('qq-slide-' + i, `Truyện số ${i}`)))).items;
  const { container, rerender } = render(<MemoryRouter><HeroSlider manga={items} /></MemoryRouter>);
  fireEvent.click(container.querySelectorAll('button')[6]);
  expect(screen.getByRole('heading', { name: 'Truyện số 4' })).toBeInTheDocument();
  rerender(<MemoryRouter><HeroSlider manga={adaptListData(page([qq])).items} /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: qq.name })).toBeInTheDocument();
});

it('retains MangaDex ranking entries when the independent homepage feed fails', async () => {
  show();
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  // Let deferred ranking queries run; the old global outage filter dropped these rows.
  await waitFor(() => expect(mangaApi.getTrending).toHaveBeenCalled());
  await waitFor(() => expect(within(section('Phổ biến nhất')).getByText(mdx.name)).toBeInTheDocument());
  await waitFor(() => expect(within(section('Đánh giá cao')).getByText(mdx.name)).toBeInTheDocument());
});

it('does not let one failed MangaDex cover erase other MangaDex rankings', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  const image = (await screen.findAllByRole('img', { name: mdx.name }))[0];
  fireEvent.error(image);
  fireEvent.error(image);
  await waitFor(() => expect(mangaApi.getTrending).toHaveBeenCalled());
  await waitFor(() => expect(within(section('Phổ biến nhất')).getByText(mdx.name)).toBeInTheDocument());
  await waitFor(() => expect(within(section('Đánh giá cao')).getByText(mdx.name)).toBeInTheDocument());
});
