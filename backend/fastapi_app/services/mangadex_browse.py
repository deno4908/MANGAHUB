"""One eligible catalog and one filter pass for every MangaDex browse order."""
import asyncio
import json
import re
import time
from collections import defaultdict

from fastapi_app.services import cache_service, mangadex_service as mdx
from fastapi_app.services.request_coalescing import coalesce_reads

STATS_KEY = "mangadex:browse:local-statistics:v1"
_local_stats = None
_local_until = 0


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
    for row in _rows(db, "manga_views", "manga_slug,views", "manga_slug"):
        mid = _id(row.get("manga_slug"))
        if mid:
            value = stats.setdefault(mid, {})
            value["views"] = value.get("views", 0) + max(0, int(row.get("views") or 0))
    for row in _rows(db, "ratings", "user_id,manga_slug,score,updated_at", "manga_slug"):
        mid = _id(row.get("manga_slug"))
        if mid:
            ratings[mid].append(row)
    for mid, rows in ratings.items():
        average, count = _aggregate_rows_by_user(rows)
        stats.setdefault(mid, {}).update(rating_average=average, rating_count=count)
    return stats


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
    else:
        try:
            result = await asyncio.wait_for(asyncio.to_thread(_read_statistics, db), timeout=5)
        except Exception as error:
            if isinstance(saved, dict) and isinstance(saved.get("items"), dict):
                result = saved["items"]
            elif _local_stats is not None:
                result = _local_stats
            else:
                # Unknown ratings must never be mistaken for zero ratings and
                # erase every result of a positive minimum-score filter.
                raise RuntimeError("Local MangaDex ranking data temporarily unavailable") from error
        else:
            await asyncio.to_thread(cache_service.cache.set, STATS_KEY,
                json.dumps({"checked": time.time(), "items": result}), ttl=86400)
    _local_stats, _local_until = result, time.monotonic() + 15
    return result


async def page(*, db, page=1, limit=24, ratings=None, excluded=None,
               genres=None, statuses=None, keyword="", sort="latest", year=None,
               min_rating=0, original_languages=None, feed_snapshot=""):
    stats = await statistics(db)
    return await mdx._get_indexed_vi_feed(page=page, limit=limit,
        content_ratings=ratings, excluded_manga_ids=excluded,
        included_tag_slugs=genres, statuses=statuses, keyword=keyword,
        sort=sort, year=year, min_rating=min_rating, statistics=stats,
        original_languages=original_languages, feed_snapshot=feed_snapshot)
