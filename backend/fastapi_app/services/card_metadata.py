"""Canonical card labels, without fetching full chapter lists or changing user stats."""
import asyncio
import json
import re

from fastapi import HTTPException
from fastapi_app.services import mangadex_service as mdx, truyenqq_service as qq
from fastapi_app.services.cache_service import cache
from fastapi_app.services.request_coalescing import coalesce_reads

_qq_slots = asyncio.Semaphore(3)
_pending_reads = set()
_BATCH_WAIT_SECONDS = 3.0


def _retain(task):
    _pending_reads.add(task)

    def finished(done):
        _pending_reads.discard(done)
        if not done.cancelled():
            done.exception()

    task.add_done_callback(finished)
    return task


def _read(key):
    value = cache.get(key)
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return None


def _from_qq(item):
    return {"id": item["slug"], "slug": item["slug"], "source": "truyenqq",
            "title": item.get("name", ""), "cover_url": item.get("cover_url", ""),
            "genres": [genre["name"] for genre in item.get("category", [])],
            "tags": [genre["slug"] for genre in item.get("category", [])],
            "status": item.get("status", "ongoing"), "chapters_latest": item.get("chaptersLatest", [])}


def cached_metadata(identifier):
    hint = _read(f"truyenqq:cover-hint:{identifier}") or {}
    item = hint.get("card")
    if not item:
        detail = _read(f"truyenqq:detail:{identifier}") or {}
        item = detail.get("data", {}).get("item")
    if isinstance(item, dict) and item.get("name") and item.get("slug"):
        return _from_qq(item)
    return _read(f"catalog:card-metadata:v1:{identifier}")


@coalesce_reads
async def _qq_metadata(identifier):
    existing = cached_metadata(identifier)
    if existing:
        return existing
    if re.fullmatch(r"[0-9a-f]{24}", identifier):
        return None  # An old OTruyen ObjectId does not identify a QQ book.
    async with _qq_slots:
        try:
            value = await qq.run_live("basic", identifier)
            return _from_qq(qq._item(value))
        except HTTPException as error:
            if error.status_code == 404:
                return None
            raise


def _from_mdx(raw):
    identifier = raw["id"]
    relationships = raw.get("relationships") or []
    parsed = mdx._parse_manga(raw.get("attributes") or {}, identifier,
                            mdx._extract_people_from_relationships(relationships, "author"),
                            mdx._extract_people_from_relationships(relationships, "artist"),
                            mdx._extract_cover_url(identifier, relationships))
    return {"id": identifier, "slug": identifier, "source": "mangadex", "title": parsed["title"],
            "cover_url": parsed["cover_url"], "genres": parsed["genres"], "status": parsed["status"],
            "content_rating": parsed["content_rating"]}


@coalesce_reads
async def _mdx_metadata(identifiers):
    found = {}
    missing = []
    for identifier in identifiers:
        raw = mdx._load_json_cache_payload(f"mangadex:metadata:{identifier}:rev={mdx._live_revision(identifier)}")
        if raw and raw.get("data"):
            found[identifier] = _from_mdx(raw["data"])
        else:
            missing.append(identifier)
    if missing:
        response = await mdx._request_json("/manga", {"ids[]": missing, "limit": len(missing),
            "includes[]": ["cover_art", "author", "artist"],
            "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"]})
        for raw in response.get("data") or []:
            identifier = raw.get("id")
            if identifier in missing:
                found[identifier] = _from_mdx(raw)
                mdx._cache_payload(f"mangadex:metadata:{identifier}:rev={mdx._live_revision(identifier)}",
                                   {"data": raw}, ttl=mdx.MANGA_DETAIL_TTL)
    for identifier, item in found.items():
        cache.set(f"catalog:card-metadata:v1:{identifier}", json.dumps(item), ttl=3600)
        if item.get("cover_url"):
            cache.set(f"mangadex:cover-url:v2:{identifier}", item["cover_url"], ttl=3600)
    return found


async def get_many(identifiers):
    from fastapi_app.routers.manga import _extract_mangadex_id
    result = {}
    missing_mdx = {}
    missing_qq = []
    for identifier in sorted(set(identifiers)):
        item = cached_metadata(identifier)
        if item:
            result[identifier] = item
            continue
        mdx_id = _extract_mangadex_id(identifier)
        if mdx_id:
            missing_mdx[identifier] = mdx_id
        else:
            missing_qq.append(identifier)
    async def manga_dex():
        if not missing_mdx:
            return
        try:
            found = await _mdx_metadata(tuple(sorted(set(missing_mdx.values()))))
            for requested, identifier in missing_mdx.items():
                result[requested] = found.get(identifier)
        except (RuntimeError, HTTPException):
            pass
    async def truyen_qq(identifier):
        try:
            result[identifier] = await _qq_metadata(identifier)
        except (HTTPException, RuntimeError):
            pass
    jobs = ([_retain(asyncio.create_task(manga_dex()))] if missing_mdx else [])
    jobs.extend(_retain(asyncio.create_task(truyen_qq(identifier))) for identifier in missing_qq)
    if jobs:
        # Return the ready labels without making every card wait for one slow
        # source. Shared reads finish warming the cache for the client's retry.
        await asyncio.wait(jobs, timeout=_BATCH_WAIT_SECONDS)
    return dict(result)
