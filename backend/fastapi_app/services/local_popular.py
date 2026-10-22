"""Paginate QQ by MangaHub views before filling with unread source titles."""
import asyncio
import copy
import logging

from fastapi import HTTPException

from fastapi_app.services import card_metadata, truyenqq_service
from fastapi_app.services.catalog_visibility import published_uploads, remember_matches

logger = logging.getLogger(__name__)


async def qq_popular(*, page, limit, genres, status, show_mature, hidden, db):
    from fastapi_app.routers import manga

    lookup = await asyncio.to_thread(manga._fetch_local_views_lookup, db)
    aliases = [slug for slug, views in lookup.items() if views > 0
               and not manga._extract_mangadex_id(slug) and not manga._is_invalid_manga_slug(slug)
               and not manga._hidden_reason_for_slug(hidden, slug)]
    labels = {}
    if aliases:
        async def resolve(group):
            values = await asyncio.to_thread(card_metadata.cache.get_many,
                [key for identifier in group for key in card_metadata.metadata_keys(identifier)])
            verified = {identifier: item for identifier in group
                        if (item := card_metadata.cached_metadata(identifier, values))
                        and item.get("source") == "truyenqq"}
            unknown = [identifier for identifier in group if identifier not in verified]
            if not unknown:
                return verified
            try:
                uploaded = await published_uploads(db, unknown)
            except HTTPException as error:
                if error.status_code != 503:
                    raise
                # A queued publication check must not discard already verified
                # QQ books. Unknown entries stay pending, without being marked
                # missing or sent to the external source as local uploads.
                logger.warning("QQ popularity publication check deferred status=503")
                return verified
            external = [identifier for identifier in unknown if identifier not in uploaded]
            return {**verified, **uploaded, **(await card_metadata.get_many(external) if external else {})}
        batches = await asyncio.gather(*(resolve(aliases[i:i + 48])
                                        for i in range(0, len(aliases), 48)))
        for batch in batches:
            labels.update(batch)
        await asyncio.to_thread(remember_matches, {key: item for key, item in labels.items()
                                                  if not item or item.get("source") != "uploaded"})
    # Unresolved aliases continue warming in retained background jobs. Show only
    # verified cards, and let the browser refresh this provisional ranking.
    pending = any(slug not in labels for slug in aliases)

    ranked = {}
    excluded = set()
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
    rows = sorted(ranked.values(), key=lambda row: (-row["views"], row["slug"]))
    offset = (page - 1) * limit
    selected = rows[offset:offset + limit]
    if pending:
        return {"data": {"items": selected, "ranking_pending": True, "params": {"pagination": {
            "currentPage": page, "totalItemsPerPage": limit, "totalItems": None,
            "totalPages": max(page, (len(rows) + limit - 1) // limit)}}}}
    if len(selected) == limit:
        # No source crawl is needed while the requested page is entirely local.
        return {"data": {"items": selected, "params": {"pagination": {
            "currentPage": page, "totalItemsPerPage": limit, "totalItems": None,
            "totalPages": max(page + 1, (len(rows) + limit - 1) // limit)}}}}

    # Every filler has zero local views, so ties may use the working latest
    # listing. Do not depend on QQ's unrelated upstream popularity endpoint.
    needed = max(0, offset - len(rows)) + limit - len(selected)
    unread = []
    seen = set(excluded)
    source_page = 1
    total = 0
    while len(unread) < needed:
        try:
            payload = await truyenqq_service.get_filtered(genres=genres, page=source_page,
                                                         sort="updated_desc", status=status or None)
        except HTTPException:
            if not selected and not unread:
                raise
            # Filler availability is independent of the verified local ranking.
            # Keep those books on screen and retry the remaining tail later.
            pending = True
            logger.warning("QQ popularity filler deferred; keeping verified local ranking")
            break
        data = payload.get("data") or {}
        source_items = data.get("items") or []
        pagination = (data.get("params") or {}).get("pagination") or {}
        total = manga._safe_int(pagination.get("totalItems"))
        for source in manga._filter_hidden(source_items, hidden):
            item = copy.deepcopy(source)
            slug = item.get("slug")
            if not slug or slug in seen:
                continue
            seen.add(slug)
            if not show_mature and manga._is_mature_metadata(item.get("content_rating"), item.get("category"), []):
                continue
            item.update(views=0, view_count=0, local_view_count=0)
            unread.append(item)
        if not source_items or source_page >= manga._otruyen_payload_total_pages(payload):
            break
        source_page += 1
    start = max(0, offset - len(rows))
    selected += unread[start:start + limit - len(selected)]
    pagination = {"currentPage": page, "totalItemsPerPage": limit, "totalItems": max(total, len(rows)),
                  "totalPages": max(1, (max(total, len(rows)) + limit - 1) // limit)}
    return {"data": {"items": selected, "ranking_pending": pending, "params": {"pagination": pagination}}}
