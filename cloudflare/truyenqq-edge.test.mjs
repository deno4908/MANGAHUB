import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { qqSourceProof } from './mangadex-edge-worker.js';
import { createHash, createHmac, webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const originalFetch = globalThis.fetch;
const accessUrl = 'https://api.mangahub.art/api/site-access';
function mockFetch(handler, policy = { enabled: false, allowed: true }) {
  globalThis.fetch = (url, options) => String(url) === accessUrl
    ? Promise.resolve(Response.json(policy)) : handler(url, options);
}

afterEach(() => { globalThis.fetch = originalFetch; });
const edge = 'https://worker.example/api/truyenqq-edge';

test('source access checks use the router binding and still fail closed',async()=>{
  let called=0;
  const env={ACCESS_ROUTER:{fetch:async r=>{
    called++;assert.equal(r.url,accessUrl);
    assert.equal(r.headers.get('Authorization'),'Bearer reader');
    assert.equal(r.headers.get('Cookie'),null);
    return Response.json({enabled:true,allowed:false},{status:403});
  }}};
  globalThis.fetch=()=>{throw new Error('denied reader must not reach source');};
  const r=await worker.fetch(new Request(edge+'/doc-truyen',{headers:{Authorization:'Bearer reader',Cookie:'private=fixture'}}),env);
  assert.equal(r.status,403);assert.equal(called,1);
});

test('a challenge of the policy endpoint is unavailable, never a false whitelist revocation',async()=>{
  for (const headers of [
    {'Content-Type':'text/html','cf-mitigated':'challenge'},
    {'Content-Type':'text/html; charset=UTF-8'},
  ]) {
    let checks=0;
    const env={ACCESS_ROUTER:{fetch:async()=>{
      checks++;return new Response('private edge challenge',{status:403,headers});
    }}};
    globalThis.fetch=()=>{throw new Error('A challenged policy must not reach source');};
    const r=await worker.fetch(new Request(edge+'/doc-truyen'),env);
    assert.equal(r.status,503);assert.equal(checks,1);
    assert.equal(r.headers.get('X-Site-Access-Error'),'edge-challenge');
    assert.equal(r.headers.get('Cache-Control'),'no-store');
    assert.doesNotMatch(await r.text(),/WHITELIST_REQUIRED|private edge challenge/);
  }
});

test('policy denial diagnostics expose only fixed categories without leaking user data',async()=>{
  for (const [code,reason] of [['COUNTRY_NOT_SUPPORTED','country'],['ACCESS_TICKET_REVOKED','ticket'],
    ['WHITELIST_REQUIRED','whitelist'],['private-user-data','authentication']]) {
    const env={ACCESS_ROUTER:{fetch:async()=>Response.json({code,detail:'private-user-data'},{status:403})}};
    globalThis.fetch=()=>{throw new Error('Denied request must not reach source');};
    const r=await worker.fetch(new Request(edge+'/doc-truyen'),env);
    assert.equal(r.status,403);
    assert.equal(r.headers.get('X-Site-Access-Denial'),reason);
    assert.doesNotMatch(await r.text(),/private-user-data/);
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

test('source proofs bind exact HTML, path, query and original freshness without extra fetches', async () => {
  const secret = 'fixture-qq-source-signing-key-not-production';
  const html = '<div class="list_grid">Truyện mới</div>';
  const path = '/tim-kiem-nang-cao/trang-5?category=85&sort=2';
  const proof = await qqSourceProof(path, '', 1000, html, secret, 1029);
  const [encoded, signature] = proof.split('.');
  const raw = Buffer.from(encoded, 'base64url');
  const metadata = JSON.parse(raw);
  assert.deepEqual(metadata, { v: 1, path, keyword: '', observed: 1000, expires: 1030,
    sha256: createHash('sha256').update(html).digest('hex') });
  assert.equal(signature, createHmac('sha256', secret).update(raw).digest('base64url'));
  assert.equal(await qqSourceProof(path, '', 1000, html, secret, 1030), null);
  assert.equal(await qqSourceProof(path, '', 1200, html, secret, 1000), null);
});

test('authorized source reads carry a verifiable handoff while denied/challenge pages do not', async () => {
  const secret = 'fixture-qq-source-signing-key-not-production';
  let reads = 0;
  mockFetch(async () => { reads++;return new Response('<div class="book_info">Source detail</div>'); });
  const response = await worker.fetch(new Request(edge + '/truyen-tranh/book-123'), { QQ_RECOVERY_SECRET: secret });
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-TruyenQQ-Proof');
  const [encoded, signature] = response.headers.get('X-TruyenQQ-Proof').split('.');
  const raw = Buffer.from(encoded, 'base64url');
  assert.equal(JSON.parse(raw).sha256, createHash('sha256').update(await response.text()).digest('hex'));
  assert.equal(signature, createHmac('sha256', secret).update(raw).digest('base64url'));
  mockFetch(async () => new Response('chapter_content challenge-platform', { status: 403 }));
  const challenge = await worker.fetch(new Request(edge + '/truyen-tranh/book-123'), { QQ_RECOVERY_SECRET: secret });
  assert.equal(challenge.headers.get('X-TruyenQQ-Proof'), null);
});

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function concurrentContext() {
  const jobs = [];
  return { waitUntil: job => jobs.push(job), done: () => Promise.all(jobs) };
}
function reader(path, token = 'same-reader', options = {}) {
  return new Request(edge + path, { ...options, headers: { Authorization: 'Bearer ' + token, ...options.headers } });
}

test('a cold concurrent burst checks one reader once and fills the public source cache once', async () => {
  const access = gate(), source = gate(), started = gate(), ctx = concurrentContext();
  let checks = 0, reads = 0, writes = 0;
  const env = { ACCESS_ROUTER: { fetch: async () => {
    checks++; await access.promise; return Response.json({ enabled: true, allowed: true });
  } }, QQ_RECOVERY_SECRET: 'fixture-concurrent-source-signing-key-not-production' };
  const oldCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async (_, response) => {
    writes++; assert.match(await response.text(), /Concurrent page/);
  } } };
  globalThis.fetch = async () => {
    reads++; started.resolve(); await source.promise;
    return new Response('<div class="list_grid">Concurrent page</div>', { headers: { 'Set-Cookie': 'private=fixture' } });
  };
  try {
    const pending = Array.from({ length: 12 }, () => worker.fetch(reader('/doc-truyen'), env, ctx));
    await turn(); assert.equal(checks, 1); assert.equal(reads, 0);
    access.resolve(); await started.promise; await turn(); assert.equal(reads, 1);
    source.resolve();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(responses.map(response => response.text()));
    assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(checks, 1);
    assert.ok(bodies.every(body => body === '<div class="list_grid">Concurrent page</div>'));
    assert.ok(responses.every(response => response.status === 200 && !response.headers.has('Set-Cookie')));
    assert.ok(responses.every(response => response.headers.has('X-TruyenQQ-Proof')));
    await ctx.done();
  } finally { access.resolve(); source.resolve(); globalThis.caches = oldCaches; }
});

test('separate readers authorize independently and a denied reader cannot join an allowed source read', async () => {
  const source = gate(), started = gate(), ctx = concurrentContext();
  let reads = 0, checks = 0;
  const env = { ACCESS_ROUTER: { fetch: async request => {
    checks++;
    return Response.json({ enabled: true, allowed: request.headers.get('Authorization') !== 'Bearer denied' });
  } } };
  globalThis.fetch = async () => {
    reads++; started.resolve(); await source.promise; return new Response('<div class="book_info">Shared public detail</div>');
  };
  const first = worker.fetch(reader('/truyen-tranh/concurrent-book-123', 'allowed-one'), env, ctx);
  try {
    await started.promise;
    const second = worker.fetch(reader('/truyen-tranh/concurrent-book-123', 'allowed-two'), env, ctx);
    const denied = await worker.fetch(reader('/truyen-tranh/concurrent-book-123', 'denied'), env, ctx);
    assert.equal(denied.status, 403); assert.equal(reads, 1);
    source.resolve();
    assert.deepEqual(await Promise.all([first, second].map(async job => (await job).text())),
      ['<div class="book_info">Shared public detail</div>', '<div class="book_info">Shared public detail</div>']);
    assert.equal(checks, 3); assert.equal(reads, 1); await ctx.done();
  } finally { source.resolve(); }
});

test('source query strings and normalized search keywords retain independent concurrent results', async () => {
  const release = gate(), ctx = concurrentContext();
  let reads = 0;
  mockFetch(async (url, options) => {
    reads++; await release.promise;
    return new Response('<div class="search_info list_grid">' + url + (options.body || '') + '</div>');
  });
  const inputs = [reader('/doc-truyen?sort=1'), reader('/doc-truyen?sort=2'),
    reader('/frontend/search/search', 'search-reader', { method: 'POST', body: 'search=one+piece&type=1' }),
    reader('/frontend/search/search', 'search-reader', { method: 'POST', body: 'search=one+piece&type=99' }),
    reader('/frontend/search/search', 'search-reader', { method: 'POST', body: 'search=naruto' })];
  const jobs = inputs.map(request => worker.fetch(request, undefined, ctx));
  try {
    // Body parsing is asynchronous; let all requests reach the source gate.
    for (let i = 0; i < 5; i++) await turn();
    assert.equal(reads, 4);
    release.resolve();
    const bodies = await Promise.all(jobs.map(async job => (await job).text()));
    assert.match(bodies[0], /sort=1/); assert.match(bodies[1], /sort=2/);
    assert.equal(bodies[2], bodies[3]); assert.match(bodies[4], /search=naruto/);
    assert.equal(reads, 4); await ctx.done();
  } finally { release.resolve(); }
});

test('completed policy decisions are not cached and revocation blocks even an existing source cache', async () => {
  const access = gate(), ctx = concurrentContext();
  let allowed = true, checks = 0, cacheReads = 0;
  const env = { ACCESS_ROUTER: { fetch: async () => {
    checks++; await access.promise; return Response.json({ enabled: true, allowed });
  } } };
  const oldCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => {
    cacheReads++; return new Response('<div class="list_grid">Cached public page</div>');
  } } };
  globalThis.fetch = () => { throw new Error('Cached page must not refetch source'); };
  try {
    const first = worker.fetch(reader('/doc-truyen', 'revocable-reader'), env, ctx);
    const second = worker.fetch(reader('/doc-truyen', 'revocable-reader'), env, ctx);
    await turn(); assert.equal(checks, 1); access.resolve();
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    allowed = false;
    const denied = await worker.fetch(reader('/doc-truyen', 'revocable-reader'), env, ctx);
    assert.equal(denied.status, 403); assert.equal(checks, 2); assert.equal(cacheReads, 2);
    await ctx.done();
  } finally { access.resolve(); globalThis.caches = oldCaches; }
});

test('concurrent denials have independent bodies and a failed access check is retried on the next request', async () => {
  for (const status of [403, 503]) {
    const release = gate(), ctx = concurrentContext();
    let checks = 0;
    const env = { ACCESS_ROUTER: { fetch: async () => {
      checks++; await release.promise;
      return Response.json({ code: 'WHITELIST_REQUIRED', detail: 'private-source-detail' }, { status });
    } } };
    globalThis.fetch = () => { throw new Error('Failed access must never reach the source'); };
    const jobs = [worker.fetch(reader('/doc-truyen'), env, ctx), worker.fetch(reader('/doc-truyen'), env, ctx)];
    await turn(); assert.equal(checks, 1); release.resolve();
    const responses = await Promise.all(jobs);
    assert.deepEqual(responses.map(response => response.status), [status, status]);
    const bodies = await Promise.all(responses.map(response => response.text()));
    assert.equal(bodies[0], bodies[1]); assert.doesNotMatch(bodies[0], /private-source-detail/);
    assert.equal((await worker.fetch(reader('/doc-truyen'), env, ctx)).status, status);
    assert.equal(checks, 2); await ctx.done();
  }
});

test('source failures are shared only while pending and do not poison a later attempt', async () => {
  for (const failure of ['challenge', 'network']) {
    const release = gate(), started = gate(), ctx = concurrentContext();
    let reads = 0;
    mockFetch(async () => {
      reads++; started.resolve(); await release.promise;
      if (reads > 1) return new Response('<div class="list_grid">Recovered page</div>');
      if (failure === 'network') throw new Error('private network failure');
      return new Response('<html>Just a moment challenge-platform</html>', { status: 403 });
    });
    const jobs = [worker.fetch(reader('/doc-truyen'), undefined, ctx), worker.fetch(reader('/doc-truyen'), undefined, ctx)];
    try {
      await started.promise; await turn(); assert.equal(reads, 1); release.resolve();
      const responses = await Promise.all(jobs);
      assert.deepEqual(responses.map(response => response.status), failure === 'network' ? [502, 502] : [403, 403]);
      if (failure === 'challenge') assert.ok(responses.every(response => response.headers.get('X-TruyenQQ-Block') === 'challenge'));
      const retry = await worker.fetch(reader('/doc-truyen'), undefined, ctx);
      assert.equal(retry.status, 200); assert.match(await retry.text(), /Recovered page/);
      assert.equal(reads, 2); await ctx.done();
    } finally { release.resolve(); }
  }
});

test('access coalescing remains bounded without delaying distinct readers or mixing their network identity', async () => {
  const release = gate(), ctx = concurrentContext();
  let checks = 0;
  const env = { ACCESS_ROUTER: { fetch: async () => {
    checks++; await release.promise; return Response.json({ enabled: true, allowed: false });
  } } };
  globalThis.fetch = () => { throw new Error('Denied readers must not reach source'); };
  const jobs = Array.from({ length: 65 }, (_, index) => worker.fetch(reader('/doc-truyen', 'bounded-' + index), env, ctx));
  jobs.push(worker.fetch(reader('/doc-truyen', 'bounded-0'), env, ctx));
  jobs.push(worker.fetch(reader('/doc-truyen', 'bounded-64'), env, ctx));
  jobs.push(worker.fetch(reader('/doc-truyen', 'bounded-0', { headers: { 'CF-Connecting-IP': '192.0.2.10' } }), env, ctx));
  try {
    await turn(); assert.equal(checks, 67); release.resolve();
    assert.ok((await Promise.all(jobs)).every(response => response.status === 403));
    await ctx.done();
  } finally { release.resolve(); }
});
