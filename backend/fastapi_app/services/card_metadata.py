"""Canonical card labels, without fetching full chapter lists or changing user stats."""
import asyncio
from serverless_runtime import create_task
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


def _read(key, values=None):
    value = cache.get(key) if values is None else values.get(key)
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


def metadata_keys(identifier):
    return [f"truyenqq:cover-hint:{identifier}", f"truyenqq:detail:{identifier}",
            f"catalog:card-metadata:v1:{identifier}"]


def cached_metadata(identifier, values=None):
    hint = _read(f"truyenqq:cover-hint:{identifier}", values) or {}
    item = hint.get("card")
    if not item:
        detail = _read(f"truyenqq:detail:{identifier}", values) or {}
        item = detail.get("data", {}).get("item")
    if isinstance(item, dict) and item.get("name") and item.get("slug"):
        return _from_qq(item)
    return _read(f"catalog:card-metadata:v1:{identifier}", values)


@coalesce_reads
async def _qq_metadata(identifier):
    existing = await asyncio.to_thread(cached_metadata, identifier)
    if existing:
        return existing
    if re.fullmatch(r"[0-9a-f]{24}", identifier):
        return None  # An old OTruyen ObjectId does not identify a QQ book.
    async with _qq_slots:
        try:
            value = await qq.run_live("basic", identifier)
            return _from_qq(await asyncio.to_thread(qq._item, value))
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
    revisions = await asyncio.to_thread(cache.get_many, [f"catalog:book-version:mangadex:{identifier}" for identifier in identifiers])
    keys = {identifier: f"mangadex:metadata:{identifier}:rev={revisions.get('catalog:book-version:mangadex:' + identifier) or ''}"
            for identifier in identifiers}
    values = await asyncio.to_thread(cache.get_many, keys.values())
    fresh = {}
    for identifier in identifiers:
        raw = _read(keys[identifier], values)
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
                fresh[keys[identifier]] = json.dumps({"data": raw}, ensure_ascii=False)
    labels = {}
    for identifier, item in found.items():
        labels[f"catalog:card-metadata:v1:{identifier}"] = json.dumps(item)
        if item.get("cover_url"):
            labels[f"mangadex:cover-url:v2:{identifier}"] = item["cover_url"]
    await asyncio.gather(
        asyncio.to_thread(cache.set_many, fresh, ttl=mdx.MANGA_DETAIL_TTL),
        asyncio.to_thread(cache.set_many, {key + ":stale": value for key, value in fresh.items()}, ttl=mdx.STALE_TTL),
        asyncio.to_thread(cache.set_many, labels, ttl=3600),
    )
    return found


async def get_many(identifiers):
    from fastapi_app.routers.manga import _extract_mangadex_id
    result = {}
    missing_mdx = {}
    missing_qq = []
    values = await asyncio.to_thread(cache.get_many, [key for identifier in set(identifiers) for key in metadata_keys(identifier)])
    for identifier in sorted(set(identifiers)):
        item = cached_metadata(identifier, values)
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
    jobs = ([_retain(create_task(manga_dex()))] if missing_mdx else [])
    jobs.extend(_retain(create_task(truyen_qq(identifier))) for identifier in missing_qq)
    if jobs:
        # Return the ready labels without making every card wait for one slow
        # source. Shared reads finish warming the cache for the client's retry.
        await asyncio.wait(jobs, timeout=_BATCH_WAIT_SECONDS)
    return dict(result)
