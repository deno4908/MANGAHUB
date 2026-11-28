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
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from functools import partial
from urllib.parse import quote, urlsplit
from uuid import uuid4

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
from fastapi_app.services.truyenqq_recovery import failure_hints, recovered_source, source_matches, surface_stale_hints
from site_access import source_authorization
import site_access


def _source_read_scope():
    # Native lifespan warmups have no reader credentials. Their denied relay
    # call must never become the in-flight result for an approved reader.
    # Approved readers can still share public QQ data without retaining tokens.
    return bool(source_authorization.get())


def _source_job_scope():
    value = recovered_source.get()
    # A signed retry must not join the ordinary read whose source just failed.
    # Public successful cache entries remain shared across all readers.
    return _source_read_scope(), (value['path'], value['sha256']) if value else None

logger = logging.getLogger(__name__)

_live: LiveService | None = None
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=5, thread_name_prefix="qq-adapter")
_image_executor = ThreadPoolExecutor(max_workers=12, thread_name_prefix="qq-images")
_reader_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="qq-reader")
_card_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="qq-card-chapter")
_cover_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="qq-cover")
_cover_source_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="qq-cover-source")
_random_pool: list[dict] = []
_catalog_jobs = {}
CATALOG_LAST_GOOD_SECONDS = 7 * 86400
COVER_SOURCE_SECONDS = 7 * 86400
DETAIL_LAST_GOOD_SECONDS = 7 * 86400
_COLLECTIONS = {
    "truyen-moi": "latest", "dang-phat-hanh": "ongoing",
    "hoan-thanh": "completed", "sap-ra-mat": "new",
}


def get_live() -> LiveService:
    global _live
    with _lock:
        if _live is None:
            settings = Settings()
            _live = LiveService(settings, SourceClient(settings, transport=TruyenQQTransport()), read_scope=_source_job_scope)
        return _live


async def run_live(method: str, *args, _pool=None, **kwargs):
    try:
        # An anonymous warmup cannot use the protected relay in whitelist
        # mode. Reject it before queuing behind readers or entering the
        # scraper's per-host request delay. Cached public payloads are read
        # by the callers before this source operation; reader credentials,
        # public mode, direct-source setups and binary CDN reads are unchanged.
        prefer_edge = os.getenv("TRUYENQQ_PREFER_EDGE", os.getenv("VERCEL", "0")).lower() in {"1", "true", "yes"}
        relay_configured = bool(os.getenv("TRUYENQQ_EDGE_URL", "default").rstrip("/"))
        if prefer_edge and relay_configured and not source_authorization.get() and method not in {"image", "chapter_image"}:
            try:
                restricted = (await asyncio.to_thread(site_access.get_state))['enabled']
            except site_access.AccessUnavailable as error:
                raise HTTPException(503, "Không thể kiểm tra quyền truy cập.", headers={
                    "Cache-Control": "no-store", "X-Site-Access-Error": "policy-unavailable",
                }) from error
            if restricted:
                raise HTTPException(503, "Không tải được dữ liệu từ TruyenQQ.", headers={
                    "Cache-Control": "no-store", "X-TruyenQQ-Error": "http-403",
                    "X-TruyenQQ-Transport": "edge-gateway",
                })
        # Creating the HTTP client also performs blocking TLS setup. Keep the
        # first request out of the event loop, just like subsequent scraping.
        def call():
            return getattr(get_live(), method)(*args, **kwargs)
        executor = _pool or (_image_executor if method in {"image", "chapter_image"} else
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
        # Cloudflare replaces origin 502 responses and strips the source hints
        # needed by browser recovery. A blocked/rate-limited source is temporarily
        # unavailable; 503 preserves its safe JSON and bounded recovery headers.
        raise HTTPException(404 if status == 404 else 503 if status in {403, 429} else 502,
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
    from fastapi_app.services.truyenqq_recovery import enabled as recovery_enabled
    if recovery_enabled():
        headers['X-TruyenQQ-Recovery'] = '1'
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
        "TruyenQQ source failed operation=%s error=%s host=%s path=%s status=%s auth=%s transport=%s colo=%s block=%s gateway=%s reason=%s",
        method, type(error).__name__, request.url.host if request else "-",
        request.url.path if request else "-", response.status_code if response is not None else "-",
        bool(source_authorization.get()),
        _source_error_headers(error).get("X-TruyenQQ-Transport", "-"),
        _source_error_headers(error).get("X-TruyenQQ-Colo", "-"),
        _source_error_headers(error).get("X-TruyenQQ-Block", "-"),
        response.extensions.get('truyenqq_gateway') if response is not None else '-',
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
            "chaptersLatest": [_chapter({**latest, "updated_at": latest.get("updated_at") or value.get("updated_at")},
                                        slug, observed)] if latest else []}
    if value.get("url"):
        card = {key: item[key] for key in ("slug", "name", "cover_url", "category", "status", "chaptersLatest")}
        observed_at = datetime.fromisoformat(observed).timestamp() if observed else time.time()
        hint = json.dumps({"cover_urls": covers, "url": value["url"], "card": card, "card_observed_at": observed_at}, ensure_ascii=False)
        hints = {f"truyenqq:cover-hint:{alias}": hint for alias in {slug, identity(value["url"])[0]}}
        hints.update({f"catalog:qq-sync:v1:{alias}": "available" for alias in {slug, identity(value["url"])[0]}})
        if cover_hints is None:
            _store_cover_hints(hints)
        else:
            cover_hints.update(hints)
    return item


def _page(value: dict) -> dict:
    cover_hints = {}
    items = [_item(item, value.get("fetched_at"), cover_hints=cover_hints) for item in value.get("items", [])]
    _store_cover_hints(cover_hints)
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


@surface_stale_hints
@coalesce_reads(scope=_source_job_scope)
async def get_home():
    payload = await _catalog_page("home")
    return await asyncio.to_thread(_remember, "truyenqq:home", payload)


def live_list_cache_key(list_type, page):
    revision = cache.get("catalog:source-version:truyenqq")
    revision = revision if isinstance(revision, str) else ""
    return f"truyenqq:live-list:{list_type}:{page}:rev={revision}"


def _decode_cached(raw):
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            pass
    return None


def _json_cached(key):
    return _decode_cached(cache.get(key))


def _fast_list_key(list_type, page):
    return f"truyenqq:live-list:v2:{list_type}:{page}"


def _read_list_cache(list_type, page):
    values = cache.get_many(['catalog:source-version:truyenqq', _fast_list_key(list_type, page)])
    revision = values.get('catalog:source-version:truyenqq')
    revision = revision if isinstance(revision, str) else ''
    stored = _decode_cached(values.get(_fast_list_key(list_type, page)))
    if isinstance(stored, dict) and stored.get('revision') == revision and stored.get('fresh_until', 0) > time.time():
        payload = stored.get('payload')
        if isinstance(payload, dict):
            return revision, payload
    return revision, None


def remember_list(list_type, page, payload, *, revision=None, fresh_seconds=8):
    current = cache.get('catalog:source-version:truyenqq')
    current = current if isinstance(current, str) else ''
    # An in-flight old reader must not overwrite a newly published chapter.
    if revision is not None and revision != current:
        return payload
    cache.set_many({
        f'truyenqq:list:{list_type}:{page}': json.dumps(payload, ensure_ascii=False),
        _fast_list_key(list_type, page): json.dumps({'revision': current, 'payload': payload,
            'fresh_until': time.time() + fresh_seconds}, ensure_ascii=False),
    }, ttl=max(60, fresh_seconds))
    return payload


def _overlay_latest(payload, *, page=1, genres=(), status=None, latest_order=False, latest_payload=None):
    latest = latest_payload if latest_payload is not None else (_json_cached("truyenqq:list:truyen-moi:1") or {})
    incoming = {item["slug"]: item for item in latest.get("data", {}).get("items", [])}
    items = payload.get("data", {}).get("items", [])
    for item in items:
        updated = incoming.get(item.get("slug"))
        chapter_ids = lambda row: [(chapter.get("chapter_api_data"), chapter.get("chapter_name"))
                                   for chapter in row.get("chaptersLatest", [])]
        if updated and chapter_ids(updated) != chapter_ids(item):
            try:
                old = [Decimal(str(ch.get('chapter_name', '')).replace(',', '.')) for ch in item.get('chaptersLatest', [])]
                new = [Decimal(str(ch.get('chapter_name', '')).replace(',', '.')) for ch in updated.get('chaptersLatest', [])]
                if old and (not new or not all(n.is_finite() for n in old + new) or max(new) < max(old)):
                    continue  # An older latest cache cannot undo a freshly recovered chapter.
            except InvalidOperation:
                if item.get('chaptersLatest'):
                    continue
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


async def _catalog_page(method, *args, background_refresh=True, refresh_timeout=None, latest_overlay=None, **kwargs):
    digest = hashlib.sha256(json.dumps([method, args, kwargs], sort_keys=True).encode()).hexdigest()
    key = "truyenqq:page-snapshot:v3:" + digest
    def read():
        if latest_overlay is None:
            return _json_cached(key), None
        values = cache.get_many([key, 'truyenqq:list:truyen-moi:1'])
        return _decode_cached(values.get(key)), _decode_cached(values.get('truyenqq:list:truyen-moi:1'))
    snapshot, latest = await asyncio.to_thread(read)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('payload'), dict):
        snapshot = None
    recovered = (isinstance(snapshot, dict) and
        (source_matches((snapshot.get('payload', {}).get('data') or {}).get('source_url')) or
         source_matches((snapshot.get('source_failure') or {}).get('X-TruyenQQ-Source-Path'))))
    async def finish(payload, *, cold=False):
        if latest_overlay is None:
            return payload
        # A live fetch may take seconds. Adopt chapters published while it was
        # in flight; the batched pre-read is sufficient only on cached pages.
        current = await asyncio.to_thread(_json_cached, 'truyenqq:list:truyen-moi:1') if cold else latest
        return await asyncio.to_thread(_overlay_latest, payload, latest_payload=current or {}, **latest_overlay)
    if snapshot is not None and not background_refresh and not recovered:
        # Interactive ranking reads can reuse this 30-minute source snapshot.
        # Do not attach an unrelated stale-page refresh to their Vercel invocation.
        return await finish(_stale_catalog_payload(snapshot))
    if recovered or snapshot is None or snapshot.get("fresh_until", 0) < time.time():
        task_key = (asyncio.get_running_loop(), key, _source_job_scope())
        task = _catalog_jobs.get(task_key)
        if task is None:
            async def refresh():
                try:
                    read = run_live(method, *args, **kwargs)
                    raw = await asyncio.wait_for(read, refresh_timeout) if refresh_timeout else await read
                    if method == "home":
                        seen = {}
                        for section in raw["sections"]:
                            for item in section["items"]:
                                seen.setdefault(item["id"], item)
                        raw = {"items": list(seen.values()), "fetched_at": raw.get("fetched_at"),
                               "source_url": raw.get("source_url")}
                    value = await asyncio.to_thread(_page, raw)
                    def save():
                        current = _json_cached(key)
                        generation = snapshot.get('generation') if snapshot else None
                        if (not recovered and isinstance(current, dict) and
                                current.get('generation') != generation):
                            return current['payload']
                        cache.set(key, json.dumps({'payload': value, 'fresh_until': time.time() + 45,
                            'generation': uuid4().hex}), ttl=CATALOG_LAST_GOOD_SECONDS)
                        return value
                    value = await asyncio.to_thread(save)
                    latest_root = (method == 'collection' and args == ('latest', 1) or
                        method == 'discover' and kwargs.get('page', 1) == 1 and
                        kwargs.get('sort', 'updated_desc') == 'updated_desc' and
                        not kwargs.get('genres') and not kwargs.get('status'))
                    if latest_root and _source_read_scope():
                        # Reuse this approved source response for native live
                        # updates. Do not make another relay request or retain
                        # the reader token in the unauthenticated probe loop.
                        from fastapi_app.services.catalog_updates import catalog_updates
                        try:
                            await catalog_updates.observe_qq_listing(value)
                        except Exception:
                            logger.warning('QQ revision publication unavailable after a successful source read')
                    return value
                except Exception as error:
                    anonymous_denial = (not _source_read_scope() and isinstance(error, HTTPException)
                        and (error.headers or {}).get('X-TruyenQQ-Transport') == 'edge-gateway')
                    if snapshot and not anonymous_denial:
                        def retain():
                            # An older failed refresh cannot roll back a
                            # verified handoff that finished in the meantime.
                            if _json_cached(key) == snapshot:
                                cache.set(key, json.dumps({**snapshot, 'fresh_until': time.time() + 30,
                                    'source_failure': failure_hints(error)}), ttl=CATALOG_LAST_GOOD_SECONDS)
                        await asyncio.to_thread(retain)
                    raise
            task = create_task(refresh())
            _catalog_jobs[task_key] = task
            def finished(done):
                _catalog_jobs.pop(task_key, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(finished)
        if recovered or snapshot is None:
            read = asyncio.shield(task)
            # An existing refresh may belong to an unrelated, unbounded latest
            # request. Bound this reader without cancelling that shared work.
            payload = deepcopy(await asyncio.wait_for(read, refresh_timeout) if refresh_timeout else await read)
            return await finish(payload, cold=True)
    return await finish(_stale_catalog_payload(snapshot))


def _stale_catalog_payload(snapshot):
    payload = snapshot['payload']
    hints = failure_hints(snapshot.get('source_failure'))
    if hints:
        return {**payload, 'data': {**payload['data'], 'source_stale': hints}}
    return payload


@surface_stale_hints
async def get_list(list_type="truyen-moi", page=1):
    if list_type == "sap-ra-mat":
        return _page({"items": [], "page": page})
    revision, shared = await asyncio.to_thread(_read_list_cache, list_type, page)
    if shared is not None and not recovered_source.get():
        return shared
    return await _load_list_page(list_type, page, revision)


@coalesce_reads(scope=_source_job_scope)
async def _load_list_page(list_type, page, revision):
    # Revision is part of the shared-read identity, so a new chapter event
    # cannot join an older in-flight request for the same page.
    payload = await _catalog_page("collection", _COLLECTIONS.get(list_type, "latest"), page,
        latest_overlay={'page': page, 'latest_order': list_type == 'truyen-moi'})
    return await asyncio.to_thread(remember_list, list_type, page, payload, revision=revision)


def invalidate_live_catalog(slugs, preserve_latest=False):
    if _live is None:
        return
    urls = {_live.source_url("/truyen-tranh/" + slug) for slug in slugs}
    _live.cache.invalidate_matching(lambda key: key == "home" or isinstance(key, tuple) and
        (key[0] in {"search", "catalog-search"} or key[0] in {"comic", "basic"} and key[1] in urls))
    _live.html_cache.invalidate_matching(lambda url: url in urls)


@coalesce_reads(scope=_source_job_scope)
async def _load_categories():
    payload = {"status": "success", "data": {"items": [_genre(g) for g in await run_live("genres")]}}
    if not _valid_categories(payload):
        raise HTTPException(502, "Không tải được thể loại TruyenQQ.")
    raw = json.dumps(payload, ensure_ascii=False)
    def save():
        cache.set('truyenqq:genres:last-good:v1', raw, ttl=30 * 86400)
        cache.set('truyenqq:genres:v1', raw, ttl=3600)
    await asyncio.to_thread(save)
    return payload


def _valid_categories(value):
    items = ((value or {}).get('data') or {}).get('items') if isinstance(value, dict) else None
    return isinstance(items, list) and bool(items) and all(
        isinstance(item, dict) and item.get('slug') and item.get('name') for item in items)


@coalesce_reads(scope=_source_job_scope)
async def get_categories():
    if source_matches('/doc-truyen'):
        return await _load_categories()
    fresh = await asyncio.to_thread(_json_cached, 'truyenqq:genres:v1')
    if _valid_categories(fresh):
        return fresh
    stale = await asyncio.to_thread(_json_cached, 'truyenqq:genres:last-good:v1')
    if not _valid_categories(stale):
        return await _load_categories()
    retry_key = 'truyenqq:genres:refresh:' + str(int(_source_read_scope()))
    job_key = (asyncio.get_running_loop(), retry_key)
    if job_key not in _catalog_jobs and not await asyncio.to_thread(cache.get, retry_key):
        await asyncio.to_thread(cache.set, retry_key, '1', ttl=60)
        async def refresh():
            try:
                await _load_categories()
            except Exception:
                logger.debug('Retaining verified QQ genres during source outage')
            finally:
                _catalog_jobs.pop(job_key, None)
        _catalog_jobs[job_key] = create_task(refresh())
    return deepcopy(stale)


def _cover_source(value):
    if not isinstance(value, dict) or not isinstance(value.get("url"), str):
        return None
    urls = value.get("cover_urls")
    if not isinstance(urls, list) or not urls or not all(isinstance(url, str) and url.startswith(("https://", "http://")) for url in urls):
        return None
    return {"cover_urls": urls, "url": value["url"]}


def _store_cover_hints(hints):
    cache.set_many(hints, ttl=86400)
    # Keep only the stable source image reference longer. Chapter/card labels
    # retain their original expiry and normal update/invalidation behavior.
    sources = {key.replace("truyenqq:cover-hint:", "truyenqq:cover-source:v1:", 1): json.dumps(source)
               for key, raw in hints.items() if key.startswith("truyenqq:cover-hint:")
               and (source := _cover_source(_decode_cached(raw)))}
    if sources:
        cache.set_many(sources, ttl=COVER_SOURCE_SECONDS)


def _cached_cover_source(identifier):
    keys = [f"truyenqq:cover-hint:{identifier}", f"truyenqq:cover-source:v1:{identifier}",
            f"truyenqq:detail:{identifier}", f"truyenqq:detail-last-good:{identifier}",
            f"catalog:card-metadata:v1:{identifier}"]
    values = cache.get_many(keys)
    canonical = _cached_detail_identifier(identifier, values)
    if canonical != identifier:
        values.update(cache.get_many([f"truyenqq:{kind}{canonical}" for kind in
                                     ("cover-hint:", "cover-source:v1:", "detail:", "detail-last-good:")]))
    for slug in dict.fromkeys([identifier, canonical]):
        for kind in ("cover-hint:", "cover-source:v1:"):
            hint = _decode_cached(values.get(f"truyenqq:{kind}{slug}"))
            if _cover_source(hint):
                return hint, canonical
        for kind in ("detail:", "detail-last-good:"):
            payload = _decode_cached(values.get(f"truyenqq:{kind}{slug}")) or {}
            item = (payload.get("data") or {}).get("item") or {}
            source_slug = item.get("source_slug") or item.get("slug")
            if item.get("source") == "truyenqq" and item.get("cover_original") and source_slug == canonical:
                hint = _cover_source({"url": Settings().base_url.rstrip("/") + "/truyen-tranh/" + canonical,
                                      "cover_urls": [item["cover_original"]]})
                if hint:
                    return hint, canonical
    return None, canonical


@coalesce_reads(scope=_source_job_scope)
async def get_cover_info(identifier):
    # Catalog work can occupy the default/thread adapter pool for seconds.
    # A known image reference must not wait behind a new chapter/catalog crawl.
    context = copy_context()
    hint, canonical = await asyncio.get_running_loop().run_in_executor(
        _cover_executor, context.run, _cached_cover_source, identifier)
    if hint is not None:
        return hint
    value = await run_live("basic", canonical, _pool=_cover_source_executor)
    source = _cover_source(value)
    if source:
        await asyncio.get_running_loop().run_in_executor(_cover_executor, partial(cache.set_many, {
            f"truyenqq:cover-source:v1:{slug}": json.dumps(source)
            for slug in {identifier, canonical}}, ttl=COVER_SOURCE_SECONDS))
    return value


async def get_total_count():
    return (await run_live("catalog"))["total"]


@surface_stale_hints
async def get_category_manga(slug, page=1):
    value = await _catalog_page("genre_comics", slug, page,
        latest_overlay={'page': page, 'genres': [slug], 'latest_order': True})
    return await asyncio.to_thread(_remember, f"truyenqq:category:{slug}:{page}", value)


@surface_stale_hints
async def get_filtered(*, genres=(), page=1, sort="updated_desc", status=None, overlay_latest=True,
                       background_refresh=True, refresh_timeout=None):
    value = await _catalog_page("discover", page=page, genres=genres, sort=sort, status=status,
        background_refresh=background_refresh, refresh_timeout=refresh_timeout,
        latest_overlay={'page': page, 'genres': genres, 'status': status, 'latest_order': sort == 'updated_desc'} if overlay_latest else None)
    return value


async def resolve_slug_from_id(manga_id):
    # Mongo ObjectIds cannot identify a QQ comic; never guess a different book.
    if re.fullmatch(r"[0-9a-f]{24}", manga_id, re.I):
        return None
    url = await run_live("resolve", manga_id)
    return "-".join(identity(url)[:2])


def _cached_detail_identifier(slug, values=None):
    """Reuse a QQ reference learned by cards instead of crawling every sitemap."""
    if re.fullmatch(r"[a-zA-Z0-9]+(?:-+[a-zA-Z0-9]+)*-\d+", slug):
        return slug  # Native source IDs already identify the exact comic.
    from fastapi_app.services.card_metadata import cached_metadata
    metadata = cached_metadata(slug, values) or {}
    canonical = str(metadata.get("slug") or "")
    if metadata.get("source") == "truyenqq" and re.fullmatch(r"[a-zA-Z0-9]+(?:-+[a-zA-Z0-9]+)*-\d+", canonical):
        return canonical
    hint_key = f"truyenqq:cover-hint:{slug}"
    hint = _json_cached(hint_key) if values is None else _decode_cached(values.get(hint_key))
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


def _valid_detail(payload):
    item = ((payload or {}).get('data') or {}).get('item') if isinstance(payload, dict) else None
    return isinstance(item, dict) and item.get('source') == 'truyenqq' and 'chapters' in item


def _overlay_detail_latest(payload, latest):
    """Expose a newly observed chapter while a full source detail refresh runs."""
    item = payload['data']['item']
    canonical = item.get('source_slug') or item.get('slug')
    incoming = next((row for row in ((latest or {}).get('data') or {}).get('items', [])
                     if row.get('slug') == canonical), None)
    chapter = next(iter((incoming or {}).get('chaptersLatest') or []), None)
    if not chapter:
        return payload
    path = str(chapter.get('chapter_api_data') or '')
    if not path.startswith('/api/manga/chapter/'):
        return payload
    try:
        slug, number = parse_chapter_token(path.rsplit('/', 1)[-1])
        incoming_number = Decimal(number.replace('-', '.'))
        if slug != canonical or not incoming_number.is_finite():
            return payload
        groups = item.get('chapters') or []
        chapters = [row for group in groups for row in group.get('server_data', [])]
        if any(row.get('chapter_api_data') == path for row in chapters):
            return payload
        existing = [Decimal(str(row.get('chapter_name', '')).replace(',', '.')) for row in chapters]
        if existing and (not all(value.is_finite() for value in existing) or incoming_number <= max(existing)):
            return payload
    except (HTTPException, InvalidOperation, ValueError):
        return payload
    if not groups:
        groups = item['chapters'] = [{'server_name': 'TruyenQQ', 'server_data': []}]
    groups[0].setdefault('server_data', []).insert(0, deepcopy(chapter))
    item['chaptersLatest'] = [deepcopy(chapter)]
    return payload


@coalesce_reads(scope=_source_job_scope)
async def _load_manga_detail(slug):
    try:
        identifier = await asyncio.to_thread(_cached_detail_identifier, slug)
        value = await run_live("comic", identifier)
        item = await asyncio.to_thread(_item, value)
        chapters = [_chapter(ch, item["slug"]) for ch in value.get("chapters", [])]
        item["chapters"] = [{"server_name": "TruyenQQ", "server_data": chapters}]
        item["chaptersLatest"] = chapters[:1]
        payload = {"status": "success", "data": {"item": item, "seoOnPage": {"titleHead": item["name"]}}}
        await asyncio.to_thread(_remember, f"truyenqq:detail:{slug}", payload)
        await asyncio.to_thread(cache.set, f'truyenqq:detail-last-good:{slug}', json.dumps(payload, ensure_ascii=False), ttl=DETAIL_LAST_GOOD_SECONDS)
        return payload
    except HTTPException as error:
        if error.status_code == 404:
            # A confirmed removal must not remain available through stale data.
            await asyncio.to_thread(cache.delete, f'truyenqq:detail-last-good:{slug}')
        raise


@surface_stale_hints
@coalesce_reads(scope=_source_job_scope)
async def get_manga_detail(slug):
    fresh_key = f'truyenqq:detail:{slug}'
    stale_key = f'truyenqq:detail-last-good:{slug}'
    retry_key = f'truyenqq:detail-refresh:{slug}:{int(_source_read_scope())}'
    legacy = not re.fullmatch(r"[a-zA-Z0-9]+(?:-+[a-zA-Z0-9]+)*-\d+", slug)
    keys = [fresh_key, stale_key, retry_key, 'truyenqq:list:truyen-moi:1']
    if legacy:
        keys += [f'truyenqq:cover-hint:{slug}', f'catalog:card-metadata:v1:{slug}']
    values = await asyncio.to_thread(cache.get_many, keys)
    cached, stale = _decode_cached(values.get(fresh_key)), _decode_cached(values.get(stale_key))
    identifier = _cached_detail_identifier(slug, values) if legacy else slug
    if source_matches('/truyen-tranh/' + identifier):
        payload = await _load_manga_detail(identifier)
        await asyncio.to_thread(cache.delete, retry_key)
    elif _valid_detail(cached):
        payload = deepcopy(cached)
        if not _valid_detail(stale):
            await asyncio.to_thread(cache.set, stale_key, json.dumps(cached, ensure_ascii=False), ttl=DETAIL_LAST_GOOD_SECONDS)
    elif _valid_detail(stale):
        payload = deepcopy(stale)
        job_key = (asyncio.get_running_loop(), retry_key)
        if job_key not in _catalog_jobs and not values.get(retry_key):
            await asyncio.to_thread(cache.set, retry_key, '1', ttl=30)
            async def refresh():
                try:
                    await _load_manga_detail(slug)
                except Exception as error:
                    hints = failure_hints(error)
                    if hints:
                        await asyncio.to_thread(cache.set, retry_key, json.dumps(hints), ttl=30)
                    logger.debug('Retaining last valid QQ detail during source outage')
                finally:
                    _catalog_jobs.pop(job_key, None)
            _catalog_jobs[job_key] = create_task(refresh())
        hints = failure_hints(_decode_cached(values.get(retry_key)))
        if hints:
            payload['data']['source_stale'] = hints
    else:
        # An old OTruyen title and its verified QQ slug refer to one source
        # detail. Share its existing cache/in-flight read instead of resolving
        # and downloading the same comic separately for every saved alias.
        payload = await get_manga_detail(identifier) if identifier != slug else await _load_manga_detail(slug)
    payload = _overlay_detail_latest(payload, _decode_cached(values.get('truyenqq:list:truyen-moi:1')))
    item = payload["data"]["item"]
    canonical = item["slug"]
    # Keep existing website IDs so ratings, views, comments and bookmarks keep
    # their original keys. Chapter tokens still carry the exact QQ comic ID.
    if canonical != slug:
        item["source_slug"] = canonical
        item["slug"] = item["id"] = slug
    return payload


@coalesce_reads(scope=_source_job_scope)
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


async def _load_chapter_manifest(slug, number):
    key = f"truyenqq:chapter-manifest:v1:{slug}:{number}"
    value = await run_live("chapter", slug, number)
    manifest = {field: value[field] for field in ("images", "url", "title")}
    if not manifest['images'] or not manifest['url']:
        raise HTTPException(502, 'Chưa tải được ảnh của chương. Vui lòng thử lại.',
                            headers={'Cache-Control': 'no-store', 'X-TruyenQQ-Error': 'invalid-response'})
    # Match the reader's one-hour chapter cache. New chapters have their own
    # keys; re-reading this chapter must not fetch its HTML every five minutes.
    await asyncio.to_thread(cache.set, key, json.dumps(manifest), ttl=3600)
    await asyncio.to_thread(cache.set, key + ':last-good', json.dumps(manifest), ttl=7 * 86400)
    return manifest


@coalesce_reads(scope=_source_job_scope)
async def get_chapter_manifest(slug, number):
    """Keep a reading session alive when the fresh source cache expires.

    The API still authorizes each reader before these public source URLs are
    reused. Refresh the last valid manifest in the background, never per image.
    """
    key = f"truyenqq:chapter-manifest:v1:{slug}:{number}"
    cached = await asyncio.to_thread(_json_cached, key)
    if isinstance(cached, dict) and cached.get('images') and cached.get('url'):
        return cached
    stale = await asyncio.to_thread(_json_cached, key + ':last-good')
    if not isinstance(stale, dict) or not stale.get('images') or not stale.get('url'):
        return await _load_chapter_manifest(slug, number)
    retry_key = key + ':refresh:' + str(int(_source_read_scope()))
    job_key = (asyncio.get_running_loop(), retry_key)
    if job_key not in _catalog_jobs and not await asyncio.to_thread(cache.get, retry_key):
        # Shared cooldown prevents every page/instance retrying a blocked source.
        await asyncio.to_thread(cache.set, retry_key, '1', ttl=300)
        async def refresh():
            try:
                await _load_chapter_manifest(slug, number)
            except Exception:
                # Older sessions may still have the previous one-day expiry.
                # Preserve their verified pages while the source is unavailable.
                await asyncio.to_thread(cache.set, key + ':last-good', json.dumps(stale), ttl=7 * 86400)
                logger.debug('Retaining last valid QQ chapter manifest after refresh failure')
            finally:
                _catalog_jobs.pop(job_key, None)
        _catalog_jobs[job_key] = create_task(refresh())
    return stale


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
