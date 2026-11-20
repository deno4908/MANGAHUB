import re
import secrets
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextvars import copy_context
from datetime import datetime, timezone
from urllib.parse import urlencode, urljoin, urlsplit
from decimal import Decimal
import httpx

from bs4 import BeautifulSoup
from fastapi import HTTPException

from .cache import MemoryCache
from .client import SourceClient
from .config import Settings
from .parsers import basic_from_comic, identity, parse_basic, parse_chapter, parse_comic, parse_comments, parse_listing, parse_home, parse_search, text
from .options import COLLECTIONS, COUNTRIES, RANKINGS, SORTS, STATUSES
from .updates import filter_updates


def normalized(value):
    value = unicodedata.normalize("NFKD", value.lower().replace("đ", "d"))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", "".join(c for c in value if not unicodedata.combining(c))).split())


class LiveService:
    def __init__(self, settings: Settings, client=None):
        self.settings = settings
        self.client = client or SourceClient(settings)
        self.cache = MemoryCache(settings.cache_max_entries)
        self.card_cache = MemoryCache(settings.cache_max_entries)
        self.reference_cache = MemoryCache(settings.cache_max_entries * 2)
        self.html_cache = MemoryCache(settings.html_cache_entries)
        self.image_cache = MemoryCache(settings.cache_max_entries, max_bytes=settings.image_cache_bytes,
                                       sizeof=lambda value: len(value[0]))
        self.fetch_pool = ThreadPoolExecutor(max_workers=settings.fetch_concurrency, thread_name_prefix="truyen-fetch")
        self.image_pool = ThreadPoolExecutor(max_workers=24, thread_name_prefix="truyen-image-fetch")
        self.image_preference_lock = threading.Lock()
        self.image_preferred_host = None
        self.base = settings.base_url.rstrip("/") + "/"
        self.origin = urlsplit(self.base).netloc

    def close(self):
        self.image_pool.shutdown(wait=True, cancel_futures=True)
        self.fetch_pool.shutdown(wait=True, cancel_futures=True)
        self.client.close()

    def source_url(self, path):
        parsed = urlsplit(path)
        url = path if parsed.scheme else urljoin(self.base, path)
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.netloc != self.origin:
            raise ValueError("Unexpected source host")
        return url

    def html(self, url, *, ttl=None, refresh=False):
        return self.html_cache.get(url, self.settings.cache_ttl if ttl is None else ttl,
                                   lambda: self.client.request(url).text, refresh=refresh)

    def html_lifetime(self, url, ttl):
        # A new parsed response must not extend the freshness of an older HTML snapshot.
        return min(ttl, self.html_cache.remaining(url))

    def remember_references(self, items):
        for item in items:
            reference = {k: item[k] for k in ("id", "slug", "url")}
            for alias in (reference["id"], reference["slug"]):
                self.reference_cache.put(alias, self.settings.catalog_ttl, reference)

    def xml(self, url):
        response = self.client.request(self.source_url(url))
        try:
            root = ET.fromstring(response.content)
        except ET.ParseError as error:
            raise ValueError("Source returned invalid sitemap XML") from error
        locations = [node.text.strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "loc" and node.text]
        return root.tag.rsplit("}", 1)[-1], locations

    def catalog_bundle(self):
        def load():
            root_url = self.source_url("/sitemap.xml")
            kind, locations = self.xml(root_url)
            if kind != "sitemapindex":
                raise ValueError("Expected a sitemap index")
            maps = list(dict.fromkeys(self.source_url(u) for u in locations if "sitemap-comic" in urlsplit(u).path))
            if not maps:
                raise ValueError("No comic sitemaps found in source index")
            with ThreadPoolExecutor(max_workers=self.settings.catalog_concurrency) as pool:
                tasks = [pool.submit(copy_context().run, self.xml, url) for url in maps]
                pages = [task.result() for task in tasks]
            comics = {}
            for page_kind, urls in pages:
                if page_kind != "urlset":
                    raise ValueError("Expected comic sitemap URL list")
                for url in urls:
                    self.source_url(url)
                    try:
                        slug, cid, chapter = identity(url)
                    except ValueError:
                        continue
                    if chapter is None:
                        comics[cid] = {"id": cid, "slug": slug, "url": url}
            if not comics:
                raise ValueError("Source comic sitemaps contained no comic URLs")
            items = sorted(comics.values(), key=lambda c: int(c["id"]), reverse=True)
            data = {"items": items,
                    "total": len(comics), "source": root_url,
                    "fetched_at": datetime.now(timezone.utc).isoformat(), "fields": ["id", "slug", "url"]}
            return {"data": data, "by_id": comics, "by_slug": {c["slug"]: c for c in items},
                    "search": [(c, normalized(c["slug"])) for c in items]}
        return self.cache.get("catalog", self.settings.catalog_ttl, load)

    def catalog(self):
        return self.catalog_bundle()["data"]

    def catalog_items(self, q=""):
        bundle = self.catalog_bundle()
        catalog = bundle["data"]
        query = normalized(q)
        if not q.strip():
            return catalog
        def load():
            terms = query.split()
            items = [c for c, slug in bundle["search"] if all(term in slug or term == c["id"] for term in terms)] if terms else []
            return {**catalog, "items": items, "total": len(items)}
        return self.cache.get(("catalog-search", catalog["fetched_at"], query), self.settings.catalog_ttl, load)

    def resolve(self, identifier):
        if not re.fullmatch(r"[a-zA-Z0-9]+(?:-+[a-zA-Z0-9]+)*", identifier):
            raise HTTPException(422, "ID hoặc slug không hợp lệ")
        known = self.reference_cache.peek(identifier)
        if known is not None:
            return self.source_url(known["url"])
        if not identifier.isdigit() and re.search(r"-\d+$", identifier):
            return self.source_url("/truyen-tranh/" + identifier)
        cached_catalog = self.cache.peek("catalog")
        if cached_catalog:
            comic = cached_catalog["by_id"].get(identifier) or cached_catalog["by_slug"].get(identifier)
            if comic:
                return comic["url"]
        if not identifier.isdigit():
            # Legacy OTruyen routes have no QQ numeric ID. A targeted search
            # avoids downloading every sitemap (and recovering each blocked
            # sitemap separately). Accept only an exact slug/title match.
            terms = identifier.replace("-", " ").split()
            queries = list(dict.fromkeys([" ".join(terms[-6:]), " ".join(terms)]))
            for query in queries:
                try:
                    candidates = self.search(query)["items"]
                except httpx.HTTPStatusError as error:
                    if error.response.status_code == 404:
                        break
                    raise
                matches = {}
                for candidate in candidates:
                    stem, cid, chapter = identity(candidate["url"])
                    source_titles = re.split(r"\s*;\s*", candidate.get("title", ""))
                    if chapter is None and (stem == identifier or any(normalized(title) == normalized(identifier) for title in source_titles)):
                        matches[cid] = candidate
                if len(matches) == 1:
                    comic = next(iter(matches.values()))
                    self.reference_cache.put(identifier, self.settings.catalog_ttl, comic)
                    return self.source_url(comic["url"])
                if len(matches) > 1:
                    raise HTTPException(404, "Không thể xác định duy nhất truyện QQ cho slug cũ")
            raise HTTPException(404, "Không tìm thấy truyện QQ khớp chính xác slug cũ")
        bundle = self.catalog_bundle()
        comic = bundle["by_id"].get(identifier) or bundle["by_slug"].get(identifier)
        if comic:
            return comic["url"]
        raise HTTPException(404, "Không tìm thấy truyện trong sitemap của nguồn")

    def saved_metadata(self, identifier, title):
        """Resolve a saved label only when the source confirms its exact identity."""
        if not title or normalized(title) != normalized(identifier):
            raise HTTPException(422, "Tên đã lưu không khớp mã tra cứu")
        candidates = self.search(title, limit=9)["items"]
        if len(candidates) > 8:
            raise HTTPException(404, "Tên đã lưu khớp quá nhiều truyện QQ")
        matches = {}
        for candidate in candidates:
            stem, cid, chapter = identity(candidate["url"])
            if chapter is not None:
                continue
            value = self.basic(stem + "-" + cid)
            names = [value.get("title", ""), *re.split(r"\s*;\s*", value.get("alternative_names") or "")]
            if any(normalized(name) == normalized(title) for name in names):
                matches[cid] = value
        if len(matches) != 1:
            raise HTTPException(404, "Không tìm thấy duy nhất một truyện QQ khớp tên đã lưu")
        value = next(iter(matches.values()))
        self.reference_cache.put(identifier, self.settings.catalog_ttl, value)
        return value

    def comic(self, identifier):
        url = self.resolve(identifier)
        def load():
            value = parse_comic(self.html(url), url)
            value["context"]["book_id"] = value["id"]
            self.remember_references([value])
            return value
        return self.cache.get(("comic", url), lambda: self.html_lifetime(url, self.settings.cache_ttl), load)

    def remember_cards(self, items, ttl=None):
        self.remember_references(items)
        for item in items:
            self.card_cache.put(item["id"], self.settings.cache_ttl if ttl is None else ttl, item)

    def cards(self, collection="latest", page=1, refresh=False):
        value = self.collection(collection, page, refresh=refresh)
        return {**value, "collection": collection}

    def basic(self, identifier, *, require_chapter=False):
        cid = identifier if identifier.isdigit() else identifier.rsplit("-", 1)[-1]
        cached = self.card_cache.peek(cid)
        has_chapter = bool(cached and (cached.get("latest_chapter") or {}).get("url"))
        if cached and identifier in (cached["id"], cached["slug"], cached["slug"] + "-" + cached["id"]) and (
                not require_chapter or has_chapter):
            return cached
        url = self.resolve(identifier)
        full = self.cache.peek(("comic", url))
        if full is not None:
            return basic_from_comic(full)
        def load():
            value = parse_basic(self.html(url), url)
            self.remember_cards([value], self.html_lifetime(url, self.settings.cache_ttl))
            return value
        return self.cache.get(("basic", url), lambda: self.html_lifetime(url, self.settings.cache_ttl), load)

    def basic_latest(self, identifier):
        return self.basic(identifier, require_chapter=True)

    def chapter(self, identifier, number):
        if not re.fullmatch(r"[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*", number):
            raise HTTPException(422, "Số chương không hợp lệ")
        url = self.resolve(identifier) + "-chap-" + number
        def load():
            value = parse_chapter(self.html(url), url)
            self.remember_references([{"id": value["comic_id"], "slug": value["slug"], "url": url.rsplit("-chap-", 1)[0]}])
            return value
        return self.cache.get(("chapter", url), lambda: self.html_lifetime(url, self.settings.cache_ttl), load)

    def comments(self, identifier, page=1, parent_id="0", chapter=None):
        value = self.chapter(identifier, chapter) if chapter is not None else self.comic(identifier)
        ctx = value["context"]
        if parent_id == "0" and page > ctx["total_page"]:
            raise HTTPException(404, "Trang bình luận vượt quá số trang nguồn cung cấp")
        if parent_id == "0" and page == 1:
            items = value["comments"]
        else:
            def load():
                url = self.source_url("/frontend/comment/list")
                payload = {k: ctx[k] for k in ("book_id", "episode_id", "team_id")}
                payload.update(parent_id=parent_id, page=page)
                html = self.client.request(url, data=payload, referer=value["url"]).text
                if not html.strip() or "cf-challenge" in html or "challenge-form" in html:
                    raise ValueError("Source returned an empty or blocked comment response")
                return parse_comments(html, url)
            items = self.cache.get(("comments", value["url"], page, parent_id), self.settings.cache_ttl, load)
        return {"items": items, "count": len(items), "page": page,
                "total_pages": ctx["total_page"] if parent_id == "0" else None,
                "episode_id": ctx["episode_id"], "parent_id": parent_id, "source_url": value["url"]}

    def latest(self, page, refresh=False):
        return self.collection("latest", page, refresh=refresh)

    def updates(self, page=1, within_minutes=None, day=None, refresh=False):
        source = self.latest(page, refresh=refresh)
        # Re-filter against the current clock even while the source snapshot is cached.
        return filter_updates(source, now=datetime.now(timezone.utc), within_minutes=within_minutes, day=day)

    def listing(self, path, page=1, params=None, *, page_style="trang", ttl=None, refresh=False):
        path = path.rstrip("/")
        url = self.source_url(path if page_style == "page" and page == 1 else path + f"/{page_style}-{page}")
        if params:
            url += "?" + urlencode(sorted(params.items()))
        ttl = self.settings.cache_ttl if ttl is None else ttl
        def load():
            try:
                value = parse_listing(self.html(url, ttl=ttl, refresh=refresh), url)
            except ValueError:
                # A blocked/invalid source page is not a usable snapshot. Let a
                # reader's retry fetch the source again instead of replaying it.
                self.html_cache.invalidate(url)
                raise
            if page > value["total_pages"]:
                raise HTTPException(404, "Trang vượt quá số trang nguồn cung cấp")
            self.remember_cards(value["items"], self.html_lifetime(url, ttl))
            return {**value, "page": page, "count": len(value["items"]), "total": None,
                    "fetched_at": datetime.now(timezone.utc).isoformat(), "cache_ttl_seconds": ttl,
                    "has_next": page < value["total_pages"], "has_previous": page > 1}
        return self.cache.get(("listing", url), lambda: self.html_lifetime(url, ttl), load, refresh=refresh)

    def home(self):
        url = self.source_url("/doc-truyen")
        def load():
            value = parse_home(self.html(url), url)
            for section in value["sections"]:
                self.remember_cards(section["items"], self.html_lifetime(url, self.settings.cache_ttl))
            return value
        return self.cache.get("home", lambda: self.html_lifetime(url, self.settings.cache_ttl), load)

    def collection(self, name, page=1, refresh=False):
        if name == "ongoing":
            return self.discover(page=page, status="ongoing", refresh=refresh)
        if name == "popular":
            return self.discover(page=page, sort="views_desc", refresh=refresh)
        if name not in COLLECTIONS:
            raise HTTPException(422, "Bộ sưu tập không hợp lệ")
        ttl = min(self.settings.latest_ttl, self.settings.cache_ttl) if name in ("latest", "new") else self.settings.cache_ttl
        return self.listing("/" + COLLECTIONS[name], page, ttl=ttl, refresh=refresh)

    def rankings(self, period, page=1):
        if period == "all":
            return self.collection("popular", page)
        if period not in RANKINGS:
            raise HTTPException(422, "Khoảng thời gian không hợp lệ")
        return self.listing("/" + RANKINGS[period], page)

    def search(self, q, limit=None):
        q = q.strip()
        if not q:
            raise HTTPException(422, "Từ khóa không được để trống")
        url = self.source_url("/frontend/search/search")
        def load():
            html = self.client.request(url, data={"search": q, "type": 0}).text
            items = parse_search(html, url)
            self.remember_references(items)
            return items
        items = self.cache.get(("search", q), self.settings.cache_ttl, load)
        selected = items if limit is None else items[:limit]
        return {"items": selected, "count": len(selected), "q": q, "total": None,
                "source_limited": True, "source_url": url}

    def genre(self, identifier):
        for genre in self.genres():
            if identifier in (genre["id"], genre["slug"], genre["slug"].rsplit("-", 1)[0]):
                return genre
        raise HTTPException(404, "Không tìm thấy thể loại")

    def genre_comics(self, identifier, page=1, sort="updated_desc", status=None, country=None):
        genre = self.genre(identifier)
        params = {"sort": SORTS[sort]}
        if status:
            params["status"] = STATUSES[status]
        if country:
            params["country"] = COUNTRIES[country]
        return {**self.listing(urlsplit(genre["url"]).path, page, params), "genre": genre}

    def discover(self, page=1, genres=(), exclude_genres=(), sort="updated_desc", status=None, country=None, min_chapters=0, refresh=False):
        include = list(dict.fromkeys(self.genre(g)["id"] for g in genres))
        exclude = list(dict.fromkeys(self.genre(g)["id"] for g in exclude_genres))
        if set(include) & set(exclude):
            raise HTTPException(422, "Một thể loại không thể vừa chọn vừa loại trừ")
        params = {"sort": SORTS[sort]}
        if include:
            params["category"] = ",".join(include)
        if exclude:
            params["notcategory"] = ",".join(exclude)
        if status:
            params["status"] = STATUSES[status]
        if country:
            params["country"] = COUNTRIES[country]
        if min_chapters:
            params["minchapter"] = min_chapters
        return self.listing("/tim-kiem-nang-cao", page, params, refresh=refresh)

    def author(self, slug, page=1):
        if not re.fullmatch(r"[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*-\d+", slug):
            raise HTTPException(422, "Tác giả cần slug-ID đầy đủ, lấy từ authors trong chi tiết truyện")
        value = self.listing("/tac-gia/" + slug, page, page_style="page")
        return {**value, "author": {"id": slug.rsplit("-", 1)[1], "slug": slug, "name": value["title"],
                                   "url": self.source_url("/tac-gia/" + slug)}}

    def related(self, identifier):
        value = self.comic(identifier)
        items = []
        for url in value["related_urls"]:
            slug, cid, _ = identity(url)
            items.append({"id": cid, "slug": slug, "url": url})
        return {"items": items, "count": len(items), "source_url": value["url"]}

    def random_comic(self):
        reference = secrets.choice(self.catalog()["items"])
        return self.comic(reference["slug"] + "-" + reference["id"])

    def batch(self, identifiers):
        def load(identifier):
            try:
                return {"id": identifier, "data": self.comic(identifier), "error": None}
            except HTTPException as error:
                return {"id": identifier, "data": None, "error": {"status": error.status_code, "detail": error.detail}}
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                return {"id": identifier, "data": None, "error": {"status": 404 if status == 404 else 503 if status == 429 else 502,
                        "detail": "Website nguồn trả lỗi", "source_status": status}}
            except (ValueError, httpx.HTTPError) as error:
                return {"id": identifier, "data": None, "error": {"status": 504 if isinstance(error, httpx.TimeoutException) else 502, "detail": str(error)}}
        tasks = [self.fetch_pool.submit(copy_context().run, load, identifier) for identifier in identifiers]
        items = [task.result() for task in tasks]
        return {"items": items, "count": len(items), "partial": any(item["error"] for item in items)}

    def chapters(self, identifier, order="desc", q=""):
        value = self.comic(identifier)
        def key(ch):
            number = ch["number"]
            title_match = re.search(r"(?:Chương|Chapter|Chap)\s*(\d+(?:\.\d+)?)", ch["title"], re.I)
            number_match = re.match(r"\d+(?:[._-]\d+)?", number)
            base = title_match[1] if title_match else number_match[0].replace("-", ".").replace("_", ".") if number_match else None
            return (1, Decimal(base), number) if base is not None else (0, Decimal(0), number)
        chapters = sorted(value["chapters"], key=key, reverse=order == "desc")
        if q:
            chapters = [c for c in chapters if normalized(q) in normalized(c["title"]) or q in c["number"]]
        return {"items": chapters, "source_url": value["url"]}

    def chapter_edge(self, identifier, edge):
        chapters = self.chapters(identifier, order="asc")["items"]
        if not chapters:
            raise HTTPException(404, "Truyện chưa có chương")
        return chapters[0 if edge == "first" else -1]

    def image(self, urls, referer):
        cache_targets = tuple(dict.fromkeys(urls))
        targets = cache_targets
        with self.image_preference_lock:
            preferred = self.image_preferred_host
        if preferred and preferred[1] > time.monotonic():
            # Reorder only URLs supplied by this page, never invent a mirror.
            targets = tuple(sorted(targets, key=lambda url: urlsplit(url).netloc != preferred[0]))
        def fetch(url):
            try:
                response = self.client.request(url, referer=referer, follow_redirects=True, image=True)
                mime = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if mime.startswith("image/") and response.content:
                    return response.content, mime
            except httpx.HTTPError:
                pass
            return None
        def load():
            if not targets:
                raise HTTPException(502, "Chương chưa có máy chủ ảnh")
            tasks = [self.image_pool.submit(copy_context().run, fetch, targets[0])]
            origins = {tasks[0]: targets[0]}
            def successful(task):
                value = task.result()
                with self.image_preference_lock:
                    self.image_preferred_host = (urlsplit(origins[task]).netloc, time.monotonic() + 300)
                return value
            try:
                done, _ = wait(tasks, timeout=0.35)
                if done and tasks[0].result() is not None:
                    return successful(tasks[0])
                # A stalled original must not consume its full timeout before
                # another source-provided CDN can deliver the same page.
                for url in targets[1:]:
                    task = self.image_pool.submit(copy_context().run, fetch, url)
                    tasks.append(task)
                    origins[task] = url
                remaining = set(tasks)
                while remaining:
                    done, remaining = wait(remaining, return_when=FIRST_COMPLETED)
                    for task in done:
                        value = task.result()
                        if value is not None:
                            return successful(task)
                raise HTTPException(502, "Các máy chủ ảnh đều không trả ảnh hợp lệ")
            finally:
                for task in tasks:
                    task.cancel()
        return self.image_cache.get((cache_targets, referer), self.settings.image_cache_ttl, load)

    def chapter_image(self, identifier, number, index, server="auto"):
        value = self.chapter(identifier, number)
        if index > len(value["images"]):
            raise HTTPException(404, "Số thứ tự ảnh vượt quá số ảnh của chương")
        image = value["images"][index - 1]
        urls = [image["url"], *image["fallback_urls"]]
        if server == "original":
            urls = urls[:1]
        elif server == "cdn":
            urls = image["fallback_urls"]
        return self.image(urls, value["url"])

    def genres(self):
        url = self.source_url("/doc-truyen")
        def load():
            soup = BeautifulSoup(self.html(url), "lxml")
            genres = {}
            for a in soup.select('a[href*="/the-loai/"]'):
                target = self.source_url(a["href"])
                if text(a):
                    slug = urlsplit(target).path.rsplit("/", 1)[-1]
                    genres[target] = {"id": slug.rsplit("-", 1)[-1], "name": text(a), "slug": slug, "url": target}
            if not genres:
                raise ValueError("Source returned no genre links")
            return list(genres.values())
        return self.cache.get("genres", lambda: self.html_lifetime(url, self.settings.cache_ttl), load)
