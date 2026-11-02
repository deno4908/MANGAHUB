import { afterEach, expect, it, vi } from 'vitest';
import { clearTokens, mangaApi, setSiteAccessRestricted } from './api';

afterEach(() => { clearTokens({ broadcast: false }); setSiteAccessRestricted(false); vi.unstubAllGlobals(); });

it('requests only the primary QQ home list and defers optional view hydration explicitly', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  await mangaApi.getHomepage({ lightweight: true, includeOngoing: false, attachRatings: false });
  const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
  expect(url.searchParams.get('include_ongoing')).toBe('false');
  expect(url.searchParams.get('lightweight')).toBe('true');
  expect(url.searchParams.get('attach_ratings')).toBe('false');
});

it('recovers the real latest home page through the owned relay instead of accepting an empty replacement', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 502, headers: {
    'Content-Type': 'application/json', 'X-TruyenQQ-Error': 'http-403',
    'X-TruyenQQ-Source-Path': '/truyen-moi-cap-nhat',
  } })).mockResolvedValueOnce(new Response('<div class="list_grid">real latest</div>', { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ latest: { data: { items: [{ slug: 'real-latest-12345' }] } },
      ongoing: { data: { items: [] } }, meta: { omitted_sections: ['ongoing'] } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  vi.stubGlobal('fetch', fetcher);
  const result = await mangaApi.getHomepage({ lightweight: true, includeOngoing: false, attachRatings: false, timeoutMs: 20_000 });
  expect(result.latest.data.items).toEqual([{ slug: 'real-latest-12345' }]);
  expect(fetcher.mock.calls).toHaveLength(3);
  expect(new URL(fetcher.mock.calls[1][0]).pathname).toBe('/api/truyenqq-edge/truyen-moi-cap-nhat');
  expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[2][0]);
});

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
