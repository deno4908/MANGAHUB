"""
Ratings API — manga rating by users (1-5 stars).
Uses the `ratings` table: (user_id, manga_slug, score, created_at, updated_at).
"""

import asyncio
import json
import logging
import re
import unicodedata
import time
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from fastapi_app.dependencies import (
    get_current_user,
    get_optional_user,
    get_supabase,
    get_supabase_public,
)
from fastapi_app.services import mangadex_service, truyenqq_service
from fastapi_app.services.cache_service import cache
from fastapi_app.services.qq_statistics import cached_aliases
from fastapi_app.services.request_coalescing import coalesce_reads
from fastapi_app.utils.anti_spam import enforce_user_action_limit

logger = logging.getLogger(__name__)

router = APIRouter()
TOP_RATED_PRIOR_AVERAGE = 3.5
TOP_RATED_PRIOR_COUNT = 5
RATING_WRITE_LIMIT_PER_MINUTE = 20
RATING_WRITE_LIMIT_PER_HOUR = 120
_aggregate_cache = OrderedDict()
_aggregate_epoch = 0


def _remember_aggregate(db, candidates, average, count, epoch):
    if epoch != _aggregate_epoch:
        return  # A rating changed while this database read was in flight.
    key = (id(db), tuple(sorted(candidates)))
    _aggregate_cache[key] = (time.monotonic() + 10, average, count, db)
    _aggregate_cache.move_to_end(key)
    while len(_aggregate_cache) > 1024:
        _aggregate_cache.popitem(last=False)


def _invalidate_aggregates():
    global _aggregate_epoch
    _aggregate_epoch += 1
    _aggregate_cache.clear()

_MANGADEX_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _safe_float(value) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _normalize_manga_slug(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    from fastapi_app.routers.manga import _extract_mangadex_id
    return _extract_mangadex_id(normalized) or normalized


def _slug_candidates(value: str, qq_aliases=None) -> list[str]:
    normalized = _normalize_manga_slug(value)
    if not normalized:
        return []
    candidates = list(dict.fromkeys([normalized, *(qq_aliases or {}).get(normalized, [])]))
    if _MANGADEX_ID_RE.fullmatch(normalized):
        candidates.extend([f"mdx-{normalized}", f"mangadex-{normalized}", f"mangadex:{normalized}"])
    return candidates


def _load_json_cache_payload(cache_key: str) -> dict | None:
    raw = cache.get(cache_key)
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        cache.delete(cache_key)
        return None
    if isinstance(payload, dict):
        return payload
    cache.delete(cache_key)
    return None


def _normalize_loose_text(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d")
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _humanize_slug_title(slug: str) -> str:
    normalized = _normalize_manga_slug(slug)
    if not normalized:
        return ""
    if _MANGADEX_ID_RE.fullmatch(normalized):
        return ""
    if "-" not in normalized:
        return ""
    words = [part for part in normalized.split("-") if part][:10]
    return " ".join(part.capitalize() for part in words)


def _slugify_tag(value: str) -> str:
    normalized = _normalize_loose_text(value).replace(" ", "-")
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    return normalized


def _sanitize_string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in value:
        text = str(raw or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _extract_genres_tags(value) -> tuple[list[str], list[str]]:
    genres: list[str] = []
    tags: list[str] = []

    if isinstance(value, list):
        for entry in value:
            if isinstance(entry, dict):
                genre_name = str(entry.get("name") or "").strip()
                tag_slug = str(entry.get("slug") or "").strip().lower()
                if genre_name:
                    genres.append(genre_name)
                if tag_slug:
                    tags.append(tag_slug)
                continue

            text = str(entry or "").strip()
            if not text:
                continue
            genres.append(text)
            slug = _slugify_tag(text)
            if slug:
                tags.append(slug)

    return _sanitize_string_list(genres), _sanitize_string_list(tags)


def _is_slug_like_title(title: str, slug: str) -> bool:
    normalized_title = _normalize_manga_slug(title)
    normalized_slug = _normalize_manga_slug(slug)
    loose_title = _normalize_loose_text(title)
    loose_slug = _normalize_loose_text(slug)
    if not normalized_title:
        return True
    if normalized_title == normalized_slug:
        return True
    if loose_title and loose_slug and loose_title == loose_slug.replace("-", " "):
        return True
    if _MANGADEX_ID_RE.fullmatch(normalized_title):
        return True
    if loose_title in {
        "dang cap nhat",
        "dang cap nhat tieu de",
        "hien dang cap nhat",
        "chua co tieu de",
        "untitled",
        "mangadex",
        "unknown",
    }:
        return True
    return False


def _pick_best_title(slug: str, *candidates: str) -> str:
    for candidate in candidates:
        title = str(candidate or "").strip()
        if not title:
            continue
        if _is_slug_like_title(title, slug):
            continue
        return title
    return _humanize_slug_title(slug)


def _pick_first_non_empty(*values) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _parse_chapter_number(value: str) -> float:
    raw = str(value or "").strip()
    if not raw:
        return 0.0

    try:
        direct = float(raw.replace(",", "."))
        if direct > 0:
            return direct
    except Exception:
        pass

    normalized = _normalize_loose_text(raw)
    if not normalized:
        return 0.0

    keyword_match = re.search(r"\b(?:chapter|chuong|ch)\.?\s*(\d+(?:[.,]\d+)?)", normalized)
    if keyword_match:
        try:
            parsed = float(keyword_match.group(1).replace(",", "."))
            return parsed if parsed > 0 else 0.0
        except Exception:
            return 0.0

    if re.search(r"\b(ago|truoc|trc|gio|phut|ngay|tuan|thang|nam|h)\b", normalized):
        return 0.0

    return 0.0


def _pick_latest_chapter_candidate(
    candidates: list[tuple[str, str]],
    fallback_updated_at: str,
) -> tuple[str, str]:
    if not candidates:
        return ("", fallback_updated_at)

    best_name = ""
    best_updated = fallback_updated_at
    best_key = (-1, -1.0, "")

    for chapter_name, chapter_updated_at in candidates:
        name = str(chapter_name or "").strip()
        if not name:
            continue
        updated = str(chapter_updated_at or fallback_updated_at or "")
        chapter_num = _parse_chapter_number(name)
        key = (1 if chapter_num > 0 else 0, chapter_num, updated)
        if key > best_key:
            best_key = key
            best_name = name
            best_updated = updated

    if not best_name:
        return ("", fallback_updated_at)

    return (best_name, best_updated)


def _extract_latest_chapter_meta(item: dict) -> tuple[str, str]:
    if not isinstance(item, dict):
        return ("", "")

    latest_chapter = _pick_first_non_empty(
        item.get("latest_chapter"),
        item.get("last_chapter"),
        item.get("chapter_newest"),
        item.get("chapter_name"),
    )
    latest_chapter_updated_at = _pick_first_non_empty(
        item.get("latest_chapter_updated_at"),
        item.get("last_chapter_updated_at"),
        item.get("local_last_published_at"),
        item.get("last_updated"),
        item.get("updated_at"),
        item.get("updatedAt"),
        item.get("created_at"),
        item.get("createdAt"),
    )
    if latest_chapter:
        return latest_chapter, latest_chapter_updated_at

    chapters_latest = item.get("chaptersLatest") or item.get("chapters_latest")
    if isinstance(chapters_latest, list):
        candidates: list[tuple[str, str]] = []
        for chapter in chapters_latest:
            if not isinstance(chapter, dict):
                continue
            chapter_name = _pick_first_non_empty(
                chapter.get("chapter_name"),
                chapter.get("chapter"),
                chapter.get("number"),
            )
            if not chapter_name:
                continue
            chapter_updated_at = _pick_first_non_empty(
                chapter.get("local_published_at"),
                chapter.get("publish_at"),
                chapter.get("readable_at"),
                chapter.get("chapter_updated_at"),
                chapter.get("updated_at"),
                chapter.get("updatedAt"),
                chapter.get("created_at"),
                chapter.get("createdAt"),
            )
            candidates.append((chapter_name, chapter_updated_at))

        picked_name, picked_updated = _pick_latest_chapter_candidate(
            candidates,
            latest_chapter_updated_at,
        )
        if picked_name:
            return picked_name, picked_updated

    chapters = item.get("chapters")
    if isinstance(chapters, list):
        direct_candidates: list[tuple[str, str]] = []
        server_candidates: list[tuple[str, str]] = []

        for chapter in chapters:
            if not isinstance(chapter, dict):
                continue

            chapter_name = _pick_first_non_empty(
                chapter.get("chapter"),
                chapter.get("chapter_name"),
                chapter.get("number"),
            )
            if chapter_name:
                chapter_updated_at = _pick_first_non_empty(
                    chapter.get("publish_at"),
                    chapter.get("readable_at"),
                    chapter.get("updated_at"),
                    chapter.get("created_at"),
                    chapter.get("updatedAt"),
                    chapter.get("createdAt"),
                )
                direct_candidates.append((chapter_name, chapter_updated_at))

            server_rows = chapter.get("server_data")
            if not isinstance(server_rows, list):
                continue

            for chapter_row in server_rows:
                if not isinstance(chapter_row, dict):
                    continue
                row_name = _pick_first_non_empty(
                    chapter_row.get("chapter_name"),
                    chapter_row.get("chapter"),
                    chapter_row.get("number"),
                )
                if not row_name:
                    continue
                row_updated_at = _pick_first_non_empty(
                    chapter_row.get("updated_at"),
                    chapter_row.get("created_at"),
                    item.get("local_last_published_at"),
                    item.get("updatedAt"),
                    item.get("updated_at"),
                )
                server_candidates.append((row_name, row_updated_at))

        picked_name, picked_updated = _pick_latest_chapter_candidate(
            direct_candidates,
            latest_chapter_updated_at,
        )
        if picked_name:
            return picked_name, picked_updated

        picked_name, picked_updated = _pick_latest_chapter_candidate(
            server_candidates,
            latest_chapter_updated_at,
        )
        if picked_name:
            return picked_name, picked_updated

    return ("", latest_chapter_updated_at)


def _extract_otruyen_detail_meta(payload: dict, canonical_slug: str) -> dict:
    if not isinstance(payload, dict):
        return {}

    item = ((payload.get("data") or {}).get("item") or {})
    if not isinstance(item, dict):
        return {}

    origin_name = item.get("origin_name")
    origin_candidate = (
        origin_name[0]
        if isinstance(origin_name, list) and origin_name
        else origin_name
    )

    title = _pick_best_title(
        canonical_slug,
        str(item.get("name") or ""),
        str(origin_candidate or ""),
    )
    thumb = str(item.get("thumb_url") or item.get("cover_url") or item.get("cover") or "").strip()
    genres, tags = _extract_genres_tags(item.get("category") or item.get("genres") or [])
    latest_chapter, latest_chapter_updated_at = _extract_latest_chapter_meta(item)

    if (
        not title
        and not thumb
        and not genres
        and not tags
        and not latest_chapter
        and not latest_chapter_updated_at
    ):
        return {}

    return {
        "title": title,
        "thumb": thumb,
        "genres": genres,
        "tags": tags,
        "latest_chapter": latest_chapter,
        "latest_chapter_updated_at": latest_chapter_updated_at,
    }


def _aggregate_rows_by_user(rows: list[dict]) -> tuple[float, int]:
    by_user: dict[str, tuple[float, str]] = {}
    anon_count = 0
    for row in rows:
        user_id = str(row.get("user_id") or "").strip()
        if not user_id:
            anon_count += 1
            user_id = f"anon:{anon_count}"
        updated_at = str(row.get("updated_at") or "")
        score = _safe_float(row.get("score"))
        prev = by_user.get(user_id)
        if prev is None or updated_at >= prev[1]:
            by_user[user_id] = (score, updated_at)

    if not by_user:
        return (0.0, 0)

    total = sum(score for score, _ in by_user.values())
    count = len(by_user)
    average = round(total / count, 1) if count > 0 else 0.0
    return (average, count)


class RateRequest(BaseModel):
    manga_slug: str
    score: int = Field(ge=1, le=5)


class BatchRatingsRequest(BaseModel):
    manga_slugs: list[str] = Field(default_factory=list, max_items=500)
    include_views: bool = False


@router.get("/manga/{manga_slug}")
@coalesce_reads(revision=lambda: _aggregate_epoch)
async def get_manga_rating(manga_slug: str, db=Depends(get_supabase_public)):
    """Get average rating and count for a manga (supports mdx-UUID / UUID aliases)."""
    normalized_slug = _normalize_manga_slug(manga_slug)
    aliases = await asyncio.to_thread(cached_aliases, [normalized_slug])
    candidates = _slug_candidates(normalized_slug, aliases)
    if not candidates:
        return {"manga_slug": manga_slug, "average": 0, "count": 0}

    epoch = _aggregate_epoch
    cached = _aggregate_cache.get((id(db), tuple(sorted(candidates))))
    if cached and cached[0] > time.monotonic() and cached[3] is db:
        return {"manga_slug": normalized_slug, "average": cached[1], "count": cached[2]}

    succeeded = True
    try:
        rows = (
            (await asyncio.to_thread(lambda: (db.table("ratings")
            .select("user_id,manga_slug,score,updated_at")
            .in_("manga_slug", candidates)
            .execute())))
            .data
            or []
        )
    except Exception:
        rows = []
        succeeded = False

    average, total = _aggregate_rows_by_user(rows)
    if succeeded:
        _remember_aggregate(db, candidates, average, total, epoch)

    return {
        "manga_slug": normalized_slug or manga_slug,
        "average": average,
        "count": total,
    }


@router.get("/manga/{manga_slug}/me")
async def get_my_rating(
    manga_slug: str, user=Depends(get_current_user), db=Depends(get_supabase)
):
    """Get current user's rating for a manga."""
    normalized_slug = _normalize_manga_slug(manga_slug)
    aliases = await asyncio.to_thread(cached_aliases, [normalized_slug])
    candidates = _slug_candidates(normalized_slug, aliases)
    if not candidates:
        return {"manga_slug": manga_slug, "score": None}

    try:
        result = (
            (await asyncio.to_thread(lambda: (db.table("ratings")
            .select("score,updated_at")
            .eq("user_id", user["id"])
            .in_("manga_slug", candidates)
            .order("updated_at", desc=True)
            .limit(1)
            .execute())))
        )
        score = result.data[0]["score"] if result.data else None
    except Exception:
        score = None

    return {"manga_slug": normalized_slug or manga_slug, "score": score}


@router.get("/me")
async def get_my_rated_manga(
    limit: int = Query(200, ge=1, le=500),
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Get current user's rated manga list with best-effort title/thumb metadata."""
    try:
        rating_rows = (
            (await asyncio.to_thread(lambda: (db.table("ratings")
            .select("manga_slug,score,updated_at")
            .eq("user_id", user["id"])
            .order("updated_at", desc=True)
            .limit(limit * 4)
            .execute())))
            .data
            or []
        )
    except Exception:
        rating_rows = []

    qq_aliases = await asyncio.to_thread(cached_aliases, [row.get("manga_slug") for row in rating_rows])
    latest_by_slug: dict[str, dict[str, str | int]] = {}
    for row in rating_rows:
        normalized_slug = _normalize_manga_slug(row.get("manga_slug"))
        normalized_slug = qq_aliases.get(normalized_slug, [normalized_slug])[0]
        if not normalized_slug:
            continue

        try:
            score = int(row.get("score"))
        except (TypeError, ValueError):
            continue

        updated_at = str(row.get("updated_at") or "")
        prev = latest_by_slug.get(normalized_slug)
        if prev is None or updated_at >= str(prev.get("updated_at") or ""):
            latest_by_slug[normalized_slug] = {
                "manga_slug": normalized_slug,
                "score": score,
                "updated_at": updated_at,
            }

    if not latest_by_slug:
        return {"items": [], "total": 0}

    ordered_items = sorted(
        latest_by_slug.values(),
        key=lambda item: str(item.get("updated_at") or ""),
        reverse=True,
    )[:limit]

    alias_to_slug: dict[str, str] = {}
    alias_slugs: list[str] = []
    seen_aliases: set[str] = set()
    for item in ordered_items:
        canonical_slug = str(item.get("manga_slug") or "")
        for alias in _slug_candidates(canonical_slug):
            alias_lc = str(alias or "").strip().lower()
            if not alias_lc or alias_lc in seen_aliases:
                continue
            seen_aliases.add(alias_lc)
            alias_to_slug[alias_lc] = canonical_slug
            alias_slugs.append(alias_lc)

    history_meta: dict[str, dict[str, str]] = {}
    if alias_slugs:
        try:
            history_rows = (
                (await asyncio.to_thread(lambda: (db.table("reading_history")
                .select("manga_slug,manga_title,manga_thumb,chapter_name,read_at")
                .in_("manga_slug", alias_slugs)
                .order("read_at", desc=True)
                .limit(min(max(len(alias_slugs) * 2, limit * 2), 600))
                .execute())))
                .data
                or []
            )
        except Exception:
            history_rows = []

        for row in history_rows:
            raw_slug = str(row.get("manga_slug") or "").strip().lower()
            normalized_row_slug = _normalize_manga_slug(raw_slug)
            canonical_slug = (
                alias_to_slug.get(raw_slug)
                or alias_to_slug.get(normalized_row_slug)
                or normalized_row_slug
            )
            if not canonical_slug or canonical_slug in history_meta:
                continue

            title = str(row.get("manga_title") or "").strip()
            thumb = str(row.get("manga_thumb") or "").strip()
            latest_chapter = str(row.get("chapter_name") or "").strip()
            latest_chapter_updated_at = str(row.get("read_at") or "").strip()

            # Ignore slug-like title values from history to avoid UUID labels.
            if title and _is_slug_like_title(title, canonical_slug):
                title = ""

            if title or thumb or latest_chapter:
                history_meta[canonical_slug] = {
                    "title": title,
                    "thumb": thumb,
                    "latest_chapter": latest_chapter,
                    "latest_chapter_updated_at": latest_chapter_updated_at,
                }

    cache_meta: dict[str, dict] = {}

    def _upsert_cache_meta(
        slug_value: str,
        title_value: str,
        thumb_value: str,
        genres_value=None,
        tags_value=None,
        latest_chapter_value=None,
        latest_chapter_updated_at_value=None,
    ) -> None:
        canonical_slug = _normalize_manga_slug(slug_value)
        if not canonical_slug:
            return

        title = str(title_value or "").strip()
        thumb = str(thumb_value or "").strip()
        genres = _sanitize_string_list(genres_value)
        tags = _sanitize_string_list(tags_value)
        latest_chapter = str(latest_chapter_value or "").strip()
        latest_chapter_updated_at = str(latest_chapter_updated_at_value or "").strip()

        if not tags and genres:
            tags = [slug for slug in (_slugify_tag(genre) for genre in genres) if slug]
            tags = _sanitize_string_list(tags)

        if title and _is_slug_like_title(title, canonical_slug):
            title = ""

        if not title and not thumb and not genres and not tags and not latest_chapter and not latest_chapter_updated_at:
            return

        prev = cache_meta.get(canonical_slug) or {}
        prev_genres = _sanitize_string_list(prev.get("genres"))
        prev_tags = _sanitize_string_list(prev.get("tags"))
        cache_meta[canonical_slug] = {
            "title": title or str(prev.get("title") or ""),
            "thumb": thumb or str(prev.get("thumb") or ""),
            "genres": genres or prev_genres,
            "tags": tags or prev_tags,
            "latest_chapter": latest_chapter or str(prev.get("latest_chapter") or ""),
            "latest_chapter_updated_at": latest_chapter_updated_at
            or str(prev.get("latest_chapter_updated_at") or ""),
        }

    list_types = ("truyen-moi", "dang-phat-hanh", "hoan-thanh")
    combined_limits = (80, 96, 120, 160, 200, 480)
    for list_type in list_types:
        for cache_limit in combined_limits:
            combined_key = f"manga:list-combined:{list_type}:1:{cache_limit}"
            combined_payload = _load_json_cache_payload(combined_key) or _load_json_cache_payload(
                f"{combined_key}:stale"
            )
            if not isinstance(combined_payload, dict):
                continue

            list_items = (((combined_payload.get("list") or {}).get("data") or {}).get("items") or [])
            for item in list_items:
                if not isinstance(item, dict):
                    continue
                genres, tags = _extract_genres_tags(item.get("category") or item.get("categories") or [])
                latest_chapter, latest_chapter_updated_at = _extract_latest_chapter_meta(item)
                _upsert_cache_meta(
                    str(item.get("slug") or ""),
                    str(item.get("name") or ""),
                    str(item.get("thumb_url") or item.get("thumb") or ""),
                    genres,
                    tags,
                    latest_chapter,
                    latest_chapter_updated_at,
                )

            mdx_mangas = ((combined_payload.get("mangadex") or {}).get("mangas") or [])
            for manga in mdx_mangas:
                if not isinstance(manga, dict):
                    continue
                genres, tags = _extract_genres_tags(manga.get("genres") or [])
                latest_chapter, latest_chapter_updated_at = _extract_latest_chapter_meta(manga)
                _upsert_cache_meta(
                    str(manga.get("id") or ""),
                    str(manga.get("title") or ""),
                    str(manga.get("cover_url") or ""),
                    genres,
                    tags,
                    latest_chapter,
                    latest_chapter_updated_at,
                )

    for cache_limit in combined_limits:
        catalog_key = f"mangadex:vi-catalog:{cache_limit}"
        catalog_payload = _load_json_cache_payload(catalog_key) or _load_json_cache_payload(
            f"{catalog_key}:stale"
        )
        if not isinstance(catalog_payload, dict):
            continue
        for manga in (catalog_payload.get("mangas") or []):
            if not isinstance(manga, dict):
                continue
            genres, tags = _extract_genres_tags(manga.get("genres") or [])
            latest_chapter, latest_chapter_updated_at = _extract_latest_chapter_meta(manga)
            _upsert_cache_meta(
                str(manga.get("id") or ""),
                str(manga.get("title") or ""),
                str(manga.get("cover_url") or ""),
                genres,
                tags,
                latest_chapter,
                latest_chapter_updated_at,
            )

    detail_meta: dict[str, dict] = {}
    for item in ordered_items:
        canonical_slug = str(item.get("manga_slug") or "")
        if not canonical_slug or _MANGADEX_ID_RE.fullmatch(canonical_slug):
            continue

        merged_title = _pick_best_title(
            canonical_slug,
            str((history_meta.get(canonical_slug) or {}).get("title") or ""),
            str((cache_meta.get(canonical_slug) or {}).get("title") or ""),
        )
        merged_thumb = str(
            (history_meta.get(canonical_slug) or {}).get("thumb")
            or (cache_meta.get(canonical_slug) or {}).get("thumb")
            or ""
        ).strip()
        if merged_title and merged_thumb:
            continue

        for key in (f"truyenqq:detail:{canonical_slug}", f"truyenqq:detail:{canonical_slug}:stale"):
            payload = _load_json_cache_payload(key)
            if not isinstance(payload, dict):
                continue
            extracted = _extract_otruyen_detail_meta(payload, canonical_slug)
            if not extracted:
                continue

            prev = detail_meta.get(canonical_slug) or {}
            detail_meta[canonical_slug] = {
                "title": str(extracted.get("title") or prev.get("title") or ""),
                "thumb": str(extracted.get("thumb") or prev.get("thumb") or ""),
                "genres": _sanitize_string_list(extracted.get("genres"))
                or _sanitize_string_list(prev.get("genres")),
                "tags": _sanitize_string_list(extracted.get("tags"))
                or _sanitize_string_list(prev.get("tags")),
                "latest_chapter": str(
                    extracted.get("latest_chapter") or prev.get("latest_chapter") or ""
                ),
                "latest_chapter_updated_at": str(
                    extracted.get("latest_chapter_updated_at")
                    or prev.get("latest_chapter_updated_at")
                    or ""
                ),
            }
            if detail_meta[canonical_slug].get("title") and detail_meta[canonical_slug].get("thumb"):
                break

    unresolved_otruyen_slugs: list[str] = []
    for item in ordered_items:
        canonical_slug = str(item.get("manga_slug") or "")
        if not canonical_slug or _MANGADEX_ID_RE.fullmatch(canonical_slug):
            continue

        merged_title = _pick_best_title(
            canonical_slug,
            str((history_meta.get(canonical_slug) or {}).get("title") or ""),
            str((cache_meta.get(canonical_slug) or {}).get("title") or ""),
            str((detail_meta.get(canonical_slug) or {}).get("title") or ""),
        )
        merged_thumb = str(
            (history_meta.get(canonical_slug) or {}).get("thumb")
            or (cache_meta.get(canonical_slug) or {}).get("thumb")
            or (detail_meta.get(canonical_slug) or {}).get("thumb")
            or ""
        ).strip()
        if not merged_title or not merged_thumb:
            unresolved_otruyen_slugs.append(canonical_slug)

    if unresolved_otruyen_slugs:
        sem = asyncio.Semaphore(4)

        async def _fetch_detail_meta(slug_value: str) -> tuple[str, dict[str, str]]:
            async with sem:
                try:
                    payload = await asyncio.wait_for(
                        truyenqq_service.get_manga_detail(slug_value),
                        timeout=3.0,
                    )
                except Exception:
                    return slug_value, {}

                if not isinstance(payload, dict):
                    return slug_value, {}

                return slug_value, _extract_otruyen_detail_meta(payload, slug_value)

        tasks = [
            _fetch_detail_meta(slug_value)
            for slug_value in list(dict.fromkeys(unresolved_otruyen_slugs))[:16]
        ]
        if tasks:
            fetched = await asyncio.gather(*tasks, return_exceptions=True)
            for result in fetched:
                if isinstance(result, Exception):
                    continue

                slug_value, extracted = result
                if not extracted:
                    continue

                prev = detail_meta.get(slug_value) or {}
                detail_meta[slug_value] = {
                    "title": str(extracted.get("title") or prev.get("title") or ""),
                    "thumb": str(extracted.get("thumb") or prev.get("thumb") or ""),
                    "genres": _sanitize_string_list(extracted.get("genres"))
                    or _sanitize_string_list(prev.get("genres")),
                    "tags": _sanitize_string_list(extracted.get("tags"))
                    or _sanitize_string_list(prev.get("tags")),
                    "latest_chapter": str(
                        extracted.get("latest_chapter") or prev.get("latest_chapter") or ""
                    ),
                    "latest_chapter_updated_at": str(
                        extracted.get("latest_chapter_updated_at")
                        or prev.get("latest_chapter_updated_at")
                        or ""
                    ),
                }

    mangadex_latest_needed_ids: list[str] = []
    seen_mangadex_ids: set[str] = set()
    for item in ordered_items:
        canonical_slug = str(item.get("manga_slug") or "")
        if not canonical_slug or not _MANGADEX_ID_RE.fullmatch(canonical_slug):
            continue
        if canonical_slug in seen_mangadex_ids:
            continue
        seen_mangadex_ids.add(canonical_slug)

        history = history_meta.get(canonical_slug) or {}
        cached = cache_meta.get(canonical_slug) or {}
        detail = detail_meta.get(canonical_slug) or {}

        existing_candidates: list[tuple[str, str]] = []
        for source in (cached, detail, history):
            chapter_name = str(source.get("latest_chapter") or "").strip()
            if not chapter_name:
                continue
            chapter_updated_at = str(source.get("latest_chapter_updated_at") or "").strip()
            existing_candidates.append((chapter_name, chapter_updated_at))

        existing_best, _ = _pick_latest_chapter_candidate(
            existing_candidates,
            str(item.get("updated_at") or ""),
        )
        if _parse_chapter_number(existing_best) > 1:
            continue

        mangadex_latest_needed_ids.append(canonical_slug)
        if len(mangadex_latest_needed_ids) >= 120:
            break

    mangadex_latest_map: dict[str, dict[str, str]] = {}
    if mangadex_latest_needed_ids:
        try:
            mangadex_latest_map = await mangadex_service.get_latest_vi_chapters_for_manga_ids(
                mangadex_latest_needed_ids
            )
        except Exception:
            mangadex_latest_map = {}

    response_items: list[dict[str, str | int]] = []
    for item in ordered_items:
        canonical_slug = str(item.get("manga_slug") or "")
        history = history_meta.get(canonical_slug) or {}
        cached = cache_meta.get(canonical_slug) or {}
        detail = detail_meta.get(canonical_slug) or {}
        mangadex_latest = mangadex_latest_map.get(canonical_slug) or {}

        title = _pick_best_title(
            canonical_slug,
            str(history.get("title") or ""),
            str(cached.get("title") or ""),
            str(detail.get("title") or ""),
        )
        thumb = str(history.get("thumb") or cached.get("thumb") or detail.get("thumb") or "").strip()
        if not thumb and canonical_slug and not _MANGADEX_ID_RE.fullmatch(canonical_slug):
            thumb = f"{canonical_slug}-thumb.jpg"

        genres = (
            _sanitize_string_list(cached.get("genres"))
            or _sanitize_string_list(detail.get("genres"))
        )
        tags = (
            _sanitize_string_list(cached.get("tags"))
            or _sanitize_string_list(detail.get("tags"))
        )
        if not tags and genres:
            tags = [slug for slug in (_slugify_tag(genre) for genre in genres) if slug]
            tags = _sanitize_string_list(tags)

        latest_candidates: list[tuple[str, str]] = []
        mangadex_chapter_name = str(mangadex_latest.get("chapter_name") or "").strip()
        mangadex_publish_at = str(mangadex_latest.get("publish_at") or "").strip()
        if mangadex_chapter_name:
            latest_candidates.append((mangadex_chapter_name, mangadex_publish_at))

        for source in (cached, detail, history):
            chapter_name = str(source.get("latest_chapter") or "").strip()
            if not chapter_name:
                continue
            chapter_updated_at = str(source.get("latest_chapter_updated_at") or "").strip()
            latest_candidates.append((chapter_name, chapter_updated_at))

        latest_chapter, latest_chapter_updated_at = _pick_latest_chapter_candidate(
            latest_candidates,
            _pick_first_non_empty(
                mangadex_publish_at,
                cached.get("latest_chapter_updated_at"),
                detail.get("latest_chapter_updated_at"),
                history.get("latest_chapter_updated_at"),
                item.get("updated_at"),
            ),
        )

        response_items.append(
            {
                "manga_slug": canonical_slug,
                "score": int(item.get("score") or 0),
                "updated_at": str(item.get("updated_at") or ""),
                "title": title,
                "thumb": thumb,
                "genres": genres,
                "tags": tags,
                "latest_chapter": latest_chapter,
                "latest_chapter_updated_at": latest_chapter_updated_at,
            }
        )

    from fastapi_app.services.catalog_visibility import unmatched
    missing = await asyncio.to_thread(unmatched, [item["manga_slug"] for item in response_items])
    response_items = [item for item in response_items if item["manga_slug"] not in missing]
    return {"items": response_items, "total": len(response_items)}


@router.get("/top")
async def get_top_rated_manga(
    limit: int = Query(24, ge=1, le=120),
    db=Depends(get_supabase_public),
):
    """Get globally top-rated manga slugs from internal ratings only (guest-safe)."""
    fetch_limit = min(20000, max(1200, limit * 250))

    try:
        rows = (
            (await asyncio.to_thread(lambda: (db.table("ratings")
            .select("user_id,manga_slug,score,updated_at")
            .order("updated_at", desc=True)
            .limit(fetch_limit)
            .execute())))
            .data
            or []
        )
    except Exception:
        logger.exception("Top-rated query failed; returning an empty ranking")
        rows = []

    qq_aliases = await asyncio.to_thread(cached_aliases, [row.get("manga_slug") for row in rows])
    per_slug_users: dict[str, dict[str, tuple[float, str]]] = {}
    anon_seq = 0
    for row in rows:
        slug = _normalize_manga_slug(row.get("manga_slug"))
        slug = qq_aliases.get(slug, [slug])[0]
        if not slug:
            continue

        user_id = str(row.get("user_id") or "").strip()
        if not user_id:
            anon_seq += 1
            user_id = f"anon:{anon_seq}"

        score = _safe_float(row.get("score"))
        updated_at = str(row.get("updated_at") or "")

        bucket = per_slug_users.setdefault(slug, {})
        prev = bucket.get(user_id)
        if prev is None or updated_at >= prev[1]:
            bucket[user_id] = (score, updated_at)

    ranked: list[dict[str, str | int | float]] = []
    global_total = 0.0
    global_count = 0
    for users in per_slug_users.values():
        for score, _ in users.values():
            global_total += score
            global_count += 1

    prior_average = (
        round(global_total / global_count, 3)
        if global_count > 0
        else TOP_RATED_PRIOR_AVERAGE
    )

    for slug, users in per_slug_users.items():
        if not users:
            continue
        total = sum(score for score, _ in users.values())
        count = len(users)
        average = round(total / count, 1) if count > 0 else 0.0
        weighted_score = (
            total + prior_average * TOP_RATED_PRIOR_COUNT
        ) / (count + TOP_RATED_PRIOR_COUNT)
        latest_updated_at = max((updated for _, updated in users.values()), default="")
        ranked.append(
            {
                "manga_slug": slug,
                "average": average,
                "count": int(count),
                "weighted_score": round(weighted_score, 4),
                "updated_at": latest_updated_at,
            }
        )

    ranked.sort(
        key=lambda item: (
            float(item.get("weighted_score") or 0.0),
            int(item.get("count") or 0),
            float(item.get("average") or 0.0),
            str(item.get("updated_at") or ""),
        ),
        reverse=True,
    )

    from fastapi_app.services.catalog_visibility import unmatched
    missing = await asyncio.to_thread(unmatched, [item["manga_slug"] for item in ranked])
    items = [item for item in ranked if item["manga_slug"] not in missing][:limit]
    return {"items": items, "total": len(items)}


@router.post("/")
async def rate_manga(
    request: Request,
    data: RateRequest,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Add or update a rating (upsert)."""
    _ = request
    enforce_user_action_limit(
        "rating-write:min",
        user["id"],
        limit=RATING_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Đánh giá quá nhanh",
    )
    enforce_user_action_limit(
        "rating-write:hour",
        user["id"],
        limit=RATING_WRITE_LIMIT_PER_HOUR,
        window_seconds=60 * 60,
        detail="Đánh giá quá nhiều",
    )
    normalized_slug = _normalize_manga_slug(data.manga_slug)
    if not normalized_slug:
        raise HTTPException(status_code=400, detail="manga_slug không hợp lệ")

    aliases = await asyncio.to_thread(cached_aliases, [normalized_slug])
    candidates = _slug_candidates(normalized_slug, aliases)
    if len(candidates) > 1 and _MANGADEX_ID_RE.fullmatch(normalized_slug):
        try:
            db.table("ratings").delete().eq("user_id", user["id"]).in_(
                "manga_slug", candidates
            ).execute()
        except Exception:
            # Keep upsert path below even if alias cleanup fails.
            pass

    db.table("ratings").upsert(
        {
            "user_id": user["id"],
            "manga_slug": normalized_slug,
            "score": data.score,
        },
        on_conflict="user_id,manga_slug",
    ).execute()
    _invalidate_aggregates()
    from fastapi_app.routers.manga import _rating_cache
    for candidate in candidates:
        _rating_cache.pop(candidate, None)
    return {"message": "Đã đánh giá", "score": data.score, "manga_slug": normalized_slug}


@router.post("/batch")
async def get_batch_ratings(
    data: BatchRatingsRequest,
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Get average rating + count for many manga slugs (supports mdx aliases)."""
    requested: list[str] = []
    seen: set[str] = set()
    for raw_slug in data.manga_slugs:
        slug = _normalize_manga_slug(raw_slug)
        if not slug or slug in seen:
            continue
        seen.add(slug)
        requested.append(slug)
        if len(requested) >= 500:
            break

    if not requested:
        return {"ratings": {}}

    alias_to_requested: dict[str, list[str]] = {}
    query_slugs: list[str] = []
    query_seen: set[str] = set()
    qq_aliases = await asyncio.to_thread(cached_aliases, requested)
    candidate_groups = {}
    for requested_slug in requested:
        candidates = _slug_candidates(requested_slug, qq_aliases)
        candidate_groups[requested_slug] = candidates
        for candidate in candidates:
            if not candidate:
                continue
            alias_to_requested.setdefault(candidate, []).append(requested_slug)
            if candidate not in query_seen:
                query_seen.add(candidate)
                query_slugs.append(candidate)

    epoch = _aggregate_epoch
    # Home cards need the same counters as detail, without N detail requests or
    # a full-table ranking scan. Run these independent reads together.
    def read_ratings():
        return db.table("ratings").select("user_id,manga_slug,score,updated_at").in_("manga_slug", query_slugs).execute().data or []

    def read_views():
        return db.table("manga_views").select("manga_slug,views").in_("manga_slug", query_slugs).execute().data or []

    def read_personal():
        return (db.table("ratings").select("manga_slug,score,updated_at")
                .eq("user_id", user["id"]).in_("manga_slug", query_slugs).execute().data or [])

    results = await asyncio.gather(
        asyncio.to_thread(read_ratings),
        *([asyncio.to_thread(read_views)] if data.include_views else []),
        *([asyncio.to_thread(read_personal)] if user else []),
        return_exceptions=True,
    )
    succeeded = not isinstance(results[0], BaseException)
    rows = results[0] if succeeded else []
    views = None
    if data.include_views and not isinstance(results[1], BaseException):
        views = {slug: 0 for slug in requested}
        for row in results[1]:
            alias = str(row.get("manga_slug") or "").strip().lower()
            for target in alias_to_requested.get(alias, []):
                views[target] += max(0, int(row.get("views") or 0))

    per_slug_users: dict[str, dict[str, tuple[float, str]]] = {
        slug: {} for slug in requested
    }
    anon_seq = 0
    for row in rows:
        alias = str(row.get("manga_slug") or "").strip().lower()
        targets = alias_to_requested.get(alias) or []
        if not targets:
            continue
        score = _safe_float(row.get("score"))
        updated_at = str(row.get("updated_at") or "")
        user_id = str(row.get("user_id") or "").strip()
        if not user_id:
            anon_seq += 1
            user_id = f"anon:{anon_seq}"
        for target in targets:
            bucket = per_slug_users[target]
            prev = bucket.get(user_id)
            if prev is None or updated_at >= prev[1]:
                bucket[user_id] = (score, updated_at)

    ratings: dict[str, dict[str, float | int]] = {}
    for slug, users in per_slug_users.items():
        total = sum(score for score, _ in users.values())
        count = len(users)
        avg = round(total / count, 1) if count > 0 else 0.0
        ratings[slug] = {"average": avg, "count": int(count)}
        if succeeded:
            _remember_aggregate(db, candidate_groups[slug], avg, count, epoch)

    # Keep the personal query independent: PostgREST may cap the aggregate
    # result before the viewer's row, even when their own score is available.
    my_scores = {}
    personal_succeeded = not user or not isinstance(results[-1], BaseException)
    if user and personal_succeeded:
        latest_by_slug = {}
        for row in results[-1]:
            alias = str(row.get("manga_slug") or "").strip().lower()
            try:
                score = int(row.get("score"))
            except (TypeError, ValueError):
                continue
            updated_at = str(row.get("updated_at") or "")
            for target in alias_to_requested.get(alias, []):
                previous = latest_by_slug.get(target)
                if previous is None or updated_at >= previous[1]:
                    latest_by_slug[target] = (score, updated_at)
        my_scores = {slug: score for slug, (score, _) in latest_by_slug.items()}

    result = {"ratings": ratings if succeeded else {}, "my_scores": my_scores}
    if views is not None:
        result["views"] = views
    if not succeeded or not personal_succeeded or (data.include_views and views is None):
        result["incomplete"] = True
    return result



@router.delete("/manga/{manga_slug}")
async def remove_rating(
    request: Request,
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Remove user's rating."""
    _ = request
    enforce_user_action_limit(
        "rating-write:min",
        user["id"],
        limit=RATING_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Đánh giá quá nhanh",
    )
    normalized_slug = _normalize_manga_slug(manga_slug)
    aliases = await asyncio.to_thread(cached_aliases, [normalized_slug])
    candidates = _slug_candidates(normalized_slug, aliases)
    if not candidates:
        raise HTTPException(status_code=400, detail="manga_slug không hợp lệ")

    db.table("ratings").delete().eq("user_id", user["id"]).in_(
        "manga_slug", candidates
    ).execute()
    _invalidate_aggregates()
    from fastapi_app.routers.manga import _rating_cache
    for candidate in candidates:
        _rating_cache.pop(candidate, None)
    return {"message": "Đã xóa đánh giá"}
