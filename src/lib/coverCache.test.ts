import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireCover, acquireReaderImage, cachedCover, canCacheCover, clearCoverCache, invalidateCover, retainCachedCover, warmCovers, warmReaderImages } from './coverCache';
const origin = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const cover = (id: number) => `${origin}/api/manga/truyenqq/cover/book-${id}`;
const image = () => new Response(new Blob(['bytes'], { type: 'image/jpeg' }), { headers: { 'content-type': 'image/jpeg' } });
let sequence = 0;
beforeEach(() => {
  sequence = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => image()));
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:cover-${++sequence}`);
    static revokeObjectURL = vi.fn();
  });
});
afterEach(async () => { clearCoverCache(); await Promise.resolve(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('downloads duplicate hero/card covers once and reuses their bytes across navigation', async () => {
  const a = acquireCover(cover(1)), b = acquireCover(cover(1));
  const [first, second] = await Promise.all([a.promise, b.promise]);
  expect(first).toBe(second);
  a.release(); b.release();
  const back = acquireCover(cover(1));
  expect(await back.promise).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(cover(1), expect.objectContaining({ credentials: 'include' }));
  back.release();
});

it('reuses a known MangaDex thumbnail for an older saved by-ID cover without another request', async () => {
  const id = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  const byFile = `${origin}/api/images/img?url=${encodeURIComponent(`https://uploads.mangadex.org/covers/${id}/current.jpg.256.jpg`)}`;
  const byId = `${origin}/api/manga/mangadex-cover/${id}?size=256`;
  const first = acquireCover(byFile);
  const bytes = await first.promise; first.release();
  expect(cachedCover(byId)).toBe(bytes);
  const saved = acquireCover(byId);
  expect(await saved.promise).toBe(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
  saved.release();
  clearCoverCache();
  expect(cachedCover(byFile)).toBeUndefined();
  expect(cachedCover(byId)).toBeUndefined();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});

it('does not confuse different MangaDex thumbnails, sizes, changed filenames or other origins', async () => {
  const id = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  const byFile = (name: string) => `${origin}/api/images/img?url=${encodeURIComponent(`https://uploads.mangadex.org/covers/${id}/${name}`)}`;
  const first = acquireCover(byFile('old.jpg.256.jpg')); await first.promise; first.release();
  expect(cachedCover(`${origin}/api/manga/mangadex-cover/${id}?size=512`)).toBeUndefined();
  expect(cachedCover(`https://untrusted.example/api/manga/mangadex-cover/${id}?size=256`)).toBeUndefined();
  expect(cachedCover(byFile('changed.jpg.256.jpg'))).toBeUndefined();
  const fresh = acquireCover(byFile('changed.jpg.256.jpg')); const bytes = await fresh.promise; fresh.release();
  expect(cachedCover(`${origin}/api/manga/mangadex-cover/${id}?size=256`)).toBe(bytes);
  const saved = acquireCover(`${origin}/api/manga/mangadex-cover/${id}?size=256`);
  invalidateCover(`${origin}/api/manga/mangadex-cover/${id}?size=256`);
  saved.release();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(bytes);
});

it('never extends a borrowed MangaDex thumbnail lifetime for a saved ID', async () => {
  vi.useFakeTimers();
  const id = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f';
  const byFile = `${origin}/api/images/img?url=${encodeURIComponent(`https://uploads.mangadex.org/covers/${id}/cover.jpg.256.jpg`)}`;
  const byId = `${origin}/api/manga/mangadex-cover/${id}?size=256`;
  const original = acquireCover(byFile); await original.promise; original.release();
  vi.advanceTimersByTime(100_000);
  const borrowed = acquireCover(byId); await borrowed.promise; borrowed.release();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(20_001);
  expect(cachedCover(byId)).toBeUndefined();
  const refreshed = acquireCover(byId); await refreshed.promise; refreshed.release();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('starts the same four foreground library covers with high browser priority', async () => {
  const release = warmCovers([cover(1), cover(2), cover(3), cover(4)], 'visible');
  await vi.waitFor(() => expect(cachedCover(cover(4))).toBeDefined());
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [, options] of vi.mocked(fetch).mock.calls) expect(options?.priority).toBe('high');
  release();
});

it('uses the same protected cache for MangaDex and refuses arbitrary origins or reader pages', () => {
  expect(canCacheCover(cover(1))).toBe(true);
  expect(canCacheCover(`${origin}/api/images/img?url=https%3A%2F%2Fuploads.mangadex.org%2Fcover.jpg`)).toBe(true);
  expect(canCacheCover(`${origin}/api/manga/mangadex-cover/book`)).toBe(true);
  expect(canCacheCover('https://other.example/api/images/img')).toBe(false);
  expect(canCacheCover(`${origin}/api/manga/truyenqq/image/book/1/1`)).toBe(false);
});

it('drops and revokes cached bytes when access is cleared, including an in-flight response', async () => {
  const old = acquireCover(cover(1)); const previous = await old.promise; old.release();
  clearCoverCache();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(previous);
  expect(cachedCover(cover(1))).toBeUndefined();
  const again = acquireCover(cover(1));
  expect(await again.promise).not.toBe(previous);
  again.release();
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = acquireCover(cover(2));
  const rejected = expect(pending.promise).rejects.toMatchObject({ name: 'AbortError' });
  clearCoverCache(); finish(image()); await rejected;
  expect(cachedCover(cover(2))).toBeUndefined(); pending.release();
});

it('cancels only an unused request and never caches HTTP or non-image errors', async () => {
  const aborts: string[] = [];
  vi.mocked(fetch).mockImplementationOnce((url, options) => new Promise((_, reject) => {
    options?.signal?.addEventListener('abort', () => { aborts.push(String(url)); reject(new DOMException('cancelled', 'AbortError')); });
  }));
  const a = acquireCover(cover(1)), b = acquireCover(cover(1));
  const rejected = expect(a.promise).rejects.toMatchObject({ name: 'AbortError' });
  a.release(); expect(aborts).toHaveLength(0);
  b.release(); await rejected; expect(aborts).toHaveLength(1);
  vi.mocked(fetch).mockResolvedValueOnce(new Response('error', { status: 503 }));
  const failed = acquireCover(cover(2)); await expect(failed.promise).rejects.toThrow(); failed.release();
  expect(cachedCover(cover(2))).toBeUndefined();
  vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }));
  const html = acquireCover(cover(3)); await expect(html.promise).rejects.toThrow(); html.release();
});

it('limits active downloads and aborts queued covers after leaving a page', async () => {
  const finish: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation((_, options) => new Promise((resolve, reject) => {
    finish.push(() => resolve(image()));
    options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
  }));
  const jobs = Array.from({ length: 14 }, (_, n) => acquireCover(cover(n)));
  const results = Promise.allSettled(jobs.map(job => job.promise));
  expect(fetch).toHaveBeenCalledTimes(10);
  jobs.slice(10).forEach(job => job.release());
  finish.forEach(done => done()); await results;
  jobs.slice(0,10).forEach(job => job.release());
  expect(fetch).toHaveBeenCalledTimes(10);
});

it('shows a larger reader batch without downloading preloaded, duplicate or revisited images again', async () => {
  const finish: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish.push(() => resolve(image())); }));
  const urls = Array.from({ length: 12 }, (_, index) => `${origin}/api/images/img?url=${encodeURIComponent(`https://uploads.mangadex.org/data/chapter/${index}.jpg`)}`);
  const stopWarming = warmReaderImages(urls);
  expect(fetch).toHaveBeenCalledTimes(4);

  const visible = urls.map(url => acquireReaderImage(url, 'visible'));
  const duplicate = acquireReaderImage(urls[0], 'visible');
  // Visible pages start together instead of waiting for the four preloads.
  expect(fetch).toHaveBeenCalledTimes(10);
  finish.splice(0).forEach(done => done());
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(12));
  finish.splice(0).forEach(done => done());
  const objects = await Promise.all(visible.map(resource => resource.promise));
  expect(await duplicate.promise).toBe(objects[0]);
  visible.forEach(resource => resource.release()); duplicate.release(); stopWarming();

  const revisited = urls.map(url => acquireReaderImage(url, 'visible'));
  expect(await Promise.all(revisited.map(resource => resource.promise))).toEqual(objects);
  revisited.forEach(resource => resource.release());
  expect(fetch).toHaveBeenCalledTimes(12);
  expect(new Set(vi.mocked(fetch).mock.calls.map(([url]) => url)).size).toBe(12);
});

it('leaves download slots available for visible covers while warming another page', async () => {
  const finish: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish.push(() => resolve(image())); }));
  const prefetches = Array.from({ length: 6 }, (_, n) => acquireCover(cover(n), 'prefetch'));
  expect(fetch).toHaveBeenCalledTimes(4);
  const visible = acquireCover(cover(100), 'visible');
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(vi.mocked(fetch).mock.calls[4][0]).toBe(cover(100));
  expect(vi.mocked(fetch).mock.calls[4][1]).toMatchObject({ priority: 'high' });
  const results = Promise.allSettled([...prefetches, visible].map(job => job.promise));
  prefetches.forEach(job => job.release());
  finish.forEach(done => done());
  await results;
  visible.release();
});

it('warms all six adjacent-page covers while keeping at most four background downloads active', async () => {
  let active = 0, peak = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return image();
  });
  const urls = Array.from({ length: 42 }, (_, index) => cover(index));
  const release = warmCovers(urls);
  expect(fetch).toHaveBeenCalledTimes(4);
  await vi.waitFor(() => expect(urls.slice(0, 6).every(url => cachedCover(url))).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(peak).toBeLessThanOrEqual(4);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 6));
  release();
});

it('cancels unused warmed covers without starting the remaining two queued downloads', async () => {
  let aborts = 0;
  vi.mocked(fetch).mockImplementation((_, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      aborts++;
      reject(new DOMException('cancelled', 'AbortError'));
    });
  }));
  const release = warmCovers(Array.from({ length: 42 }, (_, index) => cover(index)));
  expect(fetch).toHaveBeenCalledTimes(4);
  release();
  await vi.waitFor(() => expect(aborts).toBe(4));
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('promotes a queued speculative cover when that image becomes visible', async () => {
  const finish: Array<() => void> = [];
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish.push(() => resolve(image())); }));
  const prefetches = Array.from({ length: 6 }, (_, n) => acquireCover(cover(n), 'prefetch'));
  const visible = acquireCover(cover(5), 'visible');
  expect(vi.mocked(fetch).mock.calls[4][0]).toBe(cover(5));
  const results = Promise.allSettled([...prefetches, visible].map(job => job.promise));
  prefetches.forEach(job => job.release());
  finish.forEach(done => done());
  await results;
  visible.release();
  expect(vi.mocked(fetch).mock.calls.filter(call => call[0] === cover(5))).toHaveLength(1);
});

it('expires old covers instead of keeping stale bytes indefinitely', async () => {
  vi.useFakeTimers();
  const a = acquireCover(cover(1)); const first = await a.promise; a.release();
  vi.advanceTimersByTime(120_001);
  expect(cachedCover(cover(1))).toBeUndefined();
  const b = acquireCover(cover(1)); expect(await b.promise).not.toBe(first); b.release();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps an existing cover through a long chapter and the return to detail without another download', async () => {
  vi.useFakeTimers();
  const detail = acquireCover(cover(1));
  const original = await detail.promise;
  detail.release();
  const leaveReader = retainCachedCover(cover(1));
  await Promise.resolve();
  vi.advanceTimersByTime(10 * 60_000);
  expect(cachedCover(cover(1))).toBe(original);
  leaveReader();
  const returned = acquireCover(cover(1));
  expect(await returned.promise).toBe(original);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original);
  returned.release();
  await Promise.resolve();
  expect(cachedCover(cover(1))).toBeUndefined();
});

it('never fetches a missing reader cover and clears retained bytes immediately on access loss', async () => {
  const missing = retainCachedCover(cover(1));
  expect(fetch).not.toHaveBeenCalled(); missing();
  const detail = acquireCover(cover(2)); const original = await detail.promise;
  const leaveReader = retainCachedCover(cover(2)); detail.release();
  clearCoverCache();
  expect(cachedCover(cover(2))).toBeUndefined();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original);
  leaveReader(); await Promise.resolve();
  expect(cachedCover(cover(2))).toBeUndefined();
});

it('discards image bytes that the browser cannot decode', async () => {
  const a = acquireCover(cover(1)); const first = await a.promise;
  invalidateCover(cover(1)); a.release();
  expect(cachedCover(cover(1))).toBeUndefined();
  const b = acquireCover(cover(1)); expect(await b.promise).not.toBe(first); b.release();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('evicts older unused covers to keep the retained byte cache bounded', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response(new Uint8Array(5 * 1024 * 1024), { headers: { 'content-type': 'image/jpeg' } }));
  for (let n = 0; n < 6; n++) {
    const entry = acquireCover(cover(n)); await entry.promise; entry.release();
  }
  expect(cachedCover(cover(0))).toBeUndefined();
  expect(cachedCover(cover(5))).toBeDefined();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
