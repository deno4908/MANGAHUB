"""TruyenQQ integration using the bundled live TruyenAPI scraper.

Keep the website's catalog response shape while fetching exclusively from QQ.
All blocking scraper work runs in a bounded pool, outside the ASGI event loop.
"""
import asyncio
from contextvars import copy_context
from serverless_runtime import create_task
import hashlib
import json
import logging
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

import httpx
from fastapi import HTTPException
from truyenapi.truyenapi.config import Settings
from truyenapi.truyenapi.client import SourceClient
from truyenapi.truyenapi.parsers import identity, optional_integer
from truyenapi.truyenapi.service import LiveService, normalized
from truyenapi.truyenapi.updates import update_interval

from fastapi_app.services.cache_service import cache
from fastapi_app.services.request_coalescing import coalesce_reads
from fastapi_app.services.truyenqq_transport import TruyenQQTransport

logger = logging.getLogger(__name__)

_live: LiveService | None = None
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=5, thread_name_prefix="qq-adapter")
_image_executor = ThreadPoolExecutor(max_workers=12, thread_name_prefix="qq-images")
_reader_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="qq-reader")
_card_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="qq-card-chapter")
_random_pool: list[dict] = []
_catalog_jobs = {}
_COLLECTIONS = {
    "truyen-moi": "latest", "dang-phat-hanh": "ongoing",
    "hoan-thanh": "completed", "sap-ra-mat": "new",
}


def get_live() -> LiveService:
    global _live
    with _lock:
        if _live is None:
            settings = Settings()
            _live = LiveService(settings, SourceClient(settings, transport=TruyenQQTransport()))
        return _live


async def run_live(method: str, *args, **kwargs):
    try:
        # Creating the HTTP client also performs blocking TLS setup. Keep the
        # first request out of the event loop, just like subsequent scraping.
        def call():
            return getattr(get_live(), method)(*args, **kwargs)
        executor = (_image_executor if method in {"image", "chapter_image"} else
                    _reader_executor if method in {"comic", "chapter"} else
                    _card_executor if method == "basic_latest" else _executor)
        context = copy_context()
        return await asyncio.get_running_loop().run_in_executor(executor, context.run, call)
    except HTTPException:
        raise
    except httpx.TimeoutException as error:
        _log_source_error(method, error)
        raise HTTPException(504, "TruyenQQ phản hồi quá chậm, vui lòng thử lại.",
                            headers=_source_error_headers(error)) from error
    except httpx.HTTPStatusError as error:
        _log_source_error(method, error)
        status = error.response.status_code
        raise HTTPException(404 if status == 404 else 503 if status == 429 else 502,
                            "Không tải được dữ liệu từ TruyenQQ.", headers=_source_error_headers(error)) from error
    except (httpx.RequestError, ValueError) as error:
        _log_source_error(method, error)
        raise HTTPException(502, "Không tải được dữ liệu từ TruyenQQ.", headers=_source_error_headers(error)) from error


def _source_error_headers(error):
    """Expose a bounded diagnostic code, never source content or credentials."""
    if isinstance(error, httpx.HTTPStatusError):
        code = f"http-{error.response.status_code}"
    elif isinstance(error, httpx.TimeoutException):
        code = "timeout"
    elif isinstance(error, httpx.RequestError):
        errno = getattr(error.__cause__, "code", None)
        code = f"network-{errno}" if isinstance(errno, int) else "network"
    else:
        reason = str(error)
        code = next((code for prefix, code in (
            ("Source redirected", "redirect"), ("Unexpected source host", "source-host"),
            ("Missing comic listing", "invalid-listing"), ("Unexpected search response", "invalid-search"),
        ) if reason.startswith(prefix)), "invalid-response")
    headers = {"X-TruyenQQ-Error": code, "Cache-Control": "no-store"}
    response = getattr(error, "response", None)
    if response is not None:
        transport = response.extensions.get("truyenqq_transport")
        if transport in {"direct", "edge-gateway", "edge-source"}:
            headers["X-TruyenQQ-Transport"] = transport
        colo = response.headers.get("x-truyenqq-colo", "")
        if re.fullmatch(r"[A-Z]{3}", colo):
            headers["X-TruyenQQ-Colo"] = colo
        block = response.headers.get("x-truyenqq-block")
        if block in {"challenge", "cloudflare-block", "origin-forbidden", "source-denied"}:
            headers["X-TruyenQQ-Block"] = block
    request = getattr(error, "request", None) if isinstance(error, httpx.HTTPStatusError) else None
    if request is not None and request.url.host == "truyenqqko.com" and code == "http-403":
        path = request.url.raw_path.decode("ascii")
        if len(path) <= 2048 and request.method == "GET":
            headers["X-TruyenQQ-Source-Path"] = path
        elif request.method == "POST" and request.url.path == "/frontend/search/search":
            from urllib.parse import parse_qs
            keyword = (parse_qs(request.content.decode("utf-8")).get("search") or [""])[0]
            if 0 < len(keyword) <= 200:
                headers["X-TruyenQQ-Source-Path"] = request.url.path
                headers["X-TruyenQQ-Search"] = quote(keyword, safe="")
    return headers


def _log_source_error(method, error):
    try:
        request = getattr(error, "request", None)
    except RuntimeError:
        request = None
    response = getattr(error, "response", None)
    # Exclude query strings, request bodies, headers, and response content.
    logger.warning(
        "TruyenQQ source failed operation=%s error=%s host=%s path=%s status=%s reason=%s",
        method, type(error).__name__, request.url.host if request else "-",
        request.url.path if request else "-", response.status_code if response is not None else "-",
        re.sub(r"https?://[^\s;]+", "[source URL]", str(error))[:160] if isinstance(error, ValueError) else "-",
    )


def full_slug(value: dict) -> str:
    return "-".join(identity(value["url"])[:2])


def chapter_token(slug: str, number: str) -> str:
    return f"qq--{slug}--{number}"


def parse_chapter_token(token: str) -> tuple[str, str]:
    # QQ has genuine comic slugs containing consecutive hyphens. Match the
    # final chapter delimiter while still requiring the numeric comic ID.
    match = re.fullmatch(r"qq--([a-zA-Z0-9][a-zA-Z0-9-]*-\d+)--([a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*)", token)
    if not match:
        raise HTTPException(404, "Chương cũ không còn khả dụng. Vui lòng mở lại từ danh sách chương TruyenQQ.")
    return match[1], match[2]


def _genre(value) -> dict:
    if isinstance(value, str):
        # Listing cards provide labels only; genre slugs are resolved below.
        import unicodedata
        slug = unicodedata.normalize("NFKD", value.lower().replace("đ", "d"))
        slug = re.sub(r"[^a-z0-9]+", "-", "".join(c for c in slug if not unicodedata.combining(c))).strip("-")
        return {"name": value, "slug": slug}
    slug = urlsplit(value.get("url", "")).path.rsplit("/", 1)[-1] or value.get("slug", "")
    return {"name": value.get("name", ""), "slug": re.sub(r"-\d+$", "", slug), "id": value.get("id", slug)}


def _timestamp(value, observed=None):
    anchor = datetime.fromisoformat(observed) if observed else datetime.now(timezone.utc)
    interval = update_interval(value, anchor)
    return interval[0].isoformat() if interval else ""


def _chapter(value: dict, slug: str, observed=None) -> dict:
    number = str(value.get("number") if value.get("number") is not None else "")
    if not number and value.get("url"):
        number = identity(value["url"])[2] or ""
    if not number:
        title = value.get("title", "").strip()
        match = re.search(r"(?:chapter|chương|chap|ch)\.?\s*(\d+(?:[.,]\d+)?)", title, re.IGNORECASE)
        if not match:
            match = re.fullmatch(r"(\d+(?:[.,]\d+)?)", title)
        number = match[1].replace(",", ".") if match else ""
    return {"chapter_name": number.replace("-", "."), "chapter_title": value.get("title", ""),
            "updatedAt": _timestamp(value.get("updated_at"), observed),
            "chapter_api_data": f"/api/manga/chapter/{chapter_token(slug, number)}" if number else ""}


def _item(value: dict, observed=None, *, cover_hints=None) -> dict:
    slug = full_slug(value)
    covers = value.get("cover_urls") or []
    # Use a source-aware proxy: hotlink Referer and fallback CDNs matter for QQ.
    cover = f"/api/manga/truyenqq/cover/{quote(slug, safe='')}" if covers else ""
    latest = value.get("latest_chapter") or next(iter(value.get("chapters") or []), None)
    metadata = value.get("metadata") or {}
    item = {"_id": str(value["id"]), "id": slug, "slug": slug, "name": value.get("title", ""),
            "origin_name": [value.get("alternative_names") or ""], "source": "truyenqq",
            "thumb_url": cover, "cover_url": cover, "cover_original": covers[0] if covers else "",
            "status": value.get("status") or "ongoing", "content": value.get("description") or "",
            "category": [_genre(g) for g in value.get("genres", [])],
            "author": [a["name"] for a in value.get("authors", [])],
            "view_count": 0, "local_view_count": 0, "views": 0,
            "updatedAt": _timestamp(value.get("updated_at"), observed),
            "source_updated_at": value.get("updated_at"),
            "chaptersLatest": [_chapter(latest, slug, observed)] if latest else []}
    if value.get("url"):
        card = {key: item[key] for key in ("slug", "name", "cover_url", "category", "status", "chaptersLatest")}
        observed_at = datetime.fromisoformat(observed).timestamp() if observed else time.time()
        hint = json.dumps({"cover_urls": covers, "url": value["url"], "card": card, "card_observed_at": observed_at}, ensure_ascii=False)
        hints = {f"truyenqq:cover-hint:{alias}": hint for alias in {slug, identity(value["url"])[0]}}
        hints.update({f"catalog:qq-sync:v1:{alias}": "available" for alias in {slug, identity(value["url"])[0]}})
        if cover_hints is None:
            cache.set_many(hints, ttl=86400)
        else:
            cover_hints.update(hints)
    return item


def _page(value: dict) -> dict:
    cover_hints = {}
    items = [_item(item, value.get("fetched_at"), cover_hints=cover_hints) for item in value.get("items", [])]
    cache.set_many(cover_hints, ttl=86400)
    page = int(value.get("page") or 1)
    pages = int(value.get("total_pages") or 1)
    size = max(len(items), 1)
    return {"status": "success", "data": {"items": items, "source": "truyenqq",
            "source_url": value.get("source_url"),
            "params": {"pagination": {"currentPage": page, "totalItemsPerPage": size,
                "totalItems": value.get("total"), "totalPages": pages,
                "hasNext": value.get("has_next", page < pages)}},
            "source_limited": bool(value.get("source_limited"))}}


def _remember(key: str, payload: dict, ttl=60) -> dict:
    # Existing rankings/admin consumers read these normalized cache snapshots.
    raw = json.dumps(payload, ensure_ascii=False)
    cache.set(key, raw, ttl)
    return payload


async def get_home():
    payload = await _catalog_page("home")
    return await asyncio.to_thread(_remember, "truyenqq:home", payload)


def live_list_cache_key(list_type, page):
    revision = cache.get("catalog:source-version:truyenqq")
    revision = revision if isinstance(revision, str) else ""
    return f"truyenqq:live-list:{list_type}:{page}:rev={revision}"


def _json_cached(key):
    raw = cache.get(key)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            cache.delete(key)
    return None


def _overlay_latest(payload, *, page=1, genres=(), status=None, latest_order=False):
    latest = _json_cached("truyenqq:list:truyen-moi:1") or {}
    incoming = {item["slug"]: item for item in latest.get("data", {}).get("items", [])}
    items = payload.get("data", {}).get("items", [])
    for item in items:
        updated = incoming.get(item.get("slug"))
        chapter_ids = lambda row: [(chapter.get("chapter_api_data"), chapter.get("chapter_name"))
                                   for chapter in row.get("chaptersLatest", [])]
        if updated and chapter_ids(updated) != chapter_ids(item):
            for field in ("chaptersLatest", "updatedAt", "source_updated_at"):
                if field in updated:
                    item[field] = updated[field]
    if page == 1 and latest_order:
        required = {re.sub(r"-\d+$", "", str(value)).lower() for value in genres}
        additions = []
        for item in incoming.values():
            tags = {str(tag.get("slug", "")).lower() for tag in item.get("category", [])}
            if required.issubset(tags) and (not status or item.get("status") == status):
                additions.append(item)
        if additions:
            merged = {item["slug"]: item for item in items}
            for item in additions:
                merged.setdefault(item["slug"], item)
            size = payload["data"]["params"]["pagination"].get("totalItemsPerPage", 24)
            payload["data"]["items"] = sorted(merged.values(), key=lambda item: item.get("updatedAt", ""), reverse=True)[:size]
    return payload


async def _catalog_page(method, *args, **kwargs):
    digest = hashlib.sha256(json.dumps([method, args, kwargs], sort_keys=True).encode()).hexdigest()
    key = "truyenqq:page-snapshot:v2:" + digest
    snapshot = await asyncio.to_thread(_json_cached, key)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("payload"), dict):
        snapshot = None
    if snapshot is None or snapshot.get("fresh_until", 0) < time.time():
        task_key = (asyncio.get_running_loop(), key)
        task = _catalog_jobs.get(task_key)
        if task is None:
            async def refresh():
                try:
                    raw = await run_live(method, *args, **kwargs)
                    if method == "home":
                        seen = {}
                        for section in raw["sections"]:
                            for item in section["items"]:
                                seen.setdefault(item["id"], item)
                        raw = {"items": list(seen.values()), "fetched_at": raw.get("fetched_at"),
                               "source_url": raw.get("source_url")}
                    value = await asyncio.to_thread(_page, raw)
                    await asyncio.to_thread(cache.set, key, json.dumps({"payload": value, "fresh_until": time.time() + 45}), ttl=1800)
                    return value
                except Exception:
                    if snapshot:
                        await asyncio.to_thread(cache.set, key, json.dumps({**snapshot, "fresh_until": time.time() + 10}), ttl=1800)
                    raise
            task = create_task(refresh())
            _catalog_jobs[task_key] = task
            def finished(done):
                _catalog_jobs.pop(task_key, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        if snapshot is None:
            return deepcopy(await asyncio.shield(task))
    return snapshot["payload"]


async def get_list(list_type="truyen-moi", page=1):
    if list_type == "sap-ra-mat":
        return _page({"items": [], "page": page})
    shared_key = await asyncio.to_thread(live_list_cache_key, list_type, page)
    shared = await asyncio.to_thread(cache.get, shared_key)
    if isinstance(shared, str):
        try:
            return json.loads(shared)
        except ValueError:
            await asyncio.to_thread(cache.delete, shared_key)
    payload = await _catalog_page("collection", _COLLECTIONS.get(list_type, "latest"), page)
    payload = await asyncio.to_thread(_overlay_latest, payload, page=page, latest_order=list_type == "truyen-moi")
    payload = await asyncio.to_thread(_remember, f"truyenqq:list:{list_type}:{page}", payload)
    await asyncio.to_thread(cache.set, shared_key, json.dumps(payload, ensure_ascii=False), ttl=8)
    return payload


def invalidate_live_catalog(slugs, preserve_latest=False):
    if _live is None:
        return
    urls = {_live.source_url("/truyen-tranh/" + slug) for slug in slugs}
    _live.cache.invalidate_matching(lambda key: key == "home" or isinstance(key, tuple) and
        (key[0] in {"search", "catalog-search"} or key[0] in {"comic", "basic"} and key[1] in urls))
    _live.html_cache.invalidate_matching(lambda url: url in urls)


async def get_categories():
    raw = cache.get("truyenqq:genres:v1")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            cache.delete("truyenqq:genres:v1")
    payload = {"status": "success", "data": {"items": [_genre(g) for g in await run_live("genres")]}}
    cache.set("truyenqq:genres:v1", json.dumps(payload, ensure_ascii=False), ttl=3600)
    return payload


async def get_cover_info(identifier):
    raw = await asyncio.to_thread(cache.get, f"truyenqq:cover-hint:{identifier}")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            pass
    canonical = await asyncio.to_thread(_cached_detail_identifier, identifier)
    return await run_live("basic", canonical)


async def get_total_count():
    return (await run_live("catalog"))["total"]


async def get_category_manga(slug, page=1):
    value = await _catalog_page("genre_comics", slug, page)
    value = await asyncio.to_thread(_overlay_latest, value, page=page, genres=[slug], latest_order=True)
    return await asyncio.to_thread(_remember, f"truyenqq:category:{slug}:{page}", value)


async def get_filtered(*, genres=(), page=1, sort="updated_desc", status=None):
    value = await _catalog_page("discover", page=page, genres=genres, sort=sort, status=status)
    return await asyncio.to_thread(_overlay_latest, value, page=page, genres=genres, status=status, latest_order=sort == "updated_desc")


async def resolve_slug_from_id(manga_id):
    # Mongo ObjectIds cannot identify a QQ comic; never guess a different book.
    if re.fullmatch(r"[0-9a-f]{24}", manga_id, re.I):
        return None
    url = await run_live("resolve", manga_id)
    return "-".join(identity(url)[:2])


def _cached_detail_identifier(slug):
    """Reuse a QQ reference learned by cards instead of crawling every sitemap."""
    from fastapi_app.services.card_metadata import cached_metadata
    metadata = cached_metadata(slug) or {}
    canonical = str(metadata.get("slug") or "")
    if metadata.get("source") == "truyenqq" and re.fullmatch(r"[a-zA-Z0-9]+(?:-+[a-zA-Z0-9]+)*-\d+", canonical):
        return canonical
    hint = _json_cached(f"truyenqq:cover-hint:{slug}")
    if isinstance(hint, dict) and isinstance(hint.get("url"), str):
        try:
            stem, identifier, chapter = identity(hint["url"])
            canonical = f"{stem}-{identifier}"
            title = str((hint.get("card") or {}).get("name") or "")
            if chapter is None and (slug in {stem, canonical, identifier} or (title and normalized(title) == normalized(slug))):
                return canonical
        except ValueError:
            pass
    return slug


@coalesce_reads
async def get_manga_detail(slug):
    cached = await asyncio.to_thread(_json_cached, f"truyenqq:detail:{slug}")
    item = ((cached or {}).get("data") or {}).get("item") if isinstance(cached, dict) else None
    if isinstance(item, dict) and item.get("source") == "truyenqq" and "chapters" in item:
        payload = deepcopy(cached)
    else:
        identifier = await asyncio.to_thread(_cached_detail_identifier, slug)
        value = await run_live("comic", identifier)
        item = await asyncio.to_thread(_item, value)
        chapters = [_chapter(ch, item["slug"]) for ch in value.get("chapters", [])]
        item["chapters"] = [{"server_name": "TruyenQQ", "server_data": chapters}]
        item["chaptersLatest"] = chapters[:1]
        payload = {"status": "success", "data": {"item": item, "seoOnPage": {"titleHead": item["name"]}}}
        await asyncio.to_thread(_remember, f"truyenqq:detail:{slug}", payload)
    item = payload["data"]["item"]
    canonical = item["slug"]
    # Keep existing website IDs so ratings, views, comments and bookmarks keep
    # their original keys. Chapter tokens still carry the exact QQ comic ID.
    if canonical != slug:
        item["source_slug"] = canonical
        item["slug"] = item["id"] = slug
    return payload


@coalesce_reads
async def search_manga(keyword, page=1):
    # The source AJAX search is a single limited result set, without fake pages.
    if page > 1:
        return _page({"items": [], "page": page, "source_limited": True})
    key = "truyenqq:search:v1:" + hashlib.sha256(keyword.strip().casefold().encode()).hexdigest()
    cached = await asyncio.to_thread(_json_cached, key)
    if isinstance(cached, dict) and isinstance((cached.get("data") or {}).get("items"), list):
        return cached
    payload = await asyncio.to_thread(_page, await run_live("search", keyword))
    return await asyncio.to_thread(_remember, key, payload, 60)


@coalesce_reads
async def get_chapter_manifest(slug, number):
    """Share source-provided page URLs across Vercel instances, never image bytes."""
    key = f"truyenqq:chapter-manifest:v1:{slug}:{number}"
    cached = await asyncio.to_thread(_json_cached, key)
    if isinstance(cached, dict) and cached.get("images") and cached.get("url"):
        return cached
    value = await run_live("chapter", slug, number)
    manifest = {field: value[field] for field in ("images", "url", "title")}
    await asyncio.to_thread(cache.set, key, json.dumps(manifest), ttl=300)
    return manifest


async def get_chapter_image(slug, number, index):
    value = await get_chapter_manifest(slug, number)
    if index < 1 or index > len(value["images"]):
        raise HTTPException(404, "Image index out of range")
    image = value["images"][index - 1]
    return await run_live("image", [image["url"], *(image.get("fallback_urls") or [])], value["url"])


async def get_chapter(chapter_id):
    slug, number = parse_chapter_token(chapter_id)
    value = await get_chapter_manifest(slug, number)
    images = [{"image_page": img["index"], "image_file":
               f"/api/manga/truyenqq/image/{quote(slug, safe='')}/{quote(number, safe='')}/{img['index']}"}
              for img in value["images"]]
    return {"status": "success", "data": {"domain_cdn": "", "item": {
        "slug": slug, "comic_slug": slug, "comic_name": value["title"], "chapter_name": number,
        "chapter_path": slug, "chapter_image": images, "source": "truyenqq"}}}


def get_image_url(path):
    return str(path or "")


async def refresh_random_pool():
    global _random_pool
    payload = await get_list()
    _random_pool = payload["data"]["items"]


def get_random_item():
    return random.choice(_random_pool) if _random_pool else None


async def close():
    global _live
    if _live is not None:
        await asyncio.to_thread(_live.close)
        _live = None
