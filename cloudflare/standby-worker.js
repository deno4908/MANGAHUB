import { denyOutsideVietnam } from "./standby-country.js";
const HOSTS = ["mangahub.art", "api.mangahub.art", "auth.mangahub.art"];
const safe = method => method === "GET" || method === "HEAD";
const failed = status => [500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(status);
const validModes = modes => modes && HOSTS.every(host => ["primary", "backup"].includes(modes[host]));
function drillActive(env) {
  const until = Number(env.DRILL_EXPIRES_AT) * 1000, now = Date.now();
  return Boolean(env.DRILL_CLIENT_IP && Number.isFinite(until) && until > now && until <= now + 3_600_000);
}
function isDrill(request, env) {
  return drillActive(env) && request.headers.get("CF-Connecting-IP") === env.DRILL_CLIENT_IP;
}
export function createStandbyWorker(send = fetch) {
  let modes = {}, expires = 0, refresh;
  function origin(env) {
    const u = new URL(env.BACKUP_ORIGIN);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash || HOSTS.includes(u.hostname)) throw new Error("Invalid backup origin");
    return u.origin;
  }
  async function control(env, path, init = {}) {
    return send(origin(env) + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(4000),
      headers: { ...init.headers, "X-MangaHub-Origin-Secret": env.STANDBY_ORIGIN_SECRET,
        "X-MangaHub-Public-Host": HOSTS[1], "X-MangaHub-Client-IP": "127.0.0.1" }, cf: { cacheTtl: 0 } });
  }
  async function refreshModes(env) {
    try {
      const response = await control(env, "/internal/standby-control");
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (!validModes(state.modes)) throw new Error();
      modes = Date.now() / 1000 - state.updated_at < 240 ? state.modes : {};
    } catch { modes = {}; }
    finally { expires = Date.now() + 30_000; refresh = undefined; }
  }
  async function proxy(request, env, backup) {
    // Same-zone Route fetch uses the original DNS origin, which remains Vercel.
    if (!backup) return send(request);
    const url = new URL(request.url), headers = new Headers(request.headers);
    for (const key of ["Host", "X-Real-IP", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"]) headers.delete(key);
    headers.set("X-MangaHub-Origin-Secret", env.STANDBY_ORIGIN_SECRET);
    headers.set("X-MangaHub-Public-Host", url.hostname);
    headers.set("X-MangaHub-Client-IP", request.headers.get("CF-Connecting-IP") || "unknown");
    return send(new Request(origin(env) + url.pathname + url.search, {
      method: request.method, headers, body: safe(request.method) ? undefined : request.body,
      redirect: "manual", signal: request.signal, duplex: "half",
    }));
  }
  function stamp(response, backup) {
    const result = new Response(response.body, response);
    result.headers.set("X-MangaHub-Origin", backup ? "vps" : "vercel");
    return result;
  }
  return {
    async fetch(request, env, ctx) {
      const host = new URL(request.url).hostname;
      if (!HOSTS.includes(host)) return new Response("Not found", { status: 404 });
      if (host === HOSTS[0]) { const denied = denyOutsideVietnam(request); if (denied) return denied; }
      const drill = isDrill(request, env);
      if ((!drill && env.FAILOVER_ENABLED !== "true") || !env.STANDBY_ORIGIN_SECRET || !env.BACKUP_ORIGIN) return send(request);
      // A timed single-client drill exercises the full VPS without masking failures
      // with a Vercel retry, touching other readers, or changing shared routing state.
      if (drill) return stamp(await proxy(request, env, true), true);
      // A background state read never delays the healthy Vercel path.
      if (Date.now() >= expires && !refresh) { refresh = refreshModes(env); ctx.waitUntil(refresh); }
      let backup = modes[host] === "backup";
      try {
        const response = await proxy(request, env, backup);
        // Writes might already have committed; never replay a mutation.
        if (!safe(request.method) || !failed(response.status)) return stamp(response, backup);
        await response.body?.cancel();
      } catch (error) { if (!safe(request.method)) throw error; }
      backup = !backup;
      const response = await proxy(request, env, backup);
      if (response.ok) { modes[host] = backup ? "backup" : "primary"; expires = Date.now() + 30_000; }
      return stamp(response, backup);
    },
    async scheduled(event, env, ctx) {
      const enabled = env.FAILOVER_ENABLED === "true";
      if (!enabled && !drillActive(env)) return;
      // Exercise the real Cloudflare scheduled origin probes during the timed
      // drill, while public routing still requires separate full activation.
      const ready = await control(env, enabled ? "/internal/standby-health" : "/internal/standby-drill-health");
      if (!ready.ok) { await ready.body?.cancel(); return; }
      await ready.body?.cancel();
      const health = Object.fromEntries(await Promise.all(HOSTS.map(async host => {
        const path = host === HOSTS[0] ? "/" : host === HOSTS[1] ? "/health" : "/auth/health";
        try {
          const response = await send(`https://${host}${path}`, { redirect: "manual", signal: AbortSignal.timeout(8000), cf: { cacheTtl: 0 }, headers: { "Cache-Control": "no-cache" } });
          const ok = response.status === 200 && (host !== HOSTS[0] || response.headers.get("content-type")?.includes("text/html"));
          await response.body?.cancel(); return [host, Boolean(ok)];
        } catch { return [host, false]; }
      })));
      const result = await control(env, "/internal/standby-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ health }) });
      await result.body?.cancel(); expires = 0;
    },
  };
}
export default createStandbyWorker();
