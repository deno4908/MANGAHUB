"""Stable rated prefix followed by the unchanged latest QQ sequence."""
import asyncio
import hashlib
import json
from copy import deepcopy

from fastapi import HTTPException
from fastapi_app.services import card_metadata

SNAPSHOT_TTL = 900


def _read(key):
    return card_metadata._read(key)


def _save_page(key, value):
    card_metadata.cache.add(key, json.dumps(value, ensure_ascii=False), ttl=SNAPSHOT_TTL)
    return _read(key) or value


def _checkpoints(key, page):
    keys = [f"{key}:after:{number}" for number in range(max(1, page - 4096), page)]
    values = card_metadata.cache.get_many(keys) if keys else {}
    for name in reversed(keys):
        try:
            value = json.loads(values[name])
            if all(type(value.get(field)) is int for field in ("position", "source_page", "index")):
                return value
        except (KeyError, TypeError, ValueError):
            continue
    return None


async def page(*, number, limit, ranked, first, source, visible, snapshot_key, source_pages, total_bound):
    # The native order is frozen together with its cursors. A cursor can never
    # point into a later, differently ordered version of the same source page.
    head = [(item.get("slug"), [(chapter.get("chapter_api_data"), chapter.get("chapter_name"))
        for chapter in item.get("chaptersLatest", [])]) for item in first["data"]["items"]]
    epoch = hashlib.sha256(json.dumps([snapshot_key, head,
        [(row["slug"], row.get("rating_average"), row.get("rating_count")) for row in ranked]],
        sort_keys=True).encode()).hexdigest()
    key = f"qq:rating-order:v1:{limit}:{epoch}"
    offset, end = (number - 1) * limit, number * limit
    if offset >= total_bound and number > 1:
        raise HTTPException(404, "QQ page exceeds the available catalog")
    chosen = deepcopy(ranked[offset:end])
    if len(chosen) == limit:
        return chosen, None, None
    promoted = {row["slug"] for row in ranked}
    position, source_number, index = len(ranked), 1, 0
    checkpoint = await asyncio.to_thread(_checkpoints, key, number)
    if checkpoint and len(ranked) <= checkpoint["position"] <= offset:
        position, source_number, index = (checkpoint[field] for field in ("position", "source_page", "index"))
    writes = {}
    deadline = asyncio.get_running_loop().time() + 30
    try:
        while position < end and source_number <= source_pages:
            page_key = f"{key}:source:{source_number}"
            payload = await asyncio.to_thread(_read, page_key)
            if payload is None:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                value = first if source_number == 1 else await asyncio.wait_for(source(source_number), remaining)
                payload = await asyncio.to_thread(_save_page, page_key, value)
            items = payload["data"]["items"]
            while index < len(items) and position < end:
                item = items[index]
                index += 1
                if item.get("slug") in promoted or not visible(item):
                    continue
                if position >= offset:
                    chosen.append(deepcopy(item))
                position += 1
                if position % limit == 0:
                    writes[f"{key}:after:{position // limit}"] = json.dumps({
                        "position": position, "source_page": source_number, "index": index})
            if index == len(items):
                source_number += 1
                index = 0
        exact_total = position if source_number > source_pages else None
        return chosen, None, exact_total
    except (HTTPException, asyncio.TimeoutError) as error:
        if not chosen:
            if isinstance(error, asyncio.TimeoutError):
                raise HTTPException(504, "TruyenQQ phản hồi quá chậm. Vui lòng thử lại.",
                    headers={"X-TruyenQQ-Error": "timeout", "Cache-Control": "no-store"}) from error
            raise
        return chosen, error, None
    finally:
        if writes:
            await asyncio.to_thread(card_metadata.cache.set_many, writes, ttl=SNAPSHOT_TTL)
