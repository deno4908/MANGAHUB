import { afterEach, expect, it, vi } from 'vitest';

afterEach(async () => {
  const api = await import('./api');
  api.clearTokens({ broadcast: false });
  api.setSiteAccessRestricted(false);
  (await import('./truyenqqRelay')).clearQQRecovery();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('restores one shared token only when cookie-authorized QQ reads need source recovery', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const { mangaApi, setSiteAccessRestricted } = await import('./api');
  const { fetchImageResponse } = await import('./imageTransport');
  localStorage.setItem('mb:session-present', String(Date.now()));
  setSiteAccessRestricted(true);
  const base = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const detail = `${base}/api/manga/detail/book-123`;
  const cover = `${base}/api/manga/truyenqq/cover/book-123`;
  const requests = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ session: { access_token: 'fixture-restored-reader' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
    if (url.includes('workers.dev')) {
      return new Headers(options.headers).get('Authorization') === 'Bearer fixture-restored-reader'
        ? new Response('book_info', { headers: { 'X-TruyenQQ-Proof': 'fixture-proof' } })
        : new Response('Authentication required', { status: 403 });
    }
    if (options.method === 'POST') {
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer fixture-restored-reader');
      return url === cover ? new Response('cover', { headers: { 'Content-Type': 'image/jpeg' } })
        : new Response(JSON.stringify({ data: { item: { slug: 'book-123', chapters: [] } } }));
    }
    return new Response('{}', { status: 503, headers: { 'X-TruyenQQ-Error': 'http-403',
      'X-TruyenQQ-Source-Path': '/truyen-tranh/book-123', 'X-TruyenQQ-Recovery': '1' } });
  });
  vi.stubGlobal('fetch', requests);
  const [comic, image] = await Promise.all([mangaApi.getDetail('book-123'), fetchImageResponse(cover)]);
  expect(comic.data.item.slug).toBe('book-123');
  expect(image.headers.get('Content-Type')).toBe('image/jpeg');
  expect(requests.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'))).toHaveLength(1);
  expect(requests.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
  const first = requests.mock.calls.find(([url, options]) => url === detail && options.method !== 'POST');
  expect(new Headers(first![1].headers).has('Authorization')).toBe(false);
});

it('also recovers the source after a normal 401 session refresh', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const { mangaApi, setSiteAccessRestricted } = await import('./api');
  setSiteAccessRestricted(true);
  localStorage.setItem('mb:session-present', String(Date.now()));
  let reads = 0;
  const requests = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ session: { access_token: 'fixture-refreshed-reader' } }));
    if (url.includes('workers.dev')) return new Response('book_info', { headers: { 'X-TruyenQQ-Proof': 'fixture-proof' } });
    if (options.method === 'POST') return new Response(JSON.stringify({ data: { item: { slug: 'refreshed-123' } } }));
    if (++reads === 1) return new Response('{}', { status: 401 });
    return new Response('{}', { status: 503, headers: { 'X-TruyenQQ-Error': 'http-403',
      'X-TruyenQQ-Source-Path': '/truyen-tranh/refreshed-123', 'X-TruyenQQ-Recovery': '1' } });
  });
  vi.stubGlobal('fetch', requests);
  expect((await mangaApi.getDetail('refreshed-123')).data.item.slug).toBe('refreshed-123');
  expect(requests.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'))).toHaveLength(1);
  expect(requests.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
});

it('keeps healthy cookie-authorized detail and cover reads free of refresh and relay requests', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const { mangaApi, setSiteAccessRestricted } = await import('./api');
  const { fetchImageResponse } = await import('./imageTransport');
  setSiteAccessRestricted(true);
  localStorage.setItem('mb:session-present', String(Date.now()));
  const requests = vi.fn(async (url: string) => url.includes('/cover/')
    ? new Response('cover', { headers: { 'Content-Type': 'image/jpeg' } })
    : new Response(JSON.stringify({ data: { item: { slug: 'cached-123' } } })));
  vi.stubGlobal('fetch', requests);
  const base = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  await Promise.all([mangaApi.getDetail('cached-123'), fetchImageResponse(`${base}/api/manga/truyenqq/cover/cached-123`)]);
  expect(requests).toHaveBeenCalledTimes(2);
  expect(requests.mock.calls.some(([url]) => url.endsWith('/auth/refresh') || url.includes('workers.dev'))).toBe(false);
});
