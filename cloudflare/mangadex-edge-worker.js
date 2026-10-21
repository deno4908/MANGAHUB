const MANGADEX_API = "https://api.mangadex.org";
const QQ_PREFIX = "/api/truyenqq-edge";
const QQ_SOURCE = "https://truyenqqko.com";
const QQ_PAGES = /^\/(?:doc-truyen|tim-kiem-nang-cao|truyen-moi-cap-nhat|truyen-tranh-moi|truyen-hoan-thanh|truyen-yeu-thich|truyen-dich-qq|top-ngay|top-tuan|top-thang|the-loai|tac-gia|truyen-tranh)(?:\/[a-zA-Z0-9._-]+)*$/;

async function qqSource(request, url) {
  const path = url.pathname.slice(QQ_PREFIX.length);
  const search = path === "/frontend/search/search";
  const listing = QQ_PAGES.test(path) || /^\/sitemap(?:-[a-zA-Z0-9-]+)?\.xml$/.test(path);
  if ((!search && !listing) || url.search.length > 2048) return json({ error: "Not found" }, 404);
  if (request.method !== (search ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);

  let body;
  if (search) {
    const reader = request.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) { await reader.cancel(); return json({ error: "Search too long" }, 413); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const form = new URLSearchParams(new TextDecoder().decode(bytes));
    const keyword = (form.get("search") || "").trim();
    if (!keyword || keyword.length > 200) return json({ error: "Invalid search" }, 400);
    body = new URLSearchParams({ search: keyword, type: "0" }).toString();
  }

  try {
    const upstream = await fetch(QQ_SOURCE + path + url.search, {
      method: request.method, redirect: "manual", body,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "vi,en;q=0.7",
        Referer: QQ_SOURCE + "/",
        ...(search ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    const headers = new Headers(upstream.headers);
    headers.set("Cache-Control", "no-store");
    headers.delete("Set-Cookie");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return json({ error: "Source unavailable" }, 502, { "Cache-Control": "no-store" });
  }
}
const CHAPTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=20, s-maxage=20",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(QQ_PREFIX + "/")) return qqSource(request, url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

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
        "User-Agent": "MangaHub-Edge/1.0",
      },
      cf: {
        cacheTtl: 20,
        cacheEverything: true,
      },
    });

    if (!upstream.ok) {
      return json({ error: `MangaDex HTTP ${upstream.status}` }, upstream.status);
    }

    const payload = await upstream.json();
    const response = json(payload);
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
