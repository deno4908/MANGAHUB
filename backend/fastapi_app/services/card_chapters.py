"""Progressive latest-chapter hydration, isolated from catalog and reader requests."""
import asyncio
from serverless_runtime import create_task
import json
import re
import time

from fastapi import HTTPException
from fastapi_app.services import card_metadata, mangadex_service as mdx, truyenqq_service as qq
from fastapi_app.services.cache_service import cache

_jobs = {}
_slots = {"mangadex": asyncio.Semaphore(2), "truyenqq": asyncio.Semaphore(2), "moetruyen": asyncio.Semaphore(2)}
MAX_PENDING = 128
CHAPTER_TTL = 120


def _identity(identifier, values=None):
    from fastapi_app.services.moetruyen_service import is_identifier
    if is_identifier(identifier):
        return "moetruyen", identifier
    from fastapi_app.routers.manga import _extract_mangadex_id
    mdx_id = _extract_mangadex_id(identifier)
    if mdx_id:
        return "mangadex", mdx_id
    metadata = card_metadata.cached_metadata(identifier, values) or {}
    return "truyenqq", metadata.get("slug") or identifier


def _key(source, identifier, values=None):
    revision_key = f"catalog:book-version:{source}:{identifier}"
    revision = (cache.get(revision_key) if values is None else values.get(revision_key)) or ""
    return f"catalog:card-chapter:v3:{source}:{identifier}:rev={revision}"


def _from_qq(item):
    latest = (item.get("chaptersLatest") or [{}])[0]
    token = str(latest.get("chapter_api_data") or "").rsplit("/", 1)[-1]
    if not token.startswith("qq--"):
        return None
    return {"id": token, "chapter_name": latest.get("chapter_name", ""),
            "chapter_title": latest.get("chapter_title", ""), "publish_at": latest.get("updatedAt", ""),
            "source": "truyenqq", "slug": item["slug"]}


def _from_mdx(identifier, info):
    if not info or not info.get("id"):
        return None
    return {**info, "source": "mangadex", "slug": identifier}


def _read(source, identifier, values=None):
    value = card_metadata._read(_key(source, identifier, values), values)
    if value is not None:
        return value
    chapter = None
    if source == "mangadex":
        revision = (values or {}).get(f"catalog:book-version:{source}:{identifier}") or ""
        key = mdx._latest_chapter_cache_key(identifier, "vi", revision=revision) if values is not None else mdx._latest_chapter_cache_key(identifier, "vi")
        info = card_metadata._read(key, values)
        chapter = _from_mdx(identifier, info)
        if chapter:
            return {"chapter": chapter, "pending": not bool(info.get("verified_head"))}
    else:
        hint = card_metadata._read(f"truyenqq:cover-hint:{identifier}", values) or {}
        if time.time() - float(hint.get("card_observed_at") or 0) < CHAPTER_TTL:
            chapter = _from_qq(hint.get("card") or {})
            if chapter and not chapter.get("publish_at"):
                chapter = None  # Older card hints omitted the source update label.
    return {"chapter": chapter, "pending": False} if chapter else None


def cached_chapter(identifier, values=None):
    source, canonical = _identity(identifier, values)
    value = _read(source, canonical, values)
    return (value or {}).get("chapter") if not (value or {}).get("pending") else None


async def _load(source, identifier, key):
    try:
        async with _slots[source]:
            if source == "mangadex":
                # A recent-update catalog can contain chapter 37 even when 44
                # already exists. Verify the highest VI chapter, just one row.
                info = await mdx._get_latest_vi_chapter_for_manga(identifier, ignore_cache=True, raise_on_error=True)
                chapter = _from_mdx(identifier, info)
            elif source == "moetruyen":
                from fastapi_app.services import moetruyen_service as moe
                value = await moe.run(lambda source: source.basic(moe.native_id(identifier)))
                await moe._remember_cards([value])
                latest = (moe.item(value).get("chaptersLatest") or [None])[0]
                chapter = ({"id": latest["chapter_api_data"], "chapter_name": latest["chapter_name"],
                    "chapter_title": latest["chapter_title"], "publish_at": latest["publish_at"],
                    "source": "moetruyen", "slug": identifier} if latest else None)
            else:
                # A search reference may have a title/cover but no chapter. Skip
                # that incomplete card cache and parse only basic HTML fields.
                value = await qq.run_live("basic_latest", identifier)
                chapter = _from_qq(await asyncio.to_thread(qq._item, value))
        result = {"chapter": chapter, "pending": False}
        if chapter is None:
            result["state"] = "empty"
        await asyncio.to_thread(cache.set, key, json.dumps(result), ttl=CHAPTER_TTL if chapter else 30)
    except HTTPException as error:
        state = "unavailable" if error.status_code == 404 else "retry"
        result = {"chapter": None, "pending": False, "state": state}
        if state == "retry":
            result["retry_after"] = 30_000
        await asyncio.to_thread(cache.set, key, json.dumps(result), ttl=30)
    except (RuntimeError, ValueError):
        await asyncio.to_thread(cache.set, key, json.dumps({"chapter": None, "pending": False, "state": "retry", "retry_after": 30_000}), ttl=30)


def prefetch_cached(identifiers):
    identifiers = list(dict.fromkeys(identifiers))
    values = cache.get_many([key for identifier in identifiers for key in card_metadata.metadata_keys(identifier)])
    identities = {identifier: _identity(identifier, values) for identifier in identifiers}
    versions = [f"catalog:book-version:{source}:{canonical}" for source, canonical in identities.values()]
    values.update(cache.get_many(versions))
    keys = []
    for source, canonical in identities.values():
        keys.extend([_key(source, canonical, values), f"truyenqq:cover-hint:{canonical}"])
        if source == "mangadex":
            keys.append(mdx._latest_chapter_cache_key(canonical, "vi", revision=values.get(f"catalog:book-version:{source}:{canonical}") or ""))
    values.update(cache.get_many(keys))
    return identities, values


async def get_many(identifiers):
    result = {}
    loop = asyncio.get_running_loop()
    identities, values = await asyncio.to_thread(prefetch_cached, identifiers)
    for identifier, (source, canonical) in identities.items():
        if source == "truyenqq":
            from fastapi_app.routers.manga import _decode_otruyen_route_id
            if re.fullmatch(r"[0-9a-f]{24}", canonical) or _decode_otruyen_route_id(canonical):
                result[identifier] = {"chapter": None, "pending": False, "state": "unavailable"}
                continue
        found = _read(source, canonical, values)
        if found is not None and not found.get("pending"):
            result[identifier] = found
            continue
        key = _key(source, canonical, values)
        job_key = (loop, key)
        if job_key not in _jobs and len(_jobs) < MAX_PENDING:
            task = create_task(_load(source, canonical, key))
            _jobs[job_key] = task

            def finished(done, job_key=job_key):
                if _jobs.get(job_key) is done:
                    _jobs.pop(job_key, None)
                if not done.cancelled():
                    done.exception()

            task.add_done_callback(finished)
        result[identifier] = found or {"chapter": None, "pending": True}
    return result
