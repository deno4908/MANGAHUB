import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithTruyenQQRelay } from './truyenqqRelay';
import { setSiteAccessRestricted } from './siteAccessState';

afterEach(() => { setSiteAccessRestricted(false); vi.unstubAllGlobals(); });
const api = 'https://api.mangahub.art/api/manga/truyenqq-filtered?page=53';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
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
