import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './mangadex-edge-worker.js';

const originalFetch = globalThis.fetch;
const accessUrl = 'https://api.mangahub.art/api/site-access';
function mockFetch(handler, policy = { enabled: false, allowed: true }) {
  globalThis.fetch = (url, options) => String(url) === accessUrl
    ? Promise.resolve(Response.json(policy)) : handler(url, options);
}

afterEach(() => { globalThis.fetch = originalFetch; });
const edge = 'https://worker.example/api/truyenqq-edge';

test('source access goes through the bound failover router without forwarding credentials to QQ', async () => {
  let checked = 0, reads = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://truyenqqko.com/doc-truyen');
    assert.equal(options.headers.Authorization, undefined);
    reads++;
    return new Response('<div class="list_grid">source</div>');
  };
  const env = { SITE_ACCESS_ROUTER: { fetch: async (url, options) => {
    assert.equal(url, accessUrl);
    assert.equal(options.headers.Authorization, 'AccessTicket fixture-reader');
    assert.equal(options.headers.Cookie, undefined);
    checked++;
    return Response.json({enabled:true, allowed:true});
  } } };
  const response = await worker.fetch(new Request(edge+'/doc-truyen', {
    headers:{Authorization:'AccessTicket fixture-reader', Cookie:'private-cookie'},
  }), env);
  assert.equal(response.status,200);assert.equal(checked,1);assert.equal(reads,1);
});

test('bound router denials and failures stop before fetching source content', async () => {
  globalThis.fetch = async () => {throw new Error('Source must not be reached');};
  for (const status of [403,503]) {
    const response = await worker.fetch(new Request(edge+'/doc-truyen'), {
      SITE_ACCESS_ROUTER: {fetch: async()=>new Response('{}',{status})},
    });
    assert.equal(response.status,status);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
});

test('QQ filters relay to the fixed source with the full page and query', async () => {
  mockFetch(async (url, options) => {
    assert.equal(url, 'https://truyenqqko.com/tim-kiem-nang-cao/trang-7?sort=4&category=26');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Referer, 'https://truyenqqko.com/');
    assert.equal(options.headers.Authorization, undefined);
    return new Response('<div class="list_grid">Source results</div>', {
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'source-cookie=private' },
    });
  });
  const result = await worker.fetch(new Request(edge + '/tim-kiem-nang-cao/trang-7?sort=4&category=26', {
    headers: { Authorization: 'private-token', Cookie: 'private-session' },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.match(await result.text(), /Source results/);
});

test('QQ keyword search preserves the encoded form while dropping unrelated fields', async () => {
  mockFetch(async (url, options) => {
    assert.equal(url, 'https://truyenqqko.com/frontend/search/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'search=one+piece&type=0');
    return new Response('<li>One Piece</li>');
  });
  const response = await worker.fetch(new Request(edge + '/frontend/search/search', {
    method: 'POST', body: 'search=one+piece&type=999&url=https://other.example',
  }));
  assert.equal(response.status, 200);
});

test('QQ relay denies arbitrary hosts, mutation endpoints, methods, and oversized input', async () => {
  mockFetch(async () => { throw new Error('Must not reach upstream'); });
  for (const path of ['/https://other.example', '//other.example', '/frontend/comment/add', '/login']) {
    assert.equal((await worker.fetch(new Request(edge + path))).status, 404);
  }
  assert.equal((await worker.fetch(new Request(edge + '/doc-truyen', { method: 'POST', body: 'x' }))).status, 405);
  assert.equal((await worker.fetch(new Request(edge + '/frontend/search/search', {
    method: 'POST', body: 'search=' + 'a'.repeat(3000),
  }))).status, 413);
});

test('QQ source HTTP failures and redirects are preserved for the backend', async () => {
  for (const status of [403, 429, 503, 302]) {
    mockFetch(async () => new Response('source response', {
      status, headers: status === 302 ? { Location: 'https://other.example/' } : {},
    }));
    assert.equal((await worker.fetch(new Request(edge + '/doc-truyen'))).status, status);
  }
});

test('the existing MangaDex chapter endpoint still uses its original API and cache', async () => {
  const previousCaches = globalThis.caches;
  let cached = false;
  globalThis.caches = { default: {
    match: async () => undefined,
    put: async () => { cached = true; },
  } };
  const chapter = '5a3162a6-b124-4107-a65b-5ef10bbd2fe1';
  mockFetch(async url => {
    assert.equal(url, 'https://api.mangadex.org/at-home/server/' + chapter);
    return new Response(JSON.stringify({ result: 'ok', chapter: { hash: 'hash', data: ['1.jpg'] } }));
  });
  try {
    const response = await worker.fetch(new Request('https://worker.example/api/mangadex-edge/chapter/' + chapter));
    assert.equal((await response.json()).result, 'ok');
    assert.equal(cached, true);
  } finally { globalThis.caches = previousCaches; }
});

test('a valid reader fetch is shared with the backend; blocked pages never poison that cache', async () => {
  const previousCaches = globalThis.caches;
  const pages = new Map();
  globalThis.caches = { default: {
    match: async request => pages.get(request.url)?.clone(),
    put: async (request, response) => { pages.set(request.url, response.clone()); },
  } };
  let fetches = 0;
  mockFetch(async () => {
    fetches++;
    return new Response('<div class="list_grid">QQ records</div>');
  });
  try {
    const url = edge + '/tim-kiem-nang-cao/trang-60?sort=4';
    assert.equal((await worker.fetch(new Request(url))).headers.get('X-TruyenQQ-Cache'), 'MISS');
    mockFetch(async () => { throw new Error('Source rejects backend IP'); });
    const cached = await worker.fetch(new Request(url));
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get('X-TruyenQQ-Cache'), 'HIT');
    assert.equal(cached.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(await cached.text(), /QQ records/);
    assert.equal(fetches, 1);
    assert.equal((await worker.fetch(new Request(edge + '/doc-truyen'))).status, 502);
    assert.equal(pages.size, 1);
    mockFetch(async () => new Response('<html>Challenge</html>'));
    await worker.fetch(new Request(edge + '/doc-truyen'));
    assert.equal(pages.size, 1);
  } finally { globalThis.caches = previousCaches; }
});

test('a Cloudflare challenge is classified without exposing source HTML in diagnostics', async () => {
  mockFetch(async () => new Response('<html>Just a moment... /cdn-cgi/challenge-platform/</html>', { status: 403 }));
  const response = await worker.fetch(new Request(edge + '/doc-truyen'));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('X-TruyenQQ-Block'), 'challenge');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('whitelist denial takes precedence over both QQ and MangaDex cached content', async () => {
  const oldCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => { throw new Error('Must authorize before reading cache'); } } };
  mockFetch(async () => { throw new Error('Must not load source for a denied reader'); }, { enabled: true, allowed: false });
  try {
    for (const url of [edge + '/doc-truyen', 'https://worker.example/api/mangadex-edge/chapter/5a3162a6-b124-4107-a65b-5ef10bbd2fe1']) {
      const response = await worker.fetch(new Request(url));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'WHITELIST_REQUIRED');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  } finally { globalThis.caches = oldCaches; }
});

test('edge checks a website token only with the website API, never the QQ source', async () => {
  let checked = false;
  globalThis.fetch = async (url, options) => {
    if (String(url) === accessUrl) {
      assert.equal(options.headers.Authorization, 'Bearer allowed-reader');
      assert.equal(options.redirect, 'manual');
      checked = true;
      return Response.json({ enabled: true, allowed: true });
    }
    assert.equal(checked, true);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    return new Response('<div class="list_grid">Authorized source</div>');
  };
  const response = await worker.fetch(new Request(edge + '/doc-truyen', { headers: { Authorization: 'Bearer allowed-reader' } }));
  assert.equal(response.status, 200);
});

test('edge fails closed if the access service is unavailable or returns malformed policy', async () => {
  for (const response of [new Response('private failure', { status: 500 }), new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }), Response.json({})]) {
    globalThis.fetch = async url => { assert.equal(String(url), accessUrl); return response; };
    const result = await worker.fetch(new Request(edge + '/doc-truyen'));
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await result.text(), /private failure/);
  }
});
