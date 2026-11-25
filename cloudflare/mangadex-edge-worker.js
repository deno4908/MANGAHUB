const MANGADEX_API = "https://api.mangadex.org";
const QQ_PREFIX = "/api/truyenqq-edge";
const QQ_SOURCE = "https://truyenqqko.com";
const SITE_ACCESS_URL = "https://api.mangahub.art/api/site-access";

async function checkSiteAccess(request, env) {
  let failure = 'network';
  try {
    const authorization = request.headers.get('Authorization');
    const accessOptions = {
      headers: { Accept: 'application/json', 'User-Agent': 'MangaHub-Access-Relay/1.0', ...(authorization ? { Authorization: authorization } : {}) },
      redirect: 'manual', signal: AbortSignal.timeout(6000),
    };
    const response = env?.ACCESS_ROUTER ? await env.ACCESS_ROUTER.fetch(new Request(SITE_ACCESS_URL,accessOptions)) : await fetch(SITE_ACCESS_URL,accessOptions);
    // An edge challenge is not a decision by our access policy. Keep access
    // closed without telling an approved reader that their grant was revoked.
    if (response.headers.get('cf-mitigated') === 'challenge' ||
        ([401, 403].includes(response.status) && response.headers.get('Content-Type')?.includes('text/html'))) {
      failure = 'edge-challenge';
      await response.body?.cancel();
      throw new Error('Access endpoint challenged');
    }
    if (response.status === 401 || response.status === 403) {
      const denied = await response.json().catch(() => null);
      const reason = ({ COUNTRY_NOT_SUPPORTED: 'country', ACCESS_TICKET_REVOKED: 'ticket',
        WHITELIST_REQUIRED: 'whitelist' })[denied?.code] || 'authentication';
      return json({ code: 'WHITELIST_REQUIRED', detail: 'Bạn không nằm trong whitelist của website.' }, 403, {
        'Cache-Control': 'no-store', 'X-Site-Access-Error': 'http-' + response.status,
        'X-Site-Access-Denial': reason,
      });
    }
    failure = 'http-' + response.status;
    if (!response.ok) throw new Error('Access policy unavailable');
    failure = 'invalid-json';
    const policy = await response.json();
    failure = 'invalid-policy';
    if (typeof policy.enabled !== 'boolean' || typeof policy.allowed !== 'boolean') throw new Error('Invalid access policy');
    if (!policy.allowed) return json({ code: 'WHITELIST_REQUIRED', detail: policy.message }, 403, { 'Cache-Control': 'no-store', 'X-Site-Access-Error': policy.authenticated ? 'policy-authenticated' : 'policy-anonymous' });
    return null;
  } catch {
    return json({ error: 'Không thể kiểm tra quyền truy cập.' }, 503, { 'Cache-Control': 'no-store', 'X-Site-Access-Error': failure });
  }
}
const QQ_PAGES = /^\/(?:doc-truyen|tim-kiem-nang-cao|truyen-moi-cap-nhat|truyen-tranh-moi|truyen-hoan-thanh|truyen-yeu-thich|truyen-dich-qq|top-ngay|top-tuan|top-thang|the-loai|tac-gia|truyen-tranh)(?:\/[a-zA-Z0-9._-]+)*$/;

export async function fetchQQOrigin(path, query, body) {
  const search = path === "/frontend/search/search";
  const validPath = QQ_PAGES.test(path) || /^\/sitemap(?:-[a-zA-Z0-9-]+)?\.xml$/.test(path);
  if ((!search && !validPath) || query.length > 2048 || (query && !query.startsWith("?")) ||
      (body && (!search || body.length > 2048))) throw new Error("Invalid QQ source request");
  const upstream = await fetch(QQ_SOURCE + path + query, {
    method: search ? "POST" : "GET", redirect: "manual", body,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "vi,en;q=0.7", Referer: QQ_SOURCE + "/",
      ...(search ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const html = await upstream.text();
  const headers = new Headers(upstream.headers);
  if (upstream.status === 403) {
    const blocked = /cf-chl-|challenge-platform|Just a moment/i.test(html) ? "challenge"
      : /cf-error-details|Attention Required|Cloudflare Ray ID/i.test(html) ? "cloudflare-block"
        : /403 Forbidden/i.test(html) ? "origin-forbidden" : "source-denied";
    headers.set("X-TruyenQQ-Block", blocked);
  }
  return { status: upstream.status, headers: [...headers], body: html };
}

async function qqSource(request, url) {
  const path = url.pathname.slice(QQ_PREFIX.length);
  const search = path === "/frontend/search/search";
  const listing = QQ_PAGES.test(path) || /^\/sitemap(?:-[a-zA-Z0-9-]+)?\.xml$/.test(path);
  if ((!search && !listing) || url.search.length > 2048) return json({ error: "Not found" }, 404);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400",
  } });
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

  const cache = globalThis.caches?.default;
  const cacheUrl = new URL(url);
  if (search) cacheUrl.searchParams.set("qq_search", new URLSearchParams(body).get("search"));
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const serve = (response, hit) => {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-TruyenQQ-Cache", hit ? "HIT" : "MISS");
    return new Response(response.body, { status: response.status, headers });
  };
  const cached = cache && await cache.match(cacheKey);
  if (cached) return serve(cached, true);

  try {
    const result = await fetchQQOrigin(path, url.search, body);
    const upstream = new Response(result.body, { status: result.status, headers: result.headers });
    const headers = new Headers(upstream.headers);
    headers.set("Cache-Control", "public, max-age=120");
    headers.set("X-TruyenQQ-Relay", "1");
    headers.set("X-TruyenQQ-Colo", request.cf?.colo || "-");
    headers.delete("Set-Cookie");
    headers.delete("Expires");
    headers.delete("Pragma");
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    const html = await upstream.text();
    const value = new Response(html, { status: upstream.status, headers });
    const valid = search ? /search_info|no_result/.test(html)
      : /list_grid|book_info|chapter_content|<sitemapindex|<urlset/.test(html);
    // A browser and the backend can share valid public source pages. Never
    // preserve a challenge/error page, an authenticated response, or cookies.
    if (cache && upstream.status === 200 && valid) await cache.put(cacheKey, value.clone());
    return serve(value, false);
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'OPTIONS' && (url.pathname.startsWith(QQ_PREFIX + '/') || url.pathname.startsWith('/api/mangadex-edge/chapter/'))) {
      const denied = await checkSiteAccess(request, env);
      if (denied) return denied;
    }
    if (url.pathname.startsWith(QQ_PREFIX + "/")) return qqSource(request, url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }

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
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  },
};
