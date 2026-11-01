import { afterEach, expect, it, vi } from 'vitest';
import { clearTokens, mangaApi, setSiteAccessRestricted } from './api';

afterEach(() => { clearTokens({ broadcast: false }); setSiteAccessRestricted(false); vi.unstubAllGlobals(); });

it.each([undefined, true, false])('only opts out of banner ratings when explicitly requested: %s', async attachRatings => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  await mangaApi.getMangaDexHomeBanner({ attachRatings, filterHidden: true, showMature: false });
  const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
  expect(url.searchParams.get('attach_ratings')).toBe(attachRatings === false ? 'false' : null);
  expect(url.searchParams.get('filter_hidden')).toBe('true');
  expect(url.searchParams.get('show_mature')).toBe('false');
});

it.each([undefined, 'WHITELIST_REQUIRED', 'ACCESS_TICKET_REVOKED'])(
  'preserves HTTP 403 on homepage errors so recovery does not poll denied content: %s', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code, detail: 'Access denied' }), { status: 403 })));
    await expect(mangaApi.getHomepage()).rejects.toMatchObject({ message: 'Access denied', status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
