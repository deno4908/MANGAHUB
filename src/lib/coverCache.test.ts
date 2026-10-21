import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireCover, cachedCover, canCacheCover, clearCoverCache, invalidateCover } from './coverCache';
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
  const jobs = Array.from({ length: 10 }, (_, n) => acquireCover(cover(n)));
  const results = Promise.allSettled(jobs.map(job => job.promise));
  expect(fetch).toHaveBeenCalledTimes(6);
  jobs.slice(6).forEach(job => job.release());
  finish.forEach(done => done()); await results;
  jobs.slice(0,6).forEach(job => job.release());
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('expires old covers instead of keeping stale bytes indefinitely', async () => {
  vi.useFakeTimers();
  const a = acquireCover(cover(1)); const first = await a.promise; a.release();
  vi.advanceTimersByTime(120_001);
  expect(cachedCover(cover(1))).toBeUndefined();
  const b = acquireCover(cover(1)); expect(await b.promise).not.toBe(first); b.release();
  expect(fetch).toHaveBeenCalledTimes(2);
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
