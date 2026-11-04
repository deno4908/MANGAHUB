import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useHomepageCombined } from './useApi';
import { setSiteAccessRestricted } from '@/lib/siteAccessState';
import * as covers from '@/lib/coverCache';

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
  vi.spyOn(covers, 'warmCovers').mockReturnValue(() => {});
  setSiteAccessRestricted(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue(home('QQ old'));
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockResolvedValue(page('MangaDex old', 'mangadex'));
  vi.spyOn(mangaApi, 'getFeatured').mockResolvedValue(page('Featured'));
  vi.spyOn(mangaApi, 'getOTruyenFiltered').mockResolvedValue(page('QQ fallback'));
});
afterEach(() => { cleanup(); client.clear(); setSiteAccessRestricted(false); vi.restoreAllMocks(); vi.useRealTimers(); });
const wrapper = ({ children }: { children: React.ReactNode }) =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>;

it('starts fast-source covers before the slower catalog settles without publishing a partial feed', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const pending = deferred();
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(pending.promise);
  const payload = home('QQ ready');
  Object.assign(payload.latest.data.items[0], { thumb_url: '/api/manga/truyenqq/cover/book-123' });
  vi.mocked(mangaApi.getHomepage).mockResolvedValue(payload);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(covers.warmCovers).toHaveBeenCalledWith([
    expect.stringContaining('/api/manga/truyenqq/cover/book-123'),
  ]));
  expect(result.current.data).toBeUndefined();
  await act(async () => pending.resolve(page('MDX ready', 'mangadex')));
  await waitFor(() => expect(result.current.data?.latestFeed).toHaveLength(2));
});

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
  expect(mangaApi.getHomepage).toHaveBeenCalledWith(expect.objectContaining({ attachRatings: false }));
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledWith(expect.objectContaining({ attachRatings: false }));
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

it('does not substitute another catalog when QQ latest is unavailable', async () => {
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('homepage unavailable'));
  const { result } = renderHook(() => useHomepageCombined(120, true), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items).toEqual([]);
  expect(result.current.data?.latestFeed).toBeUndefined();
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledWith(expect.objectContaining({ showMature: true }));
});

it('retains QQ when MangaDex fails and reports which source is unavailable', async () => {
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('maintenance'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.unavailableSources).toEqual(['mangadex']);
});

it('rejects a QQ source response that contains only MangaDex cards', async () => {
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page('MDX cache', 'mangadex'), ongoing: page('MDX cache', 'mangadex') });
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  expect(result.current.data?.latestFeed).toBeUndefined();
  expect(result.current.data?.unavailableSources).toContain('truyenqq');
});

it.each(['truyenqq', 'mangadex'] as const)('bounds a stalled %s then recovers without publishing a partial latest feed', async source => {
  vi.useFakeTimers();
  const pending = deferred(), recovery = deferred();
  if (source === 'truyenqq') vi.mocked(mangaApi.getHomepage).mockReturnValueOnce(pending.promise).mockReturnValueOnce(recovery.promise);
  else vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValueOnce(pending.promise).mockReturnValueOnce(recovery.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
  expect(result.current.data).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data).toBeUndefined(); // no 1.5-second early abort/retry
  await act(async () => { await vi.advanceTimersByTimeAsync(source === 'truyenqq' ? 18_500 : 10_500); });
  const snapshot = result.current.data;
  expect(snapshot?.unavailableSources).toEqual([source]);
  expect(snapshot?.latestFeed).toBeUndefined();
  if (source === 'truyenqq') {
    expect(snapshot?.mangadex.items[0].title).toBe('MangaDex old');
    expect(snapshot?.latest.items).toEqual([]);
    expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(true);
  } else {
    expect(snapshot?.latest.items[0].title).toBe('QQ old');
    expect(snapshot?.mangadex.items).toEqual([]);
    expect(vi.mocked(mangaApi.getMangaDexHomeBanner).mock.calls[0][0]?.signal?.aborted).toBe(true);
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  const sourceMock = source === 'truyenqq' ? vi.mocked(mangaApi.getHomepage) : vi.mocked(mangaApi.getMangaDexHomeBanner);
  const healthyMock = source === 'truyenqq' ? mangaApi.getMangaDexHomeBanner : mangaApi.getHomepage;
  expect(sourceMock).toHaveBeenCalledTimes(2);
  expect(healthyMock).toHaveBeenCalledTimes(1);
  expect(sourceMock.mock.calls[1][0]?.signal?.aborted).toBe(false);
  expect(result.current.data).toEqual(snapshot);
  await act(async () => {
    pending.resolve(source === 'truyenqq' ? home('QQ late') : page('MangaDex late', 'mangadex'));
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data).toEqual(snapshot);
  await act(async () => {
    recovery.resolve(source === 'truyenqq' ? home('QQ recovered') : page('MangaDex recovered', 'mangadex'));
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(result.current.data?.unavailableSources).toEqual([]);
  expect(result.current.data?.latestFeed).toHaveLength(2);
  expect(result.current.data?.latest.items[0].title).toBe(source === 'truyenqq' ? 'QQ recovered' : 'QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe(source === 'mangadex' ? 'MangaDex recovered' : 'MangaDex old');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(sourceMock).toHaveBeenCalledTimes(2);
  expect(healthyMock).toHaveBeenCalledTimes(1);
});

it.each(['truyenqq', 'mangadex'] as const)('retains the last good %s cards through a failed refresh', async source => {
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  if (source === 'truyenqq') {
    vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('QQ unavailable'));
    vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('QQ fallback unavailable'));
    vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page('MangaDex new', 'mangadex'));
  } else {
    vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('MDX unavailable'));
    vi.mocked(mangaApi.getHomepage).mockResolvedValue(home('QQ new'));
  }
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(source === 'truyenqq' ? result.current.data?.mangadex.items[0].title
    : result.current.data?.latest.items[0].title).toBe(source === 'truyenqq' ? 'MangaDex new' : 'QQ new'));
  expect(result.current.data?.latest.items[0].title).toBe(source === 'truyenqq' ? 'QQ old' : 'QQ new');
  expect(result.current.data?.mangadex.items[0].title).toBe(source === 'mangadex' ? 'MangaDex old' : 'MangaDex new');
  expect(result.current.data?.unavailableSources).toEqual([source]);
});

it('backs off failed QQ recovery and cancels recovery when leaving the page', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('QQ unavailable'));
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('QQ unavailable'));
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.unavailableSources).toEqual(['truyenqq']);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_900); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(3);
  const pending = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(pending.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(4);
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(mangaApi.getHomepage).mock.calls[3][0]?.signal;
  unmount();
  client.removeQueries({ queryKey: ['manga', 'homepage'] });
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(home('QQ obsolete')); await vi.advanceTimersByTimeAsync(60_000); });
  expect(client.getQueriesData({ queryKey: ['manga', 'homepage'] })).toEqual([]);
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(4);
});

it('cancels old recovery when the mature-content filter changes and ignores its late result', async () => {
  vi.useFakeTimers();
  const obsolete = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValueOnce(new Promise(() => {}))
    .mockReturnValueOnce(obsolete.promise).mockResolvedValue(home('QQ safe'));
  const { result, rerender } = renderHook(({ mature }) => useHomepageCombined(120, mature), {
    wrapper, initialProps: { mature: true },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_350); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(2);
  const oldSignal = vi.mocked(mangaApi.getHomepage).mock.calls[1][0]?.signal;
  rerender({ mature: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(oldSignal?.aborted).toBe(true);
  expect(result.current.data?.latest.items[0].title).toBe('QQ safe');
  await act(async () => { obsolete.resolve(home('QQ obsolete adult filter')); await vi.advanceTimersByTimeAsync(2_000); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ safe');
  expect(result.current.data?.unavailableSources).toEqual([]);
});

it.each(['latest', 'ongoing'] as const)('recovers an unavailable QQ %s section even when homepage returned HTTP 200', async section => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockResolvedValueOnce({ ...home('QQ available section'),
    [section]: { data: { items: [] } }, meta: { unavailable_sections: [section] },
  }).mockResolvedValue(home('QQ complete'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.[section].items).toEqual([]);
  expect(result.current.data?.[section === 'latest' ? 'ongoing' : 'latest'].items[0].title).toBe('QQ available section');
  expect(result.current.data?.latestFeed === undefined).toBe(section === 'latest');
  expect(result.current.data?.unavailableSources).toEqual(['truyenqq']);
  await act(async () => { await vi.advanceTimersByTimeAsync(320); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ complete');
  expect(result.current.data?.ongoing.items[0].title).toBe('QQ complete');
  expect(result.current.data?.unavailableSources).toEqual([]);
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1);
});

it('retains the last good latest QQ section through a partial HTTP 200 refresh', async () => {
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: { data: { items: [] } },
    ongoing: page('QQ ongoing new'), meta: { unavailable_sections: ['latest'] } });
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.data?.ongoing.items[0].title).toBe('QQ ongoing new'));
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.unavailableSources).toEqual(['truyenqq']);
});

it('keeps the entire last complete latest feed until both sources recover, rather than reordering half of it', async () => {
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.data?.latestFeed).toHaveLength(2));
  const complete = result.current.data!.latestFeed;
  vi.mocked(mangaApi.getHomepage).mockResolvedValue(home('QQ new'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('MDX temporarily unavailable'));
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.data?.latest.items[0].title).toBe('QQ new'));
  expect(result.current.data?.latestFeed).toEqual(complete);
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue(page('MangaDex recovered', 'mangadex'));
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.data?.latestFeed?.map(item => item.title)).toEqual(['QQ new', 'MangaDex recovered']));
});

it('does not retry the intentionally omitted ongoing section or fetch a full catalog for home', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockResolvedValue({ latest: page('QQ latest'), ongoing: { data: { items: [] } },
    meta: { omitted_sections: ['ongoing'] } });
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.unavailableSources).toEqual([]);
  expect(result.current.data?.latestFeed).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(1);
  expect(mangaApi.getHomepage).toHaveBeenCalledWith(expect.objectContaining({ includeOngoing: false, lightweight: true }));
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
});

it('finishes a healthy slower source with one request even when it takes more than 1.5 seconds', async () => {
  vi.useFakeTimers();
  const qq = deferred(), mdx = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(qq.promise);
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(mdx.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
  expect(result.current.data).toBeUndefined();
  await act(async () => { qq.resolve(home('QQ cold')); await vi.advanceTimersByTimeAsync(2_000); });
  expect(result.current.data).toBeUndefined();
  await act(async () => { mdx.resolve(page('MangaDex cold', 'mangadex')); await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ cold');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex cold');
  expect(result.current.data?.latestFeed?.map(item => item.title)).toEqual(['QQ cold', 'MangaDex cold']);
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(1);
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(false);
});

it('allows a cold QQ relay recovery beyond six seconds to finish without cancelling and starting over', async () => {
  vi.useFakeTimers();
  const qq = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(qq.promise);
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(false);
  expect(result.current.data).toBeUndefined();
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(1);
  await act(async () => { qq.resolve(home('QQ recovered source page')); await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.latestFeed?.map(item => item.title)).toEqual(['QQ recovered source page', 'MangaDex old']);
  expect(result.current.data?.unavailableSources).toEqual([]);
});

it('bounds a fully stalled home request to twenty seconds', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(new Promise(() => {}));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
  expect(result.current.isLoading).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.isError).toBe(true);
  expect(result.current.data).toBeUndefined();
});

it('does not cut off the remaining source just because an empty catalog returned quickly', async () => {
  vi.useFakeTimers();
  const qq = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(qq.promise);
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockResolvedValue({ data: { items: [] } });
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(result.current.data).toBeUndefined();
  expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(false);
  await act(async () => { qq.resolve(home('QQ ready')); await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ ready');
});

it('does not publish a cancelled request or start a fallback after cancellation', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(new Promise(() => {}));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await client.cancelQueries({ queryKey: ['manga', 'homepage'] }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_100); });
  expect(result.current.data).toBeUndefined();
  expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  expect(vi.mocked(mangaApi.getHomepage).mock.calls[0][0]?.signal?.aborted).toBe(true);
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

it('recovers a completely failed first load without a manual retry and stops polling after success', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValueOnce(new Error('temporary outage'));
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValueOnce(new Error('temporary outage'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(result.current.isError).toBe(true);
  expect(result.current.data).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_020); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  expect(result.current.data?.unavailableSources).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(2);
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(2);
});

it('backs off complete outages to thirty seconds and cancels an automatic retry on unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(mangaApi.getHomepage).mockRejectedValue(new Error('offline'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(new Error('offline'));
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('offline'));
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  let calls = 1;
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 40); });
    expect(mangaApi.getHomepage).toHaveBeenCalledTimes(calls);
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(mangaApi.getHomepage).toHaveBeenCalledTimes(++calls);
  }
  const pending = deferred();
  vi.mocked(mangaApi.getHomepage).mockReturnValue(pending.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(result.current.isFetching).toBe(true);
  const signal = vi.mocked(mangaApi.getHomepage).mock.lastCall?.[0]?.signal;
  unmount();
  client.removeQueries({ queryKey: ['manga', 'homepage'] });
  expect(signal?.aborted).toBe(true);
  const before = vi.mocked(mangaApi.getHomepage).mock.calls.length;
  await act(async () => { pending.resolve(home('obsolete')); await vi.advanceTimersByTimeAsync(60_000); });
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(before);
  expect(client.getQueriesData({ queryKey: ['manga', 'homepage'] })).toEqual([]);
});

it.each([Object.assign(new Error('Forbidden'), { status: 403 }), new Error('MAINTENANCE_MODE'), new Error('BANNED')])(
  'does not poll or use a QQ fallback after a non-recoverable failure: %s', async error => {
    vi.useFakeTimers();
    vi.mocked(mangaApi.getHomepage).mockRejectedValue(error);
    vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValue(error);
    const { result } = renderHook(() => useHomepageCombined(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(result.current.isError).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mangaApi.getHomepage).toHaveBeenCalledTimes(1);
    expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(1);
    expect(mangaApi.getOTruyenFiltered).not.toHaveBeenCalled();
  },
);

it('still recovers for an approved reader when the website requires whitelist access', async () => {
  vi.useFakeTimers();
  setSiteAccessRestricted(true); // This means whitelist enabled, not access denied.
  vi.mocked(mangaApi.getHomepage).mockRejectedValueOnce(new Error('offline'));
  vi.mocked(mangaApi.getMangaDexHomeBanner).mockRejectedValueOnce(new Error('offline'));
  vi.mocked(mangaApi.getOTruyenFiltered).mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useHomepageCombined(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_050); });
  expect(result.current.data?.latest.items[0].title).toBe('QQ old');
  expect(result.current.data?.mangadex.items[0].title).toBe('MangaDex old');
  expect(mangaApi.getHomepage).toHaveBeenCalledTimes(2);
  expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalledTimes(2);
});
