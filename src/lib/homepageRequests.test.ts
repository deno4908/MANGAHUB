import { afterEach, expect, it, vi } from 'vitest';
import { clearTokens, mangaApi } from './api';

afterEach(() => { clearTokens({ broadcast: false }); vi.unstubAllGlobals(); });

it.each([undefined, true, false])('only opts out of banner ratings when explicitly requested: %s', async attachRatings => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  await mangaApi.getMangaDexHomeBanner({ attachRatings, filterHidden: true, showMature: false });
  const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
  expect(url.searchParams.get('attach_ratings')).toBe(attachRatings === false ? 'false' : null);
  expect(url.searchParams.get('filter_hidden')).toBe('true');
  expect(url.searchParams.get('show_mature')).toBe('false');
});
