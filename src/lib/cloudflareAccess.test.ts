// @vitest-environment node
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { accessDecision, accessSettings } from '../../cloudflare/access-gate.js';
import middleware from '../../middleware';
import worker from '../../cloudflare/mangadex-edge-worker.js';

const issuer = 'https://access-tests.cloudflareaccess.com';
const env = { CF_ACCESS_REQUIRED: 'true', CF_ACCESS_TEAM_DOMAIN: issuer, CF_ACCESS_AUD: 'private-application' };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: any;
beforeAll(async () => {
  pair = await generateKeyPair('RS256', { extractable: true });
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'access-key', alg: 'RS256', use: 'sig' }] };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function token(changes = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: env.CF_ACCESS_AUD, iat: now - 1, exp: now + 120,
    email: 'member@example.test', type: 'app', ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'access-key', ...header }).sign(pair.privateKey);
}
function request(jwt?: string, path = '/', method = 'GET') {
  return new Request('https://project.vercel.app' + path, { method,
    headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : undefined });
}
function keysOnly() {
  return vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    expect(String(url)).toBe(issuer + '/cdn-cgi/access/certs');
    return Response.json(jwks);
  }));
}

it('is inactive until explicitly enabled and fails closed on malformed settings', async () => {
  expect(accessSettings({})).toBe(null);
  expect((await accessDecision(request(), {})).enabled).toBe(false);
  for (const settings of [
    { ...env, CF_ACCESS_REQUIRED: 'typo' }, { ...env, CF_ACCESS_AUD: '' },
    { ...env, CF_ACCESS_TEAM_DOMAIN: 'http://access-tests.cloudflareaccess.com' },
    { ...env, CF_ACCESS_TEAM_DOMAIN: 'access-tests.cloudflareaccess.com.evil.test' },
    { ...env, CF_ACCESS_TEAM_DOMAIN: 'access-tests.cloudflareaccess.com/private' },
    { ...env, CF_ACCESS_TEAM_DOMAIN: 'user@access-tests.cloudflareaccess.com' },
  ]) expect((await accessDecision(request(), settings)).denied?.status).toBe(503);
});

it('requires the signed assertion even with spoofed Cloudflare/email/Host or app auth headers', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('must not fetch keys for missing token'); }));
  for (const headers of [
    { 'Cf-Access-Authenticated-User-Email': 'member@example.test' }, { 'CF-Ray': 'trusted-looking' },
    { Authorization: 'Bearer app-session' }, { Cookie: 'CF_Authorization=unverified' },
    { Host: 'mangahub.art', 'X-Forwarded-Host': 'mangahub.art' },
  ]) {
    const result = await accessDecision(new Request('https://project.vercel.app/', { headers }), env);
    expect(result.denied?.status).toBe(403);
    expect(await result.denied!.text()).toBe('Unavailable');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('validates real signatures and caches the fixed issuer keys across valid requests', async () => {
  keysOnly();
  const jwt = await token();
  expect((await accessDecision(request(jwt), env)).denied).toBe(null);
  expect((await accessDecision(request(jwt), env)).denied).toBe(null);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  { aud: 'different-app' }, { iss: 'https://different-team.cloudflareaccess.com' },
  { exp: 100 }, { iat: 9999999999 }, { nbf: 9999999999 }, { exp: undefined },
  { aud: undefined }, { iss: undefined }, { iat: undefined }, { exp: '9999999999' },
])('denies invalid issuer, audience, required claims and lifetimes: %j', async changes => {
  keysOnly();
  expect((await accessDecision(request(await token(changes)), env)).denied?.status).toBe(403);
});

it('rejects forged signatures, unsigned/HS256 tokens, duplicate and oversized assertions', async () => {
  keysOnly();
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({ iss: issuer, aud: env.CF_ACCESS_AUD, exp: 9999999999, iat: 1 })
    .setProtectedHeader({ alg: 'RS256', kid: 'access-key' }).sign(other.privateKey);
  const hs = await new SignJWT({ iss: issuer, aud: env.CF_ACCESS_AUD, exp: 9999999999, iat: 1 })
    .setProtectedHeader({ alg: 'HS256', kid: 'access-key' }).sign(new TextEncoder().encode('untrusted'));
  for (const jwt of [forged, hs, 'e30.e30.', 'invalid', 'x'.repeat(16385), 'a.b.c,a.b.c']) {
    expect((await accessDecision(request(jwt), env)).denied?.status).toBe(403);
  }
});

it('fails closed when keys are unavailable and does not expose error text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private provider failure'); }));
  const result = await accessDecision(request(await token()), { ...env, CF_ACCESS_TEAM_DOMAIN: 'down.cloudflareaccess.com' });
  expect(result.denied?.status).toBe(403);
  expect(await result.denied!.text()).toBe('Unavailable');
});

it('protects frontend assets, metadata and deep links with no cacheable public content', async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  for (const path of ['/', '/manga/test', '/assets/main.js', '/favicon.ico', '/robots.txt', '/og-logo.png', '/privacy', '/sitemap.xml']) {
    const response = await middleware(request(undefined, path));
    expect(response.status).toBe(403);
    expect(response.headers.get('x-middleware-next')).toBe(null);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await response.text()).toBe('Unavailable');
  }
  expect(await (await middleware(request(undefined, '/', 'HEAD'))).text()).toBe('');
  keysOnly();
  const response = await middleware(request(await token(), '/assets/main.js'));
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store');
});

it('preserves the disabled middleware behavior', async () => {
  vi.stubEnv('CF_ACCESS_REQUIRED', 'false');
  const response = await middleware(request());
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(response.headers.get('Cache-Control')).toBe(null);
});

it('blocks all Worker paths, preflights and cached source reads before any fetch', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const cached = vi.fn(async () => new Response('private cached source data'));
  vi.stubGlobal('caches', { default: { match: cached } });
  for (const path of ['/', '/api/truyenqq-edge/doc-truyen', '/api/mangadex-edge/chapter/11111111-1111-4111-8111-111111111111']) {
    const response = await worker.fetch(request(undefined, path), env);
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  }
  expect((await worker.fetch(request(undefined, '/', 'OPTIONS'), env)).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(cached).not.toHaveBeenCalled();
});

it('sends machine credentials only to the owned API, never to QQ', async () => {
  const machineEnv = { ...env, CF_ACCESS_CLIENT_ID: 'machine-id', CF_ACCESS_CLIENT_SECRET: 'machine-secret' };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit) => {
    if (String(url).endsWith('/cdn-cgi/access/certs')) return Response.json(jwks);
    const headers = new Headers(options.headers);
    if (String(url) === 'https://api.mangahub.art/api/site-access') {
      expect(headers.get('CF-Access-Client-Id')).toBe('machine-id');
      expect(headers.get('CF-Access-Client-Secret')).toBe('machine-secret');
      return Response.json({ enabled: false, allowed: true });
    }
    expect(String(url)).toBe('https://truyenqqko.com/doc-truyen');
    expect(headers.get('CF-Access-Client-Secret')).toBe(null);
    expect(headers.get('Cf-Access-Jwt-Assertion')).toBe(null);
    expect(headers.get('Cookie')).toBe(null);
    return new Response('<div class="list_grid">QQ</div>');
  }));
  const response = await worker.fetch(request(await token(), '/api/truyenqq-edge/doc-truyen'), machineEnv);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
});
