import { afterEach, expect, it, vi } from 'vitest';
import { authApi, clearTokens, FORCE_SITE_ACCESS_EVENT, setTokens, siteAccessApi } from './api';

afterEach(() => { clearTokens({ broadcast: false }); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('captures the login token before local logout and revokes cookies on both hosts', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/api/site-access/logout') ? { ok: true } : { revoked: true }), { status: 200 });
  }));
  setTokens('test-session', undefined, { broadcast: false });
  const pending = authApi.logout();
  clearTokens({ broadcast: false });
  await pending;
  expect(requests).toHaveLength(2);
  expect(requests.map(request => new URL(request.url).pathname).sort()).toEqual(['/api/site-access/logout', '/auth/logout']);
  for (const request of requests) {
    expect(request.options.credentials).toBe('include');
    expect(new Headers(request.options.headers).get('Authorization')).toBe('Bearer test-session');
    expect(new Headers(request.options.headers).get('X-MangaHub-CSRF')).toBe('1');
  }
});

it('does not claim server revocation when both the cookie and provider revocations fail', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/api/site-access/logout') ? { detail: 'unavailable' } : { revoked: false },
  ), { status: url.endsWith('/api/site-access/logout') ? 503 : 200 })));
  await expect(authApi.logout()).rejects.toThrow();
});

it('prompts a fresh access check for a revoked ticket without treating it as a ban', async () => {
  const denied = vi.fn();
  window.addEventListener(FORCE_SITE_ACCESS_EVENT, denied);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    code: 'ACCESS_TICKET_REVOKED', detail: 'Access session revoked',
  }), { status: 403 })));
  try {
    await expect(siteAccessApi.getStatus()).rejects.toThrow('Access session revoked');
    expect(denied).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(FORCE_SITE_ACCESS_EVENT, denied); }
});
