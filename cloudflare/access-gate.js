// Shared by the source Worker and Vercel routing middleware. Server-side only.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const keys = new Map();
const FALSE = new Set(['', '0', 'false', 'off', 'no']);
const TRUE = new Set(['1', 'true', 'on', 'yes']);

export function accessSettings(env = {}) {
  const required = String(env.CF_ACCESS_REQUIRED || '').trim().toLowerCase();
  if (FALSE.has(required)) return null;
  if (!TRUE.has(required)) throw new Error('Invalid Access configuration');
  let host = String(env.CF_ACCESS_TEAM_DOMAIN || '').trim();
  if (host.startsWith('https://')) host = host.slice(8);
  host = host.replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(host)) {
    throw new Error('Invalid Access configuration');
  }
  const audience = String(env.CF_ACCESS_AUD || '').split(',').map(value => value.trim());
  if (!audience.length || audience.length > 8 || audience.some(value => !/^[a-zA-Z0-9_-]{1,256}$/.test(value))) {
    throw new Error('Invalid Access configuration');
  }
  return { issuer: 'https://' + host, audience };
}

export function privateHeaders() {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
  };
}

export async function accessDecision(request, env = {}) {
  let settings;
  try { settings = accessSettings(env); }
  catch { return { enabled: true, denied: unavailable(request, 503) }; }
  if (!settings) return { enabled: false, denied: null };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  // Do not trust email/Host/CF-Ray headers or accept application bearer tokens.
  if (!token || token.length > 16_384 || token.includes(',')) {
    return { enabled: true, denied: unavailable(request, 403) };
  }
  try {
    let jwks = keys.get(settings.issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(settings.issuer + '/cdn-cgi/access/certs'), {
        timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
      });
      // Runtime settings are fixed in production; also bound development/tests.
      if (keys.size >= 8) keys.delete(keys.keys().next().value);
      keys.set(settings.issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: settings.issuer, audience: settings.audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'iss', 'aud'], clockTolerance: 0,
    });
    if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 || payload.exp <= payload.iat) {
      throw new Error('Invalid Access lifetime');
    }
    return { enabled: true, denied: null };
  } catch {
    // Key outages and malformed/expired tokens fail closed. Never log tokens.
    return { enabled: true, denied: unavailable(request, 403) };
  }
}

function unavailable(request, status) {
  return new Response(request.method === 'HEAD' ? null : 'Unavailable', {
    status, headers: { ...privateHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
