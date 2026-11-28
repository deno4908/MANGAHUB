import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Installed in a temporary CI directory; never bundled into the Worker.
const require = createRequire(import.meta.url);
const { Miniflare, Response: RuntimeResponse } = require(process.env.MANGAHUB_MINIFLARE_MODULE || 'miniflare');
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline(job) {
  let timer;
  try {
    return await Promise.race([job, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('A newer reader waited behind an unrelated slow read')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
const options = { headers: { Authorization: 'Bearer fixture-reader', Cookie: 'private=fixture' } };

test('workerd lets a new reader finish while an older policy lookup is stalled, and still enforces revocation', { timeout: 15000 }, async () => {
  const hold = gate(), started = gate();
  let checks = 0, reads = 0, allowed = true, first;
  const mf = new Miniflare({
    modules: true, cf: false, compatibilityDate: '2026-06-10',
    scriptPath: fileURLToPath(new URL('./mangadex-edge-worker.js', import.meta.url)),
    serviceBindings: { ACCESS_ROUTER: async request => {
      checks++;
      assert.equal(request.headers.get('Authorization'), options.headers.Authorization);
      assert.equal(request.headers.get('Cookie'), null);
      if (checks === 1) { started.resolve(); await hold.promise; }
      return RuntimeResponse.json({ enabled: true, allowed });
    } },
    outboundService: async request => {
      reads++;
      assert.equal(new URL(request.url).hostname, 'truyenqqko.com');
      assert.equal(request.headers.get('Authorization'), null);
      assert.equal(request.headers.get('Cookie'), null);
      return new RuntimeResponse('<div class="list_grid">Public page</div>');
    },
  });
  try {
    await mf.ready;
    const url = 'https://worker.example/api/truyenqq-edge/doc-truyen';
    first = mf.dispatchFetch(url, options);
    await started.promise;
    const fresh = await deadline(mf.dispatchFetch(url, options));
    assert.equal(fresh.status, 200); assert.match(await fresh.text(), /Public page/);
    assert.equal(checks, 2); assert.equal(reads, 1);
    hold.resolve(); assert.equal((await first).status, 200);
    allowed = false;
    const denied = await mf.dispatchFetch(url, options);
    assert.equal(denied.status, 403); assert.equal(checks, 3); assert.equal(reads, 1);
  } finally { hold.resolve(); await first?.catch(() => {}); await mf.dispose(); }
});

test('workerd lets a new source read finish while an older cold read of the same page is stalled', { timeout: 15000 }, async () => {
  const hold = gate(), started = gate();
  let reads = 0, first;
  const mf = new Miniflare({
    modules: true, cf: false, compatibilityDate: '2026-06-10',
    scriptPath: fileURLToPath(new URL('./mangadex-edge-worker.js', import.meta.url)),
    bindings: { QQ_RECOVERY_SECRET: 'fixture-workerd-signing-key-not-production' },
    serviceBindings: { ACCESS_ROUTER: async () => RuntimeResponse.json({ enabled: true, allowed: true }) },
    outboundService: async () => {
      const number = ++reads;
      if (number === 1) { started.resolve(); await hold.promise; }
      return new RuntimeResponse('<div class="book_info">Read ' + number + '</div>');
    },
  });
  try {
    await mf.ready;
    const url = 'https://worker.example/api/truyenqq-edge/truyen-tranh/runtime-book-123';
    first = mf.dispatchFetch(url, options);
    await started.promise;
    const fresh = await deadline(mf.dispatchFetch(url, options));
    assert.equal(fresh.status, 200); assert.match(await fresh.text(), /Read 2/);
    assert.ok(fresh.headers.has('X-TruyenQQ-Proof')); assert.equal(reads, 2);
    hold.resolve(); const older = await first;
    assert.equal(older.status, 200); assert.match(await older.text(), /Read 1/);
  } finally { hold.resolve(); await first?.catch(() => {}); await mf.dispose(); }
});
