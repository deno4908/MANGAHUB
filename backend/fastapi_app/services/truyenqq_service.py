"""TruyenQQ integration using the bundled live TruyenAPI scraper.

Keep the website's catalog response shape while fetching exclusively from QQ.
All blocking scraper work runs in a bounded pool, outside the ASGI event loop.
"""
import asyncio
import functools
import hashlib
import json
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
from truyenapi.truyenapi.parsers import identity, optional_integer
from truyenapi.truyenapi.service import LiveService
from truyenapi.truyenapi.updates import update_interval

from fastapi_app.services.cache_service import cache

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
            _live = LiveService(Settings())
        return _live


async def run_live(method: str, *args, **kwargs):
    try:
        call = functools.partial(getattr(get_live(), method), *args, **kwargs)
        executor = (_image_executor if method in {"image", "chapter_image"} else
                    _reader_executor if method in {"comic", "chapter"} else
                    _card_executor if method == "basic_latest" else _executor)
        return await asyncio.get_running_loop().run_in_executor(executor, call)
    except HTTPException:
        raise
    except httpx.TimeoutException as error:
        raise HTTPException(504, "TruyenQQ phản hồi quá chậm, vui lòng thử lại.") from error
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        raise HTTPException(404 if status == 404 else 503 if status == 429 else 502,
                            "Không tải được dữ liệu từ TruyenQQ.") from error
    except (httpx.RequestError, ValueError) as error:
        raise HTTPException(502, "Không tải được dữ liệu từ TruyenQQ.") from error


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


def _item(value: dict, observed=None) -> dict:
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
        for alias in {slug, identity(value["url"])[0]}:
            cache.set(f"truyenqq:cover-hint:{alias}", hint, ttl=86400)
    return item


def _page(value: dict) -> dict:
    items = [_item(item, value.get("fetched_at")) for item in value.get("items", [])]
    page = int(value.get("page") or 1)
    pages = int(value.get("total_pages") or 1)
    size = max(len(items), 1)
    return {"status": "success", "data": {"items": items, "source": "truyenqq",
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
    value = await run_live("home")
    seen = {}
    for section in value["sections"]:
        for item in section["items"]:
            seen.setdefault(item["id"], item)
    return _remember("truyenqq:home", _page({"items": list(seen.values())}))


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
    key = "truyenqq:page-snapshot:v1:" + digest
    snapshot = _json_cached(key)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("payload"), dict):
        snapshot = None
    if snapshot is None or snapshot.get("fresh_until", 0) < time.time():
        task_key = (asyncio.get_running_loop(), key)
        task = _catalog_jobs.get(task_key)
        if task is None:
            async def refresh():
                try:
                    value = _page(await run_live(method, *args, **kwargs))
                    cache.set(key, json.dumps({"payload": value, "fresh_until": time.time() + 45}), ttl=1800)
                    return value
                except Exception:
                    if snapshot:
                        cache.set(key, json.dumps({**snapshot, "fresh_until": time.time() + 10}), ttl=1800)
                    raise
            task = asyncio.create_task(refresh())
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
    shared_key = live_list_cache_key(list_type, page)
    shared = cache.get(shared_key)
    if isinstance(shared, str):
        try:
            return json.loads(shared)
        except ValueError:
            cache.delete(shared_key)
    payload = await _catalog_page("collection", _COLLECTIONS.get(list_type, "latest"), page)
    payload = _overlay_latest(payload, page=page, latest_order=list_type == "truyen-moi")
    payload = _remember(f"truyenqq:list:{list_type}:{page}", payload)
    cache.set(shared_key, json.dumps(payload, ensure_ascii=False), ttl=8)
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
    raw = cache.get(f"truyenqq:cover-hint:{identifier}")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            pass
    return await run_live("basic", identifier)


async def get_total_count():
    return (await run_live("catalog"))["total"]


async def get_category_manga(slug, page=1):
    value = await _catalog_page("genre_comics", slug, page)
    return _remember(f"truyenqq:category:{slug}:{page}", _overlay_latest(value, page=page, genres=[slug], latest_order=True))


async def get_filtered(*, genres=(), page=1, sort="updated_desc", status=None):
    value = await _catalog_page("discover", page=page, genres=genres, sort=sort, status=status)
    return _overlay_latest(value, page=page, genres=genres, status=status, latest_order=sort == "updated_desc")


async def resolve_slug_from_id(manga_id):
    # Mongo ObjectIds cannot identify a QQ comic; never guess a different book.
    if re.fullmatch(r"[0-9a-f]{24}", manga_id, re.I):
        return None
    url = await run_live("resolve", manga_id)
    return "-".join(identity(url)[:2])


async def get_manga_detail(slug):
    value = await run_live("comic", slug)
    item = _item(value)
    chapters = [_chapter(ch, item["slug"]) for ch in value.get("chapters", [])]
    item["chapters"] = [{"server_name": "TruyenQQ", "server_data": chapters}]
    item["chaptersLatest"] = chapters[:1]
    payload = {"status": "success", "data": {"item": item, "seoOnPage": {"titleHead": item["name"]}}}
    return _remember(f"truyenqq:detail:{slug}", payload)


async def search_manga(keyword, page=1):
    # The source AJAX search is a single limited result set, without fake pages.
    if page > 1:
        return _page({"items": [], "page": page, "source_limited": True})
    return _page(await run_live("search", keyword))


async def get_chapter(chapter_id):
    slug, number = parse_chapter_token(chapter_id)
    value = await run_live("chapter", slug, number)
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
