import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useMangaSuggestions } from './useMangaSuggestions';

vi.mock('@/lib/api', () => ({ mangaApi: { search: vi.fn(), searchMangaDex: vi.fn(), getMoeFiltered: vi.fn() } }));
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
  beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); vi.mocked(mangaApi.getMoeFiltered).mockResolvedValue(page()); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('includes Moe suggestions fairly alongside the two existing sources', async () => {
    vi.mocked(mangaApi.search).mockResolvedValue(page(...Array.from({ length: 8 }, (_, i) => qq(`qq-${i}`))));
    vi.mocked(mangaApi.searchMangaDex).mockResolvedValue(page(mdx));
    vi.mocked(mangaApi.getMoeFiltered).mockResolvedValue(page({ slug: 'moe-1048', source: 'moetruyen' }));
    const { result } = renderHook(() => useMangaSuggestions('book'));
    await debounce();
    expect(result.current.items.slice(0, 3).map(item => item.source)).toEqual(['truyenqq', 'mangadex', 'moetruyen']);
    expect(result.current.loading).toBe(false);
  });

  it('shows MangaDex while QQ is pending, then shows results from both sources', async () => {
    const slow = pending();
    vi.mocked(mangaApi.search).mockReturnValue(slow.promise);
    vi.mocked(mangaApi.searchMangaDex).mockResolvedValue(page(mdx));
    const { result } = renderHook(() => useMangaSuggestions('one piece'));
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['mdx-id']);
    expect(result.current.loading).toBe(true);
    await act(async () => slow.resolve(page(...Array.from({ length: 8 }, (_, i) => qq(`qq-${i}`)))));
    expect(result.current.items).toHaveLength(6);
    expect(result.current.items[1].source).toBe('mangadex');
    expect(result.current.loading).toBe(false);
    expect(mangaApi.search).toHaveBeenCalledTimes(1);
    expect(mangaApi.searchMangaDex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mangaApi.search).mock.calls[0][2]).toMatchObject({ includeMangaDex: false, attachRatings: false });
  });

  it('keeps successful QQ results when MangaDex fails and does not cache the failure', async () => {
    vi.mocked(mangaApi.search).mockResolvedValue(page(qq()));
    vi.mocked(mangaApi.searchMangaDex).mockRejectedValue(new Error('upstream unavailable'));
    const { result, rerender } = renderHook(({ q }) => useMangaSuggestions(q), { initialProps: { q: 'one piece' } });
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['qq-123']);
    rerender({ q: '' }); rerender({ q: 'one piece' }); await debounce();
    expect(mangaApi.search).toHaveBeenCalledTimes(2);
  });

  it('cancels old searches and never publishes a late result for an earlier keyword', async () => {
    const old = pending();
    vi.mocked(mangaApi.search).mockReturnValueOnce(old.promise).mockResolvedValue(page(qq('new-123')));
    vi.mocked(mangaApi.searchMangaDex).mockResolvedValue(page());
    const { result, rerender } = renderHook(({ q }) => useMangaSuggestions(q), { initialProps: { q: 'older' } });
    await debounce();
    const signal = vi.mocked(mangaApi.search).mock.calls[0][2]!.signal!;
    rerender({ q: 'newer' }); await debounce();
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(page(qq('old-999'))));
    expect(result.current.items.map(item => item.id)).toEqual(['new-123']);
  });

  it('applies mature settings, clears results below two characters and isolates viewers', async () => {
    vi.mocked(mangaApi.search).mockResolvedValue(page(qq(), { ...qq('adult-1'), mature: true }));
    vi.mocked(mangaApi.searchMangaDex).mockResolvedValue(page(mdx));
    const { result, rerender } = renderHook(({ q, viewer }) => useMangaSuggestions(q, { viewerKey: viewer }),
      { initialProps: { q: 'one piece', viewer: 'one' } });
    await debounce();
    expect(result.current.items.map(item => item.id)).toEqual(['qq-123', 'mdx-id']);
    rerender({ q: 'o', viewer: 'one' }); expect(result.current.items).toEqual([]);
    rerender({ q: 'one piece', viewer: 'two' }); await debounce();
    expect(mangaApi.search).toHaveBeenCalledTimes(2);
  });

  it('distinguishes failed sources from a successful empty search', async () => {
    vi.mocked(mangaApi.search).mockRejectedValue(new Error('timeout'));
    vi.mocked(mangaApi.searchMangaDex).mockRejectedValue(new Error('timeout'));
    const { result } = renderHook(() => useMangaSuggestions('unavailable'));
    await debounce();
    expect(result.current).toMatchObject({ failed: true, loading: false, settled: true, items: [] });
  });
});
