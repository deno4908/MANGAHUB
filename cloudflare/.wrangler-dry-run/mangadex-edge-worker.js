var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// mangadex-edge-worker.js
var MANGADEX_API = "https://api.mangadex.org";
var CHAPTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=20, s-maxage=20",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}
__name(json, "json");
var mangadex_edge_worker_default = {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const url = new URL(request.url);
    const prefix = "/api/mangadex-edge/chapter/";
    if (!url.pathname.startsWith(prefix)) return json({ error: "Not found" }, 404);
    const chapterId = url.pathname.slice(prefix.length).trim();
    if (!CHAPTER_ID_RE.test(chapterId)) return json({ error: "Invalid chapter ID" }, 400);
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${prefix}${chapterId}`, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const upstream = await fetch(`${MANGADEX_API}/at-home/server/${chapterId}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "MangaHub-Edge/1.0"
      },
      cf: {
        cacheTtl: 20,
        cacheEverything: true
      }
    });
    if (!upstream.ok) {
      return json({ error: `MangaDex HTTP ${upstream.status}` }, upstream.status);
    }
    const payload = await upstream.json();
    const response = json(payload);
    await cache.put(cacheKey, response.clone());
    return response;
  }
};
export {
  mangadex_edge_worker_default as default
};
//# sourceMappingURL=mangadex-edge-worker.js.map
