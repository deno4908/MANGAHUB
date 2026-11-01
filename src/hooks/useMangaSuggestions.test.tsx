import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useMangaSuggestions } from './useMangaSuggestions';

const requests = vi.hoisted(() => ({ qq: vi.fn(), mdx: vi.fn() }));
vi.mock('@/lib/api', () => ({ mangaApi: { searchSuggestions: vi.fn() } }));
vi.mock('@/lib/adapters', () => ({ adaptMangaItem: (item: any) => ({ ...item, id: item.slug }) }));
vi.mock('@/lib/contentFilter', () => ({ isMatureManga: (item: any) => item.mature === true }));
const page = (...items: any[]) => ({ data: { items } });
const qq = (slug = 'qq-123') => ({ slug, source: 'truyenqq' });
const mdx = { slug: 'mdx-id', source: 'mangadex' };
function pending<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function debounce() { await act(async () => { vi.advanceTimersByTime(200); }); }

describe('independent source suggestions', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks();
    vi.mocked(mangaApi.searchSuggestions).mockImplementation((q, source, options) =>
      source === 'uploaded' ? Promise.resolve(page()) : (source === 'truyenqq' ? requests.qq : requests.mdx)(q, options));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows MangaDex while QQ is pending, then shows results from both sources', async () => {
    const slow = pending();
    requests.qq.mockReturnValue(slow.promise);
    requests.mdx.mockResolvedValue(page(mdx));
    const { result } = renderHook(() => useMangaSuggestions('one piece'));
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['mdx-id']);
    expect(result.current.loading).toBe(true);
    await act(async () => slow.resolve(page(...Array.from({ length: 8 }, (_, i) => qq(`qq-${i}`)))));
    expect(result.current.items).toHaveLength(6);
    expect(result.current.items[1].source).toBe('mangadex');
    expect(result.current.loading).toBe(false);
    expect(requests.qq).toHaveBeenCalledTimes(1);
    expect(requests.mdx).toHaveBeenCalledTimes(1);
    expect(mangaApi.searchSuggestions).toHaveBeenCalledWith('one piece', 'truyenqq', expect.objectContaining({ showMature: false }));
  });

  it('keeps successful QQ results when MangaDex fails and does not cache the failure', async () => {
    requests.qq.mockResolvedValue(page(qq()));
    requests.mdx.mockRejectedValue(new Error('upstream unavailable'));
    const { result, rerender } = renderHook(({ q }) => useMangaSuggestions(q), { initialProps: { q: 'one piece' } });
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['qq-123']);
    rerender({ q: '' }); rerender({ q: 'one piece' }); await debounce();
    expect(requests.qq).toHaveBeenCalledTimes(1);
    expect(requests.mdx).toHaveBeenCalledTimes(2);
  });

  it('cancels old searches and never publishes a late result for an earlier keyword', async () => {
    const old = pending();
    requests.qq.mockReturnValueOnce(old.promise).mockResolvedValue(page(qq('new-123')));
    requests.mdx.mockResolvedValue(page());
    const { result, rerender } = renderHook(({ q }) => useMangaSuggestions(q), { initialProps: { q: 'older' } });
    await debounce();
    const signal = requests.qq.mock.calls[0][1]!.signal!;
    rerender({ q: 'newer' }); await debounce();
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(page(qq('old-999'))));
    expect(result.current.items.map(item => item.id)).toEqual(['new-123']);
  });

  it('applies mature settings, clears results below two characters and isolates viewers', async () => {
    requests.qq.mockResolvedValue(page(qq(), { ...qq('adult-1'), mature: true }));
    requests.mdx.mockResolvedValue(page(mdx));
    const { result, rerender } = renderHook(({ q, viewer }) => useMangaSuggestions(q, { viewerKey: viewer }),
      { initialProps: { q: 'one piece', viewer: 'one' } });
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['qq-123', 'mdx-id']);
    rerender({ q: 'o', viewer: 'one' }); expect(result.current.items).toEqual([]);
    rerender({ q: 'one piece', viewer: 'two' }); await debounce();
    expect(requests.qq).toHaveBeenCalledTimes(2);
  });

  it('distinguishes failed sources from a successful empty search', async () => {
    requests.qq.mockRejectedValue(new Error('timeout'));
    requests.mdx.mockRejectedValue(new Error('timeout'));
    const { result } = renderHook(() => useMangaSuggestions('unavailable'));
    await debounce();
    expect(result.current).toMatchObject({ failed: true, loading: false, settled: true, items: [] });
  });

  it('starts at 120 ms and reopens cached results immediately without another network request', async () => {
    requests.qq.mockResolvedValue(page(qq()));
    requests.mdx.mockResolvedValue(page(mdx));
    const { result, rerender } = renderHook(({ q }) => useMangaSuggestions(q), { initialProps: { q: 'one piece' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(119); });
    expect(mangaApi.searchSuggestions).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.items).toHaveLength(2);
    rerender({ q: '' });
    rerender({ q: 'ONE PIECE' });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    await debounce();
    expect(mangaApi.searchSuggestions).toHaveBeenCalledTimes(3);
  });

  it('shows uploaded suggestions while both external sources are still pending', async () => {
    requests.qq.mockReturnValue(new Promise(() => {}));
    requests.mdx.mockReturnValue(new Promise(() => {}));
    vi.mocked(mangaApi.searchSuggestions).mockImplementation((q, source, options) => source === 'uploaded'
      ? Promise.resolve(page({ slug: 'upload-1', source: 'uploaded' })) : (source === 'truyenqq' ? requests.qq : requests.mdx)(q, options));
    const { result } = renderHook(() => useMangaSuggestions('one piece'));
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['upload-1']);
    expect(result.current.loading).toBe(true);
  });
});
