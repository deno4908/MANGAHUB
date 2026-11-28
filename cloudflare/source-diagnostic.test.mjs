import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceDiagnostic } from './source-diagnostic-worker.js';

const env = { OPERATOR_PROBE_SECRET: 'fixture-only' };
const request = (query = 'case=latest', options = {}) => new Request('https://fixture.invalid/?' + query,
  { ...options, headers: { 'X-MangaHub-Source-Probe': 'fixture-only', ...options.headers } });

test('missing credentials and caller-selected URLs never reach the source', async () => {
  const worker = createSourceDiagnostic(() => { throw new Error('must not fetch'); });
  for (const r of [request('case=latest', { headers: { 'X-MangaHub-Source-Probe': '' } }),
    request('case=latest&url=https://untrusted.example'), request('case=https://untrusted.example'),
    request('case=__proto__'), request('case=detail', { method: 'POST', body: 'private' })])
    assert.equal((await worker.fetch(r, env)).status, 404);
  assert.equal((await worker.fetch(request(), {})).status, 404);
});

test('only fixed public paths are read and source content or credentials never appear in results', async () => {
  const calls = [];
  const worker = createSourceDiagnostic(async (...args) => {
    calls.push(args);
    return { status: 200, headers: [['CF-Ray', 'fixture-SIN']], body: 'list_grid book_info private-body' };
  });
  for (const name of ['latest', 'detail']) {
    const response = await worker.fetch(request('case=' + name, { headers: {
      Authorization: 'Bearer private-fixture', Cookie: 'private-cookie',
    } }), env);
    const text = await response.text();
    const value = JSON.parse(text);
    assert.equal(value.valid, true);assert.equal(value.sourceColo, 'SIN');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(!text.includes('private'));
  }
  assert.deepEqual(calls, [['/truyen-moi-cap-nhat', ''],
    ['/truyen-tranh/xin-loi-vi-toi-khong-the-roi-mat-khoi-ve-ngoai-cua-ngai-17629', '']]);
});

test('a challenge, missing source markers or a transport failure never reports a usable source', async () => {
  for (const read of [async () => ({ status: 403, headers: [], body: 'Just a moment private-body' }),
    async () => ({ status: 200, headers: [], body: 'unrecognized' }),
    async () => { throw new Error('private exception'); }]) {
    const response = await createSourceDiagnostic(read).fetch(request(), env);
    const text = await response.text();
    assert.equal(JSON.parse(text).valid, false);
    assert.ok(!text.includes('private'));
  }
});
