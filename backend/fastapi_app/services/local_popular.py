"""Page the QQ catalog, promoting verified local rankings without a full crawl."""
import asyncio
import copy
import logging
import math
import hashlib
import json
import inspect
from serverless_runtime import create_task

from fastapi import HTTPException

from fastapi_app.services import card_metadata, truyenqq_service
from fastapi_app.services.catalog_visibility import legacy_qq_identifier, published_uploads, remember_matches
from fastapi_app.services.request_coalescing import coalesce_reads
from fastapi_app.services.truyenqq_recovery import source_matches, surface_stale_hints

logger = logging.getLogger(__name__)
SOURCE_WAIT_SECONDS = 30.0
SOURCE_REFRESH_SECONDS = 26.0
SNAPSHOT_TTL = 90
SOURCE_SIZE_KEY = "qq:browse-source-size:v1"


def _cached_source_size():
    value = card_metadata._read(SOURCE_SIZE_KEY)
    size = value.get("size") if isinstance(value, dict) else None
    return size if type(size) is int and 1 <= size <= 96 else None


def _remember_source_size(payload, number):
    if number != 1:
        return
    pagination = ((payload.get("data") or {}).get("params") or {}).get("pagination") or {}
    size, pages = pagination.get("totalItemsPerPage"), pagination.get("totalPages")
    # A short, single-page genre result must never shrink the native page size.
    if type(size) is int and 1 <= size <= 96 and isinstance(pages, int) and pages > 1:
        card_metadata.cache.set(SOURCE_SIZE_KEY, json.dumps({"size": size}), ttl=86400)


def _frozen(key, value=None):
    existing = card_metadata._read(key)
    if isinstance(existing, dict):
        return existing
    if value is None:
        return None
    # First writer wins across concurrent Vercel instances, too.
    if card_metadata.cache.add(key, json.dumps(value, ensure_ascii=False), ttl=SNAPSHOT_TTL):
        return value
    return card_metadata._read(key) or value


@surface_stale_hints
@coalesce_reads(scope=truyenqq_service._source_job_scope)
async def _source_page(genres, status, number, snapshot_key, source_sort="views_desc"):
    key = f"{snapshot_key}:source:{number}"
    previous = await asyncio.to_thread(_frozen, key)
    data = previous.get('data') or {} if previous else {}
    recovered = source_matches(data.get('source_url')) or source_matches(
        (data.get('source_stale') or {}).get('X-TruyenQQ-Source-Path'))
    if previous is not None and not recovered:
        await asyncio.to_thread(_remember_source_size, previous, number)
        return previous
    value = await truyenqq_service.get_filtered(genres=list(genres), page=number,
                                                sort=source_sort, status=status or None,
                                                overlay_latest=False, background_refresh=source_sort != "views_desc",
                                                refresh_timeout=SOURCE_REFRESH_SECONDS)
    await asyncio.to_thread(_remember_source_size, value, number)
    if recovered:
        # Replace only this public source page after a verified handoff; keep
        # ranking slots and pagination stable for the other pages.
        await asyncio.to_thread(card_metadata.cache.set, key, json.dumps(value, ensure_ascii=False), ttl=SNAPSHOT_TTL)
        return value
    return await asyncio.to_thread(_frozen, key, value)


def _cached_labels(identifiers):
    values = card_metadata.cache.get_many(
        [key for identifier in identifiers for key in card_metadata.metadata_keys(identifier)])
    return {identifier: item for identifier in identifiers
            if (item := card_metadata.cached_metadata(identifier, values)) and item.get("source") == "truyenqq"}


async def qq_popular(*, page, limit, genres, status, show_mature, hidden, db, http_response=None, sort="popular"):
    from fastapi_app.routers import manga

    source_sort = {"popular": "views_desc", "newest": "created_desc", "oldest": "created_asc"}.get(sort, "updated_desc")
    revision = await asyncio.to_thread(card_metadata.cache.get, 'catalog:source-version:truyenqq')
    revision = revision if isinstance(revision, str) else ''
    # Public source pages are identical across moderation/maturity/rating
    # selections. Share their cache rather than fetching each variant again.
    source_key = "qq:browse-source:v1:" + hashlib.sha256(json.dumps(
        [source_sort, sorted(genres), status, revision], sort_keys=True).encode()).hexdigest()
    async def source(number):
        read = (_source_page(tuple(genres), status, number, source_key) if source_sort == "views_desc"
                else _source_page(tuple(genres), status, number, source_key, source_sort))
        return await asyncio.wait_for(read, SOURCE_WAIT_SECONDS)

    known_source_size = await asyncio.to_thread(_cached_source_size) if sort not in {"popular", "rating"} else None
    initial_number = ((page - 1) * limit // known_source_size + 1) if known_source_size else 1
    # Start the source before moderation, DB ranking or saved-title hydration.
    # Moderation still completes before a single card can be returned.
    first_source_task = create_task(source(initial_number))
    first_source_task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
    if inspect.isawaitable(hidden):
        hidden = await hidden

    rating_rows = {}
    if sort == "rating":
        from fastapi_app.routers import ratings
        rated = await asyncio.to_thread(_frozen, "qq:browse:ratings:v1")
        if rated is None:
            rated = await ratings.get_top_rated_manga(limit=120, db=db)
            rated = await asyncio.to_thread(_frozen, "qq:browse:ratings:v1", rated)
        rating_rows = {item["manga_slug"]: item for item in rated.get("items", [])}
        lookup = {slug: len(rating_rows) - index for index, slug in enumerate(rating_rows)}
    else:
        lookup = await asyncio.to_thread(manga._fetch_local_views_lookup, db) if sort == "popular" else {}
    # Reading another chapter must not invalidate every source-page read while
    # a client is waiting for this ranking snapshot to finish.
    snapshot_key = "qq:browse:v6:" + hashlib.sha256(json.dumps(
        [sort, sorted(genres), status, show_mature, hidden], sort_keys=True).encode()).hexdigest()
    snapshot = await asyncio.to_thread(_frozen, snapshot_key + ":ranking")
    aliases = [slug for slug, views in lookup.items() if views > 0
               and not manga._extract_mangadex_id(slug) and not manga._is_invalid_manga_slug(slug)
               and not manga._hidden_reason_for_slug(hidden, slug)]
    labels = {}
    if aliases and snapshot is None:
        async def resolve(group):
            verified = await asyncio.to_thread(_cached_labels, group)
            unknown = [identifier for identifier in group if identifier not in verified]
            if not unknown:
                return verified
            try:
                uploaded = await published_uploads(db, unknown)
            except HTTPException as error:
                if error.status_code != 503:
                    raise
                logger.warning("QQ popularity publication check deferred status=503")
                return verified
            # Unverified OTruyen aliases stay outside the public catalog.
            # Saved-library hydration can still resolve their exact titles and
            # warm shared labels without holding every browse request.
            external = [identifier for identifier in unknown
                        if identifier not in uploaded and not legacy_qq_identifier(identifier)]
            return {**verified, **uploaded, **(await card_metadata.get_many(external, source_timeout=2.0) if external else {})}
        batches = await asyncio.gather(*(resolve(aliases[i:i + 48])
                                        for i in range(0, len(aliases), 48)))
        for batch in batches:
            labels.update(batch)
        await asyncio.to_thread(remember_matches, {key: item for key, item in labels.items()
                                                  if not item or item.get("source") != "uploaded"})

    def build_ranking():
        ranked, excluded = {}, set()
        for alias, label in labels.items():
            if not label or label.get("source") not in {"truyenqq", "uploaded"}:
                continue
            slug = label["slug"]
            excluded.add(slug)
            if manga._hidden_reason_for_slug(hidden, slug):
                continue
            item = {"slug": slug, "id": slug, "source": label["source"], "name": label["title"],
                    "thumb_url": label.get("cover_url", ""), "status": label.get("status", "ongoing"),
                    "category": [{"name": name, "slug": manga._slugify_loose(name)} for name in label.get("genres", [])],
                    "chaptersLatest": label.get("chapters_latest", []), "content_rating": label.get("content_rating", ""),
                    "views": lookup[alias] if sort == "popular" else 0,
                    "view_count": lookup[alias] if sort == "popular" else 0,
                    "local_view_count": lookup[alias] if sort == "popular" else 0}
            if sort == "rating":
                rating = rating_rows[alias]
                item.update(rating_average=rating["average"], rating_count=rating["count"],
                            rating_weighted_score=rating.get("weighted_score", 0))
            if not manga._otruyen_item_matches_filters(item, required_genres=set(genres),
                                                       status_value=status, show_mature=show_mature, hidden=hidden):
                continue
            existing = ranked.get(slug)
            if existing and sort == "popular":
                existing["views"] += lookup[alias]
                existing["view_count"] = existing["local_view_count"] = existing["views"]
            elif existing is None:
                ranked[slug] = item
        if sort == "rating":
            # The ratings service already applies the same weighted score and
            # alias de-duplication as the public rating list.
            priority = {labels[alias]["slug"]: value for alias, value in reversed(list(lookup.items()))
                        if labels.get(alias)}
            return sorted(ranked.values(), key=lambda row: (-priority[row["slug"]], row["slug"])), excluded
        return sorted(ranked.values(), key=lambda row: (-row["views"], row["slug"])), excluded

    def native_pending():
        unresolved = [slug for slug in aliases if slug not in labels and not legacy_qq_identifier(slug)]
        # A failed read has finished; it is not an ongoing job. Keep verified
        # titles without telling the browser to poll a permanent failure forever.
        return card_metadata.has_pending_reads(unresolved)

    offset = (page - 1) * limit
    rows, excluded = (snapshot["rows"], set(snapshot["excluded"])) if snapshot else build_ranking()
    pending = native_pending() if snapshot is None else False

    async def freeze_ranking():
        nonlocal snapshot, rows, excluded
        if not pending and snapshot is None:
            snapshot = await asyncio.to_thread(_frozen, snapshot_key + ":ranking",
                                               {"rows": rows, "excluded": sorted(excluded)})
            rows, excluded = snapshot["rows"], set(snapshot["excluded"])

    def response(items, *, refreshing=False, total=None, pages=None, source_error=None):
        data = {"items": items, "ranking_pending": refreshing, "params": {"pagination": {
            "currentPage": page, "totalItemsPerPage": limit, "totalItems": total,
            "totalPages": pages or max(page + int(len(items) == limit), math.ceil(len(rows) / limit), 1)}}}
        if source_error is not None:
            headers = (source_error.headers or {}) if isinstance(source_error, HTTPException) else {}
            # Partial success must keep the same browser recovery hints as an
            # HTTP error. Otherwise a 200 response with only the local prefix
            # silently prevents the existing relay recovery from ever running.
            if http_response is not None:
                http_response.headers.update(headers)
            data["source_error"] = {
                "status": source_error.status_code if isinstance(source_error, HTTPException) else 504,
                "code": headers.get("X-TruyenQQ-Error", "timeout" if isinstance(source_error, asyncio.TimeoutError) else "source-error"),
            }
        return {"data": data}

    source_tasks = {initial_number: first_source_task}
    if initial_number == 1 and limit == 42 and page > 1 and len(rows) < offset + limit:
        # Older callers can still request native-sized pages. The 24-title UI
        # uses the measured source size below, never an assumed page size.
        source_tasks[page] = create_task(source(page))
    for task in source_tasks.values():
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())

    try:
        first_source_page = await source_tasks[initial_number]
    except asyncio.TimeoutError as error:
        if not rows[offset:offset + limit]:
            raise HTTPException(504, "TruyenQQ phản hồi quá chậm, vui lòng thử lại.",
                                headers={"X-TruyenQQ-Error": "timeout", "Cache-Control": "no-store"}) from error
        return response(rows[offset:offset + limit], refreshing=True, source_error=error)
    except HTTPException as error:
        if not rows[offset:offset + limit]:
            raise
        logger.warning("QQ popularity filler failed page=1 status=%s reason=%s", error.status_code,
                       (error.headers or {}).get("X-TruyenQQ-Error", "source-error"))
        return response(rows[offset:offset + limit], refreshing=True, source_error=error)

    # One normal listing warms exact QQ slug/stem matches in a batch.
    if snapshot is None:
        labels.update(await asyncio.to_thread(_cached_labels, aliases))
        rows, excluded = build_ranking()
        pending = native_pending()
    await freeze_ranking()
    selected = rows[offset:offset + limit]
    # Promote the local ranking by swapping catalog slots, rather than
    # removing rows then scanning from page 1 to count the remaining titles.
    # Each displaced zero-view title replaces exactly one promoted title in
    # that title's original slot. Random access needs only the small prefix
    # and the requested source page(s), independent of the target page number.
    pagination = ((first_source_page.get("data") or {}).get("params") or {}).get("pagination") or {}
    source_size = known_source_size or max(1, manga._safe_int(pagination.get("totalItemsPerPage"))
                      or len((first_source_page.get("data") or {}).get("items") or []) or limit)
    source_pages = max(1, manga._otruyen_payload_total_pages(first_source_page))
    total = pagination.get("totalItems")
    source_total = manga._safe_int(total) if total is not None else source_pages * source_size
    uploads = sum(row.get("source") == "uploaded" for row in rows)
    total_items = source_total + uploads
    if sort == "rating":
        from fastapi_app.services import qq_rating
        def visible_rating(item):
            return bool(item and item.get("slug") and manga._otruyen_item_matches_filters(
                item, required_genres=set(), status_value="", show_mature=show_mature, hidden=hidden))
        selected, source_error, exact = await qq_rating.page(number=page, limit=limit, ranked=rows,
            first=first_source_page, source=source, visible=visible_rating, snapshot_key=snapshot_key,
            source_pages=source_pages, total_bound=total_items + len(rows))
        return response(selected, refreshing=pending or source_error is not None,
            total=exact if exact is not None else total_items if total is not None else None,
            pages=max(1, math.ceil((exact if exact is not None else total_items) / limit)), source_error=source_error)
    if len(selected) == limit:
        return response(selected, refreshing=pending, total=total_items if total is not None else None,
                        pages=max(1, math.ceil(total_items / limit)))
    native_rows = [row for row in rows if row.get("source") != "uploaded"]
    prefix_size = len(native_rows)
    start = max(prefix_size, offset - uploads)
    end = max(start, offset + limit - uploads)
    prefix_pages = set(range(1, math.ceil(prefix_size / source_size) + 1))
    requested_pages = set(range(start // source_size + 1, math.ceil(end / source_size) + 1))
    numbers = sorted((prefix_pages | requested_pages) - {initial_number})
    numbers = [number for number in numbers if number <= source_pages]
    payloads = {initial_number: first_source_page}
    source_failure = None
    results = await asyncio.gather(*(source_tasks[number] if number in source_tasks else source(number)
                                     for number in numbers), return_exceptions=True)
    for number, value in zip(numbers, results):
        if isinstance(value, (asyncio.TimeoutError, HTTPException)):
            pending = True
            source_failure = value
            logger.warning("QQ popular source failed page=%d status=%s reason=%s", number,
                           value.status_code if isinstance(value, HTTPException) else 504,
                           (value.headers or {}).get("X-TruyenQQ-Error", "source-error")
                           if isinstance(value, HTTPException) else "timeout")
        elif isinstance(value, BaseException):
            raise value
        else:
            payloads[number] = value

    def visible(item):
        # These cards already came from the source's genre/status query. QQ
        # often omits those labels on listing cards; re-applying the local
        # metadata filter would discard an otherwise valid filtered page.
        # Local promoted titles were checked against the full filters above.
        return bool(item and item.get("slug") and manga._otruyen_item_matches_filters(
            item, required_genres=set(), status_value="",
            show_mature=show_mature, hidden=hidden))

    def require_page_data():
        if not selected and source_failure is not None:
            if isinstance(source_failure, HTTPException):
                raise source_failure
            raise HTTPException(504, "TruyenQQ phản hồi quá chậm, vui lòng thử lại.",
                                headers={"X-TruyenQQ-Error": "timeout", "Cache-Control": "no-store"}) from source_failure

    prefix = []
    for number in sorted(prefix_pages):
        if number not in payloads:
            # An incomplete swap plan could repeat or lose displaced titles.
            require_page_data()
            return response(selected, refreshing=True, source_error=source_failure)
        prefix.extend((payloads[number].get("data") or {}).get("items") or [])
    prefix = prefix[:prefix_size]
    prefix_ids = {item.get("slug") for item in prefix}
    ranked_ids = {row["slug"] for row in native_rows}
    displaced = [item if visible(item) else None for item in prefix if item.get("slug") not in ranked_ids]
    promoted = [row["slug"] for row in native_rows if row["slug"] not in prefix_ids]
    replacements = dict(zip(promoted, displaced))
    for number in sorted(requested_pages):
        payload = payloads.get(number)
        if payload is None:
            continue
        for index, original in enumerate((payload.get("data") or {}).get("items") or []):
            position = (number - 1) * source_size + index
            if not start <= position < end:
                continue
            slug = original.get("slug")
            item = replacements.get(slug) if slug in ranked_ids else original
            if not visible(item):
                continue
            item = copy.deepcopy(item)
            item.update(views=0, view_count=0, local_view_count=0)
            selected.append(item)
    require_page_data()
    if source_pages in payloads:
        # The last source page provides an exact count even when QQ omits its
        # total. This also removes empty trailing 24-title pages.
        source_total = (source_pages - 1) * source_size + len((payloads[source_pages].get("data") or {}).get("items") or [])
        total = source_total
    total_items = source_total + uploads
    return response(selected, refreshing=pending, total=total_items if total is not None else None,
                    pages=max(1, math.ceil(total_items / limit)), source_error=source_failure)
