"""One eligible catalog and one filter pass for every MangaDex browse order."""
import asyncio
import json
import logging
import re
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from serverless_runtime import create_task

from fastapi_app.services import cache_service, mangadex_service as mdx
from fastapi_app.services.request_coalescing import coalesce_reads

STATS_KEY = "mangadex:browse:local-statistics:v1"
_local_stats = None
_local_until = 0
_refresh_tasks = {}
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mdx-statistics")
logger = logging.getLogger(__name__)


def _id(value):
    value = str(value or "").removeprefix("mdx-").lower()
    return value if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value) else ""


def _rows(db, table, fields, order):
    offset = 0
    while True:
        query = db.table(table).select(fields).order(order)
        if table == "ratings":
            query = query.order("user_id")
        rows = query.range(offset, offset + 499).execute().data
        if not isinstance(rows, list):
            raise RuntimeError("Invalid local catalog statistics")
        yield from rows
        if len(rows) < 500:
            return
        offset += len(rows)


def _read_statistics(db):
    from fastapi_app.routers.ratings import _aggregate_rows_by_user
    stats, ratings = {}, defaultdict(list)
    # Independent tables share a bounded pool; each table still reads every
    # page in a stable order and failures preserve the previous full aggregate.
    views = _executor.submit(lambda: list(_rows(db, "manga_views", "manga_slug,views", "manga_slug")))
    scores = _executor.submit(lambda: list(_rows(db, "ratings", "user_id,manga_slug,score,updated_at", "manga_slug")))
    for row in views.result():
        mid = _id(row.get("manga_slug"))
        if mid:
            value = stats.setdefault(mid, {})
            value["views"] = value.get("views", 0) + max(0, int(row.get("views") or 0))
    for row in scores.result():
        mid = _id(row.get("manga_slug"))
        if mid:
            ratings[mid].append(row)
    for mid, rows in ratings.items():
        average, count = _aggregate_rows_by_user(rows)
        stats.setdefault(mid, {}).update(rating_average=average, rating_count=count)
    return stats


@coalesce_reads
async def _refresh_statistics(db):
    global _local_stats, _local_until
    result = await asyncio.wait_for(asyncio.to_thread(_read_statistics, db), timeout=5)
    await asyncio.to_thread(cache_service.cache.set, STATS_KEY,
        json.dumps({"checked": time.time(), "items": result}), ttl=86400)
    _local_stats, _local_until = result, time.monotonic() + 15
    return result


def _schedule_refresh(db):
    loop = asyncio.get_running_loop()
    if loop in _refresh_tasks:
        return

    async def refresh():
        try:
            await _refresh_statistics(db)
        except Exception as error:
            logger.warning("MangaDex statistics refresh deferred (%s)", type(error).__name__)
    task = create_task(refresh())
    _refresh_tasks[loop] = task
    task.add_done_callback(lambda done: _refresh_tasks.pop(loop, None))


@coalesce_reads
async def statistics(db):
    global _local_stats, _local_until
    if _local_stats is not None and time.monotonic() < _local_until:
        return _local_stats
    raw = await asyncio.to_thread(cache_service.cache.get, STATS_KEY)
    try:
        saved = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        saved = None
    if isinstance(saved, dict) and saved.get("checked", 0) > time.time() - 30:
        result = saved["items"]
    elif (isinstance(saved, dict) and isinstance(saved.get("items"), dict)) or _local_stats is not None:
        result = saved["items"] if isinstance(saved, dict) and isinstance(saved.get("items"), dict) else _local_stats
        _local_stats, _local_until = result, time.monotonic() + 2
        _schedule_refresh(db)
        return result
    else:
        try:
            return await _refresh_statistics(db)
        except Exception as error:
            # Unknown ratings must never be mistaken for zero ratings and
            # erase every result of a positive minimum-score filter.
            raise RuntimeError("Local MangaDex ranking data temporarily unavailable") from error
    _local_stats, _local_until = result, time.monotonic() + 15
    return result


async def page(*, db, page=1, limit=24, ratings=None, excluded=None,
               genres=None, statuses=None, keyword="", sort="latest", year=None,
               min_rating=0, original_languages=None, feed_snapshot=""):
    from fastapi_app.services import mangadex_release_index as index
    # Redis metadata and DB aggregate reads are independent on a cold worker.
    stats, release_state = await asyncio.gather(statistics(db),
        asyncio.to_thread(index._state, "" if page == 1 else feed_snapshot))
    if not release_state:
        index.request_refresh()
        raise index.IndexBuilding()
    return await mdx._get_indexed_vi_feed(page=page, limit=limit,
        content_ratings=ratings, excluded_manga_ids=excluded,
        included_tag_slugs=genres, statuses=statuses, keyword=keyword,
        sort=sort, year=year, min_rating=min_rating, statistics=stats,
        original_languages=original_languages, feed_snapshot=feed_snapshot, release_state=release_state)
