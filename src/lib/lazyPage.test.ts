import { afterEach, expect, it, vi } from 'vitest';
import { lazyPage, retryFailedPages } from './lazyPage';

afterEach(() => { retryFailedPages();vi.useRealTimers(); });

it('shares a pending route download across callers', async () => {
  const component = { default: () => null };
  let complete!: (value: typeof component) => void;
  const loader = vi.fn(() => new Promise<typeof component>(resolve => { complete = resolve; }));
  const page = lazyPage(loader);
  const first = page.preload();
  expect(page.preload()).toBe(first);
  complete(component);
  expect(await first).toBe(component);
  expect(await page.preload()).toBe(component);
  expect(loader).toHaveBeenCalledTimes(1);
});

it('allows navigation to retry after an early download fails', async () => {
  const component = { default: () => null };
  const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(component);
  const page = lazyPage(loader);
  await expect(page.preload()).rejects.toThrow('offline');
  await expect(page.preload()).resolves.toBe(component);
  expect(loader).toHaveBeenCalledTimes(2);
});

it('retries a transient module download once, sharing the retry across callers', async () => {
  vi.useFakeTimers();
  const component = { default: () => null };
  const loader = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: /assets/page.js'))
    .mockResolvedValue(component);
  const page = lazyPage(loader);
  const pending = page.preload();
  expect(page.preload()).toBe(pending);
  await vi.advanceTimersByTimeAsync(350);
  expect(await pending).toBe(component);
  expect(loader).toHaveBeenCalledTimes(2);
});
