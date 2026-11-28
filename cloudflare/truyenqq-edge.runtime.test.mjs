import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Installed into a temporary CI directory, never bundled into the Worker.
const require = createRequire(import.meta.url);
const { Miniflare, Response: RuntimeResponse } = require(process.env.MANGAHUB_MINIFLARE_MODULE || 'miniflare');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('workerd shares only pending plain data across requests, retaining revocation and independent bodies', { timeout: 15000 }, async () => {
  const access = gate(), source = gate(), started = gate();
  let checks = 0, reads = 0, allowed = true;
  const mf = new Miniflare({
    modules: true, cf: false, compatibilityDate: '2026-06-10',
    scriptPath: fileURLToPath(new URL('./mangadex-edge-worker.js', import.meta.url)),
    bindings: { QQ_RECOVERY_SECRET: 'fixture-workerd-signing-key-not-production' },
    serviceBindings: { ACCESS_ROUTER: async request => {
      checks++;
      assert.equal(request.headers.get('Authorization'), 'Bearer workerd-reader');
      assert.equal(request.headers.get('Cookie'), null);
      await access.promise;
      return RuntimeResponse.json({ enabled: true, allowed });
    } },
    outboundService: async request => {
      reads++; started.resolve();
      assert.equal(new URL(request.url).hostname, 'truyenqqko.com');
      assert.equal(request.headers.get('Authorization'), null);
      assert.equal(request.headers.get('Cookie'), null);
      await source.promise;
      return new RuntimeResponse('<div class="list_grid">Runtime public page</div>');
    },
  });
  try {
    await mf.ready;
    const url = 'https://worker.example/api/truyenqq-edge/doc-truyen';
    const options = { headers: { Authorization: 'Bearer workerd-reader', Cookie: 'fixture=private' } };
    const jobs = Array.from({ length: 12 }, () => mf.dispatchFetch(url, options));
    await pause(100); access.resolve(); await started.promise; await pause(100); source.resolve();
    const responses = await Promise.all(jobs);
    assert.ok(responses.every(response => response.status === 200));
    assert.ok(responses.every(response => response.headers.has('X-TruyenQQ-Proof')));
    assert.ok((await Promise.all(responses.map(response => response.text())))
      .every(body => body === '<div class="list_grid">Runtime public page</div>'));
    assert.equal(reads, 1); assert.equal(checks, 1);
    // The completed public cache is reusable, the completed grant is not.
    allowed = false;
    const denied = await mf.dispatchFetch(url, options);
    assert.equal(denied.status, 403); assert.equal(checks, 2); assert.equal(reads, 1);
    allowed = true;
    const cached = await mf.dispatchFetch(url, options);
    assert.equal(cached.status, 200); assert.equal(cached.headers.get('X-TruyenQQ-Cache'), 'HIT');
    assert.equal(checks, 3); assert.equal(reads, 1);
  } finally { access.resolve(); source.resolve(); await mf.dispose(); }
});

test('workerd keeps a shared source read alive when its first client disconnects', { timeout: 15000 }, async () => {
  const source = gate(), started = gate();
  let reads = 0;
  const mf = new Miniflare({
    modules: true, cf: false, compatibilityDate: '2026-06-10',
    scriptPath: fileURLToPath(new URL('./mangadex-edge-worker.js', import.meta.url)),
    serviceBindings: { ACCESS_ROUTER: async () => RuntimeResponse.json({ enabled: true, allowed: true }) },
    outboundService: async () => {
      reads++; started.resolve(); await source.promise;
      return new RuntimeResponse('<div class="chapter_content">Surviving source read</div>');
    },
  });
  try {
    await mf.ready;
    const url = 'https://worker.example/api/truyenqq-edge/truyen-tranh/runtime-book-123';
    const controller = new AbortController();
    const owner = mf.dispatchFetch(url, { signal: controller.signal }).catch(error => error);
    await started.promise;
    const survivor = mf.dispatchFetch(url);
    await pause(100); controller.abort(); await pause(50); source.resolve();
    const response = await survivor;
    assert.equal(response.status, 200); assert.match(await response.text(), /Surviving source read/);
    assert.equal(reads, 1); await owner;
  } finally { source.resolve(); await mf.dispose(); }
});
