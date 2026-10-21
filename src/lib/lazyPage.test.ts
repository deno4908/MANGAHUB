import { expect, it, vi } from 'vitest';
import { lazyPage } from './lazyPage';

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
