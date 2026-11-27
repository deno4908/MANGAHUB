import { denyOutsideVietnam } from './standby-country.js';

const FRONT = 'mangahub.art', API = 'api.mangahub.art', AUTH = 'auth.mangahub.art';
const STANDBY = 'standby.mangahub.art';
const HOSTS = [FRONT, API, AUTH, STANDBY];
const SAFE = method => ['GET', 'HEAD'].includes(method);
// A CORS preflight checks permission only; retrying it never submits the
// requested mutation. Keep document navigation and body handling GET/HEAD-only.
const RETRYABLE = method => SAFE(method) || method === 'OPTIONS';
const FAILED = status => [500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(status);
const ORIGIN_FAILED = response => FAILED(response.status) || (response.status === 402 &&
  ['DEPLOYMENT_DISABLED', 'DEPLOYMENT_PAUSED'].includes(response.headers.get('X-Vercel-Error')));
const TTL = 24 * 60 * 60_000;
const SHARED_READ_TTL = 60_000;
const BUSY_TTL = 30_000;
const FRONTEND_LEASE = 120_000;

export function createStandbyWorker(send = fetch, now = Date.now, countryGate = denyOutsideVietnam) {
  const regions = new Map();
  const encoder = new TextEncoder();
  async function routeSignature(value, secret) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('frontend-route:' + value));
    return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function frontendLease(request, env) {
    const value = request.headers.get('Cookie')?.match(/(?:^|;\s*)mh_front_route=([pb]\.\d+\.[a-f0-9]{64})(?:;|$)/)?.[1];
    if (!value) return null;
    const [provider, expires, signature] = value.split('.');
    if (Number(expires) <= now() || Number(expires) > now() + FRONTEND_LEASE + 5000) return null;
    if (signature !== await routeSignature(provider + '.' + expires, env.STANDBY_ORIGIN_SECRET)) return null;
    return provider === 'b' ? 'backup' : 'primary';
  }
  async function rememberFrontend(response, target, env) {
    const value = (target === 'backup' ? 'b' : 'p') + '.' + (now() + FRONTEND_LEASE);
    response.headers.append('Set-Cookie', `mh_front_route=${value}.${await routeSignature(value, env.STANDBY_ORIGIN_SECRET)}; Domain=mangahub.art; Path=/; Max-Age=120; Secure; HttpOnly; SameSite=Lax`);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  function state(request) {
    const colo = request.cf?.colo || 'unknown';
    if (!regions.has(colo)) {
      if (regions.size >= 100) regions.delete(regions.keys().next().value);
      regions.set(colo, { expires: 0, primary: {}, backup: {}, failures: {}, busyUntil: 0 });
    }
    return regions.get(colo);
  }
  function backupOrigin(env) {
    const value = new URL(env.BACKUP_ORIGIN);
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' ||
        value.search || value.hash || [FRONT, API, AUTH].includes(value.hostname)) throw new Error('Invalid standby configuration');
    return value.origin;
  }
  async function timed(url, options = {}, ms = 5000, html = false) {
    const started = now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await send(url, { ...options, redirect: 'manual', signal: controller.signal });
      const value = response.status === 200 ? (html ? { html: response.headers.get('Content-Type')?.startsWith('text/html') } : await response.json()) : null;
      if (!value || html) await response.body?.cancel();
      return { response, value, milliseconds: Math.max(0, now() - started) };
    } finally { clearTimeout(timer); }
  }
  async function primaryProbe(host) {
    const html = host === FRONT, path = html ? '/index.html' : host === API ? '/health' : '/auth/health';
    try {
      const { response, value, milliseconds } = await timed('https://' + host + path, {
        headers: { Accept: html ? 'text/html' : 'application/json', 'Cache-Control': 'no-cache' }, cf: { cacheTtl: 0 },
      },5000,html);
      return { ok: response.status === 200 && (html ? value?.html : value?.status === 'ok'), milliseconds };
    } catch { return { ok: false }; }
  }
  async function backupProbe(env, checkFrontend) {
    try {
      const { value, milliseconds } = await timed(backupOrigin(env) + '/internal/origin-status' + (checkFrontend ? '?check_frontend=1' : ''), {
        headers: { 'X-MangaHub-Origin-Secret': env.STANDBY_ORIGIN_SECRET,
          'X-MangaHub-Public-Host': API, 'Cache-Control': 'no-cache' }, cf: { cacheTtl: 0 },
      });
      const frontend = await timed(backupOrigin(env) + '/index.html', {
        headers: { 'X-MangaHub-Origin-Secret': env.STANDBY_ORIGIN_SECRET, 'X-MangaHub-Public-Host': FRONT,
          'Cache-Control':'no-cache' }, cf: {cacheTtl:0},
      },3000,true);
      return { ok: value?.status === 'ready' && frontend.value?.html === true,
        capacity: value?.accept_extra === true, milliseconds, frontendMilliseconds:frontend.milliseconds,
        primaryFrontend: value?.primary_frontend_ok };
    } catch { return { ok: false, capacity: false }; }
  }
  async function measure(env) {
    const [front, api, auth, backup] = await Promise.all([
      primaryProbe(FRONT), primaryProbe(API), primaryProbe(AUTH), backupProbe(env, false)]);
    return { checkedAt: now(), primary: { [FRONT]: front, [API]: api, [AUTH]: auth }, backup };
  }
  function validSnapshot(value) {
    return Number.isFinite(value?.checkedAt) && value.checkedAt <= now() + 60_000 &&
      [FRONT, API, AUTH].every(host => typeof value.primary?.[host]?.ok === 'boolean') &&
      typeof value.backup?.ok === 'boolean' && typeof value.backup?.capacity === 'boolean';
  }
  async function readSnapshot(env) {
    // Read the daily file; this never checks either application's health.
    // The narrowly scoped route bypasses Workers and still requires our secret.
    try {
      const { value, milliseconds } = await timed(backupOrigin(env) + '/internal/router-health', {
        headers: { 'X-MangaHub-Origin-Secret': env.STANDBY_ORIGIN_SECRET,
          'Cache-Control': 'no-cache' }, cf: { cacheTtl: 0 },
      // A cold edge-to-Sydney TLS connection can exceed 500 ms. This reads
      // only the saved file; it never issues additional application probes.
      }, 1500);
      if (!validSnapshot(value)) return null;
      // Measure distance from this edge, not from the VPS writing the file.
      return { ...value, backup: { ...value.backup, milliseconds, frontendMilliseconds: milliseconds } };
    } catch { return null; }
  }
  async function refresh(s, env) {
    if (s.pending) return s.pending;
    s.pending = (async () => {
      // Production reads the single daily result. Direct measurement
      // is reserved for isolated operator drills/tests, never ordinary readers.
      const snapshot = env.DAILY_HEALTH_SHARED === 'true' ? await readSnapshot(env)
        : env.HEALTH_PROBE_MODE === 'operator' ? await measure(env) : null;
      if (validSnapshot(snapshot) && snapshot.checkedAt > (s.checkedAt ?? -1)) {
        s.primary = Object.fromEntries([FRONT, API, AUTH].map(host => [host, {
          ...snapshot.primary[host], ok: (s.failures[host] ?? -1) >= snapshot.checkedAt ? false : snapshot.primary[host].ok,
          milliseconds: env.DAILY_HEALTH_SHARED === 'true'
            ? s.primary[host]?.milliseconds : snapshot.primary[host].milliseconds }]));
        s.backup = { ...snapshot.backup, ok: (s.failures.backup ?? -1) >= snapshot.checkedAt ? false : snapshot.backup.ok };
        s.checkedAt = snapshot.checkedAt;
      }
      if (validSnapshot(snapshot) && snapshot.checkedAt === s.checkedAt && env.DAILY_HEALTH_SHARED === 'true') {
        s.backup.milliseconds = snapshot.backup.milliseconds;
        s.backup.frontendMilliseconds = snapshot.backup.frontendMilliseconds;
      }
      s.expires = now() + (env.DAILY_HEALTH_SHARED === 'true' || !snapshot ? SHARED_READ_TTL : TTL);
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
    // An operator can pin one trusted Cloudflare client IP for a short user
    // acceptance test. It grants no application access and expires by itself.
    if (b.test && s.backup.ok) return 'backup';
    if (env.BALANCE_ENABLED !== 'true' || !s.backup.ok || !s.backup.capacity) return 'primary';
    const standbyTime = host === FRONT ? s.backup.frontendMilliseconds : s.backup.milliseconds;
    const faster = Number.isFinite(primary?.milliseconds) &&
      standbyTime + 100 < primary.milliseconds * .8;
    const congested = now() < s.busyUntil;
    // The 1 GB standby has a deliberately bounded share while both hosts are
    // healthy. An actual primary outage is handled above, independently.
    const share = faster || congested ? 25 : host === FRONT ? 0 : 10;
    return b.value < share ? 'backup' : 'primary';
  }
  function standbyFrontendEligible(s,b,env) {
    if (!s.backup.ok) return false;
    if ([FRONT,API,AUTH].some(host=>s.primary[host]?.ok===false) || b.test) return true;
    if (env.BALANCE_ENABLED!=='true' || !s.backup.capacity) return false;
    const primary=s.primary[FRONT]?.milliseconds, backup=s.backup.frontendMilliseconds;
    return Number.isFinite(primary) && Number.isFinite(backup) && backup+100<primary*.8;
  }
  async function proxy(request, env, target) {
    const headers = new Headers(request.headers), source = new URL(request.url);
    for (const name of ['X-MangaHub-Origin-Secret', 'X-MangaHub-Public-Host', 'X-MangaHub-Client-IP',
      'Host', 'X-Real-IP', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto']) headers.delete(name);
    // Both frontends are owned by this application. The backend retains its
    // canonical callback and strict CSRF policy; translate only this exact
    // additional frontend origin, then translate its CORS response below.
    if ([API, AUTH].includes(source.hostname) && headers.get('Origin') === 'https://' + STANDBY) {
      headers.set('Origin','https://' + FRONT);
      headers.set('Referer','https://' + FRONT + '/');
    }
    let url = source.href;
    if (source.hostname === STANDBY && target === 'primary') {
      url = 'https://' + FRONT + source.pathname + source.search;
    }
    if (target === 'backup') {
      // The policy relay can originate in workers.dev, without a VN browser
      // country. Its fixed, secret-protected endpoint bypasses the public
      // frontend Worker; the backend still verifies the reader and whitelist.
      const path = source.hostname===API && source.pathname==='/api/site-access' &&
        request.method==='GET' && !headers.has('Origin')
        ? '/internal/source-access' : source.pathname;
      url = backupOrigin(env) + path + source.search;
      headers.set('X-MangaHub-Origin-Secret', env.STANDBY_ORIGIN_SECRET);
      headers.set('X-MangaHub-Public-Host', source.hostname === STANDBY ? FRONT : source.hostname);
      headers.set('X-MangaHub-Client-IP', request.headers.get('CF-Connecting-IP') || 'unknown');
    }
    // Bound waiting for response headers, not streaming bodies or SSE lifetime.
    const timeout = source.pathname === '/api/site-access' ? 2500 : 8000;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    try {
      const response = await send(new Request(url, { method: request.method, headers,
        body: SAFE(request.method) ? undefined : request.body, redirect: 'manual', signal, duplex: 'half' }));
      // Supabase's authorize URL carries an explicit, allowlisted redirect_to.
      // Change only that fixed callback for a login begun on our standby UI;
      // PKCE, provider URL, protected verifier cookie and errors stay intact.
      if (source.hostname===AUTH && request.method==='POST' && ['/auth/google','/auth/discord'].includes(source.pathname) &&
          request.headers.get('Origin')==='https://'+STANDBY && response.ok &&
          response.headers.get('Content-Type')?.includes('application/json')) {
        const value=await response.clone().json().catch(()=>null);
        if (typeof value?.url==='string') {
          let authorize;
          try { authorize=new URL(value.url); } catch { /* Preserve invalid provider responses. */ }
          if (authorize?.protocol==='https:' && authorize.pathname==='/auth/v1/authorize' &&
              authorize.searchParams.get('redirect_to')==='https://'+FRONT+'/auth/callback') {
            authorize.searchParams.set('redirect_to','https://'+STANDBY+'/auth/callback');
            const resultHeaders=new Headers(response.headers);
            for (const h of ['Content-Length','Content-Encoding','ETag']) resultHeaders.delete(h);
            resultHeaders.set('Cache-Control','private, no-store');
            await response.body?.cancel();
            return new Response(JSON.stringify({...value,url:authorize.href}),{status:response.status,headers:resultHeaders});
          }
        }
      }
      return response;
    } finally { clearTimeout(timer); }
  }
  function publicResponse(response, request, b) {
    const result = new Response(response.body, response);
    for (const header of ['X-MangaHub-Origin', 'X-MangaHub-Origin-Secret', 'X-MangaHub-Public-Host', 'X-MangaHub-Client-IP']) result.headers.delete(header);
    if (request.headers.get('Origin') === 'https://' + STANDBY && result.headers.get('Access-Control-Allow-Origin') === 'https://' + FRONT) {
      result.headers.set('Access-Control-Allow-Origin','https://' + STANDBY);
      result.headers.append('Vary','Origin');
    }
    const path = new URL(request.url).pathname;
    if (b?.fresh && (new URL(request.url).hostname !== FRONT || request.headers.get('accept')?.includes('text/html')) && !path.startsWith('/assets/')) {
      result.headers.append('Set-Cookie', `mh_route=${b.id}; Domain=mangahub.art; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Lax`);
    }
    return result;
  }
  function unavailable(request) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' };
    if (['https://' + FRONT,'https://' + STANDBY].includes(request.headers.get('Origin'))) {
      headers['Access-Control-Allow-Origin'] = request.headers.get('Origin');
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
        if (!['api','auth','frontend','readiness','drill','daily-health'].includes(kind) || !['primary','backup'].includes(target)) return new Response('Invalid probe', { status: 400 });
        if (kind === 'daily-health') {
          const snapshot = env.DAILY_HEALTH_SHARED === 'true' ? await readSnapshot(env) : null;
          return Response.json({ shared: env.DAILY_HEALTH_SHARED === 'true', initialized: validSnapshot(snapshot),
            checkedAt: validSnapshot(snapshot) ? snapshot.checkedAt : null,
            intervalHours: 24 }, { headers: { 'Cache-Control':'no-store' } });
        }
        if (kind === 'readiness') return Response.json(await backupProbe(env, true), { headers: { 'Cache-Control':'no-store' } });
        if (kind === 'drill') {
          // Exercise the real routing implementation with only the primary
          // network leg failing. State is private to this one health drill;
          // no public reader or application mutation is affected.
          const results=[];
          for (const failed of ['primary','backup']) {
            const drill=createStandbyWorker(async(input, options) => {
              const url=new URL(typeof input==='string'?input:input.url);
              const isPrimary=[FRONT,API,AUTH].includes(url.hostname);
              if (isPrimary===(failed==='primary')) throw new Error('operator outage drill');
              return send(input,options);
            },now,()=>null); // Operator reads fixed public HTML, never account data.
            const jobs=[], drillEnv={...env,FAILOVER_ENABLED:'true',BALANCE_ENABLED:'false'};
            drillEnv.DAILY_HEALTH_SHARED = 'false';
            drillEnv.HEALTH_PROBE_MODE = 'operator';
            const context={waitUntil:p=>jobs.push(p)};
            for (const [host,path] of [[API,'/health'],[AUTH,'/auth/health']]) {
              const response=await drill.fetch(new Request('https://'+host+path,{headers:{Cookie:'mh_route=00000063'}}),drillEnv,context);
              results.push({failed,service:host===API?'api':'auth',status:response.status});
              await response.body?.cancel();
            }
            const navigation=await drill.fetch(new Request('https://'+(failed==='primary'?FRONT:STANDBY)+'/',
              {headers:{Accept:'text/html',Cookie:'mh_route=00000063'}}),drillEnv,context);
            const expected='https://'+(failed==='primary'?STANDBY:FRONT)+'/';
            const redirected=navigation.status===307 && navigation.headers.get('Location')===expected;
            await navigation.body?.cancel();
            let status=503;
            if (redirected) {
              const page=await drill.fetch(new Request(expected,{headers:{Accept:'text/html',Cookie:'mh_route=00000063'}}),drillEnv,context);
              status=page.status;
              await page.body?.cancel();
            }
            results.push({failed,service:'frontend',redirected,status});
            await Promise.all(jobs);
          }
          return Response.json({recovered:results.every(r=>r.status===200),results},{headers:{'Cache-Control':'no-store'}});
        }
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
      // Origin credentials authenticate our network hop, not the reader.
      // Never add them to a public request for an internal server endpoint.
      let decodedPath;
      try { decodedPath=decodeURIComponent(incoming.pathname).replace(/\/+/g,'/'); }
      catch { return new Response('Invalid path',{status:400}); }
      if (decodedPath==='/internal' || decodedPath.startsWith('/internal/')) return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
      if (incoming.port) {
        incoming.port='';
        return new Response(null,{status:308,headers:{Location:incoming.href,'Cache-Control':'no-store'}});
      }
      if ([FRONT, STANDBY].includes(host)) { const denied = countryGate(request); if (denied) return denied; }
      if (env.FAILOVER_ENABLED !== 'true') return publicResponse(await send(request), request);
      if (!env.STANDBY_ORIGIN_SECRET || !env.BACKUP_ORIGIN) return publicResponse(await send(request), request);
      const s = state(request), b = bucket(request);
      const until = Number(env.STANDBY_TEST_UNTIL);
      b.test = !!env.STANDBY_TEST_IP && request.headers.get('CF-Connecting-IP') === env.STANDBY_TEST_IP &&
        until > now() && until <= now() + 15 * 60_000;
      if (now() >= s.expires) {
        const job = refresh(s, env);
        // Load the saved decision before selecting an origin for a mutation. Never
        // repeat a submitted write, even after a network error or a 5xx.
        // A source service binding starts without a routing lease. Select its
        // access-policy origin from the saved decision before the first read;
        // a primary edge challenge must not become a false whitelist denial.
        if (!SAFE(request.method) || b.test || host===STANDBY || incoming.pathname==='/api/site-access') await job;
        else ctx.waitUntil(job);
      }
      const frontend = [FRONT, STANDBY].includes(host);
      const navigation = frontend && SAFE(request.method) && request.headers.get('accept')?.includes('text/html') &&
        !incoming.pathname.startsWith('/assets/') && !incoming.pathname.startsWith('/api/');
      const lease = navigation ? await frontendLease(request, env) : null;
      let target = host === STANDBY ? (standbyFrontendEligible(s,b,env)?'backup':'primary') : choose(s,host,b,env);
      if (host===FRONT) {
        if (!standbyFrontendEligible(s,b,env)) target='primary';
        else if ([FRONT,API,AUTH].some(host=>s.primary[host]?.ok===false)) target='backup';
        // Finish a primary OAuth callback on its original frontend unless an
        // outage requires the other host. Both frontends use the same auth
        // host's protected PKCE cookie, including a standby-to-primary return.
        if (incoming.pathname==='/auth/callback' && s.primary[FRONT]?.ok!==false) target='primary';
      }
      // Health and latency samples are local to an isolate. Carry a short,
      // signed decision across domains so a different isolate cannot reverse
      // the redirect immediately. Actual origin errors can still fail over.
      // A sticky navigation must never keep a user on an observed failed host.
      if (lease && !(lease === 'primary' && [FRONT, API, AUTH].some(host => s.primary[host]?.ok === false)) &&
          !(lease === 'backup' && s.backup.ok === false)) target = lease;
      // Spare capacity limits new spillover, not readers already using the
      // standby UI. Its API/auth requests must not drift back to a disabled
      // Vercel deployment while a daily health sample is still catching up.
      // The same backend authentication, CSRF and whitelist checks still run.
      if ([API, AUTH].includes(host) && request.headers.get('Origin') === 'https://' + STANDBY) target='backup';
      const image = incoming.pathname.startsWith('/api/images/') ||
        /^\/api\/manga\/(?:mangadex-cover|truyenqq\/(?:cover|image))\//.test(incoming.pathname);
      // Keep warm image bytes at one origin while it is healthy. Splitting
      // covers by API affinity would turn a cache hit into a cold source fetch.
      if (host===API && image && s.primary[API]?.ok!==false) target='primary';
      async function navigationRedirect(to) {
        const destination = new URL(incoming); destination.hostname=to;
        return rememberFrontend(publicResponse(new Response(null,{status:307,headers:{Location:destination.href,'Cache-Control':'private, no-store'}}),request,b),to===STANDBY?'backup':'primary',env);
      }
      if (navigation && ((host === FRONT && target === 'backup') || (host === STANDBY && target === 'primary'))) {
        return navigationRedirect(target === 'backup' ? STANDBY : FRONT);
      }
      let response;
      const primaryHost = frontend ? FRONT : host;
      function failedOrigin(provider) {
        if (provider === 'primary') { s.primary[primaryHost] = { ...s.primary[primaryHost], ok: false }; s.failures[primaryHost] = now(); }
        else { s.backup.ok = false; s.failures.backup = now(); }
      }
      const started = now();
      try { response = await proxy(request, env, target); }
      catch {
        if (!RETRYABLE(request.method)) { failedOrigin(target); return unavailable(request); }
      }
      // QQ failures are source failures with browser recovery hints, not an
      // outage of Vercel/VPS. Authorization and ordinary client errors pass on.
      const sourceFailure = response?.headers.has('X-TruyenQQ-Error');
      if (env.DAILY_HEALTH_SHARED === 'true' && response && !ORIGIN_FAILED(response) && response.status !== 429) {
        const measured = Math.max(0, now() - started);
        const current = target === 'primary' ? (s.primary[primaryHost] ||= {}) : s.backup;
        current.milliseconds = current.milliseconds === undefined ? measured : current.milliseconds * .6 + measured * .4;
        if (target === 'backup' && frontend) current.frontendMilliseconds = current.milliseconds;
      }
      if (response && (!ORIGIN_FAILED(response) || sourceFailure || !RETRYABLE(request.method))) {
        if (ORIGIN_FAILED(response) && !sourceFailure) failedOrigin(target);
        if (response.status === 429 && !sourceFailure) s.busyUntil = now() + BUSY_TTL;
        if (host === FRONT && target === 'primary' && response.ok) s.primary[FRONT] = { ...s.primary[FRONT], ok: true };
        const result = publicResponse(response, request, b);
        return navigation && response.ok && !lease ? rememberFrontend(result,target,env) : result;
      }
      const alternative = target === 'primary' ? 'backup' : 'primary';
      // A previous negative health sample is advisory for a fresh read error:
      // the other origin might have recovered since the last periodic probe.
      if (response) await response.body?.cancel();
      try {
        const retry = await proxy(request, env, alternative);
        if (retry.ok) {
          failedOrigin(target);
          if (target === 'primary') s.backup.ok = true;
          else s.primary[primaryHost] = { ...s.primary[primaryHost], ok: true };
          if (navigation) {
            await retry.body?.cancel();
            return navigationRedirect(alternative === 'backup' ? STANDBY : FRONT);
          }
        }
        return publicResponse(retry, request, b);
      } catch { return unavailable(request); }
    },
  };
}
export default createStandbyWorker();
