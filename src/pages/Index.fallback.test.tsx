import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

it.each(['truyenqq', 'mangadex'] as const)('does not show an early hero or cards while %s is still loading', async source => {
  let finish!: (value: any) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  if (source === 'truyenqq') vi.mocked(mangaApi.getHomepage).mockReturnValue(pending);
  else vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(pending);
  show();
  await waitFor(() => expect(mangaApi.getFeatured).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('heading', { level: 2, name: mdx.name })).not.toBeInTheDocument();
  expect(within(section('Mới cập nhật')).queryByText(qq.name)).not.toBeInTheDocument();
  // Ranking is independent primary data, so it can start while catalogs wait.
  expect(mangaApi.getTrending).toHaveBeenCalledTimes(1);
  await act(async () => finish(source === 'truyenqq' ? { latest: page([qq]), ongoing: page([qq]) } : page([mdx])));
  await waitFor(() => expect(screen.getAllByText(mdx.name).length).toBeGreaterThan(0));
  expect(screen.getAllByText(qq.name).length).toBeGreaterThan(0);
});

it('uses QQ for the banner when the MangaDex home feed fails while retaining the independent ranking', async () => {
  show();
  expect(await screen.findByRole('heading', { level: 2, name: qq.name })).toBeInTheDocument();
  for (const title of ['Đánh giá cao']) {
    await waitFor(() => expect(within(section(title)).getAllByText(qq.name).length).toBeGreaterThan(0));
  }
  expect(within(section('Mới cập nhật')).queryByText(qq.name)).not.toBeInTheDocument();
  expect(within(section('Mới cập nhật')).getByRole('button', { name: 'Thử lại mục mới cập nhật' })).toBeInTheDocument();
  expect(within(section('Phổ biến nhất')).getByText(mdx.name)).toBeInTheDocument();
  expect(screen.queryByText(/Chưa tải được truyện/)).not.toBeInTheDocument();
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Chi tiết' })).toHaveAttribute('href', '/manga/qq-readable');
});

it('starts ranking alongside the home catalogs and never flashes catalog fallbacks while waiting', async () => {
  let finish!: (value: any) => void;
  const ranking = new Promise(resolve => { finish = resolve; });
  vi.mocked(mangaApi.getTrending).mockReturnValue(ranking);
  show();
  expect(mangaApi.getTrending).toHaveBeenCalledTimes(1);
  await screen.findByRole('heading', { level: 2, name: qq.name });
  const popular = section('Phổ biến nhất');
  expect(within(popular).queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  expect(within(popular).queryByText(qq.name)).not.toBeInTheDocument();
  await act(async () => { finish({ trending: [{ slug: 'real-popular-12345', title: 'Đúng bảng xếp hạng',
    thumb: 'https://qq.example/ranked.jpg', views: 999 }] }); });
  await waitFor(() => expect(within(popular).getByRole('heading', { level: 3, name: 'Đúng bảng xếp hạng' })).toBeInTheDocument());
  expect(within(popular).queryByText(qq.name)).not.toBeInTheDocument();
});

it('renders all twelve real popular titles immediately in server tie order without waiting for home sources', async () => {
  vi.mocked(mangaApi.getHomepage).mockReturnValue(new Promise(() => {}));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(new Promise(() => {}));
  const ranked = Array.from({ length: 12 }, (_, n) => ({ slug: `ranked-${n}-12345`, title: `Xếp hạng ${12 - n}`,
    thumb: `https://qq.example/rank-${n}.jpg`, views: 100 }));
  vi.mocked(mangaApi.getTrending).mockResolvedValue({ trending: ranked });
  show();
  const popular = section('Phổ biến nhất');
  await waitFor(() => expect(within(popular).getAllByRole('heading', { level: 3 }).map(node => node.textContent))
    .toEqual(ranked.map(row => row.title)));
  expect(screen.queryByRole('heading', { level: 2, name: qq.name })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 2, name: mdx.name })).not.toBeInTheDocument();
});

it('shows an honest empty ranking instead of filling it with latest titles', async () => {
  vi.mocked(mangaApi.getTrending).mockResolvedValue({ trending: [] });
  show();
  await screen.findByRole('heading', { level: 2, name: qq.name });
  expect(within(section('Phổ biến nhất')).getByText('Chưa có truyện trong bảng xếp hạng.')).toBeInTheDocument();
  expect(within(section('Phổ biến nhất')).queryByText(qq.name)).not.toBeInTheDocument();
});

it('retains the real ranking when a background refresh fails, without catalog substitution', async () => {
  show();
  await waitFor(() => expect(within(section('Phổ biến nhất')).getByText(mdx.name)).toBeInTheDocument());
  vi.mocked(mangaApi.getTrending).mockRejectedValue(new Error('temporary ranking outage'));
  await act(async () => { await client.refetchQueries({ queryKey: ['manga', 'home', 'trending-popular-v4'] }); });
  expect(within(section('Phổ biến nhất')).getByText(mdx.name)).toBeInTheDocument();
  expect(within(section('Phổ biến nhất')).queryByText(qq.name)).not.toBeInTheDocument();
});

it('does not fill latest with another catalog when the homepage contains no items', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page([]), ongoing: page([]) });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  await screen.findByRole('heading', { level: 2, name: mdx.name });
  expect(within(section('Mới cập nhật')).queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
});

it('keeps the MangaDex catalog when one image exhausts both cover sources', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  expect(await screen.findByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  const image = screen.getAllByRole('img', { name: mdx.name })[0];
  fireEvent.error(image);
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  fireEvent.error(image);
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  expect(within(section('Mới cập nhật')).getByRole('heading', { level: 3, name: mdx.name })).toBeInTheDocument();
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

it('preserves mature-content filtering on the complete latest feed', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page([qq, row('qq-adult', 'Truyện người lớn QQ', { content_rating: 'pornographic' })]), ongoing: page([]), meta: { omitted_sections: ['ongoing'] } });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  expect(await within(section('Mới cập nhật')).findByRole('heading', { level: 3, name: qq.name })).toBeInTheDocument();
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

it('orders recent sections by chapter time across sources, without promoting pinned MangaDex titles', async () => {
  const now = Date.now();
  const recent = (item: typeof qq, minutes: number) => ({ ...item, chaptersLatest: [{
    chapter_name: '91', chapter_api_data: item.source === 'mangadex' ? '11111111-1111-4111-8111-111111111111' : 'qq--12285--91',
    publish_at: new Date(now - minutes * 60_000).toISOString(),
  }] });
  const newestQQ = recent(row('newest-qq-12285', 'QQ vừa xong'), 1);
  const nextMDX = recent(row('22222222-2222-4222-8222-222222222222', 'MangaDex mới', { source: 'mangadex' }), 10);
  const nextQQ = recent(row('next-qq-12345', 'QQ sau đó'), 25);
  const oldMDX = recent(mdx, 120);
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page([nextQQ, newestQQ]), ongoing: page([newestQQ]) });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([oldMDX, nextMDX]));
  vi.mocked(mangaApi.getFeatured).mockResolvedValue(page([oldMDX]));
  show();
  for (const title of ['Mới cập nhật', 'Mới thêm gần đây']) {
    await waitFor(() => expect(within(section(title)).getAllByRole('heading', { level: 3 })
      .map(heading => heading.textContent)).toEqual(['QQ vừa xong', 'MangaDex mới', 'QQ sau đó', mdx.name]));
  }
  const newestCard = within(section('Mới cập nhật')).getAllByRole('heading', { level: 3 })[0].closest('a')!;
  expect(within(newestCard).getByText('Chương 91 - Vừa xong')).toBeInTheDocument();
  const columns = section('Mới cập nhật').querySelector('.grid-cols-1.md\\:grid-cols-2')!;
  expect(columns.children).toHaveLength(2); // Preserve the existing two-column UI.
});

it('publishes complete recent sections after QQ recovery without ever showing a partial latest list', async () => {
  let recover!: (value: any) => void;
  const recovery = new Promise(resolve => { recover = resolve; });
  const now = Date.now();
  const recoveredQQ = row('recovered-qq-12285', 'QQ tự phục hồi', { chaptersLatest: [{
    chapter_name: '91', chapter_api_data: 'qq--12285--91', publish_at: new Date(now - 60_000).toISOString(),
  }] });
  vi.mocked(mangaApi.getHomepage).mockRejectedValueOnce(new Error('temporary outage')).mockReturnValueOnce(recovery);
  vi.mocked(mangaApi.getFeatured).mockResolvedValue(page([]));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([{ ...mdx, is_featured: false,
    chaptersLatest: [{ chapter_name: '4', chapter_api_data: '11111111-1111-4111-8111-111111111111',
      publish_at: new Date(now - 120 * 60_000).toISOString() }] }]));
  show();
  await waitFor(() => expect(mangaApi.getHomepage).toHaveBeenCalledTimes(2), { timeout: 4_000 });
  expect(screen.queryByText(recoveredQQ.name)).not.toBeInTheDocument();
  await act(async () => { recover({ latest: page([recoveredQQ]), ongoing: page([recoveredQQ]) }); });
  expect(await screen.findByRole('heading', { level: 2, name: recoveredQQ.name })).toBeInTheDocument();
  for (const title of ['Mới cập nhật', 'Mới thêm gần đây']) {
    await waitFor(() => expect(within(section(title)).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(recoveredQQ.name));
  }
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1);
});

it('keeps previously loaded MangaDex home cards visible when its refresh fails', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  await screen.findByRole('heading', { level: 2, name: mdx.name });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('temporary source failure'));
  await act(async () => { await client.refetchQueries({ queryKey: ['manga', 'homepage'] }); });
  expect(within(section('Mới cập nhật')).getByRole('heading', { level: 3, name: mdx.name })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
});

it('keeps loaded MangaDex cards and retries an empty source refresh', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  await screen.findByRole('heading', { level: 2, name: mdx.name });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([]));
  await act(async () => { await client.refetchQueries({ queryKey: ['manga', 'homepage'] }); });
  expect(screen.getByRole('heading', { level: 2, name: mdx.name })).toBeInTheDocument();
  const state = client.getQueryData<any>(['manga', 'homepage', 'complete-latest-v3', 120, false]);
  expect(state.unavailableSources).toContain('mangadex');
});

it('keeps good QQ sections instead of swapping in a fallback list on refresh failure', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  show();
  await screen.findByRole('heading', { level: 2, name: mdx.name });
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('temporary QQ outage'));
  await act(async () => { await client.refetchQueries({ queryKey: ['manga', 'homepage'] }); });
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  const state = client.getQueryData<any>(['manga', 'homepage', 'complete-latest-v3', 120, false]);
  expect(state.latest.items[0].id).toBe(qq.slug);
  expect(state.unavailableSources).toContain('truyenqq');
});

it('replaces an initially empty error screen with recovered catalogs without pressing Retry', async () => {
  let recover!: (value: any) => void;
  const pending = new Promise(resolve => { recover = resolve; });
  vi.mocked(mangaApi.getHomepage).mockRejectedValueOnce(new Error('temporary outage')).mockReturnValueOnce(pending);
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('temporary outage'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValue(page([mdx]));
  show();
  expect(await screen.findByText('Chưa tải được truyện. Vui lòng thử lại.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeEnabled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Đang thử lại…' })).toBeDisabled(), { timeout: 2_500 });
  await act(async () => { recover({ latest: page([qq]), ongoing: page([qq]) }); });
  await waitFor(() => expect(screen.queryByText('Chưa tải được truyện. Vui lòng thử lại.')).not.toBeInTheDocument());
  expect(within(section('Mới cập nhật')).getByRole('heading', { name: qq.name })).toBeInTheDocument();
  expect(within(section('Mới cập nhật')).getByRole('heading', { name: mdx.name })).toBeInTheDocument();
});


it('hydrates both latest sources with detail counters and ratings without waiting for idle work', async () => {
  vi.stubGlobal('requestIdleCallback', vi.fn(() => 1));
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  vi.mocked(ratingApi.getBatchRatings).mockResolvedValue({
    views: { [mdxId]: 6, 'qq-readable': 90 },
    ratings: { [mdxId]: { average: 4.5, count: 2 }, 'qq-readable': { average: 3.5, count: 4 } },
    my_scores: {},
  });
  show();
  await waitFor(() => {
    const latest = within(section('Mới cập nhật'));
    expect(latest.getByTitle('6 lượt xem')).toBeInTheDocument();
    expect(latest.getByTitle('90 lượt xem')).toBeInTheDocument();
    expect(latest.getByText('4.5')).toBeInTheDocument();
    expect(latest.getByText('3.5')).toBeInTheDocument();
  });
  expect(ratingApi.getBatchRatings).toHaveBeenCalledWith(expect.arrayContaining([mdxId, 'qq-readable']), expect.any(Number), true);
  expect(window.requestIdleCallback).toHaveBeenCalled(); // idle work has not run, but primary stats have
});

it('shows pending counters instead of zero while the home statistics request is in flight', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  vi.mocked(ratingApi.getBatchRatings).mockReturnValue(new Promise(() => {}));
  show();
  await waitFor(() => expect(within(section('Mới cập nhật')).getAllByTitle('Đang tải lượt xem')).toHaveLength(2));
  expect(within(section('Mới cập nhật')).queryByTitle('0 lượt xem')).not.toBeInTheDocument();
});

it('retains real home counters during a failed statistics refresh and adopts recovery without changing titles', async () => {
  client.setDefaultOptions({ queries: { retryDelay: 1 } });
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page([mdx]));
  const stats = (views: number) => ({ views: { [mdxId]: views, 'qq-readable': 90 },
    ratings: { [mdxId]: { average: 4.5, count: 2 }, 'qq-readable': { average: 3.5, count: 4 } } });
  vi.mocked(ratingApi.getBatchRatings).mockResolvedValue(stats(6));
  show();
  await waitFor(() => expect(within(section('Mới cập nhật')).getByTitle('6 lượt xem')).toBeInTheDocument());
  const titles = within(section('Mới cập nhật')).getAllByRole('heading', { level: 3 }).map(node => node.textContent);
  vi.mocked(ratingApi.getBatchRatings).mockRejectedValue(new Error('Temporary stats outage'));
  await act(async () => { await client.invalidateQueries({ queryKey: ['rating', 'batch', 'home'] }); });
  expect(within(section('Mới cập nhật')).getByTitle('6 lượt xem')).toBeInTheDocument();
  expect(within(section('Mới cập nhật')).getByText('4.5')).toBeInTheDocument();
  vi.mocked(ratingApi.getBatchRatings).mockResolvedValue(stats(7));
  await act(async () => { await client.invalidateQueries({ queryKey: ['rating', 'batch', 'home'] }); });
  await waitFor(() => expect(within(section('Mới cập nhật')).getByTitle('7 lượt xem')).toBeInTheDocument());
  expect(within(section('Mới cập nhật')).getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(titles);
});
