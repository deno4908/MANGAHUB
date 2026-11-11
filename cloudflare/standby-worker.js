import { denyOutsideVietnam } from './standby-country.js';

const FRONT = 'mangahub.art', API = 'api.mangahub.art', AUTH = 'auth.mangahub.art';
const HOSTS = [FRONT, API, AUTH];
const SAFE = method => ['GET', 'HEAD'].includes(method);
const FAILED = status => [500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(status);
const TTL = 30_000;

export function createStandbyWorker(send = fetch, now = Date.now) {
  const regions = new Map();
  function state(request) {
    const colo = request.cf?.colo || 'unknown';
    if (!regions.has(colo)) {
      if (regions.size >= 100) regions.delete(regions.keys().next().value);
      regions.set(colo, { expires: 0, primary: {}, backup: {}, recovery: {}, busyUntil: 0 });
    }
    return regions.get(colo);
  }
  function backupOrigin(env) {
    const value = new URL(env.BACKUP_ORIGIN);
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' ||
        value.search || value.hash || HOSTS.includes(value.hostname)) throw new Error('Invalid standby configuration');
    return value.origin;
  }
  async function timed(url, options = {}, ms = 5000) {
    const started = now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await send(url, { ...options, redirect: 'manual', signal: controller.signal });
      const value = response.status === 200 ? await response.json() : null;
      if (!value) await response.body?.cancel();
      return { response, value, milliseconds: Math.max(0, now() - started) };
    } finally { clearTimeout(timer); }
  }
  async function primaryProbe(host) {
    const path = host === API ? '/health' : '/auth/health';
    try {
      const { response, value, milliseconds } = await timed('https://' + host + path, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, cf: { cacheTtl: 0 },
      });
      return { ok: response.status === 200 && value?.status === 'ok', milliseconds };
    } catch { return { ok: false }; }
  }
  async function backupProbe(env, checkFrontend) {
    try {
      const { value, milliseconds } = await timed(backupOrigin(env) + '/internal/origin-status' + (checkFrontend ? '?check_frontend=1' : ''), {
        headers: { 'X-MangaHub-Origin-Secret': env.STANDBY_ORIGIN_SECRET,
          'X-MangaHub-Public-Host': API, 'Cache-Control': 'no-cache' }, cf: { cacheTtl: 0 },
      });
      return { ok: value?.status === 'ready', capacity: value?.accept_extra === true, milliseconds,
        primaryFrontend: value?.primary_frontend_ok };
    } catch { return { ok: false, capacity: false }; }
  }
  function adopt(previous, measured, recoveries, key) {
    if (!measured.ok) { recoveries[key] = 0; return measured; }
    if (previous?.ok === false && (recoveries[key] = (recoveries[key] || 0) + 1) < 2) return { ...measured, ok: false };
    recoveries[key] = 0;
    return { ...measured, milliseconds: previous?.milliseconds === undefined ? measured.milliseconds
      : previous.milliseconds * .6 + measured.milliseconds * .4 };
  }
  async function refresh(s, env) {
    if (s.pending) return s.pending;
    s.pending = (async () => {
      const [api, auth, backup] = await Promise.all([primaryProbe(API), primaryProbe(AUTH), backupProbe(env, s.primary[FRONT]?.ok === false)]);
      s.primary[API] = adopt(s.primary[API], api, s.recovery, API);
      s.primary[AUTH] = adopt(s.primary[AUTH], auth, s.recovery, AUTH);
      // A primary API probe must not stand in for a frontend probe. Frontend
      // observations come from real requests, without the Under Attack layer.
      s.backup = adopt(s.backup, backup, s.recovery, 'backup');
      if (typeof backup.primaryFrontend === 'boolean') s.primary[FRONT] = adopt(s.primary[FRONT],
        { ok: backup.primaryFrontend }, s.recovery, FRONT);
      s.expires = now() + TTL;
    })().finally(() => { s.pending = undefined; });
    return s.pending;
  }
  function bucket(request) {
    const cookie = request.headers.get('cookie') || '';
    const existing = cookie.match(/(?:^|;\s*)mh_route=([a-f0-9]{8})(?:;|$)/)?.[1];
    const id = existing || crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    return { value: parseInt(id, 16) % 100, id, fresh: !existing };
  }
  function choose(s, host, b, env) {
    const primary = s.primary[host];
    if (primary?.ok === false) return s.backup.ok ? 'backup' : 'primary';
    if (host === FRONT || env.BALANCE_ENABLED !== 'true' || !s.backup.ok || !s.backup.capacity) return 'primary';
    const faster = Number.isFinite(primary?.milliseconds) &&
      s.backup.milliseconds + 100 < primary.milliseconds * .8;
    const congested = now() < s.busyUntil;
    // The 1 GB standby has a deliberately bounded share while both hosts are
    // healthy. An actual primary outage is handled above, independently.
    const share = faster || congested ? 25 : 10;
    return b.value < share ? 'backup' : 'primary';
  }
  async function proxy(request, env, target) {
    const headers = new Headers(request.headers), source = new URL(request.url);
    for (const name of ['X-MangaHub-Origin-Secret', 'X-MangaHub-Public-Host', 'X-MangaHub-Client-IP',
      'Host', 'X-Real-IP', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto']) headers.delete(name);
    let url = source.href;
    if (target === 'backup') {
      url = backupOrigin(env) + source.pathname + source.search;
      headers.set('X-MangaHub-Origin-Secret', env.STANDBY_ORIGIN_SECRET);
      headers.set('X-MangaHub-Public-Host', source.hostname);
      headers.set('X-MangaHub-Client-IP', request.headers.get('CF-Connecting-IP') || 'unknown');
    }
    // Bound waiting for response headers, not streaming bodies or SSE lifetime.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    try {
      return await send(new Request(url, { method: request.method, headers,
        body: SAFE(request.method) ? undefined : request.body, redirect: 'manual', signal, duplex: 'half' }));
    } finally { clearTimeout(timer); }
  }
  function publicResponse(response, request, b) {
    const result = new Response(response.body, response);
    for (const header of ['X-MangaHub-Origin', 'X-MangaHub-Origin-Secret', 'X-MangaHub-Public-Host', 'X-MangaHub-Client-IP']) result.headers.delete(header);
    const path = new URL(request.url).pathname;
    if (b?.fresh && (new URL(request.url).hostname !== FRONT || request.headers.get('accept')?.includes('text/html')) && !path.startsWith('/assets/')) {
      result.headers.append('Set-Cookie', `mh_route=${b.id}; Domain=mangahub.art; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Lax`);
    }
    return result;
  }
  function unavailable(request) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' };
    if (request.headers.get('Origin') === 'https://' + FRONT) {
      headers['Access-Control-Allow-Origin'] = 'https://' + FRONT;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    return new Response(JSON.stringify({ detail: 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại.' }), { status: 503, headers });
  }
  return {
    async fetch(request, env, ctx) {
      const incoming = new URL(request.url), host = incoming.hostname;
      // Operator-only fixed health targets. Never proxy caller-selected URLs,
      // cookies or response bodies through this diagnostic endpoint.
      if (incoming.pathname === '/internal/router-probe') {
        if (!env.STANDBY_ORIGIN_SECRET || request.headers.get('X-MangaHub-Probe-Secret') !== env.STANDBY_ORIGIN_SECRET) return new Response('Not found', { status: 404 });
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        const kind = incoming.searchParams.get('kind') || 'api';
        const target = incoming.searchParams.get('target') || 'primary';
        if (!['api','auth','frontend','readiness'].includes(kind) || !['primary','backup'].includes(target)) return new Response('Invalid probe', { status: 400 });
        if (kind === 'readiness') return Response.json(await backupProbe(env, false), { headers: { 'Cache-Control':'no-store' } });
        const canonical = kind === 'api' ? API : kind === 'auth' ? AUTH : FRONT;
        const path = kind === 'api' ? '/health' : kind === 'auth' ? '/auth/health' : '/';
        try {
          const response = await proxy(new Request('https://' + canonical + path), env, target);
          const type = response.headers.get('Content-Type');
          await response.body?.cancel();
          return Response.json({ status: response.status, type, originMarker: response.headers.has('X-MangaHub-Origin') }, { headers:{'Cache-Control':'no-store'} });
        } catch { return Response.json({status:503}, {headers:{'Cache-Control':'no-store'}}); }
      }
      if (!HOSTS.includes(host)) return new Response('Not found', { status: 404 });
      if (host === FRONT) { const denied = denyOutsideVietnam(request); if (denied) return denied; }
      if (env.FAILOVER_ENABLED !== 'true') return publicResponse(await send(request), request);
      if (!env.STANDBY_ORIGIN_SECRET || !env.BACKUP_ORIGIN) return publicResponse(await send(request), request);
      const s = state(request), b = bucket(request);
      if (now() >= s.expires) {
        const job = refresh(s, env);
        // Check readiness before selecting an origin for a mutation. Never
        // repeat a submitted write, even after a network error or a 5xx.
        if (!SAFE(request.method)) await job;
        else ctx.waitUntil(job);
      }
      const target = choose(s, host, b, env);
      let response;
      try { response = await proxy(request, env, target); }
      catch {
        if (!SAFE(request.method)) return unavailable(request);
      }
      // QQ failures are source failures with browser recovery hints, not an
      // outage of Vercel/VPS. Authorization and ordinary client errors pass on.
      const sourceFailure = response?.headers.has('X-TruyenQQ-Error');
      if (response && (!FAILED(response.status) || sourceFailure || !SAFE(request.method))) {
        if (response.status === 429 && !sourceFailure) s.busyUntil = now() + TTL;
        if (host === FRONT && response.ok) s.primary[FRONT] = { ok: true };
        return publicResponse(response, request, b);
      }
      const alternative = target === 'primary' ? 'backup' : 'primary';
      // A previous negative health sample is advisory for a fresh read error:
      // the other origin might have recovered since the last periodic probe.
      if (response) await response.body?.cancel();
      try {
        const retry = await proxy(request, env, alternative);
        if (retry.ok) {
          if (target === 'primary') { s.primary[host] = { ok: false }; s.recovery[host] = 0; }
          else s.backup.ok = false;
          s.expires = Math.min(s.expires, now() + 5000);
        }
        return publicResponse(retry, request, b);
      } catch { return unavailable(request); }
    },
  };
}
export default createStandbyWorker();
