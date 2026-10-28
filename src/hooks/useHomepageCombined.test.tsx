import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useHomepageCombined } from './useApi';

const mdxId = 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938';
const page = (name: string, source = 'truyenqq') => ({ data: {
  items: [{ slug: source === 'mangadex' ? mdxId : 'book-123', name, source }],
  params: { pagination: { currentPage: 1, totalItemsPerPage: 1, totalItems: 1 } },
} });
const home = (name: string) => ({ latest: page(name), ongoing: page(name) });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue(home('QQ old'));
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockResolvedValue(page('MangaDex old', 'mangadex'));
  vi.spyOn(mangaApi, 'getFeatured').mockResolvedValue(page('Featured'));
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockResolvedValue(page('QQ fallback'));
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
const wrapper = ({ children }: { children: React.ReactNode }) =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>;

it.each(['truyenqq', 'mangadex'] as const)('waits for %s before publishing either source', async source => {
  const pending = deferred();
  if (source === 'truyenqq') vi.mocked(mangaApi.getHomepage).mockReturnValue(pending.promise);
  else vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(pending.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.isLoading).toBe(true);
  expect(result.current.data).toBeUndefined();
  await act(async () => pending.resolve(source === 'truyenqq' ? home('QQ old') : page('MangaDex old', 'mangadex')));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
});

it('publishes both catalogs without waiting for slow featured-title lookups', async () => {
  const pending = deferred();
  vi.mocked(mangaApi.getFeatured).mockReturnValue(pending.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  expect(result.current.data?.featured).toBeUndefined();
  await act(async () => pending.resolve(page('Featured')));
  await waitFor(() => expect(result.current.data?.featured?.items[0].title).toBe('Featured'));
});

it('keeps the previous complete snapshot until both refetched catalogs settle', async () => {
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const pending = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(pending.promise);
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page('MangaDex new', 'mangadex'));
  act(() => { void result.current.refetch(); });
  await waitFor(() => expect(result.current.isFetching).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  await act(async () => pending.resolve(home('QQ new')));
  await waitFor(() => expect(result.current.data?.latest.items[0].title).toBe('QQ new'));
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex new');
});

it('includes the QQ fallback in the same snapshot and preserves the mature-content setting', async () => {
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('homepage unavailable'));
  const { result } = renderHook(() => useHomepageCombined(120, true), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ fallback');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledWith(expect.objectContaining({
    showMature: true, page: 1, sort: 'latest', timeoutMs: 2_000,
  }));
});

it('retains QQ when MangaDex fails and reports which source is unavailable', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('maintenance'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.unavailableSources).toEqual(['mangadex']);
});

it('requests QQ when a cached homepage contains only MangaDex cards', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page('MDX cache', 'mangadex'), ongoing: page('MDX cache', 'mangadex') });
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mangaApi.getOTruyenFiltered).toHaveBeenCalledTimes(1);
  expect(result.current.data?.latest.items[0].title).toBe('QQ fallback');
});

it.each(['truyenqq', 'mangadex'] as const)('skips slow %s after six seconds and ignores its late response', async source => {
  vi.useFakeTimers();
  const pending = deferred();
  if (source === 'truyenqq') vi.mocked(mangaApi.getHomepage).mockReturnValue(pending.promise);
  else vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(pending.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_999); });
  expect(result.current.data).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  const snapshot = result.current.data;
  expect(snapshot?.unavailableSources).toEqual([source]);
  if (source === 'truyenqq') {
    expect(snapshot?.mangadex.items[0].title).toBe('MangaDex old');
    expect(snapshot?.latest.items).toEqual([]);
    expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(true);
  } else {
    expect(snapshot?.latest.items[0].title).toBe('QQ old');
    expect(snapshot?.mangadex.items).toEqual([]);
    expect(vi.mocked(mangaApi.getMangaDexHomeBanner).mock.calls[0][0]?.signal?.aborted).toBe(true);
  }
  await act(async () => {
    pending.resolve(source === 'truyenqq' ? home('QQ late') : page('MangaDex late', 'mangadex'));
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data).toEqual(snapshot);
});

it('reports an error when neither source nor the QQ fallback is available', async () => {
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('unavailable'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('unavailable'));
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('unavailable'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(1);
});
