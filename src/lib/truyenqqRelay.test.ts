import { afterEach, expect, it, vi } from 'vitest';
import { clearQQRecovery, fetchWithTruyenQQRelay } from './truyenqqRelay';
import { setSiteAccessRestricted } from './siteAccessState';

afterEach(() => { clearQQRecovery();setSiteAccessRestricted(false); vi.unstubAllGlobals();vi.useRealTimers(); });
const api = 'https://api.mangahub.art/api/manga/truyenqq-filtered?page=53';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

it('overlaps the same two proven failed page fills and hands each proof back without extra relay requests', async () => {
  setSiteAccessRestricted(true);
  const paths = ['/tim-kiem-nang-cao/trang-58?sort=4', '/tim-kiem-nang-cao/trang-57?sort=4'];
  const started = new Set<string>();
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  let apiCalls = 0;
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('workers.dev')) {
      started.add(url);
      if (started.size === 2) release();
      await both;
      return new Response('list_grid', { headers: { 'X-TruyenQQ-Proof': url.endsWith('58?sort=4') ? 'proof58' : 'proof57' } });
    }
    apiCalls++;
    return apiCalls < 3 ? json({}, 503, {
      'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Recovery': '1',
      'X-TruyenQQ-Source-Path': paths[apiCalls - 1],
      ...(apiCalls === 1 ? { 'X-TruyenQQ-Source-Paths': JSON.stringify(paths) } : {}),
    }) : json({ data: { items: Array.from({ length: 24 }, (_, index) => ({ slug: `book-${index}` })) } });
  });
  vi.stubGlobal('fetch', fetcher);
  const response = await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'Bearer reader' } }, 1000);
  expect((await response.json()).data.items).toHaveLength(24);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(2);
  const posts = fetcher.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(posts.map(([, options]) => JSON.parse(options.body).proof)).toEqual(['proof58', 'proof57']);
});

it.each([
  ['//external.example/secret'],
  ['/truyen-tranh/unrelated-123'],
  ['/tim-kiem-nang-cao/trang-57?sort=2'],
  ['/tim-kiem-nang-cao/trang-57?sort=4', '/tim-kiem-nang-cao/trang-58?sort=4', '/tim-kiem-nang-cao/trang-59?sort=4'],
])('ignores unrelated or over-budget recovery page hints %j', async (...paths) => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Recovery': '1',
    'X-TruyenQQ-Source-Path': '/tim-kiem-nang-cao/trang-58?sort=4',
    'X-TruyenQQ-Source-Paths': JSON.stringify(paths),
  })).mockResolvedValueOnce(new Response('list_grid', { headers: { 'X-TruyenQQ-Proof': 'proof' } }))
    .mockResolvedValueOnce(json({ data: { items: [] } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(api, {}, 1000)).ok).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('warms the exact blocked QQ source page, then retries the original backend request', async () => {
  const blocked = json({ detail: 'Unavailable' }, 502, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/tim-kiem-nang-cao/trang-53?sort=4',
  });
  const fetcher = vi.fn().mockResolvedValueOnce(blocked)
    .mockResolvedValueOnce(new Response('<div class="list_grid"></div>'))
    .mockResolvedValueOnce(json({ data: { items: [{ source: 'truyenqq' }] } }));
  vi.stubGlobal('fetch', fetcher);
  const result = await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'private-token' } }, 10_000);
  expect(result.ok).toBe(true);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    api, 'https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge/tim-kiem-nang-cao/trang-53?sort=4', api,
  ]);
  expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: 'omit', method: 'GET' });
  expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
  expect(fetcher.mock.calls[2][1].headers.Authorization).toBe('private-token');
});

it('recovers a missing QQ source in partial combined search results using a public search form', async () => {
  const url = 'https://api.mangahub.art/api/manga/search?keyword=one%20piece';
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: { items: [{ source: 'mangadex' }] } }, 200, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/frontend/search/search',
    'X-TruyenQQ-Search': 'one%20piece',
  })).mockResolvedValueOnce(new Response('<li>search_info</li>'))
    .mockResolvedValueOnce(json({ data: { items: [{ source: 'truyenqq' }, { source: 'mangadex' }] } }));
  vi.stubGlobal('fetch', fetcher);
  const response = await fetchWithTruyenQQRelay(url, {}, 10_000);
  expect((await response.json()).data.items).toHaveLength(2);
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    method: 'POST', credentials: 'omit', body: 'search=one+piece&type=0',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
});

it('fills a partial local ranking after a blocked QQ catalog is warmed by the browser', async () => {
  setSiteAccessRestricted(true);
  const rows = Array.from({ length: 11 }, (_, index) => ({ slug: `ranked-${index}`, views: 50 - index }));
  const fullRows = [...rows, ...Array.from({ length: 31 }, (_, index) => ({ slug: `unread-${index}`, views: 0 }))];
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: {
    items: rows, ranking_pending: true, source_error: { status: 502, code: 'http-403' },
  } }, 200, { 'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/tim-kiem-nang-cao/trang-1?sort=4' }))
    .mockResolvedValueOnce(new Response('<div class="list_grid">QQ catalog</div>'))
    .mockResolvedValueOnce(json({ data: { items: fullRows, ranking_pending: false } }));
  vi.stubGlobal('fetch', fetcher);
  const result = await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'Bearer verified-reader' } }, 35_000);
  const payload = await result.json();
  expect(payload.data.items).toHaveLength(42);
  expect(payload.data.ranking_pending).toBe(false);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    api, 'https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge/tim-kiem-nang-cao/trang-1?sort=4', api,
  ]);
  expect(fetcher.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer verified-reader' });
});

it('keeps source errors when recovery fails and rejects paths outside the fixed relay', async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ detail: 'Unavailable' }, 502, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '//other.example/secret',
  }));
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(api, {}, 10_000)).status).toBe(502);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not retry unrelated failures or authentication requests through QQ', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ detail: 'Unavailable' }, 503)));
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(api, {}, 10_000)).status).toBe(503);
  expect((await fetchWithTruyenQQRelay('https://auth.mangahub.art/login', { method: 'POST', body: 'secret' }, 10_000)).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('authenticates only the owned relay during whitelist recovery', async () => {
  setSiteAccessRestricted(true);
  const fetcher = vi.fn().mockResolvedValueOnce(json({}, 502, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/doc-truyen',
  })).mockResolvedValueOnce(new Response('<div class="list_grid"></div>'))
    .mockResolvedValueOnce(json({ data: { items: [] } }));
  vi.stubGlobal('fetch', fetcher);
  await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'Bearer allowed-reader' } }, 10_000);
  expect(fetcher.mock.calls[1][0]).toBe('https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge/doc-truyen');
  expect(fetcher.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer allowed-reader' }, credentials: 'omit' });
});

it('does not warm Cloudflare after successful catalog or homepage reads', async () => {
  const data = { data: { source_url: 'https://truyenqqko.com/truyen-moi-cap-nhat/trang-1', items: [] } };
  const fetcher = vi.fn().mockImplementation(async () => json({ ...data, latest: data, ongoing: data }));
  vi.stubGlobal('fetch', fetcher);
  await fetchWithTruyenQQRelay(api, {}, 10_000);
  await fetchWithTruyenQQRelay('https://api.mangahub.art/api/manga/homepage', {}, 10_000);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([api, 'https://api.mangahub.art/api/manga/homepage']);
});

it('warms a blocked source path once instead of repeating an ineffective recovery', async () => {
  const blocked = () => json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/truyen-tranh/repeated-123-chap-1',
  });
  const fetcher = vi.fn().mockResolvedValueOnce(blocked())
    .mockResolvedValueOnce(new Response('chapter_content')).mockResolvedValueOnce(blocked());
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(api, {}, 10_000)).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('shares failed manifest recovery across sequential chapter images and retries only after cooldown', async () => {
  vi.useFakeTimers();
  const blocked = () => json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/truyen-tranh/shared-123-chap-1',
  });
  const fetcher = vi.fn().mockImplementation(async (url: string) =>
    url.includes('workers.dev') ? new Response('source denied', { status: 403 }) : blocked());
  vi.stubGlobal('fetch', fetcher);
  for (let index = 1; index <= 8; index++) {
    expect((await fetchWithTruyenQQRelay(`https://api.mangahub.art/api/manga/truyenqq/image/shared-123/1/${index}`, {}, 10_000)).status).toBe(503);
  }
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_001);
  await fetchWithTruyenQQRelay(api, {}, 10_000);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(2);
});

it('reports the same remaining relay cooldown to every waiting image without extending or bypassing it', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(async (url: string) => url.includes('workers.dev')
    ? new Response('Temporary relay failure', { status: 503 })
    : json({ detail: 'Source unavailable' }, 503, { 'X-TruyenQQ-Error': 'http-403',
      'X-TruyenQQ-Source-Path': '/truyen-tranh/cooldown-shared-123-chap-1' }));
  vi.stubGlobal('fetch', fetcher);
  const first = await fetchWithTruyenQQRelay(api, {}, 60_000);
  expect(first.headers.get('Retry-After')).toBe('30');
  expect(await first.json()).toEqual({ detail: 'Source unavailable' });
  await vi.advanceTimersByTimeAsync(10_000);
  const second = await fetchWithTruyenQQRelay(api + '&image=2', {}, 60_000);
  expect(second.headers.get('Retry-After')).toBe('20');
  await vi.advanceTimersByTimeAsync(19_000);
  expect((await fetchWithTruyenQQRelay(api + '&image=3', {}, 60_000)).headers.get('Retry-After')).toBe('1');
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await fetchWithTruyenQQRelay(api, {}, 60_000)).headers.get('Retry-After')).toBe('30');
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(2);
});

it('shares successful recovery hints but still asks the backend to authorize each image', async () => {
  const blocked = () => json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/truyen-tranh/successful-123-chap-1',
  });
  let apiCalls = 0;
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('workers.dev')) return new Response('chapter_content');
    return ++apiCalls % 2 ? blocked() : new Response('page', { headers: { 'Content-Type': 'image/jpeg' } });
  });
  vi.stubGlobal('fetch', fetcher);
  for (let index = 1; index <= 3; index++) expect((await fetchWithTruyenQQRelay(api, {}, 10_000)).ok).toBe(true);
  expect(apiCalls).toBe(6);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
});

it('hands a signed successful source response to the same API read instead of asking the remote cache again', async () => {
  setSiteAccessRestricted(true);
  const html = '<div class="list_grid">Fresh QQ titles</div>';
  const proof = 'signed-source-proof';
  const fetcher = vi.fn().mockResolvedValueOnce(json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/tim-kiem-nang-cao/trang-5?category=85&sort=2',
    'X-TruyenQQ-Recovery': '1',
  })).mockResolvedValueOnce(new Response(html, { headers: { 'X-TruyenQQ-Proof': proof } }))
    .mockResolvedValueOnce(json({ data: { items: Array.from({ length: 24 }, (_, index) => ({ slug: `book-${index}` })) } }));
  vi.stubGlobal('fetch', fetcher);
  const response = await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'Bearer reader' } }, 10_000);
  expect((await response.json()).data.items).toHaveLength(24);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const retry = fetcher.mock.calls[2][1];
  expect(retry.method).toBe('POST');
  expect(new Headers(retry.headers).get('Authorization')).toBe('Bearer reader');
  expect(new Headers(retry.headers).get('X-TruyenQQ-Recovery')).toBe('1');
  expect(JSON.parse(retry.body)).toEqual({ html, proof });
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
});

it('uses the actual standby image host for a handoff and never retries its snapshot through disabled Vercel', async () => {
  const original = 'https://api.mangahub.art/api/manga/truyenqq/image/book-123/1/2';
  const standby = original.replace('https://api.mangahub.art', 'https://standby.mangahub.art');
  const blocked = json({}, 503, { 'X-TruyenQQ-Error': 'http-403',
    'X-TruyenQQ-Source-Path': '/truyen-tranh/book-123-chap-1', 'X-TruyenQQ-Recovery': '1' });
  Object.defineProperty(blocked, 'url', { value: standby });
  const fetcher = vi.fn().mockResolvedValueOnce(blocked)
    .mockResolvedValueOnce(new Response('chapter_content', { headers: { 'X-TruyenQQ-Proof': 'proof' } }))
    .mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(original, {}, 10_000)).ok).toBe(true);
  expect(fetcher.mock.calls[2][0]).toBe(standby);
  expect(fetcher.mock.calls[2][1].method).toBe('POST');
});

it('keeps the older recovery transport when the backend has not enabled signed handoffs', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({}, 503, {
    'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/doc-truyen',
  })).mockResolvedValueOnce(new Response('list_grid', { headers: { 'X-TruyenQQ-Proof': 'proof' } }))
    .mockResolvedValueOnce(json({ data: { items: [] } }));
  vi.stubGlobal('fetch', fetcher);
  await fetchWithTruyenQQRelay(api, {}, 10_000);
  expect(fetcher.mock.calls[2][1].method).toBeUndefined();
  expect(fetcher.mock.calls[2][1].body).toBeUndefined();
});

it('changing one page cannot cancel a shared source recovery needed by another page', async () => {
  const first = new AbortController();
  let finish!: (response: Response) => void;
  const blocked = () => json({}, 503, { 'X-TruyenQQ-Error': 'http-403',
    'X-TruyenQQ-Source-Path': '/truyen-tranh/shared-navigation-123-chap-1', 'X-TruyenQQ-Recovery': '1' });
  const fetcher = vi.fn().mockImplementation(async (url, options) => {
    if (url.includes('workers.dev')) return new Promise<Response>(resolve => { finish = resolve; });
    return options.method === 'POST' ? json({ data: { items: [{ slug: 'recovered' }] } }) : blocked();
  });
  vi.stubGlobal('fetch', fetcher);
  const previous = fetchWithTruyenQQRelay(api, { signal: first.signal }, 10_000);
  const cancelled = expect(previous).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const next = fetchWithTruyenQQRelay(api, {}, 10_000);
  // Let the second response body finish and subscribe to the shared fill,
  // before a separate UI event aborts the old page's request.
  await new Promise(resolve => setTimeout(resolve, 0));
  first.abort();
  finish(new Response('chapter_content', { headers: { 'X-TruyenQQ-Proof': 'proof' } }));
  await cancelled;
  expect((await next).ok).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
});

it('renders valid stale pages immediately and shares their bounded background repair', async () => {
  let finish!: (response: Response) => void;
  const notify = vi.fn();
  window.addEventListener('mangahub:qq-source-recovered', notify);
  const fetcher = vi.fn().mockImplementation(async (url, options) => {
    if (url.includes('workers.dev')) return new Promise<Response>(resolve => { finish = resolve; });
    return options.method === 'POST' ? json({ data: { items: [{ slug: 'new-chapter' }] } }) :
      json({ data: { items: [{ slug: 'last-good' }] } }, 200, {
        'X-TruyenQQ-Stale': '1', 'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Recovery': '1',
        'X-TruyenQQ-Source-Path': '/tim-kiem-nang-cao/trang-1?sort=2',
      });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const responses = await Promise.all([fetchWithTruyenQQRelay(api, {}, 10_000), fetchWithTruyenQQRelay(api, {}, 10_000)]);
    for (const response of responses) expect((await response.json()).data.items[0].slug).toBe('last-good');
    expect(notify).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('workers.dev'))).toHaveLength(1);
    finish(new Response('list_grid', { headers: { 'X-TruyenQQ-Proof': 'proof' } }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  } finally { window.removeEventListener('mangahub:qq-source-recovered', notify); }
});

it('keeps the rendered last-good body readable when background source recovery fails', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: { items: [{ slug: 'last-good' }] } }, 200, {
    'X-TruyenQQ-Stale': '1', 'X-TruyenQQ-Error': 'http-403',
    'X-TruyenQQ-Source-Path': '/truyen-moi-cap-nhat/trang-1',
  })).mockResolvedValueOnce(new Response('blocked', { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  const response = await fetchWithTruyenQQRelay(api, {}, 10_000);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await response.json()).data.items[0].slug).toBe('last-good');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

const cookieDeniedSource = () => json({}, 503, { 'X-TruyenQQ-Error': 'http-403',
  'X-TruyenQQ-Source-Path': '/truyen-tranh/cookie-reader-123', 'X-TruyenQQ-Recovery': '1' });

it('never restores authorization for healthy reads, unrelated failures, or a ready token', async () => {
  setSiteAccessRestricted(true);
  const restore = vi.fn().mockResolvedValue('Bearer restored');
  const fetcher = vi.fn().mockResolvedValueOnce(json({ data: {} }))
    .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(cookieDeniedSource())
    .mockResolvedValueOnce(new Response('book_info', { headers: { 'X-TruyenQQ-Proof': 'proof' } }))
    .mockResolvedValueOnce(json({ data: {} }));
  vi.stubGlobal('fetch', fetcher);
  await fetchWithTruyenQQRelay(api, {}, 10_000, restore);
  await fetchWithTruyenQQRelay(api, {}, 10_000, restore);
  await fetchWithTruyenQQRelay(api, { headers: { Authorization: 'Bearer ready' } }, 10_000, restore);
  expect(restore).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it.each([null, 'throws'])('does not spend a relay request when restoring authorization fails (%s)', async result => {
  setSiteAccessRestricted(true);
  const restore = vi.fn(async () => { if (result === 'throws') throw new Error('offline');return null; });
  const fetcher = vi.fn().mockImplementation(async () => cookieDeniedSource());
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchWithTruyenQQRelay(api, {}, 10_000, restore)).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(1);
});

it.each(['deadline', 'abort', 'logout'])('stops cookie recovery after %s without sending a late relay request', async reason => {
  vi.useFakeTimers();
  setSiteAccessRestricted(true);
  let finish!: (authorization: string | null) => void;
  const restore = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve; }));
  const fetcher = vi.fn().mockImplementation(async () => cookieDeniedSource());
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const running = fetchWithTruyenQQRelay(api, { signal: controller.signal }, 200, restore);
  const checked = reason === 'abort' ? expect(running).rejects.toMatchObject({ name: 'AbortError' })
    : expect(running).resolves.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(0);
  expect(restore).toHaveBeenCalledTimes(1);
  if (reason === 'deadline') await vi.advanceTimersByTimeAsync(201);
  else if (reason === 'abort') controller.abort();
  else clearQQRecovery();
  finish('Bearer late-restored-reader');
  await checked;
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
