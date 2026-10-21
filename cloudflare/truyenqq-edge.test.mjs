import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './mangadex-edge-worker.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const edge = 'https://worker.example/api/truyenqq-edge';

test('QQ filters relay to the fixed source with the full page and query', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://truyenqqko.com/tim-kiem-nang-cao/trang-7?sort=4&category=26');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Referer, 'https://truyenqqko.com/');
    assert.equal(options.headers.Authorization, undefined);
    return new Response('<div class="list_grid">Source results</div>', {
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'source-cookie=private' },
    });
  };
  const result = await worker.fetch(new Request(edge + '/tim-kiem-nang-cao/trang-7?sort=4&category=26', {
    headers: { Authorization: 'private-token', Cookie: 'private-session' },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.match(await result.text(), /Source results/);
});

test('QQ keyword search preserves the encoded form while dropping unrelated fields', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://truyenqqko.com/frontend/search/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'search=one+piece&type=0');
    return new Response('<li>One Piece</li>');
  };
  const response = await worker.fetch(new Request(edge + '/frontend/search/search', {
    method: 'POST', body: 'search=one+piece&type=999&url=https://other.example',
  }));
  assert.equal(response.status, 200);
});

test('QQ relay denies arbitrary hosts, mutation endpoints, methods, and oversized input', async () => {
  globalThis.fetch = async () => { throw new Error('Must not reach upstream'); };
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
    globalThis.fetch = async () => new Response('source response', {
      status, headers: status === 302 ? { Location: 'https://other.example/' } : {},
    });
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
  globalThis.fetch = async url => {
    assert.equal(url, 'https://api.mangadex.org/at-home/server/' + chapter);
    return new Response(JSON.stringify({ result: 'ok', chapter: { hash: 'hash', data: ['1.jpg'] } }));
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/api/mangadex-edge/chapter/' + chapter));
    assert.equal((await response.json()).result, 'ok');
    assert.equal(cached, true);
  } finally { globalThis.caches = previousCaches; }
});
