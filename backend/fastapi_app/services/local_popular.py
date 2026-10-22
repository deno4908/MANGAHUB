"""Rank verified QQ titles by local views; old unsynced rows stay hidden."""
import asyncio
import copy
import logging
import math
import hashlib
import json

from fastapi import HTTPException

from fastapi_app.services import card_metadata, truyenqq_service
from fastapi_app.services.catalog_visibility import legacy_qq_identifier, published_uploads, remember_matches
from fastapi_app.services.request_coalescing import coalesce_reads

logger = logging.getLogger(__name__)
SOURCE_WAIT_SECONDS = 1.5
SNAPSHOT_TTL = 90


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


@coalesce_reads
async def _source_page(genres, status, number, snapshot_key):
    key = f"{snapshot_key}:source:{number}"
    previous = await asyncio.to_thread(_frozen, key)
    if previous is not None:
        return previous
    value = await truyenqq_service.get_filtered(genres=list(genres), page=number,
                                                sort="updated_desc", status=status or None)
    return await asyncio.to_thread(_frozen, key, value)


def _cached_labels(identifiers):
    values = card_metadata.cache.get_many(
        [key for identifier in identifiers for key in card_metadata.metadata_keys(identifier)])
    return {identifier: item for identifier in identifiers
            if (item := card_metadata.cached_metadata(identifier, values)) and item.get("source") == "truyenqq"}


async def qq_popular(*, page, limit, genres, status, show_mature, hidden, db):
    from fastapi_app.routers import manga

    lookup = await asyncio.to_thread(manga._fetch_local_views_lookup, db)
    snapshot_key = "qq:local-popular:v2:" + hashlib.sha256(json.dumps(
        [sorted(lookup.items()), sorted(genres), status, show_mature, hidden], sort_keys=True).encode()).hexdigest()
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
            return {**verified, **uploaded, **(await card_metadata.get_many(external) if external else {})}
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
                    "views": lookup[alias], "view_count": lookup[alias], "local_view_count": lookup[alias]}
            if not manga._otruyen_item_matches_filters(item, required_genres=set(genres),
                                                       status_value=status, show_mature=show_mature, hidden=hidden):
                continue
            existing = ranked.get(slug)
            if existing:
                existing["views"] += lookup[alias]
                existing["view_count"] = existing["local_view_count"] = existing["views"]
            else:
                ranked[slug] = item
        return sorted(ranked.values(), key=lambda row: (-row["views"], row["slug"])), excluded

    def native_pending():
        return any(slug not in labels for slug in aliases if not legacy_qq_identifier(slug))

    offset = (page - 1) * limit
    rows, excluded = (snapshot["rows"], set(snapshot["excluded"])) if snapshot else build_ranking()
    pending = native_pending() if snapshot is None else False

    async def freeze_ranking():
        nonlocal snapshot, rows, excluded
        if not pending and snapshot is None:
            snapshot = await asyncio.to_thread(_frozen, snapshot_key + ":ranking",
                                               {"rows": rows, "excluded": sorted(excluded)})
            rows, excluded = snapshot["rows"], set(snapshot["excluded"])

    def response(items, *, refreshing=False, total=None, pages=None):
        return {"data": {"items": items, "ranking_pending": refreshing, "params": {"pagination": {
            "currentPage": page, "totalItemsPerPage": limit, "totalItems": total,
            "totalPages": pages or max(page + int(len(items) == limit), math.ceil(len(rows) / limit), 1)}}}}

    if len(rows) >= offset + limit:
        await freeze_ranking()
        return response(rows[offset:offset + limit], refreshing=pending)

    async def source(number):
        # The complete shared read, including its initial Redis lookup, survives
        # the response timeout and continues warming the source page.
        return await asyncio.wait_for(_source_page(tuple(genres), status, number, snapshot_key), SOURCE_WAIT_SECONDS)

    try:
        first_source_page = await source(1)
    except asyncio.TimeoutError:
        return response(rows[offset:offset + limit], refreshing=True)
    except HTTPException:
        if not rows:
            raise
        logger.warning("QQ popularity filler deferred; keeping verified local ranking")
        return response(rows[offset:offset + limit], refreshing=True)

    # One normal listing warms exact QQ slug/stem matches in a batch.
    if snapshot is None:
        labels.update(await asyncio.to_thread(_cached_labels, aliases))
        rows, excluded = build_ranking()
        pending = native_pending()
    await freeze_ranking()
    selected = rows[offset:offset + limit]
    if len(selected) == limit:
        return response(selected, refreshing=pending)

    # Zero-view titles fill the tail; exclusions precede pagination.
    needed = max(0, offset - len(rows)) + limit - len(selected)
    unread, seen = [], set(excluded)
    source_page, total, source_pages, source_size = 1, None, 1, limit
    while len(unread) < needed:
        try:
            payload = first_source_page if source_page == 1 else await source(source_page)
        except (asyncio.TimeoutError, HTTPException):
            pending = True
            break
        data = payload.get("data") or {}
        source_items = data.get("items") or []
        pagination = (data.get("params") or {}).get("pagination") or {}
        total = pagination.get("totalItems")
        source_pages = max(1, manga._otruyen_payload_total_pages(payload))
        source_size = max(source_size, manga._safe_int(pagination.get("totalItemsPerPage")) or len(source_items) or limit)
        for source_item in manga._filter_hidden(source_items, hidden):
            item = copy.deepcopy(source_item)
            slug = item.get("slug")
            if not slug or slug in seen:
                continue
            seen.add(slug)
            # Newly discovered positive-view aliases belong in the next ranked
            # prefix, never among zero-view fillers.
            stem = slug.rsplit("-", 1)[0]
            if lookup.get(slug, 0) > 0 or lookup.get(stem, 0) > 0:
                continue
            if not show_mature and manga._is_mature_metadata(item.get("content_rating"), item.get("category"), []):
                continue
            item.update(views=0, view_count=0, local_view_count=0)
            unread.append(item)
        if not source_items or source_page >= source_pages:
            break
        source_page += 1
    start = max(0, offset - len(rows))
    selected += unread[start:start + limit - len(selected)]
    total_items = max(manga._safe_int(total), len(rows)) if total is not None else None
    estimated_total = max(len(rows) + len(unread), total_items if total_items is not None else source_pages * source_size)
    return response(selected, refreshing=pending, total=total_items,
                    pages=max(page, math.ceil(estimated_total / limit), 1))
