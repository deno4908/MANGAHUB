import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useHomepageCombined } from './useApi';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = (source: string, slug: string) => ({ data: { items: [{ slug, name: slug, source }],
  params: { pagination: { currentPage: 1, totalItemsPerPage: 24, totalItems: 1 } } } });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(mangaApi, 'getFeatured').mockResolvedValue({ data: { items: [] } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

it('publishes QQ, MangaDex and Moe atomically regardless of completion order', async () => {
  const { client, wrapper } = setup();
  const mdx = page('mangadex', 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938');
  const qq = page('truyenqq', 'qq-book-123');
  let finishQQ!: (value: any) => void;
  let finishMoe!: (value: any) => void;
  vi.spyOn(mangaApi, 'getHomepage').mockImplementation(() => new Promise(resolve => { finishQQ = resolve; }));
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockResolvedValue(mdx);
  vi.spyOn(mangaApi, 'getMoeFiltered').mockImplementation(() => new Promise(resolve => { finishMoe = resolve; }));
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(mangaApi.getMangaDexHomeBanner).toHaveBeenCalled());
  expect(result.current.data).toBeUndefined();
  await act(async () => { finishQQ({ latest: qq, ongoing: qq }); });
  expect(result.current.data).toBeUndefined();
  expect(result.current.isLoading).toBe(true);
  await act(async () => { finishMoe(page('moetruyen', 'moe-123')); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.latest.items.map(item => item.source)).toEqual(['truyenqq', 'moetruyen']);
  expect(result.current.data?.mangadex.items[0].source).toBe('mangadex');
  unmount(); client.clear();
});

it('keeps successful sources when Moe fails and makes no delayed replacement', async () => {
  const { client, wrapper } = setup();
  const qq = page('truyenqq', 'qq-book-123');
  vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue({ latest: qq, ongoing: qq });
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockResolvedValue({ data: { items: [] } });
  vi.spyOn(mangaApi, 'getMoeFiltered').mockRejectedValue(new Error('timeout'));
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.unavailableSources).toEqual(['moetruyen']);
  expect(result.current.data?.latest.items[0].source).toBe('truyenqq');
  unmount(); client.clear();
});

it('publishes a refresh as one snapshot while retaining the previous complete snapshot', async () => {
  const { client, wrapper } = setup();
  const qq = page('truyenqq', 'qq-book-123');
  vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue({ latest: qq, ongoing: qq });
  vi.spyOn(mangaApi, 'getMangaDexHomeBanner').mockResolvedValue({ data: { items: [] } });
  const source = vi.spyOn(mangaApi, 'getMoeFiltered').mockResolvedValue(page('moetruyen', 'moe-123'));
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  let finish!: (value: any) => void;
  source.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  act(() => { void result.current.refetch(); });
  await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  expect(result.current.data?.moetruyen.items[0].id).toBe('moe-123');
  await act(async () => finish(page('moetruyen', 'moe-456')));
  await waitFor(() => expect(result.current.data?.moetruyen.items[0].id).toBe('moe-456'));
  unmount(); client.clear();
});
