"""MangaHub adapter for the bundled MoeTruyen client. Source IDs never overlap QQ."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
import os
import re
import unicodedata
from urllib.parse import quote, urlsplit

import httpx
from fastapi import HTTPException

from moetruyen_api.config import Filters, Settings, SourceAuth
from moetruyen_api.source import Runtime, Source, SourceFailure
from fastapi_app.services.cache_service import cache
from fastapi_app.services.request_coalescing import coalesce_reads

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="moe-catalog")
_reader_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="moe-reader-request")
_IDENTIFIER = re.compile(r"^moe-([0-9]+)(?:-[a-zA-Z0-9_-]+)?$")
_CHAPTER = re.compile(r"^moe--([0-9]+)--([0-9]+(?:[.-][0-9]+)*|oneshot)$")


def is_identifier(value):
    return bool(_IDENTIFIER.fullmatch(str(value or "")))


def native_id(value):
    match = _IDENTIFIER.fullmatch(str(value or ""))
    if not match:
        raise HTTPException(404, "Không tìm thấy truyện Mòe.")
    return match[1]


def chapter_identity(value):
    match = _CHAPTER.fullmatch(str(value or ""))
    if not match:
        raise HTTPException(404, "Không tìm thấy chương Mòe.")
    return "moe-" + match[1], match[2]


def chapter_token(identifier, number):
    token = f"moe--{native_id(identifier)}--{number}"
    chapter_identity(token)
    return token


def genre_slug(value):
    text = unicodedata.normalize("NFD", str(value).lower().replace("đ", "d"))
    return re.sub(r"[^a-z0-9]+", "-", "".join(c for c in text if not unicodedata.combining(c))).strip("-")


@lru_cache(maxsize=1)
def runtime():
    # Browser startup is lazy: browsing the homepage never starts Chromium.
    settings = Settings(_env_file=None)
    settings = settings.model_copy(update={"timeout": min(settings.timeout, 15)})
    return Runtime(settings)


@lru_cache(maxsize=1)
def reader():
    from moetruyen_api.imgx import ReaderImages
    return ReaderImages(runtime().settings)


def _source_call(method, *args):
    shared = runtime()
    # These endpoints are public catalogue reads, isolated from browser/user cookies.
    source = Source(shared.settings, shared, SourceAuth())
    try:
        return method(source, *args)
    finally:
        source.close()


async def run(method, *args, reader_task=False):
    try:
        return await asyncio.get_running_loop().run_in_executor(_reader_executor if reader_task else _executor, _source_call, method, *args)
    except SourceFailure as error:
        raise HTTPException(404 if error.status == 404 else 503 if error.status == 503 else 502,
                            "Không tải được dữ liệu từ Mòe Truyện.") from None
    except (httpx.RequestError, ValueError):
        raise HTTPException(502, "Mòe Truyện tạm thời không khả dụng.") from None


def _read(key):
    value = cache.get(key)
    try:
        return json.loads(value) if isinstance(value, str) else None
    except ValueError:
        return None


async def _remember(key, value, ttl=120):
    await asyncio.to_thread(cache.set, key, json.dumps(value, ensure_ascii=False), ttl=ttl)
    return value


def _chapter(row, identifier):
    number = str(row["number"]) if row.get("number") is not None and str(row["number"]).strip() else "oneshot"
    from fastapi_app.services.truyenqq_service import _timestamp
    date = _timestamp(row.get("updated_at") or row.get("updated_date_label") or "")
    return {"chapter_name": number, "chapter_title": row.get("title") or row.get("label") or "",
            "chapter_api_data": chapter_token(identifier, number), "updatedAt": date,
            "publish_at": date, "translation_source": "moetruyen",
            "translation_source_label": "Mòe Truyện", "scanlation_group": row.get("team") or ""}


def item(raw):
    identifier = "moe-" + str(raw["id"])
    latest = raw.get("latest_chapter")
    if not latest and raw.get("chapters"):
        latest = raw["chapters"][0]
    chapters = [_chapter(latest, identifier)] if latest else []
    return {"id": identifier, "_id": identifier, "slug": identifier, "source": "moetruyen",
            "name": raw.get("title") or "", "title": raw.get("title") or "",
            "native_slug": raw.get("slug"), "external_url": raw.get("url"),
            "content": raw.get("description") or "", "author": raw.get("authors") or ["Mòe Truyện"],
            "thumb_url": f"/api/manga/moetruyen/cover/{identifier}",
            "cover_url": f"/api/manga/moetruyen/cover/{identifier}",
            "status": {"Hoàn thành": "completed", "Tạm dừng": "hiatus"}.get(raw.get("status"), "ongoing"),
            "category": [{"name": name, "slug": genre_slug(name)} for name in raw.get("genres") or []],
            "chaptersLatest": chapters, "local_view_count": 0, "view_count": 0,
            "source_views": raw.get("views") or 0,
            "content_rating": "erotica" if raw.get("adult") else "safe",
            "is_mature": bool(raw.get("adult")), "updatedAt": chapters[0]["updatedAt"] if chapters else ""}


async def _remember_cards(rows):
    entries = {}
    for row in rows:
        identifier = "moe-" + str(row["id"])
        card = item(row)
        entries[f"moetruyen:card:{identifier}"] = json.dumps(row, ensure_ascii=False)
        entries[f"catalog:card-metadata:v1:{identifier}"] = json.dumps(metadata(card), ensure_ascii=False)
    if entries:
        await asyncio.to_thread(cache.set_many, entries, ttl=3600)


def metadata(card):
    return {"id": card["id"], "slug": card["slug"], "source": "moetruyen", "title": card["name"],
            "cover_url": card["cover_url"], "status": card["status"], "content_rating": card["content_rating"],
            "genres": [g["name"] for g in card["category"]], "tags": [g["slug"] for g in card["category"]],
            "chapters_latest": card["chaptersLatest"]}


@coalesce_reads
async def get_categories():
    value = await run(lambda source: source.options())
    return [{"slug": genre_slug(g["name"]), "name": g["name"], "id": g["id"], "source": "moetruyen"}
            for g in value["genres"]]


@coalesce_reads
async def get_filtered(page=1, limit=24, sort="latest", status="", genres=(), keyword="", show_mature=False):
    key = "moetruyen:list:v1:" + hashlib.sha256(json.dumps(
        [page, limit, sort, status, sorted(genres), keyword, show_mature], ensure_ascii=True).encode()).hexdigest()
    cached = await asyncio.to_thread(_read, key)
    if cached is not None:
        return cached
    categories = await get_categories() if genres or not show_mature else []
    names = {g["slug"]: str(g["id"]) for g in categories}
    unsupported = [g for g in genres if g not in names]
    excluded = [str(g["id"]) for g in categories if g["slug"] in {"adult", "hentai", "smut", "ecchi", "mature", "18"}] if not show_mature else []
    selected = [names[g] for g in genres if g in names]
    if unsupported or set(selected) & set(excluded):
        raw = {"items": [], "page": page, "page_size": limit, "total": 0, "total_pages": 1}
    else:
        filters = Filters(page=page, perPage=limit, q=keyword,
            sort={"popular": "views_desc", "favorites": "bookmarks_desc", "alphabetical": "title_asc"}.get(sort, "updated_desc"),
            status={"ongoing": "Còn tiếp", "completed": "Hoàn thành", "hiatus": "Tạm dừng"}.get(status, ""),
            include=selected, exclude=excluded)
        raw = await run(lambda source: source.listing(filters))
    await _remember_cards(raw["items"])
    rows = [item(row) for row in raw["items"] if show_mature or not row.get("adult")]
    result = {"status": "success", "data": {"items": rows, "params": {"pagination": {
        "currentPage": page, "totalItemsPerPage": limit, "totalItems": raw["total"],
        "totalPages": max(1, raw["total_pages"])}}}, "meta": {"source": "moetruyen", "unsupported_genres": unsupported}}
    return await _remember(key, result)


@coalesce_reads
async def get_basic(identifier):
    value = await asyncio.to_thread(_read, f"moetruyen:card:{identifier}")
    if value is None:
        value = await run(lambda source: source.basic(native_id(identifier)))
        await _remember_cards([value])
    return item(value)


@coalesce_reads
async def get_manga_detail(identifier):
    key = f"moetruyen:detail:v1:{identifier}"
    existing = await asyncio.to_thread(_read, key)
    if existing is not None:
        return existing
    def load(source):
        value = source.detail(native_id(identifier))
        if value["chapter_pagination"]["total_pages"] > 1:
            value["chapters"] = source.all_chapters(native_id(identifier))["items"]
        return value
    value = await run(load)
    await _remember_cards([value])
    card = item(value)
    chapters = [_chapter(ch, card["id"]) for ch in value["chapters"]]
    card["chapters"] = [{"server_name": "Mòe Truyện", "server_data": chapters}]
    return await _remember(key, {"status": "success", "data": {"item": card,
        "seoOnPage": {"titleHead": card["name"]}}, "meta": {"chapters_complete": True}})


def _remote_base():
    base = os.getenv("MOE_READER_API_URL", "").strip().rstrip("/")
    parsed = urlsplit(base)
    if base and (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path):
        raise HTTPException(503, "Cấu hình máy chủ ảnh Mòe chưa hợp lệ.")
    return base


async def _remote(path, *, image=False):
    headers = {"Accept": "image/jpeg" if image else "application/json"}
    key = os.getenv("MOE_READER_API_KEY", "")
    if key:
        headers["X-API-Key"] = key
    async with httpx.AsyncClient(timeout=75, follow_redirects=False) as client:
        response = await client.get(_remote_base() + path, headers=headers)
    if response.status_code != 200:
        raise HTTPException(404 if response.status_code == 404 else 502, "Máy chủ ảnh Mòe chưa tải được chương.")
    if image:
        from fastapi_app.utils.upload_security import detect_image_content_type
        mime = detect_image_content_type(response.content)
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(502, "Máy chủ Mòe trả ảnh không hợp lệ.")
        return response.content, mime
    return response.json()


@coalesce_reads
async def get_chapter(token):
    identifier, number = chapter_identity(token)
    native = native_id(identifier)
    if _remote_base():
        value = await _remote(f"/api/v1/comics/{native}/chapters/{number}")
    else:
        value = await run(lambda source: reader().describe(source, native, number, warm=False), reader_task=True)
    images = []
    for image in value["images"]:
        if image.get("protected"):
            url = f"/api/manga/moetruyen/image/{identifier}/{number}/{image['index']}"
        else:
            url = image.get("url")
        if not url:
            raise HTTPException(502, "Chưa tải đủ ảnh chương Mòe.")
        images.append({"image_page": image["index"], "image_file": url})
    return {"status": "success", "data": {"domain_cdn": "", "item": {
        "slug": identifier, "comic_slug": identifier, "comic_name": value.get("comic_title") or "",
        "chapter_name": number, "chapter_title": value.get("title") or "", "chapter_path": identifier,
        "chapter_image": images, "source": "moetruyen"}}}


async def get_image(identifier, number, index):
    native = native_id(identifier)
    chapter_token(identifier, number)
    if _remote_base():
        return await _remote(f"/api/v1/comics/{native}/chapters/{number}/images/{index}?format=jpeg", image=True)
    if os.getenv("VERCEL"):
        raise HTTPException(503, "Cần cấu hình máy chủ ảnh Mòe để đọc chương trên Vercel.")
    frame = await run(lambda source: reader().image(source, native, number, index, image_format="jpeg"), reader_task=True)
    return frame.content, frame.mime


async def get_cover(identifier):
    native_id(identifier)
    value = await asyncio.to_thread(_read, f"moetruyen:card:{identifier}")
    if value is None:
        value = await run(lambda source: source.basic(native_id(identifier)))
        await _remember_cards([value])
    from fastapi_app.routers.images import _fetch_image
    for url in [value.get("thumbnail_url"), *(value.get("thumbnail_fallback_urls") or [])]:
        if not url:
            continue
        content, _, mime, _ = await _fetch_image(url)
        if content and mime:
            return content, mime
    raise HTTPException(502, "Chưa tải được ảnh bìa Mòe.")


async def close():
    if reader.cache_info().currsize:
        await asyncio.to_thread(reader().close)
        reader.cache_clear()
