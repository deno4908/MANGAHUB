import json
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

import httpx

from . import parsers
from .config import Settings, SourceAuth, Filters


class SourceFailure(Exception):
    def __init__(self, detail, status=502, source_status=None):
        super().__init__(detail)
        self.status = status
        self.source_status = source_status


class Runtime:
    """Shared rate limiter; only anonymous catalogue responses enter the bounded cache."""
    def __init__(self, settings):
        self.settings = settings
        # Loading the CA bundle is expensive on Windows. A TLS context contains no
        # cookies or user credentials and can be reused by otherwise isolated clients.
        self.ssl_context = httpx.create_ssl_context()
        self.lock = threading.Lock()
        self.last_request = 0.0
        self.cache = OrderedDict()

    def throttle(self):
        with self.lock:
            time.sleep(max(0, self.settings.request_delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()

    def cached(self, key, enabled, refresh, load, ttl=None):
        ttl = self.settings.cache_ttl if ttl is None else ttl
        if not enabled or ttl == 0:
            return load()
        with self.lock:
            entry = self.cache.get(key)
            if entry and not refresh and entry[0] > time.monotonic():
                self.cache.move_to_end(key)
                return deepcopy(entry[1])
        value = load()
        with self.lock:
            self.cache[key] = (time.monotonic() + ttl, deepcopy(value))
            self.cache.move_to_end(key)
            while len(self.cache) > self.settings.cache_entries:
                self.cache.popitem(last=False)
        return value


class Source:
    def __init__(self, settings: Settings, runtime: Runtime, auth: SourceAuth, transport=None):
        self.settings, self.runtime = settings, runtime
        self.cookie = auth.header()
        self.base = settings.base_url
        # Each API request owns a cookie jar; Set-Cookie can never contaminate another caller.
        self.http = httpx.Client(timeout=settings.timeout, follow_redirects=False, transport=transport, verify=runtime.ssl_context,
                                 headers={"User-Agent": settings.user_agent, "Accept-Language": "vi;q=0.9"})
        for part in self.cookie.split("; ") if self.cookie else []:
            name, _, value = part.partition("=")
            self.http.cookies.set(name, value, domain=urlsplit(self.base).hostname, path="/")

    def close(self):
        self.http.close()

    def request(self, path, *, body=None, accept="text/html,application/xhtml+xml", referer=None):
        url = urljoin(self.base + "/", path)
        method = "POST" if body is not None else "GET"
        for _ in range(5):
            if urlsplit(url).netloc != urlsplit(self.base).netloc or urlsplit(url).scheme != urlsplit(self.base).scheme:
                raise SourceFailure("Nguồn chuyển sang tên miền khác; cần cập nhật MOE_BASE_URL.")
            self.runtime.throttle()
            headers = {"Accept": accept, "Referer": referer or self.base + "/"}
            if accept.startswith("text/html"):
                headers.update({"x-bfang-fast-nav": "1", "x-bfang-fast-nav-fresh": "0"})
            response = self.http.request(method, url, json=body if method == "POST" else None, headers=headers)
            if response.is_redirect:
                url = urljoin(str(response.url), response.headers.get("location", ""))
                if response.status_code in (301, 302, 303):
                    method, body = "GET", None
                continue
            if response.is_error:
                code = response.status_code
                status = code if code in (401, 403, 404) else 503 if code == 429 else 502
                raise SourceFailure("Website nguồn từ chối hoặc trả lỗi; kiểm tra cookie/phiên đăng nhập nếu cần.", status, code)
            return response
        raise SourceFailure("Website nguồn chuyển hướng quá nhiều lần.")

    def json(self, path, body=None):
        response = self.request(path, body=body, accept="application/json")
        try:
            value = response.json()
        except ValueError:
            raise SourceFailure("Nguồn trả nội dung không phải JSON.") from None
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise SourceFailure("Nguồn không xác nhận yêu cầu thành công.")
        return value

    def listing(self, filters: Filters, refresh=False):
        body = filters.model_dump(by_alias=True)
        key = json.dumps(body, sort_keys=True, ensure_ascii=True)
        def load():
            value = self.json("/manga/filter", body)
            try:
                pagination = value["pagination"]
                items = parsers.parse_cards(value["html"], self.base)
                # Both resultCount and pageCount describe the entire result set upstream,
                # rather than the number of cards rendered on this page.
                expected = min(pagination["perPage"], max(0, pagination["total"] - pagination["offset"]))
                if len(items) != expected:
                    raise ValueError("Card count does not match source pagination")
                return {"items": items, "count": len(items), "total": pagination["total"],
                        "page": pagination["page"], "page_size": pagination["perPage"],
                        "total_pages": pagination["totalPages"], "has_next": pagination["hasNext"],
                        "has_previous": pagination["hasPrev"], "filters": value["filters"],
                        "source_url": str(httpx.URL(self.base + "/manga", params=[
                            (k, x) for k, v in body.items() for x in (v if isinstance(v, list) else [v]) if x != ""])),
                        "fetched_at": datetime.now(timezone.utc).isoformat(),
                        "cache_ttl_seconds": 0 if self.cookie else self.settings.cache_ttl}
            except (KeyError, TypeError, ValueError) as exc:
                raise SourceFailure("Không đọc được danh sách nguồn; cấu trúc nguồn có thể đã đổi.") from exc
        return self.runtime.cached(key, not self.cookie, refresh, load)

    def options(self):
        def load():
            response = self.request("/manga")
            return parsers.parse_options(response.text)
        return self.runtime.cached("options", not self.cookie, False, load, self.settings.catalog_ttl)

    def catalog(self, q="", refresh=False):
        def load():
            pending = [self.base + "/sitemap.xml"]
            visited, comics = [], {}
            while pending:
                url = pending.pop(0)
                if url in visited:
                    continue
                if len(visited) >= 64:
                    raise SourceFailure("Danh mục sitemap vượt giới hạn; chưa thể xác nhận danh sách đầy đủ.")
                response = self.request(url, accept="application/xml,text/xml")
                visited.append(url)
                try:
                    root = ET.fromstring(response.content)
                except ET.ParseError:
                    raise SourceFailure("Nguồn trả sitemap XML không hợp lệ.") from None
                kind = root.tag.rsplit("}", 1)[-1]
                locations = [node.text.strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "loc" and node.text]
                if kind == "sitemapindex":
                    maps = [u for u in locations if "chapter" not in urlsplit(u).path.lower()]
                    if not maps:
                        raise SourceFailure("Không tìm thấy sitemap danh mục truyện.")
                    pending.extend(maps)
                elif kind == "urlset":
                    for location in locations:
                        if urlsplit(location).netloc != urlsplit(self.base).netloc:
                            continue
                        try:
                            item = parsers.identity(location)
                        except ValueError:
                            continue
                        comics[item["id"]] = item
                else:
                    raise SourceFailure("Cấu trúc sitemap nguồn không hợp lệ.")
            if not comics:
                raise SourceFailure("Sitemap nguồn không có danh mục manga; không trả danh sách rỗng giả.")
            items = sorted(comics.values(), key=lambda item: int(item["id"]))
            return {"items": items, "count": len(items), "total": len(items), "complete": True,
                    "scope": "source_sitemaps", "sitemap_urls": visited, "source_url": self.base + "/sitemap.xml",
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "cache_ttl_seconds": 0 if self.cookie else self.settings.catalog_ttl}

        value = self.runtime.cached("catalog", not self.cookie, refresh, load, self.settings.catalog_ttl)
        if q.strip():
            def normalized(s):
                return "".join(c for c in unicodedata.normalize("NFKD", s.lower().replace("đ", "d")) if not unicodedata.combining(c)).replace("-", " ")
            query = normalized(q.strip())
            all_items = value["items"]
            value["items"] = [item for item in all_items if query in normalized(item["slug"])]
            value["source_total"] = len(all_items)
            value["count"] = value["total"] = len(value["items"])
        return value

    def basic(self, slug):
        detail = self.detail(slug)
        return {**{k: v for k, v in detail.items() if k not in ("chapters", "chapter_pagination")},
                "latest_chapter": detail["chapters"][0] if detail["chapters"] else None}

    def detail(self, slug, page=1, order="desc"):
        response = self.request(f"/manga/{slug}?chapterPage={page}&chapterOrder={order}")
        return parsers.parse_detail(response.text, str(response.url), page)

    def chapters(self, slug, page=1, order="desc"):
        response = self.request(f"/manga/{slug}?chapterPage={page}&chapterOrder={order}")
        return {**parsers.parse_chapters(response.text, str(response.url), page), "order": order}

    def all_chapters(self, slug, order="desc"):
        first = self.chapters(slug, 1, order)
        items = list(first["items"])
        for page in range(2, first["total_pages"] + 1):
            value = self.chapters(slug, page, order)
            if value["total_pages"] != first["total_pages"]:
                raise SourceFailure("Số trang chương thay đổi trong lúc lấy dữ liệu; hãy thử lại.")
            items.extend(value["items"])
        identifiers = [item["id"] or item["url"] for item in items]
        if len(identifiers) != len(set(identifiers)):
            raise SourceFailure("Nguồn trả chương trùng giữa các trang; chưa thể xác nhận danh sách đầy đủ.")
        return {"items": items, "count": len(items), "total": len(items), "complete": True,
                "source_pages": first["total_pages"], "source_url": first["source_url"], "order": order}

    def chapter(self, slug, number):
        response = self.request(f"/manga/{slug}/chapters/{number}")
        return parsers.parse_reader(response.text, str(response.url))

    def session(self):
        value = self.json("/auth/session")
        session = value.get("session")
        banned = value.get("reason") == "banned" or bool(value.get("ban"))
        return {"ok": True, "signed_in": bool(isinstance(session, dict) and session.get("user") and not banned),
                "session": {k: session[k] for k in ("user", "expires_at", "expires_in") if k in session} if isinstance(session, dict) else None,
                "reason": value.get("reason"), "ban": value.get("ban"), "source_url": self.base + "/auth/session"}
