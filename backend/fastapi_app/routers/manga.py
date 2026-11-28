"""
Manga router — proxies OTruyenAPI with caching.
"""

import asyncio
from serverless_runtime import create_task, writable_path
import json
import logging
import math
import os
import random
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from html import escape as html_escape, unescape as html_unescape
from typing import Any, Annotated
from urllib.parse import quote, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from config import config
from fastapi_app.dependencies import get_optional_user, get_supabase, get_supabase_public
from fastapi_app.services.cache_service import cache
from fastapi_app.services import mangadex_service, truyenqq_service
from fastapi_app.services.public_reads import cached_public_read
from fastapi_app.services.request_coalescing import coalesce_reads
otruyen_service = truyenqq_service  # compatibility for existing integrations

from fastapi_app.utils.anti_spam import (
    check_fixed_window,
    check_recent_once,
    get_client_ip,
    hash_value,
    request_fingerprint,
)
from fastapi_app.utils.upload_security import detect_image_content_type

router = APIRouter()


class CardMetadataRequest(BaseModel):
    identifiers: list[Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9-]+$")]] = Field(max_length=48)
    titles: dict[Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9-]+$")], Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=dict, max_length=48)


@router.post("/chapters/latest/batch")
async def card_latest_chapters(payload: CardMetadataRequest, db=Depends(get_supabase_public)):
    from fastapi_app.services import card_chapters, card_metadata, catalog_visibility
    requested = [value.lower() for value in payload.identifiers]
    uploaded = await catalog_visibility.published_uploads(db, requested)
    external = [identifier for identifier in requested if identifier not in uploaded]
    found, hidden = await asyncio.gather(card_chapters.get_many(external), _get_hidden_slugs(db))
    found.update({identifier: {"chapter": None, "pending": False} for identifier in uploaded})
    await asyncio.to_thread(catalog_visibility.remember_matches,
        {identifier: None for identifier, item in found.items() if item.get("state") == "unavailable"})
    pending_aliases = [identifier for identifier, result in found.items() if hidden and not result.get("chapter")]
    metadata = await asyncio.to_thread(cache.get_many,
        [key for identifier in pending_aliases for key in card_metadata.metadata_keys(identifier)]) if pending_aliases else {}
    for identifier, result in found.items():
        canonical = ((result.get("chapter") or {}).get("slug")
                     or (card_metadata.cached_metadata(identifier, metadata) or {}).get("slug", ""))
        if _hidden_reason_for_slug(hidden, identifier) or _hidden_reason_for_slug(hidden, canonical):
            found[identifier] = {"chapter": None, "pending": False}
    return {"items": found}


@router.post("/metadata/batch")
async def card_metadata_batch(payload: CardMetadataRequest, db=Depends(get_supabase_public)):
    from fastapi_app.services import card_metadata, catalog_visibility
    requested = [value.lower() for value in payload.identifiers]
    uploaded = await catalog_visibility.published_uploads(db, requested)
    external = [identifier for identifier in requested if identifier not in uploaded]
    found, hidden = await asyncio.gather(card_metadata.get_many(external, payload.titles) if payload.titles else card_metadata.get_many(external), _get_hidden_slugs(db))
    found.update(uploaded)
    await asyncio.to_thread(catalog_visibility.remember_matches, found)
    result = {}
    for identifier, item in found.items():
        aliases = [identifier, (item or {}).get("id", ""), (item or {}).get("slug", "")]
        if any(_hidden_reason_for_slug(hidden, alias) for alias in aliases if alias):
            result[identifier] = None
        else:
            result[identifier] = item
    return {"items": result}
logger = logging.getLogger(__name__)
_MANGADEX_RETRY_AFTER_RE = re.compile(r"retry_after=([0-9.]+)s")


def _mangadex_upstream_http_exception(error: RuntimeError) -> HTTPException:
    detail = str(error)
    status_code = 503 if "cooldown active" in detail or "rate limited" in detail else 502
    headers: dict[str, str] = {}
    match = _MANGADEX_RETRY_AFTER_RE.search(detail)
    if match:
        try:
            headers["Retry-After"] = str(max(1, math.ceil(float(match.group(1)))))
        except Exception:
            pass
    return HTTPException(status_code=status_code, detail=detail, headers=headers or None)


def _mangadex_unavailable_response() -> JSONResponse:
    return JSONResponse(status_code=503, content={
        "code": "MANGADEX_UNAVAILABLE",
        "detail": "Nguồn MangaDex đang tạm thời không khả dụng. Vui lòng thử lại sau.",
    }, headers={"Cache-Control": "no-store", "Retry-After": "30"})


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except Exception:
        return default


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return max(minimum, float(raw))
    except Exception:
        return default


RATING_CACHE_TTL_SECONDS = 120
_rating_cache: dict[str, tuple[float, int, float]] = {}
_MAX_RATING_CACHE = 2000  # Maximum slugs to keep in memory
COMBINED_LIST_TTL_SECONDS = 120
COMBINED_LIST_STALE_TTL_SECONDS = 900
COMBINED_LIST_MDX_TIMEOUT_SECONDS = 6.0
TRENDING_CACHE_TTL_SECONDS = 120
TRENDING_CACHE_VERSION = "v18-ranked-only"
TRENDING_ENABLE_NETWORK_DETAIL_ENRICH = False
MANGADEX_STARTUP_WARMUP_ENABLED = str(
    os.getenv("MANGADEX_STARTUP_WARMUP_ENABLED", "false") or "false"
).strip().lower() in {"1", "true", "yes", "on"}
_trending_memory_cache: dict[str, tuple[list[dict], float]] = {}
_combined_refresh_tasks: dict[str, asyncio.Task] = {}
_startup_warmup_task: asyncio.Task | None = None
OTRUYEN_IMG_CDN = "https://img.otruyenapi.com/uploads/comics/"
DEFAULT_SHARE_IMAGE_PATH = "/og-logo.png"
SITEMAP_CACHE_VERSION = "v5-truyenqq"
SITEMAP_CACHE_TTL_SECONDS = _env_int("SITEMAP_CACHE_TTL_SECONDS", 1800, minimum=300)
SITEMAP_LOCAL_ACTIVITY_LIMIT = _env_int("SITEMAP_LOCAL_ACTIVITY_LIMIT", 3000, minimum=100)
SITEMAP_OTRUYEN_PAGE_LIMIT = _env_int("SITEMAP_OTRUYEN_PAGE_LIMIT", 30, minimum=3)
SITEMAP_OTRUYEN_BATCH_SIZE = _env_int("SITEMAP_OTRUYEN_BATCH_SIZE", 10, minimum=2)
SITEMAP_OTRUYEN_TIMEOUT_SECONDS = _env_float("SITEMAP_OTRUYEN_TIMEOUT_SECONDS", 24.0, minimum=6.0)
SITEMAP_MANGADEX_TIMEOUT_SECONDS = _env_float("SITEMAP_MANGADEX_TIMEOUT_SECONDS", 10.0, minimum=3.0)

# ─── Hidden manga cache ────────────────────────────────────────────────────────
_hidden_cache: dict[str, str] = {}   # {normalized_slug_or_alias: hidden_reason}
_hidden_cache_at: float = 0.0
_HIDDEN_CACHE_TTL = 180  # refresh every 3 minutes
_HIDDEN_CACHE_FETCH_TIMEOUT_SECONDS = 1.2
_manga_views_lookup_cache: dict[str, int] = {}
_manga_views_lookup_cache_at: float = 0.0
_MANGA_VIEWS_LOOKUP_CACHE_TTL_SECONDS = 30
_MANGA_VIEWS_LOOKUP_LIMIT = 5000
_MANGADEX_LOCAL_VIEWED_INJECT_LIMIT = 48
_MANGADEX_POPULAR_LOCAL_VIEW_LIMIT = 500
_MANGADEX_LOCAL_VIEWED_LOOKUP_CONCURRENCY = 2
_MANGADEX_LOCAL_VIEWED_LOOKUP_TIMEOUT_SECONDS = 8.0
_MANGADEX_RATING_SORT_CANDIDATE_LIMIT = _env_int("MANGADEX_RATING_SORT_CANDIDATE_LIMIT", 300, minimum=48)
_MANGADEX_RATING_SORT_MAX_CANDIDATES = _env_int("MANGADEX_RATING_SORT_MAX_CANDIDATES", 600, minimum=100)
_MANGADEX_RATING_SORT_PAGE_SIZE = 100
_MANGADEX_POPULAR_FILTERED_CANDIDATE_LIMIT = _env_int(
    "MANGADEX_POPULAR_FILTERED_CANDIDATE_LIMIT",
    100,
    minimum=48,
)
_MANGADEX_POPULAR_FILTERED_MAX_CANDIDATES = _env_int(
    "MANGADEX_POPULAR_FILTERED_MAX_CANDIDATES",
    300,
    minimum=100,
)
_MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT = _env_int(
    "MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT",
    96,
    minimum=0,
)
MANGADEX_POPULAR_FILTERED_CACHE_TTL_SECONDS = 90
VIEW_DEDUP_SECONDS = 15 * 60
VIEW_DB_DEDUP_SECONDS = 15 * 60
VIEW_BURST_LIMIT_PER_MINUTE = 30
VIEW_BURST_LIMIT_PER_10_MINUTES = 120
VIEW_SESSION_START_LIMIT_PER_MINUTE = 30
VIEW_SESSION_START_LIMIT_PER_10_MINUTES = 120
VIEW_IP_BURST_LIMIT_PER_MINUTE = 120
VIEW_IP_BURST_LIMIT_PER_10_MINUTES = 600
VIEW_MIN_ELAPSED_SECONDS = 12
VIEW_MIN_PROGRESS_PERCENT = 15
VIEW_MIN_PAGE_SEEN = 2
VIEW_CHAPTER_VALID_CACHE_TTL_SECONDS = 6 * 60 * 60
VIEW_CHAPTER_INVALID_CACHE_TTL_SECONDS = 5 * 60


async def _get_hidden_slugs(db) -> dict[str, str]:
    """Returns {slug: reason} for all admin-hidden manga. Cached in memory 3 min."""
    if time.time() - _hidden_cache_at < _HIDDEN_CACHE_TTL:
        return _hidden_cache
    return await _refresh_hidden_slugs(db)


@coalesce_reads
async def _refresh_hidden_slugs(db) -> dict[str, str]:
    # Home, banner, featured and ranking start together. Share their cold read
    # while preserving the existing moderation TTL and write invalidation.
    global _hidden_cache, _hidden_cache_at
    try:
        res = await asyncio.wait_for(
            asyncio.to_thread(
                lambda: db.table("manga_overrides")
                .select("manga_slug, hidden_reason")
                .eq("is_hidden", True)
                .execute()
            ),
            timeout=_HIDDEN_CACHE_FETCH_TIMEOUT_SECONDS,
        )
        new_cache: dict[str, str] = {}
        for row in (res.data or []):
            slug = str(row.get("manga_slug") or "").strip()
            reason = str(row.get("hidden_reason") or "Nội dung vi phạm quy định")
            if not slug:
                continue
            # Keep all lookup aliases in-memory so mdx-<uuid> and <uuid>
            # are both blocked even if DB has only one representation.
            for candidate in _hidden_slug_candidates(slug):
                if candidate and candidate not in new_cache:
                    new_cache[candidate] = reason
        _hidden_cache = new_cache
        _hidden_cache_at = time.time()
        return _hidden_cache
    except Exception:
        _hidden_cache_at = time.time() - _HIDDEN_CACHE_TTL + 10
        return _hidden_cache  # Return stale on DB error


def _filter_hidden(items: list[dict], hidden: dict[str, str]) -> list[dict]:
    """Remove hidden manga from any items list (OTruyen uses 'slug', MangaDex uses 'id')."""
    if not hidden:
        return items
    return [
        it for it in items
        if _hidden_reason_for_slug(hidden, (it or {}).get("slug") or (it or {}).get("id")) is None
    ]


def _filter_hidden_mangadex_payload(payload: dict[str, Any], hidden: dict[str, str]) -> dict[str, Any]:
    if not hidden or not isinstance(payload, dict):
        return payload

    mangas = payload.get("mangas")
    if not isinstance(mangas, list):
        return payload

    filtered = _filter_hidden(mangas, hidden)
    result = dict(payload)
    result["mangas"] = filtered

    meta = result.get("meta")
    if isinstance(meta, dict):
        next_meta = dict(meta)
        next_meta["total_manga"] = len(filtered)
        result["meta"] = next_meta

    return result


def invalidate_hidden_cache() -> None:
    """Force-expire the hidden-slug cache so next request re-fetches from DB.
    Call this from admin endpoints after any hide / show action."""
    global _hidden_cache_at
    _hidden_cache_at = 0.0


class ViewPayload(BaseModel):
    chapter_id: str | None = None
    read_session_id: str | None = None
    elapsed_seconds: int = 0
    progress: float = 0
    page_seen: int = 0
    total_pages: int = 0


class ViewSessionPayload(BaseModel):
    chapter_id: str | None = None
    read_session_id: str


def _normalize_view_chapter_id(value: Any) -> str:
    chapter_id = str(value or "").strip()[:100]
    if not chapter_id or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", chapter_id):
        return ""
    return chapter_id


def _normalize_read_session_id(value: Any) -> str:
    session_id = str(value or "").strip()
    if len(session_id) > 96:
        session_id = session_id[:96]
    return session_id


def _rpc_json_payload(result: Any) -> dict | None:
    data = getattr(result, "data", result)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            if "track_manga_view_checked" in first and isinstance(first["track_manga_view_checked"], dict):
                return first["track_manga_view_checked"]
            if "start_manga_read_session" in first and isinstance(first["start_manga_read_session"], dict):
                return first["start_manga_read_session"]
            return first
    return None


def _recent_user_view_exists(db: Any, user_id: str, manga_slug: str) -> bool:
    if not user_id:
        return False
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=VIEW_DB_DEDUP_SECONDS)).isoformat()
    try:
        query = (
            db.table("manga_view_events")
            .select("id")
            .eq("manga_slug", manga_slug)
            .eq("user_id", user_id)
            .gte("created_at", cutoff)
            .limit(1)
        )
        result = query.execute()
        return bool(result.data)
    except Exception:
        return False


def _view_chapter_validation_cache_key(manga_slug: str, chapter_id: str) -> str:
    return f"view:chapter-owner:v1:{hash_value(f'{manga_slug}:{chapter_id}')}"


async def _validate_view_chapter_owner(db: Any, manga_slug: str, chapter_id: str) -> str:
    """Return valid, invalid, or unavailable for a chapter/manga relationship."""

    if not manga_slug or not chapter_id:
        return "invalid"

    cache_key = _view_chapter_validation_cache_key(manga_slug, chapter_id)
    cached = str(cache.get(cache_key) or "").strip().lower()
    if cached in {"valid", "invalid"}:
        return cached

    try:
        if chapter_id.startswith("upload-"):
            upload_id = chapter_id[7:].strip()
            if not _MANGADEX_ID_RE.fullmatch(upload_id):
                status = "invalid"
            else:
                result = await asyncio.to_thread(
                    lambda: db.table("chapter_uploads")
                    .select("manga_slug,status")
                    .eq("id", upload_id)
                    .eq("status", "published")
                    .maybe_single()
                    .execute()
                )
                row = getattr(result, "data", None) or {}
                status = (
                    "valid"
                    if _clean_slug(row.get("manga_slug")) == _clean_slug(manga_slug)
                    else "invalid"
                )
        else:
            mangadex_manga_id = _extract_mangadex_id(manga_slug)
            if mangadex_manga_id:
                mangadex_chapter_id = _extract_mangadex_id(chapter_id)
                if not mangadex_chapter_id:
                    status = "invalid"
                else:
                    payload = await mangadex_service.get_chapter_metadata(mangadex_chapter_id)
                    chapter = (payload or {}).get("data") or {}
                    relationships = chapter.get("relationships") or []
                    owner_ids = {
                        str(rel.get("id") or "").strip().lower()
                        for rel in relationships
                        if isinstance(rel, dict) and rel.get("type") == "manga"
                    }
                    status = "valid" if mangadex_manga_id in owner_ids else "invalid"
            else:
                payload = await truyenqq_service.get_chapter(chapter_id)
                item = (payload or {}).get("data", {}).get("item") if isinstance(payload, dict) else None
                if not isinstance(item, dict):
                    status = "invalid"
                else:
                    owner_slug = _extract_otruyen_chapter_manga_slug(item)
                    status = "valid" if _clean_slug(owner_slug) == _clean_slug(manga_slug) else "invalid"
    except Exception as exc:
        logger.debug(
            "manga.view chapter ownership unavailable: manga=%s chapter=%s error=%s",
            manga_slug,
            chapter_id,
            exc,
        )
        return "unavailable"

    ttl = (
        VIEW_CHAPTER_VALID_CACHE_TTL_SECONDS
        if status == "valid"
        else VIEW_CHAPTER_INVALID_CACHE_TTL_SECONDS
    )
    cache.set(cache_key, status, ttl)
    return status


def _start_manga_read_session_rpc(
    db: Any,
    *,
    manga_slug: str,
    chapter_id: str,
    user_id: str | None,
    viewer_hash: str,
    ip_hash: str,
    user_agent_hash: str,
    session_id: str,
) -> dict | None:
    try:
        result = db.rpc(
            "start_manga_read_session",
            {
                "p_manga_slug": manga_slug,
                "p_chapter_id": chapter_id or None,
                "p_user_id": user_id,
                "p_viewer_hash": viewer_hash,
                "p_ip_hash": ip_hash,
                "p_user_agent_hash": user_agent_hash,
                "p_session_id": session_id,
            },
        ).execute()
        return _rpc_json_payload(result) or {"ok": True}
    except Exception as exc:
        logger.debug("manga.view session rpc unavailable: %s", exc)
        return None


def _track_manga_view_checked_rpc(
    db: Any,
    *,
    manga_slug: str,
    chapter_id: str,
    user_id: str | None,
    viewer_hash: str,
    ip_hash: str,
    user_agent_hash: str,
    session_id: str,
    elapsed_seconds: int,
    progress: float,
    page_seen: int,
    min_page_seen: int,
) -> dict | None:
    try:
        result = db.rpc(
            "track_manga_view_checked",
            {
                "p_manga_slug": manga_slug,
                "p_chapter_id": chapter_id or None,
                "p_user_id": user_id,
                "p_viewer_hash": viewer_hash,
                "p_ip_hash": ip_hash,
                "p_user_agent_hash": user_agent_hash,
                "p_dedup_seconds": VIEW_DB_DEDUP_SECONDS,
                "p_session_id": session_id,
                "p_elapsed_seconds": max(0, int(elapsed_seconds or 0)),
                "p_progress": max(0.0, min(100.0, float(progress or 0))),
                "p_page_seen": max(0, int(page_seen or 0)),
                "p_min_elapsed_seconds": VIEW_MIN_ELAPSED_SECONDS,
                "p_min_progress": VIEW_MIN_PROGRESS_PERCENT,
                "p_min_page_seen": max(1, int(min_page_seen or VIEW_MIN_PAGE_SEEN)),
            },
        ).execute()
        return _rpc_json_payload(result) or {"ok": True, "counted": bool(getattr(result, "data", None))}
    except Exception as exc:
        logger.debug("manga.view checked rpc unavailable: %s", exc)
        return None


def _extract_chapter_id(chapter_api_data: str | None) -> str:
    if not chapter_api_data:
        return ""
    return str(chapter_api_data).rstrip("/").split("/")[-1]


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _clean_slug(value: Any) -> str:
    return re.sub(r"[^a-z0-9-]", "", str(value or "").strip().lower().strip("/"))


_MANGADEX_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_OTRUYEN_OBJECT_ID_RE = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)
_UUID_HEX_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
_OTRUYEN_ROUTE_ID_PREFIX = "07e0aa"
_OTRUYEN_ROUTE_ID_VERSION_POS = 12
_OTRUYEN_ROUTE_ID_VARIANT_POS = 16
_OTRUYEN_ROUTE_ID_VERSION = "5"
_OTRUYEN_ROUTE_ID_VARIANT = "8"
_NON_ASCII_RE = re.compile(r"[^\x00-\x7f]")
_MOJIBAKE_RE = re.compile(
    r"(?:[\u00c3\u00c2\u00c4\u00c5\u00c6\u00d0]|\u00e1[\u00ba\u00bb].)"
)
_MATURE_TERMS = (
    "adult",
    "mature",
    "erotica",
    "pornographic",
    "hentai",
    "ecchi",
    "smut",
    "nsfw",
    "bao luc tinh duc",
    "sexual violence",
    "sexual-violence",
    "sexual assault",
    "sexual-assault",
    "sexual abuse",
    "sexual-abuse",
    "18",
)


def _is_otruyen_route_fixed_pos(pos: int) -> bool:
    return (
        pos < len(_OTRUYEN_ROUTE_ID_PREFIX)
        or pos == _OTRUYEN_ROUTE_ID_VERSION_POS
        or pos == _OTRUYEN_ROUTE_ID_VARIANT_POS
    )


def _decode_otruyen_route_id(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    compact = normalized.replace("-", "")
    if _OTRUYEN_OBJECT_ID_RE.fullmatch(compact):
        return compact
    if not _UUID_HEX_RE.fullmatch(compact):
        return None
    if not compact.startswith(_OTRUYEN_ROUTE_ID_PREFIX):
        return None
    if compact[_OTRUYEN_ROUTE_ID_VERSION_POS] != _OTRUYEN_ROUTE_ID_VERSION:
        return None
    if compact[_OTRUYEN_ROUTE_ID_VARIANT_POS] != _OTRUYEN_ROUTE_ID_VARIANT:
        return None

    object_id = "".join(
        ch for pos, ch in enumerate(compact)
        if not _is_otruyen_route_fixed_pos(pos)
    )
    return object_id if _OTRUYEN_OBJECT_ID_RE.fullmatch(object_id) else None


def _is_otruyen_route_uuid(value: Any) -> bool:
    normalized = str(value or "").strip()
    return "-" in normalized and _decode_otruyen_route_id(normalized) is not None


def _extract_mangadex_id(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    if normalized.startswith("mdx-"):
        normalized = normalized[4:]
    if normalized.startswith(("mangadex-", "mangadex:")):
        normalized = normalized[9:]
    if _is_otruyen_route_uuid(normalized):
        return None
    return normalized if _MANGADEX_ID_RE.fullmatch(normalized) else None


async def _canonical_view_slug(value: Any) -> str:
    raw = str(value or "").strip().strip("/").lower()
    if not raw:
        return ""

    mangadex_id = _extract_mangadex_id(raw)
    if mangadex_id:
        return mangadex_id

    otruyen_object_id = _decode_otruyen_route_id(raw)
    if otruyen_object_id:
        try:
            resolved_slug = await truyenqq_service.resolve_slug_from_id(otruyen_object_id)
        except Exception:
            resolved_slug = None
        cleaned_resolved = _clean_slug(resolved_slug)
        if cleaned_resolved:
            return cleaned_resolved

    return _clean_slug(raw)


def _hidden_slug_candidates(value: Any) -> list[str]:
    normalized = str(value or "").strip().strip("/").lower()
    if not normalized:
        return []

    candidates: set[str] = {normalized}
    cleaned = _clean_slug(normalized)
    if cleaned:
        candidates.add(cleaned)

    mangadex_id = _extract_mangadex_id(normalized)
    if mangadex_id:
        candidates.add(mangadex_id)
        candidates.add(f"mdx-{mangadex_id}")
        candidates.add(f"mangadex-{mangadex_id}")
        candidates.add(f"mangadex:{mangadex_id}")

    return list(candidates)


def _hidden_reason_for_slug(hidden: dict[str, str], value: Any) -> str | None:
    if not hidden:
        return None
    for candidate in _hidden_slug_candidates(value):
        reason = hidden.get(candidate)
        if reason:
            return reason
    return None


async def _fetch_override_rows_by_slugs(db: Any, slugs: list[Any]) -> dict[str, dict[str, Any]]:
    lookup_slugs = sorted(
        {
            candidate
            for slug in slugs
            for candidate in _hidden_slug_candidates(slug)
            if candidate
        }
    )
    if not lookup_slugs:
        return {}

    try:
        result = await cached_public_read(("overrides", id(db), tuple(lookup_slugs)),
            lambda: db.table("manga_overrides")
            .select("manga_slug,is_featured,featured_at,admin_notes")
            .in_("manga_slug", lookup_slugs)
            .execute(), None
        )
    except Exception:
        return {}

    rows: dict[str, dict[str, Any]] = {}
    for row in (getattr(result, "data", None) or []):
        key = str((row or {}).get("manga_slug") or "").strip().strip("/").lower()
        if key and key not in rows:
            rows[key] = row
    return rows


def _resolve_override_row(
    override_rows: dict[str, dict[str, Any]], slug: Any
) -> dict[str, Any] | None:
    if not override_rows:
        return None
    for candidate in _hidden_slug_candidates(slug):
        row = override_rows.get(candidate)
        if row is not None:
            return row
    return None


def _apply_override_fields(target: Any, override_row: dict[str, Any] | None) -> None:
    if not isinstance(target, dict):
        return
    if override_row is None:
        target.setdefault("is_featured", False)
        if "featured_at" not in target:
            target["featured_at"] = None
        if "admin_notes" not in target:
            target["admin_notes"] = None
        return

    target["is_featured"] = bool(override_row.get("is_featured", False))
    target["featured_at"] = override_row.get("featured_at")
    target["admin_notes"] = override_row.get("admin_notes")


async def _attach_overrides_to_otruyen_payload(payload: Any, db: Any, *, attach_views: bool = True) -> None:
    if not isinstance(payload, dict):
        return
    items = (payload.get("data") or {}).get("items")
    if not isinstance(items, list) or not items:
        return

    slugs = [
        str((item or {}).get("slug") or "").strip()
        for item in items
        if str((item or {}).get("slug") or "").strip()
    ]
    if not slugs:
        return

    reads = [_fetch_override_rows_by_slugs(db, slugs)]
    if attach_views:
        reads.append(_async_attach_local_views_to_otruyen_payload(payload, db))
    override_rows = (await asyncio.gather(*reads))[0]
    if not override_rows:
        for item in items:
            _apply_override_fields(item, None)
        return

    for item in items:
        item_slug = str((item or {}).get("slug") or "").strip()
        _apply_override_fields(item, _resolve_override_row(override_rows, item_slug))


async def _attach_overrides_to_mangadex_payload(payload: Any, db: Any) -> None:
    if not isinstance(payload, dict):
        return
    mangas = payload.get("mangas")
    if not isinstance(mangas, list) or not mangas:
        return

    ids = [
        str((manga or {}).get("id") or (manga or {}).get("slug") or "").strip()
        for manga in mangas
        if str((manga or {}).get("id") or (manga or {}).get("slug") or "").strip()
    ]
    if not ids:
        return

    override_rows = await _fetch_override_rows_by_slugs(db, ids)
    if not override_rows:
        for manga in mangas:
            _apply_override_fields(manga, None)
        return

    for manga in mangas:
        manga_slug = str((manga or {}).get("id") or (manga or {}).get("slug") or "").strip()
        _apply_override_fields(manga, _resolve_override_row(override_rows, manga_slug))


def _normalize_loose_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("\u0111", "d").replace("\u00c4\u2018", "d")
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _mojibake_score(value: Any) -> int:
    text = str(value or "")
    if not text:
        return 0
    return len(_MOJIBAKE_RE.findall(text))


def _repair_mojibake_text(value: Any) -> str:
    text = str(value or "")
    if not text or _mojibake_score(text) == 0:
        return text

    candidates = [text]
    for source_encoding in ("latin1", "cp1252"):
        try:
            fixed = text.encode(source_encoding, errors="strict").decode(
                "utf-8", errors="strict"
            )
            if fixed:
                candidates.append(fixed)
        except Exception:
            continue

    best = text
    best_score = _mojibake_score(text)
    for candidate in candidates[1:]:
        score = _mojibake_score(candidate)
        if score < best_score:
            best = candidate
            best_score = score

    return best


def _humanize_slug_title(slug: str) -> str:
    normalized = _clean_slug(slug)
    if not normalized:
        return ""
    if _extract_mangadex_id(normalized):
        return ""
    if "-" not in normalized:
        return ""
    words = [part for part in normalized.split("-") if part][:8]
    if not words:
        return ""
    return " ".join(part.capitalize() for part in words)


def _is_slug_like_title(title: Any, slug: str) -> bool:
    raw_title = str(title or "").strip()
    normalized_title = _clean_slug(title)
    normalized_slug = _clean_slug(slug)
    loose_title = _normalize_loose_text(title)
    loose_slug = _normalize_loose_text(slug)
    if not normalized_title:
        return True
    if normalized_title == normalized_slug:
        return True
    if (
        loose_title
        and loose_slug
        and loose_title == loose_slug.replace("-", " ")
        and not _NON_ASCII_RE.search(raw_title)
    ):
        return True
    if _extract_mangadex_id(normalized_title):
        return True
    if loose_title in {
        "mangadex",
        "untitled",
        "dang cap nhat tieu de",
        "hien dang cap nhat",
        "chua co tieu de",
    }:
        return True
    return False


def _pick_best_trending_title(slug: str, *candidates: Any) -> str:
    best = ""
    best_score = float("-inf")

    for index, candidate in enumerate(candidates):
        text = _repair_mojibake_text(candidate).strip()
        if not text:
            continue
        if _is_slug_like_title(text, slug):
            continue

        score = 0.0
        if _NON_ASCII_RE.search(text):
            score += 4.0
        score += 2.0 if _mojibake_score(text) == 0 else -min(2.0, float(_mojibake_score(text)))
        score += min(len(text), 80) / 80
        score += max(0.0, 0.8 - (index * 0.15))

        if score > best_score:
            best = text
            best_score = score

    return best or _humanize_slug_title(slug)


def _is_mature_marker(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    normalized = _normalize_loose_text(raw)
    if not normalized:
        return False
    if re.search(r"(^|[^0-9a-z])(18\+|18plus|18 plus|r18)([^0-9a-z]|$)", normalized):
        return True
    if normalized == "18":
        return True
    return any(term in normalized for term in _MATURE_TERMS)


def _is_mature_metadata(content_rating: Any, genres: Any, tags: Any) -> bool:
    if _is_mature_marker(content_rating):
        return True

    for values in (genres, tags):
        if not isinstance(values, list):
            continue
        for value in values:
            if _is_mature_marker(value):
                return True

    return False


def _fallback_trending_thumb(slug: str) -> str:
    normalized = _clean_slug(slug)
    if not normalized:
        return ""
    if _extract_mangadex_id(normalized):
        return ""
    return f"/api/manga/truyenqq/cover/{quote(normalized, safe='')}"


def _extract_item_categories(item: dict[str, Any]) -> tuple[list[str], list[str]]:
    categories = item.get("category") or []
    if not isinstance(categories, list):
        return [], []

    names: list[str] = []
    tags: list[str] = []
    for cat in categories:
        if isinstance(cat, dict):
            name = str(cat.get("name") or "").strip()
            tag = _clean_slug(cat.get("slug") or "")
        else:
            name = str(cat or "").strip()
            tag = _clean_slug(name)

        if name and name not in names:
            names.append(name)
        if tag and tag not in tags:
            tags.append(tag)

    return names, tags


def _pick_item_latest_chapter(item: dict[str, Any]) -> str:
    chapters_latest = item.get("chaptersLatest") or item.get("chapters_latest") or []
    if isinstance(chapters_latest, list):
        for chapter in chapters_latest:
            if isinstance(chapter, dict):
                chapter_name = str(
                    chapter.get("chapter_name")
                    or chapter.get("chapterName")
                    or chapter.get("chapter")
                    or chapter.get("name")
                    or ""
                ).strip()
            else:
                chapter_name = str(chapter or "").strip()
            if chapter_name:
                return chapter_name

    return str(item.get("last_chapter") or item.get("chapter_newest") or item.get("chapterNewest") or "").strip()


def _pick_item_latest_chapter_updated_at(item: dict[str, Any]) -> str:
    chapters_latest = item.get("chaptersLatest") or item.get("chapters_latest") or []
    if isinstance(chapters_latest, list):
        for chapter in chapters_latest:
            if not isinstance(chapter, dict):
                continue
            for key in (
                "local_published_at",
                "publish_at",
                "published_at",
                "readable_at",
                "chapter_updated_at",
                "chapterUpdatedAt",
                "updatedAt",
                "updated_at",
                "createdAt",
                "created_at",
            ):
                candidate = str(chapter.get(key) or "").strip()
                if candidate:
                    return candidate

    for key in (
        "local_last_published_at",
        "last_chapter_updated_at",
        "last_chapter_update_at",
        "last_chapter_time",
        "updatedAt",
        "updated_at",
        "createdAt",
        "created_at",
    ):
        candidate = str(item.get(key) or "").strip()
        if candidate:
            return candidate

    return ""


def _pick_item_last_updated(item: dict[str, Any]) -> str:
    for key in (
        "local_last_published_at",
        "updatedAt",
        "updated_at",
        "createdAt",
        "created_at",
    ):
        candidate = str(item.get(key) or "").strip()
        if candidate:
            return candidate
    return ""


def _parse_chapter_number(value: Any) -> float | None:
    raw = str(value or "").strip().replace(",", ".")
    if not raw:
        return None
    try:
        num = float(raw)
    except Exception:
        return None
    if not math.isfinite(num):
        return None
    return num


def _pick_latest_chapter_from_servers(item: dict[str, Any]) -> str:
    chapters = item.get("chapters") or []
    if not isinstance(chapters, list):
        return ""

    best_name = ""
    best_num: float | None = None
    fallback_name = ""

    for server in chapters:
        if not isinstance(server, dict):
            continue
        for chapter in server.get("server_data") or []:
            if not isinstance(chapter, dict):
                continue
            chapter_name = str(chapter.get("chapter_name") or "").strip()
            if not chapter_name:
                continue
            if not fallback_name:
                fallback_name = chapter_name

            chapter_num = _parse_chapter_number(chapter_name)
            if chapter_num is None:
                continue
            if best_num is None or chapter_num > best_num:
                best_num = chapter_num
                best_name = chapter_name

    return best_name or fallback_name


def _extract_otruyen_detail_meta(slug: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    item = (payload.get("data") or {}).get("item")
    if not isinstance(item, dict):
        return {}

    genres, tags = _extract_item_categories(item)
    latest_chapter = _pick_item_latest_chapter(item)
    if not latest_chapter:
        latest_chapter = _pick_latest_chapter_from_servers(item)
    latest_chapter_updated_at = _pick_item_latest_chapter_updated_at(item)
    last_updated = _pick_item_last_updated(item)

    origin_names = item.get("origin_name") if isinstance(item.get("origin_name"), list) else [item.get("origin_name")]
    title = _pick_best_trending_title(slug, item.get("name"), *(origin_names or []))
    thumb = str(item.get("thumb_url") or "").strip() or _fallback_trending_thumb(slug)
    status = str(item.get("status") or "").strip()
    content_rating = str(item.get("content_rating") or item.get("contentRating") or "").strip().lower()
    is_mature = _is_mature_metadata(content_rating, genres, tags)

    return {
        "title": title,
        "thumb": thumb,
        "genres": genres,
        "tags": tags,
        "status": status,
        "latest_chapter": latest_chapter,
        "latest_chapter_updated_at": latest_chapter_updated_at,
        "last_updated": last_updated,
        "content_rating": content_rating,
        "is_mature": is_mature,
    }


def _is_invalid_manga_slug(value: Any) -> bool:
    slug = _clean_slug(value)
    if not slug or len(slug) < 3:
        return True
    if re.fullmatch(r"\d+", slug):
        return True
    if re.fullmatch(r"[0-9a-f]{20,}", slug):
        return True
    if re.fullmatch(r"chapter\d*", slug):
        return True
    return slug in {
        "about",
        "admin",
        "api",
        "bookmarks",
        "browse",
        "chapter",
        "chapters",
        "completed",
        "comics",
        "data",
        "history",
        "images",
        "img",
        "latest",
        "login",
        "manga",
        "none",
        "notifications",
        "null",
        "popular",
        "profile",
        "random",
        "ranking",
        "rankings",
        "read",
        "reader",
        "register",
        "search",
        "settings",
        "u",
        "undefined",
        "upload",
        "uploads",
        "v1",
    }


def _filter_trending_items(
    items: list[dict[str, Any]],
    hidden: dict[str, str] | None = None,
    source: str = "all",
) -> list[dict[str, Any]]:
    from fastapi_app.services.card_metadata import cached_metadata
    from fastapi_app.services.catalog_visibility import unmatched
    from fastapi_app.services.card_chapters import cached_chapter
    from fastapi_app.services.card_chapters import prefetch_cached
    _, values = prefetch_cached([_clean_slug(item.get("slug") or item.get("id"))
                                 for item in items or [] if isinstance(item, dict)])
    unavailable = unmatched([_clean_slug(item.get("slug") or item.get("id"))
                             for item in items or [] if isinstance(item, dict)], values)
    visible: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        slug = _clean_slug(item.get("slug") or item.get("id"))
        if slug in unavailable:
            continue
        if _is_invalid_manga_slug(slug):
            continue
        if not _trending_source_matches(slug, source):
            continue
        if hidden and _hidden_reason_for_slug(hidden, slug):
            continue
        if _safe_int(item.get("views") or item.get("view_count")) <= 0:
            continue
        canonical = cached_metadata(slug, values)
        if canonical and canonical.get("title"):
            if hidden and _hidden_reason_for_slug(hidden, canonical.get("slug")):
                continue
            item = {**item, "title": canonical["title"],
                    "thumb": canonical.get("cover_url") or item.get("thumb", ""),
                    "genres": canonical.get("genres") or item.get("genres", []),
                    "tags": canonical.get("tags") or item.get("tags", []),
                    "content_rating": canonical.get("content_rating") or item.get("content_rating", "")}
        chapter = cached_chapter(slug, values)
        if chapter:
            item = {**item, "latest_chapter": chapter["chapter_name"], "latest_chapter_id": chapter["id"],
                    "latest_chapter_updated_at": chapter.get("publish_at", "")}
        title = str(item.get("title") or item.get("name") or "").strip()
        thumb = str(item.get("thumb") or item.get("thumb_url") or item.get("cover_url") or "").strip()
        if not title and not thumb:
            continue
        visible.append(item)
    return visible


def _normalize_trending_source(value: Any) -> str:
    source = str(value or "all").strip().lower()
    return source if source in {"all", "truyenqq", "mangadex"} else "all"


def _trending_source_matches(slug: Any, source: str) -> bool:
    normalized_source = _normalize_trending_source(source)
    if normalized_source == "all":
        return True
    normalized_slug = _clean_slug(slug)
    is_mangadex = bool(_extract_mangadex_id(normalized_slug))
    return is_mangadex if normalized_source == "mangadex" else not is_mangadex


def _normalize_title_key(value: Any) -> str:
    title = str(value or "").strip()
    if not title:
        return ""
    title = re.sub(r"\[[^\]]*(chap|chương)[^\]]*\]", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip().lower()
    return title


def _fetch_rating_aggregates(db: Any, slugs: list[str], alias_groups=None) -> dict[str, tuple[float, int]]:
    if not slugs:
        return {}

    now = time.time()
    result: dict[str, tuple[float, int]] = {}
    missing: list[str] = []

    for slug in slugs:
        cached = _rating_cache.get(slug)
        if cached and cached[2] > now:
            result[slug] = (cached[0], cached[1])
        else:
            missing.append(slug)

    if missing:
        from fastapi_app.services.qq_statistics import cached_aliases
        from fastapi_app.routers.ratings import _aggregate_rows_by_user
        groups = cached_aliases(missing) if alias_groups is None else alias_groups
        query_slugs = list(dict.fromkeys(alias for slug in missing for alias in groups.get(slug, [slug])))
        # Evict oldest entries if cache is too large
        if len(_rating_cache) > _MAX_RATING_CACHE:
            now_t = time.time()
            # Remove all expired entries first
            expired = [k for k, v in _rating_cache.items() if v[2] <= now_t]
            for k in expired:
                _rating_cache.pop(k, None)
            # If still too large, remove oldest (lowest TTL)
            if len(_rating_cache) > _MAX_RATING_CACHE:
                oldest = sorted(_rating_cache.items(), key=lambda x: x[1][2])
                for k, _ in oldest[: len(_rating_cache) - _MAX_RATING_CACHE]:
                    _rating_cache.pop(k, None)
        try:
            rows = (
                db.table("ratings")
                .select("user_id,manga_slug,score,updated_at")
                .in_("manga_slug", query_slugs)
                .execute()
                .data
                or []
            )
        except Exception:
            rows = []

        bucket: dict[str, list] = {}
        for row in rows:
            slug = str(row.get("manga_slug") or "").strip()
            if not slug:
                continue
            bucket.setdefault(slug, []).append(row)

        for slug in missing:
            combined = [row for alias in groups.get(slug, [slug]) for row in bucket.get(alias, [])]
            avg, count = _aggregate_rows_by_user(combined)
            result[slug] = (avg, count)
            _rating_cache[slug] = (avg, count, now + RATING_CACHE_TTL_SECONDS)
    return result


async def _async_fetch_rating_aggregates(db: Any, slugs: list[str]) -> dict[str, tuple[float, int]]:
    """Async wrapper — runs the sync DB call in a thread pool to avoid blocking the event loop."""
    return await asyncio.to_thread(_fetch_rating_aggregates, db, slugs)


def _attach_ratings_to_items(payload: Any, db: Any, user: dict | None = None) -> None:
    if not isinstance(payload, dict):
        return

    items = payload.get("data", {}).get("items")
    if not isinstance(items, list) or not items:
        return

    item_lookup_keys: dict[str, list[str]] = {}
    from fastapi_app.services.qq_statistics import cached_aliases
    qq_aliases = cached_aliases([str(item.get("slug") or "") for item in items])
    slugs: list[str] = []
    for item in items:
        slug = str((item or {}).get("slug") or "").strip()
        if not slug:
            continue
        lookup_keys = qq_aliases.get(slug, [slug])[:]
        manga_id = _extract_mangadex_id(slug)
        if manga_id:
            lookup_keys.extend([manga_id, f"mdx-{manga_id}"])
        lookup_keys = list(dict.fromkeys(key for key in lookup_keys if key))
        item_lookup_keys[slug] = lookup_keys
        slugs.extend(lookup_keys)
    slugs = list(dict.fromkeys(slugs))
    if not slugs:
        return

    agg = _fetch_rating_aggregates(db, slugs, qq_aliases)

    my_scores: dict[str, tuple[int, str]] = {}
    if user and user.get("id"):
        try:
            my_rows = (
                db.table("ratings")
                .select("manga_slug,score,updated_at")
                .eq("user_id", user.get("id"))
                .in_("manga_slug", slugs)
                .execute()
                .data
                or []
            )
            my_scores = {
                str(r.get("manga_slug") or "").strip(): (_safe_int(r.get("score")), str(r.get("updated_at") or ""))
                for r in my_rows
                if str(r.get("manga_slug") or "").strip()
            }
        except Exception:
            my_scores = {}

    for item in items:
        slug = str((item or {}).get("slug") or "").strip()
        lookup_keys = item_lookup_keys.get(slug) or [slug]
        avg, count = 0.0, 0
        for lookup_key in lookup_keys:
            avg, count = agg.get(lookup_key, (0.0, 0))
            if count > 0:
                break
        if count <= 0:
            item["rating_average"] = 0
            item["rating_count"] = 0
            if user:
                item["my_rating"] = None
            continue

        item["rating_average"] = avg
        item["rating_count"] = count
        if user:
            latest = max((my_scores[key] for key in lookup_keys if key in my_scores),
                         key=lambda score: score[1], default=None)
            item["my_rating"] = latest[0] if latest else None


async def _async_attach_ratings_to_items(payload: Any, db: Any, user: dict | None = None) -> None:
    """Keep optional rating reads from delaying source catalog data."""
    items = _otruyen_payload_items(payload)
    slugs = sorted({str(item.get("slug") or "") for item in items if item.get("slug")})
    if not slugs:
        return
    def load():
        rows = {"data": {"items": [{"slug": slug} for slug in slugs]}}
        _attach_ratings_to_items(rows, db, user)
        return {row["slug"]: row for row in rows["data"]["items"]}
    enriched = await cached_public_read(("catalog-ratings", id(db), tuple(slugs), (user or {}).get("id")),
                                        load, {}, ttl=5)
    for item in items:
        row = enriched.get(item.get("slug"), {})
        item["rating_average"] = row.get("rating_average", 0)
        item["rating_count"] = row.get("rating_count", 0)
        if user:
            item["my_rating"] = row.get("my_rating")


def _attach_ratings_to_mangadex_payload(payload: Any, db: Any, user: dict | None = None) -> None:
    if not isinstance(payload, dict):
        return

    mangas = payload.get("mangas")
    if not isinstance(mangas, list) or not mangas:
        return

    ids: list[str] = []
    for manga in mangas:
        manga_id = str((manga or {}).get("id") or "").strip().lower()
        if manga_id:
            ids.append(manga_id)
    ids = list(dict.fromkeys(ids))
    if not ids:
        return

    lookup_slugs: list[str] = []
    for manga_id in ids:
        lookup_slugs.append(manga_id)
        if _extract_mangadex_id(manga_id):
            lookup_slugs.append(f"mdx-{manga_id}")
    lookup_slugs = list(dict.fromkeys(lookup_slugs))

    agg = _fetch_rating_aggregates(db, lookup_slugs)

    my_scores: dict[str, int] = {}
    if user and user.get("id"):
        try:
            my_rows = (
                db.table("ratings")
                .select("manga_slug,score")
                .eq("user_id", user.get("id"))
                .in_("manga_slug", lookup_slugs)
                .execute()
                .data
                or []
            )
            my_scores = {
                str(r.get("manga_slug") or "").strip().lower(): _safe_int(r.get("score"))
                for r in my_rows
                if str(r.get("manga_slug") or "").strip()
            }
        except Exception:
            my_scores = {}

    for manga in mangas:
        manga_id = str((manga or {}).get("id") or "").strip().lower()
        if not manga_id:
            continue
        alias = f"mdx-{manga_id}"
        avg, count = agg.get(manga_id, (0.0, 0))
        if count <= 0:
            avg, count = agg.get(alias, (0.0, 0))
        manga["rating_average"] = avg if count > 0 else 0
        manga["rating_count"] = count if count > 0 else 0
        if user:
            manga["my_rating"] = my_scores.get(manga_id) or my_scores.get(alias)


async def _async_attach_ratings_to_mangadex_payload(payload: Any, db: Any, user: dict | None = None) -> None:
    """Async wrapper — runs MangaDex rating attachment in a thread pool."""
    await asyncio.to_thread(_attach_ratings_to_mangadex_payload, payload, db, user)


def _source_revision(source: str) -> str:
    value = cache.get(f"catalog:source-version:{source}")
    return value if isinstance(value, str) else ""


def _combined_cache_key(list_type: str, page: int, max_chapters: int, *, revision: str | None = None) -> str:
    if revision is None:
        revision = _source_revision("truyenqq")
    return f"manga:list-combined:truyenqq-v1:{list_type}:{page}:{max_chapters}:rev={revision}"


def _cache_combined_payload(cache_key: str, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload, ensure_ascii=False)
    cache.set(cache_key, raw, ttl=COMBINED_LIST_TTL_SECONDS)
    cache.set(f"{cache_key}:stale", raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)


def _fallback_empty_list_payload(page: int) -> dict[str, Any]:
    return {
        "data": {
            "items": [],
            "params": {"pagination": {"currentPage": page, "totalItemsPerPage": 24, "totalItems": 0}},
        }
    }


def _fallback_empty_mangadex_payload() -> dict[str, Any]:
    return {"meta": {"language": "vi", "fetched_chapters": 0, "total_manga": 0}, "mangas": []}


def _load_json_cache(cache_key: str) -> dict[str, Any] | None:
    raw = cache.get(cache_key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        cache.delete(cache_key)
        return None


def _has_positive_trending_views(items: list[dict[str, Any]]) -> bool:
    for item in items:
        try:
            if int((item or {}).get("views") or 0) > 0:
                return True
        except Exception:
            continue
    return False


def _load_recent_trending_fallback(
    limit: int,
    hidden: dict[str, str] | None = None,
    source: str = "all",
) -> list[dict[str, Any]]:
    normalized_source = _normalize_trending_source(source)
    candidate_lists: list[list[dict[str, Any]]] = []

    memory_candidates = sorted(
        _trending_memory_cache.values(),
        key=lambda entry: float(entry[1]),
        reverse=True,
    )
    for items, _cached_at in memory_candidates:
        if isinstance(items, list) and items:
            candidate_lists.append(items)

    for candidate_limit in (300, 240, 160, 120, 80, 50, 40, 32, 24, 20, 16, 12, 8):
        suffix = f"{candidate_limit}" if normalized_source == "all" else f"{normalized_source}:{candidate_limit}"
        candidate_key = f"manga:trending:{TRENDING_CACHE_VERSION}:{suffix}"
        payload = _load_json_cache(candidate_key) or _load_json_cache(f"{candidate_key}:stale")
        if not isinstance(payload, dict):
            continue
        items = payload.get("trending") or []
        if isinstance(items, list) and items:
            candidate_lists.append(items)

    for items in candidate_lists:
        visible = _filter_trending_items(items, hidden, normalized_source)
        if visible and _has_positive_trending_views(visible):
            return visible[:limit]

    for items in candidate_lists:
        visible = _filter_trending_items(items, hidden, normalized_source)
        if visible:
            return visible[:limit]

    return []


def _load_mangadex_catalog_cache(max_chapters: int | None) -> dict[str, Any] | None:
    mdx_cache_key = f"mangadex:vi-catalog:{'all' if max_chapters is None else max_chapters}"
    return _load_json_cache(mdx_cache_key) or _load_json_cache(f"{mdx_cache_key}:stale")


def _payload_manga_count(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0
    mangas = payload.get("mangas")
    if not isinstance(mangas, list):
        return 0
    return len(mangas)


def _payload_has_mangadex_latest_signal(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    mangas = payload.get("mangas")
    if not isinstance(mangas, list):
        return False
    for manga in mangas:
        if not isinstance(manga, dict):
            continue
        if str(manga.get("local_last_published_at") or "").strip():
            return True
        chapters = manga.get("chapters")
        if not isinstance(chapters, list):
            continue
        for chapter in chapters:
            if not isinstance(chapter, dict):
                continue
            for key in ("publish_at", "readable_at", "created_at", "updated_at"):
                if str(chapter.get(key) or "").strip():
                    return True
    return False


def _payload_missing_mangadex_popularity_count(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0
    mangas = payload.get("mangas")
    if not isinstance(mangas, list):
        return 0
    missing = 0
    for manga in mangas:
        try:
            score = int((manga or {}).get("mangadex_popularity_score") or 0)
        except Exception:
            score = 0
        if score <= 0:
            missing += 1
    return missing


def _min_expected_manga_count(max_chapters: int | None) -> int:
    if max_chapters is None:
        return 520
    if max_chapters >= 3000:
        return 320
    if max_chapters >= 2000:
        return 260
    if max_chapters >= 1200:
        return 180
    if max_chapters >= 800:
        return 120
    return 60


def _ready_mangadex_catalog_count(max_chapters: int | None, min_count: int) -> int:
    if max_chapters is None or max_chapters >= 2000:
        return max(min_count, 700)
    return min_count


def _load_best_mangadex_catalog_cache(max_chapters: int | None, min_count: int) -> dict[str, Any] | None:
    candidates: list[int | None] = [max_chapters]
    candidates.extend([None, 5000, 3000, 2000, 1800, 1200, 1000, 800, 500, 300, 240, 160, 120])

    seen: set[str] = set()
    best_payload: dict[str, Any] | None = None
    best_count = 0
    for limit in candidates:
        cache_key = "all" if limit is None else str(limit)
        if cache_key in seen:
            continue
        seen.add(cache_key)
        payload = _load_mangadex_catalog_cache(limit)
        count = _payload_manga_count(payload)
        if count <= 0:
            continue
        if count > best_count:
            best_payload = payload
            best_count = count
        if count >= min_count:
            return payload

    return best_payload


def _mark_mangadex_catalog_refreshing(
    payload: dict[str, Any],
    *,
    requested_limit: str,
    served_from: str,
) -> dict[str, Any]:
    result = dict(payload)
    meta = result.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    result["meta"] = {
        **meta,
        "background_refreshing": True,
        "requested_max_chapters": requested_limit,
        "served_from": served_from,
    }
    return result


async def _prepare_mangadex_catalog_response(
    payload: dict[str, Any],
    *,
    db: Any,
    user: dict | None,
    attach_overrides: bool,
    attach_ratings: bool,
    filter_hidden: bool,
) -> dict[str, Any]:
    if filter_hidden:
        hidden = await _get_hidden_slugs(db)
        if hidden and isinstance(payload, dict):
            payload = _filter_hidden_mangadex_payload(payload, hidden)
    else:
        hidden = {}
    if attach_overrides:
        await _attach_overrides_to_mangadex_payload(payload, db)
    if attach_ratings:
        await _async_attach_ratings_to_mangadex_payload(payload, db, user)
    await _async_attach_local_views_to_mangadex_payload(payload, db)
    await _async_inject_local_viewed_mangadex_rows(payload, db, hidden=hidden)
    return payload


async def _build_combined_payload(list_type: str, page: int, max_chapters: int) -> dict[str, Any]:
    otruyen_task = truyenqq_service.get_list(list_type, page)
    mangadex_task = asyncio.wait_for(
        mangadex_service.get_vi_catalog(max_chapters=max_chapters),
        timeout=COMBINED_LIST_MDX_TIMEOUT_SECONDS,
    )
    otruyen_result, mangadex_result = await asyncio.gather(
        otruyen_task,
        mangadex_task,
        return_exceptions=True,
    )

    base_data = otruyen_result if isinstance(otruyen_result, dict) else _fallback_empty_list_payload(page)
    if isinstance(mangadex_result, dict):
        mangadex_payload = mangadex_result
    else:
        mangadex_payload = _load_mangadex_catalog_cache(max_chapters) or _fallback_empty_mangadex_payload()

    return {"list": base_data, "mangadex": mangadex_payload}


async def _warmup_mangadex_catalog() -> None:
    """Background task: warm vi_catalog cache + preload cover images into disk cache."""
    import hashlib
    from pathlib import Path
    logger = logging.getLogger(__name__)
    try:
        await asyncio.sleep(2)  # Let server finish startup first
        # The native lifecycle already runs this warmup once. Decode the
        # indexed browser catalog here instead of on the first reader's visit.
        if not config.IS_VERCEL:
            from fastapi_app.services import mangadex_release_index
            try:
                started = time.monotonic()
                prepared = await asyncio.to_thread(mangadex_release_index.warm_index)
                logger.info('MangaDex index startup warmup prepared=%s seconds=%.3f', prepared, time.monotonic() - started)
            except Exception:
                logger.debug('MangaDex index warmup deferred; normal reads remain available')
        if not MANGADEX_STARTUP_WARMUP_ENABLED:
            return
        catalog = await mangadex_service.get_vi_catalog(max_chapters=120)
        mangas: list[dict] = catalog.get("mangas", []) if isinstance(catalog, dict) else []
        if not mangas:
            return

        # Collect cover URLs (direct CDN) from catalog
        cover_urls: list[str] = []
        for item in mangas:
            url = str(item.get("cover_url") or "").strip()
            if url.startswith("https://uploads.mangadex.org"):
                cover_urls.append(url)

        if not cover_urls:
            return

        # Keep startup warmup small; browsing will cache the rest on demand.
        CACHE_DIR = writable_path(".image_cache")
        CACHE_DIR.mkdir(exist_ok=True)
        TARGET = min(24, len(cover_urls))

        import httpx as _httpx

        _client = _httpx.AsyncClient(
            timeout=_httpx.Timeout(15.0, connect=8.0),
            follow_redirects=True,
            http2=False,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept": "image/*,*/*;q=0.8",
                "Referer": "https://mangadex.org/",
                "Origin": "https://mangadex.org",
            },
        )

        sem = asyncio.Semaphore(4)
        try:
            max_cover_mb = int(float(os.getenv("MANGADEX_COVER_WARMUP_MAX_MB", "8")))
        except Exception:
            max_cover_mb = 8
        max_cover_bytes = max(1, min(32, max_cover_mb)) * 1024 * 1024
        cover_cache_version = (
            str(os.getenv("MANGADEX_IMAGE_CACHE_VERSION", "2") or "2").strip() or "2"
        )

        async def _cache_one(url: str) -> None:
            h = hashlib.md5(
                f"mangadex-cover-v{cover_cache_version}:{url}".encode()
            ).hexdigest()
            import os
            ext = os.path.splitext(url.split("?")[0])[1] or ".jpg"
            path = CACHE_DIR / f"{h}{ext}"
            if path.exists():
                return  # Already cached
            async with sem:
                try:
                    async with _client.stream("GET", url) as resp:
                        if resp.status_code >= 400:
                            return
                        try:
                            content_length = int(resp.headers.get("content-length") or 0)
                        except Exception:
                            content_length = 0
                        if content_length > max_cover_bytes:
                            return

                        chunks: list[bytes] = []
                        total = 0
                        async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                            if not chunk:
                                continue
                            total += len(chunk)
                            if total > max_cover_bytes:
                                return
                            chunks.append(chunk)

                    data = b"".join(chunks)
                    if data and detect_image_content_type(data):
                        path.write_bytes(data)
                except Exception:
                    pass

        jobs = [_cache_one(u) for u in cover_urls[:TARGET]]
        await asyncio.gather(*jobs, return_exceptions=True)
        await _client.aclose()
        logger.info(f"✅ MangaDex cover warmup done — {TARGET} covers preloaded")
    except Exception as e:
        logging.getLogger(__name__).warning(f"MangaDex warmup failed: {e}")


def schedule_startup_warmup() -> None:
    """Schedule background warmup of MangaDex catalog (idempotent)."""
    global _startup_warmup_task
    if config.IS_VERCEL and not MANGADEX_STARTUP_WARMUP_ENABLED:
        return
    if _startup_warmup_task and not _startup_warmup_task.done():
        return
    _startup_warmup_task = create_task(_warmup_mangadex_catalog())


def _schedule_combined_refresh(cache_key: str, list_type: str, page: int, max_chapters: int) -> None:
    existing = _combined_refresh_tasks.get(cache_key)
    if existing and not existing.done():
        return

    async def _refresh() -> None:
        payload = await _build_combined_payload(list_type=list_type, page=page, max_chapters=max_chapters)
        _cache_combined_payload(cache_key, payload)

    task = create_task(_refresh())
    _combined_refresh_tasks[cache_key] = task

    def _cleanup(done_task: asyncio.Task) -> None:
        current = _combined_refresh_tasks.get(cache_key)
        if current is done_task:
            _combined_refresh_tasks.pop(cache_key, None)

    task.add_done_callback(_cleanup)


@router.get("/home")
async def home(
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Trang chủ — danh sách truyện mới nhất."""
    data, hidden = await asyncio.gather(
        truyenqq_service.get_home(),
        _get_hidden_slugs(db),
    )
    if hidden and isinstance(data, dict):
        items = (data.get("data") or {}).get("items") or []
        if isinstance(items, list):
            data["data"]["items"] = _filter_hidden(items, hidden)
    await _attach_overrides_to_otruyen_payload(data, db)
    await _async_attach_ratings_to_items(data, db, user)
    return data


@router.get("/homepage")
async def homepage(
    include_featured: bool = Query(False),
    attach_ratings: bool = Query(True),
    lightweight: bool = False,
    include_ongoing: bool = True,
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Combined homepage data — returns both latest + ongoing in one request."""
    import asyncio

    # Only the actual Home screen needs featured titles. Starting it here
    # keeps that screen to one request without making other consumers of this
    # endpoint (such as search suggestions) more expensive.
    featured_task = (
        create_task(featured_manga(limit=12, user=user, db=db))
        if include_featured
        else None
    )
    latest, ongoing, hidden = await asyncio.gather(
        truyenqq_service.get_list("truyen-moi", 1),
        truyenqq_service.get_list("dang-phat-hanh", 1) if include_ongoing else asyncio.sleep(0, result=_fallback_empty_list_payload(1)),
        _get_hidden_slugs(db),
        return_exceptions=True,
    )
    if not include_ongoing and not isinstance(latest, dict):
        # The lightweight home request has only one QQ section. Do not turn
        # its source failure into HTTP 200: the browser needs the bounded QQ
        # error/path headers to warm the same source page through our relay.
        if isinstance(latest, HTTPException):
            raise latest
        raise HTTPException(503, 'QQ latest feed unavailable')
    source_errors = []
    for name, value in (("latest", latest), ("ongoing", ongoing)):
        if not isinstance(value, dict):
            source_errors.append(name)
    if not isinstance(latest, dict):
        latest = _fallback_empty_list_payload(1)
    if not isinstance(ongoing, dict):
        ongoing = _fallback_empty_list_payload(1)
    if not isinstance(hidden, dict):
        hidden = {}
    for src in (latest, ongoing):
        if hidden and isinstance(src, dict):
            items = (src.get("data") or {}).get("items") or []
            if isinstance(items, list):
                src["data"]["items"] = _filter_hidden(items, hidden)
    # Both sections contain independent items, so enrich their combined item
    # list once. The objects are shared with their source payloads, which
    # avoids duplicate override and rating database lookups without changing
    # either response section.
    home_items = [
        item
        for source in (latest, ongoing)
        for item in (((source.get("data") or {}).get("items") or []) if isinstance(source, dict) else [])
        if isinstance(item, dict)
    ]
    home_items_payload = {"data": {"items": home_items}}
    reads = [_attach_overrides_to_otruyen_payload(home_items_payload, db, attach_views=not lightweight)]
    if attach_ratings:
        reads.append(_async_attach_ratings_to_items(home_items_payload, db, user))
    await asyncio.gather(*reads)
    result = {"latest": latest, "ongoing": ongoing, "meta": {"unavailable_sections": source_errors}}
    if not include_ongoing:
        result['meta']['omitted_sections'] = ['ongoing']
    if featured_task is not None:
        try:
            result["featured"] = await featured_task
        except Exception:
            result["featured"] = {
                "data": {
                    "items": [],
                    "params": {
                        "pagination": {
                            "currentPage": 1,
                            "totalItemsPerPage": 12,
                            "totalItems": 0,
                        }
                    },
                }
            }
    return result


def _canonical_featured_slug(value: Any) -> str:
    normalized = str(value or "").strip().strip("/").lower()
    if not normalized:
        return ""
    mangadex_id = _extract_mangadex_id(normalized)
    if mangadex_id:
        return mangadex_id
    return normalized


async def _build_featured_item_from_slug(
    slug: str,
    featured_at: str,
    admin_notes: str | None,
    db: Any,
) -> dict[str, Any] | None:
    normalized = _canonical_featured_slug(slug)
    if not normalized:
        return None

    mangadex_id = _extract_mangadex_id(normalized)
    if mangadex_id:
        try:
            data = await mangadex_service.get_manga_detail(manga_id=mangadex_id, max_chapters=1)
        except Exception:
            return None

        manga = (data or {}).get("manga") or {}
        if not isinstance(manga, dict):
            return None

        chapters = manga.get("chapters") or []
        latest_chapter: dict[str, Any] = {}
        latest_ts = ""
        if isinstance(chapters, list):
            for chapter in chapters:
                if not isinstance(chapter, dict):
                    continue
                candidate_ts = str(
                    chapter.get("publish_at")
                    or chapter.get("readable_at")
                    or chapter.get("created_at")
                    or chapter.get("updated_at")
                    or ""
                ).strip()
                if candidate_ts and (not latest_ts or candidate_ts > latest_ts):
                    latest_ts = candidate_ts
                    latest_chapter = chapter
            if not latest_chapter and chapters and isinstance(chapters[0], dict):
                latest_chapter = chapters[0]

        latest_chapter_name = str(
            latest_chapter.get("chapter")
            or latest_chapter.get("number")
            or ""
        ).strip()
        latest_chapter_id = str(latest_chapter.get("id") or "").strip()
        chapters_latest: list[dict[str, Any]] = []
        if latest_chapter_name or latest_chapter_id:
            chapters_latest.append(
                {
                    "chapter_name": latest_chapter_name,
                    "chapter_title": str(latest_chapter.get("chapter_with_groups") or latest_chapter.get("title") or "").strip(),
                    "chapter_api_data": latest_chapter_id,
                    "publish_at": latest_ts,
                    "updated_at": latest_ts,
                }
            )

        local_views = await asyncio.to_thread(_sum_manga_views, db, [mangadex_id, f"mdx-{mangadex_id}"])
        genres = manga.get("genres") or []
        categories = []
        if isinstance(genres, list):
            for genre in genres:
                name = str(genre or "").strip()
                if not name:
                    continue
                categories.append({"name": name, "slug": _clean_slug(name)})

        return {
            "slug": mangadex_id,
            "id": mangadex_id,
            "name": str(manga.get("title") or mangadex_id),
            "title": str(manga.get("title") or mangadex_id),
            "origin_name": [],
            "thumb_url": str(manga.get("cover_url") or "").strip(),
            "cover_url": str(manga.get("cover_url") or "").strip(),
            "author": str(manga.get("authors_text") or "MangaDex"),
            "category": categories,
            "status": str(manga.get("status") or "ongoing"),
            "content": str(manga.get("description") or ""),
            "source": "mangadex",
            "chaptersLatest": chapters_latest,
            "last_chapter": latest_chapter_name,
            "updatedAt": str(manga.get("updated_at") or "").strip(),
            "local_view_count": local_views,
            "view_count": local_views,
            "views": local_views,
            "content_rating": str(manga.get("content_rating") or manga.get("contentRating") or "").strip().lower(),
            "is_featured": True,
            "featured_at": featured_at,
            "admin_notes": admin_notes,
        }

    try:
        detail = await truyenqq_service.get_manga_detail(normalized)
    except Exception:
        return None

    item = (detail.get("data") or {}).get("item") if isinstance(detail, dict) else None
    if not isinstance(item, dict):
        return None

    meta = _extract_otruyen_detail_meta(normalized, detail)
    latest_chapter = str(meta.get("latest_chapter") or "").strip()
    latest_chapter_updated_at = str(meta.get("latest_chapter_updated_at") or "").strip()

    chapters_latest: list[dict[str, Any]] = []
    if latest_chapter:
        chapter_entry = {
            "chapter_name": latest_chapter,
            "chapter_title": "",
            "chapter_api_data": "",
        }
        if latest_chapter_updated_at:
            chapter_entry["updated_at"] = latest_chapter_updated_at
            chapter_entry["publish_at"] = latest_chapter_updated_at
        chapters_latest.append(chapter_entry)

    local_views = await asyncio.to_thread(_sum_manga_views, db, [normalized])
    base_views = _safe_int(item.get("view_count") or item.get("views") or 0)
    category_value = item.get("category")
    if not isinstance(category_value, list):
        category_value = [
            {"name": genre, "slug": _clean_slug(genre)}
            for genre in (meta.get("genres") or [])
            if str(genre or "").strip()
        ]

    return {
        **item,
        "slug": str(item.get("slug") or normalized).strip() or normalized,
        "name": str(item.get("name") or meta.get("title") or normalized),
        "title": str(item.get("name") or meta.get("title") or normalized),
        "thumb_url": str(item.get("thumb_url") or meta.get("thumb") or "").strip(),
        "cover_url": str(item.get("thumb_url") or meta.get("thumb") or "").strip(),
        "category": category_value,
        "source": str(item.get("source") or "truyenqq"),
        "chaptersLatest": chapters_latest,
        "last_chapter": latest_chapter or str(item.get("last_chapter") or item.get("chapter_newest") or "").strip(),
        "updatedAt": str(meta.get("last_updated") or item.get("updatedAt") or item.get("updated_at") or "").strip(),
        "view_count": local_views,
        "views": local_views,
        "local_view_count": local_views,
        "content_rating": str(item.get("content_rating") or item.get("contentRating") or meta.get("content_rating") or "").strip().lower(),
        "is_featured": True,
        "featured_at": featured_at,
        "admin_notes": admin_notes,
    }


@router.get("/featured")
async def featured_manga(
    limit: int = Query(12, ge=1, le=30),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    hidden = await _get_hidden_slugs(db)
    try:
        featured_res = await asyncio.to_thread(
            lambda: db.table("manga_overrides")
            .select("manga_slug,featured_at,admin_notes")
            .eq("is_featured", True)
            .order("featured_at", desc=True)
            .limit(max(limit * 3, limit))
            .execute()
        )
    except Exception:
        empty_payload = {
            "data": {
                "items": [],
                "params": {
                    "pagination": {
                        "currentPage": 1,
                        "totalItemsPerPage": limit,
                        "totalItems": 0,
                    }
                },
            }
        }
        return empty_payload

    raw_rows = featured_res.data or []
    ordered_rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in raw_rows:
        raw_slug = str((row or {}).get("manga_slug") or "").strip()
        canonical_slug = _canonical_featured_slug(raw_slug)
        if not canonical_slug:
            continue
        if canonical_slug in seen:
            continue
        if _hidden_reason_for_slug(hidden, canonical_slug):
            continue
        seen.add(canonical_slug)
        ordered_rows.append(
            {
                "slug": canonical_slug,
                "featured_at": str((row or {}).get("featured_at") or "").strip(),
                "admin_notes": (row or {}).get("admin_notes"),
            }
        )
        if len(ordered_rows) >= limit:
            break

    semaphore = asyncio.Semaphore(4)

    async def _resolve_featured(row: dict[str, Any]) -> dict[str, Any] | None:
        async with semaphore:
            return await _build_featured_item_from_slug(
                slug=str(row.get("slug") or "").strip(),
                featured_at=str(row.get("featured_at") or "").strip(),
                admin_notes=(row.get("admin_notes") if isinstance(row, dict) else None),
                db=db,
            )

    resolved_rows = await asyncio.gather(
        *[_resolve_featured(row) for row in ordered_rows],
        return_exceptions=False,
    )
    items = [item for item in resolved_rows if isinstance(item, dict)]
    items.sort(key=lambda x: str(x.get("featured_at") or ""), reverse=True)

    payload = {
        "data": {
            "items": items,
            "params": {
                "pagination": {
                    "currentPage": 1,
                    "totalItemsPerPage": max(len(items), limit),
                    "totalItems": len(items),
                }
            },
        }
    }
    await _async_attach_ratings_to_items(payload, db, user)
    return payload


@router.get("/list/{list_type}")
async def manga_list(
    list_type: str = "truyen-moi",
    page: int = Query(1, ge=1),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """
    Danh sách truyện theo loại.
    - truyen-moi: Truyện mới
    - sap-ra-mat: Sắp ra mắt
    - dang-phat-hanh: Đang phát hành
    - hoan-thanh: Hoàn thành
    """
    # Fetch list data and hidden slugs in parallel
    data, hidden = await asyncio.gather(
        truyenqq_service.get_list(list_type, page),
        _get_hidden_slugs(db),
    )
    if hidden and isinstance(data, dict):
        items = (data.get("data") or {}).get("items") or []
        if isinstance(items, list):
            data["data"]["items"] = _filter_hidden(items, hidden)
    await _async_attach_local_views_to_otruyen_payload(data, db)
    # Run rating attachment in thread pool to avoid blocking the event loop
    await _async_attach_ratings_to_items(data, db, user)
    return data


def _parse_page_batch(raw_pages: str, *, max_pages: int = 40) -> list[int]:
    seen: set[int] = set()
    pages: list[int] = []
    for raw in str(raw_pages or "").split(","):
        try:
            page = int(str(raw).strip())
        except Exception:
            continue
        if page < 1 or page in seen:
            continue
        seen.add(page)
        pages.append(page)
        if len(pages) >= max_pages:
            break
    return pages


async def _build_otruyen_page_batch(
    pages: list[int],
    fetch_page,
    *,
    hidden: dict[str, str],
    db: Any,
    user: Any,
    attach_ratings: bool,
) -> dict[str, Any]:
    semaphore = asyncio.Semaphore(10)
    views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)

    async def load_one(page_number: int) -> tuple[int, dict[str, Any] | None, str | None]:
        async with semaphore:
            try:
                payload = await fetch_page(page_number)
                if hidden and isinstance(payload, dict):
                    items = (payload.get("data") or {}).get("items") or []
                    if isinstance(items, list):
                        payload["data"]["items"] = _filter_hidden(items, hidden)
                items = (payload.get("data") or {}).get("items") or []
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict):
                            _otruyen_apply_local_views(item, views_lookup)
                if attach_ratings:
                    await _async_attach_ratings_to_items(payload, db, user)
                return page_number, payload, None
            except Exception as exc:
                return page_number, None, str(exc)

    results = await asyncio.gather(*(load_one(page) for page in pages))
    payloads: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for page_number, payload, error in sorted(results, key=lambda row: row[0]):
        key = str(page_number)
        if payload is not None:
            payloads[key] = payload
        if error:
            errors[key] = error
    return {"pages": payloads, "errors": errors}


OTRUYEN_FILTERED_CACHE_TTL_SECONDS = 180
OTRUYEN_FILTERED_FETCH_CHUNK = 12
OTRUYEN_FILTERED_MAX_SCAN_PAGES = 500
OTRUYEN_FILTERED_EXACT_SCAN_PAGE_CAP = 12
OTRUYEN_FILTERED_POPULAR_SCAN_PAGE_CAP = _env_int(
    "OTRUYEN_FILTERED_POPULAR_SCAN_PAGE_CAP",
    96,
    minimum=12,
)
OTRUYEN_FILTERED_POPULAR_SNAPSHOT_TTL_SECONDS = _env_int(
    "OTRUYEN_FILTERED_POPULAR_SNAPSHOT_TTL_SECONDS",
    OTRUYEN_FILTERED_CACHE_TTL_SECONDS,
    minimum=30,
)
OTRUYEN_FILTERED_EXACT_RESULT_PAGE_CAP = _env_int(
    "OTRUYEN_FILTERED_EXACT_RESULT_PAGE_CAP",
    12,
    minimum=1,
)


def _otruyen_filtered_cache_key(
    *,
    page: int,
    limit: int,
    base_slug: str,
    genre_values: list[str],
    status_value: str,
    sort: str,
    show_mature: bool,
) -> str:
    genre_key = ",".join(sorted(_clean_slug(value) for value in genre_values if _clean_slug(value)))
    return (
        "manga:truyenqq-filtered:v1:"
        f"p{page}:l{limit}:base={_clean_slug(base_slug)}:"
        f"g={genre_key}:s={_clean_slug(status_value)}:sort={_clean_slug(sort)}:"
        f"mature={1 if show_mature else 0}:rev={_source_revision('truyenqq')}"
    )


def _otruyen_filtered_popular_snapshot_cache_key(
    *,
    base_slug: str,
    genre_values: list[str],
    status_value: str,
    show_mature: bool,
) -> str:
    """Key for the shared ranked candidate window used by popular pages."""
    genre_key = ",".join(sorted(_clean_slug(value) for value in genre_values if _clean_slug(value)))
    return (
        "manga:truyenqq-filtered:popular-snapshot:v1:"
        f"base={_clean_slug(base_slug)}:g={genre_key}:s={_clean_slug(status_value)}:"
        f"mature={1 if show_mature else 0}:rev={_source_revision('truyenqq')}"
    )


def _load_otruyen_filtered_popular_snapshot(cache_key: str) -> dict[str, Any] | None:
    snapshot = _load_json_cache(cache_key)
    if not isinstance(snapshot, dict):
        return None

    items = snapshot.get("items")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        return None

    scanned_pages = _safe_int(snapshot.get("scanned_pages"))
    total_source_pages = _safe_int(snapshot.get("total_source_pages"))
    scan_page_limit = _safe_int(snapshot.get("scan_page_limit"))
    if scanned_pages < 1 or total_source_pages < 1 or scan_page_limit < 1:
        return None

    return snapshot


def _cache_otruyen_filtered_popular_snapshot(cache_key: str, snapshot: dict[str, Any]) -> None:
    """Cache one ranked OTruyen candidate window for every page of a filter."""
    items = snapshot.get("items")
    if not isinstance(items, list) or not items:
        # An upstream hiccup must not turn into a shared empty popular catalog.
        return
    cache.set(
        cache_key,
        json.dumps(snapshot, ensure_ascii=False),
        ttl=OTRUYEN_FILTERED_POPULAR_SNAPSHOT_TTL_SECONDS,
    )


def _cache_otruyen_filtered_payload(cache_key: str, payload: dict[str, Any]) -> None:
    items = (((payload.get("data") or {}).get("items") or []))
    pagination = (((payload.get("data") or {}).get("params") or {}).get("pagination") or {})
    total_items = _safe_int(pagination.get("totalItems"))
    if isinstance(items, list) and not items and total_items > 0:
        return
    raw = json.dumps(payload, ensure_ascii=False)
    cache.set(cache_key, raw, ttl=OTRUYEN_FILTERED_CACHE_TTL_SECONDS)
    cache.set(f"{cache_key}:stale", raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)


def _slugify_loose(value: Any) -> str:
    normalized = _normalize_loose_text(value)
    if not normalized:
        return _clean_slug(value)
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")


def _normalize_otruyen_status(value: Any) -> str:
    normalized = _normalize_loose_text(value).replace("-", " ")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    compact = normalized.replace(" ", "")
    if not normalized:
        return ""
    if (
        "completed" in normalized
        or "complete" in normalized
        or "hoan thanh" in normalized
        or compact == "hoanthanh"
    ):
        return "completed"
    if "cancel" in normalized or "huy" in normalized:
        return "cancelled"
    if (
        "hiatus" in normalized
        or "coming soon" in normalized
        or "sap ra mat" in normalized
        or compact == "sapramat"
        or "tam" in normalized
        or "ngung" in normalized
        or "on hold" in normalized
        or "paused" in normalized
    ):
        return "hiatus"
    if (
        "ongoing" in normalized
        or "publishing" in normalized
        or "dang ra" in normalized
        or "dang phat hanh" in normalized
        or compact == "dangphathanh"
        or "tien hanh" in normalized
        or "cap nhat" in normalized
        or "phat hanh" in normalized
    ):
        return "ongoing"
    return normalized


def _otruyen_list_type_for_status(status_value: str) -> str:
    normalized = _normalize_otruyen_status(status_value)
    if normalized == "completed":
        return "hoan-thanh"
    if normalized == "ongoing":
        return "dang-phat-hanh"
    if normalized == "hiatus":
        return "sap-ra-mat"
    return "truyen-moi"


def _otruyen_item_identity_key(item: dict[str, Any]) -> str:
    for key in ("slug", "_id", "id", "name"):
        value = str((item or {}).get(key) or "").strip().lower()
        if value:
            return value
    return ""


def _otruyen_item_genre_slugs(item: dict[str, Any]) -> set[str]:
    names, tags = _extract_item_categories(item)
    slugs: set[str] = set()
    for value in tags:
        cleaned = _clean_slug(value)
        if cleaned:
            slugs.add(cleaned)
    for value in names:
        cleaned = _slugify_loose(value)
        if cleaned:
            slugs.add(cleaned)
    return slugs


def _otruyen_item_matches_filters(
    item: dict[str, Any],
    *,
    required_genres: set[str],
    status_value: str,
    show_mature: bool,
    hidden: dict[str, str],
) -> bool:
    if not isinstance(item, dict):
        return False

    if _hidden_reason_for_slug(hidden, item.get("slug") or item.get("_id") or item.get("id")):
        return False

    names, tags = _extract_item_categories(item)
    if not show_mature and _is_mature_metadata(
        item.get("content_rating") or item.get("contentRating"),
        names,
        tags,
    ):
        return False

    normalized_status = _normalize_otruyen_status(item.get("status"))
    required_status = _normalize_otruyen_status(status_value)
    if required_status and normalized_status != required_status:
        return False

    if required_genres:
        item_genres = _otruyen_item_genre_slugs(item)
        if not required_genres.issubset(item_genres):
            return False

    return True


def _otruyen_payload_items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    items = (payload.get("data") or {}).get("items") or []
    return items if isinstance(items, list) else []


def _otruyen_payload_total_pages(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 1
    pagination = (((payload.get("data") or {}).get("params") or {}).get("pagination") or {})
    if _safe_int(pagination.get("totalPages")) > 0:
        return _safe_int(pagination["totalPages"])
    total_items = _safe_int(pagination.get("totalItems"))
    per_page = _safe_int(pagination.get("totalItemsPerPage")) or 24
    if total_items > 0 and per_page > 0:
        return max(1, math.ceil(total_items / per_page))
    return 1


def _otruyen_apply_local_views(item: dict[str, Any], views_lookup: dict[str, int]) -> None:
    if not isinstance(item, dict):
        return
    candidates = _hidden_slug_candidates(item.get("slug") or item.get("_id") or item.get("id"))
    from fastapi_app.services.qq_statistics import item_slugs
    qq_aliases = item_slugs(item)
    local_views = (sum(_safe_int(views_lookup.get(candidate)) for candidate in qq_aliases)
                   if len(qq_aliases) > 1 else
                   max((_safe_int(views_lookup.get(candidate)) for candidate in candidates), default=0))
    item["local_view_count"] = local_views
    item["view_count"] = local_views
    item["views"] = local_views


def _attach_local_views_to_otruyen_payload(payload: Any, db: Any) -> None:
    if not isinstance(payload, dict):
        return
    items = (payload.get("data") or {}).get("items") or []
    if not isinstance(items, list) or not items:
        return
    views_lookup = _fetch_local_views_lookup(db)
    for item in items:
        if isinstance(item, dict):
            _otruyen_apply_local_views(item, views_lookup)


async def _async_attach_local_views_to_otruyen_payload(payload: Any, db: Any) -> None:
    lookup = await cached_public_read(("views", id(db)), lambda: _fetch_local_views_lookup(db),
                                      dict(_manga_views_lookup_cache), ttl=10)
    for item in _otruyen_payload_items(payload):
        _otruyen_apply_local_views(item, lookup)


def _sort_otruyen_filtered_items(
    items: list[dict[str, Any]],
    *,
    sort: str,
) -> list[dict[str, Any]]:
    normalized_sort = _clean_slug(sort) or "latest"
    decorated = list(enumerate(items))
    if normalized_sort == "popular":
        decorated.sort(
            key=lambda entry: (
                -_safe_int((entry[1] or {}).get("local_view_count")),
                -_safe_int((entry[1] or {}).get("views") or (entry[1] or {}).get("view_count")),
                -_parse_sort_timestamp(
                    _pick_item_latest_chapter_updated_at(entry[1] or {}) or _pick_item_last_updated(entry[1] or {})
                ),
                entry[0],
            )
        )
    elif normalized_sort == "rating":
        decorated.sort(
            key=lambda entry: (
                -_safe_float((entry[1] or {}).get("rating_average") or (entry[1] or {}).get("average_rating")),
                -_safe_int((entry[1] or {}).get("rating_count") or (entry[1] or {}).get("ratings_count")),
                -_parse_sort_timestamp(
                    _pick_item_latest_chapter_updated_at(entry[1] or {}) or _pick_item_last_updated(entry[1] or {})
                ),
                entry[0],
            )
        )
    elif normalized_sort == "alphabetical":
        decorated.sort(
            key=lambda entry: (
                _normalize_loose_text((entry[1] or {}).get("name") or (entry[1] or {}).get("title")),
                entry[0],
            )
        )
    else:
        decorated.sort(
            key=lambda entry: (
                -_parse_sort_timestamp(
                    _pick_item_latest_chapter_updated_at(entry[1] or {}) or _pick_item_last_updated(entry[1] or {})
                ),
                entry[0],
            )
        )
    return [item for _, item in decorated]


def _otruyen_filtered_page_payload(
    *,
    sorted_items: list[dict[str, Any]],
    safe_page: int,
    safe_limit: int,
    required_genres: set[str],
    status_value: str,
    sort: str,
    total_source_pages: int,
    scanned_page_count: int,
    scan_page_limit: int,
    popular_scan: bool,
) -> dict[str, Any]:
    """Render one page from an already filtered and sorted OTruyen window."""
    offset = (safe_page - 1) * safe_limit
    page_items = sorted_items[offset: offset + safe_limit]

    scanned_all = scanned_page_count >= total_source_pages
    scanned_popular_window = popular_scan and scanned_page_count >= scan_page_limit
    if scanned_all:
        total_items = len(sorted_items)
    else:
        scanned_ratio = max(1, scanned_page_count) / max(1, total_source_pages)
        estimated_total = math.ceil(len(sorted_items) / scanned_ratio)
        total_items = max(len(sorted_items), safe_page * safe_limit + 1, estimated_total)

    return {
        "status": "success",
        "data": {
            "items": page_items,
            "params": {
                "pagination": {
                    "currentPage": safe_page,
                    "totalItemsPerPage": safe_limit,
                    "totalItems": total_items,
                },
                "filters": {
                    "genre_slugs": sorted(required_genres),
                    "status": _normalize_otruyen_status(status_value),
                    "sort": _clean_slug(sort) or "latest",
                    "source_pages_scanned": scanned_page_count,
                    "source_pages_total": total_source_pages,
                    "source_scan_complete": scanned_all,
                    "source_popular_scan_complete": scanned_popular_window,
                    "source_scan_page_limit": scan_page_limit,
                },
            },
        },
    }


async def _build_otruyen_filtered_payload(
    *,
    genre_values: list[str],
    status_value: str,
    sort: str,
    page: int,
    limit: int,
    show_mature: bool,
    base_slug: str,
    hidden: dict[str, str],
    db: Any,
    user: Any,
    attach_ratings: bool,
) -> dict[str, Any]:
    safe_page = max(1, page)
    safe_limit = max(1, min(limit, 96))
    target_count = safe_page * safe_limit
    required_genres = {
        _clean_slug(value)
        for value in genre_values
        if _clean_slug(value)
    }
    selected_base_slug = _clean_slug(base_slug) or (next(iter(required_genres), ""))
    normalized_status_value = _normalize_otruyen_status(status_value)
    # For an intersection such as Romance + Completed, the status list is a
    # much narrower source than the whole Romance category. We still apply all
    # genre checks below, so this changes fetch cost rather than result logic.
    use_category_source = bool(selected_base_slug) and not normalized_status_value
    effective_required_genres = set(required_genres)
    if use_category_source and selected_base_slug in effective_required_genres:
        # The category endpoint already guarantees the base genre. Some OTruyen
        # rows omit category metadata, so requiring that same slug again can
        # incorrectly turn a valid popular tag page into an empty result.
        effective_required_genres.discard(selected_base_slug)
    list_type = _otruyen_list_type_for_status(normalized_status_value)
    normalized_sort = _clean_slug(sort) or "latest"
    popular_scan = normalized_sort == "popular"
    popular_snapshot_key = _otruyen_filtered_popular_snapshot_cache_key(
        base_slug=selected_base_slug,
        genre_values=genre_values,
        status_value=normalized_status_value,
        show_mature=show_mature,
    )

    if popular_scan:
        popular_snapshot = _load_otruyen_filtered_popular_snapshot(popular_snapshot_key)
        snapshot_item_count = len((popular_snapshot or {}).get("items") or [])
        snapshot_scanned_pages = _safe_int((popular_snapshot or {}).get("scanned_pages"))
        snapshot_total_source_pages = _safe_int((popular_snapshot or {}).get("total_source_pages"))
        # A snapshot created for an earlier page can be too shallow for a deep
        # direct link. Rebuild and extend it below instead of returning an empty
        # page that makes the client issue a second latest-sort request.
        snapshot_covers_page = (
            snapshot_item_count >= target_count
            or snapshot_scanned_pages >= snapshot_total_source_pages
        )
        if popular_snapshot is not None and snapshot_covers_page:
            payload = _otruyen_filtered_page_payload(
                sorted_items=popular_snapshot["items"],
                safe_page=safe_page,
                safe_limit=safe_limit,
                required_genres=required_genres,
                status_value=status_value,
                sort=sort,
                total_source_pages=_safe_int(popular_snapshot.get("total_source_pages")),
                scanned_page_count=_safe_int(popular_snapshot.get("scanned_pages")),
                scan_page_limit=_safe_int(popular_snapshot.get("scan_page_limit")),
                popular_scan=True,
            )
            await _attach_overrides_to_otruyen_payload(payload, db)
            if attach_ratings:
                await _async_attach_ratings_to_items(payload, db, user)
            return payload

    async def fetch_page(target_page: int) -> dict[str, Any]:
        if use_category_source:
            return await truyenqq_service.get_category_manga(selected_base_slug, target_page)
        return await truyenqq_service.get_list(list_type, target_page)

    first_payload = await fetch_page(1)
    total_source_pages = min(_otruyen_payload_total_pages(first_payload), OTRUYEN_FILTERED_MAX_SCAN_PAGES)
    exact_scan = total_source_pages <= OTRUYEN_FILTERED_EXACT_SCAN_PAGE_CAP
    scan_page_limit = total_source_pages
    if popular_scan and not exact_scan:
        scan_page_limit = min(total_source_pages, OTRUYEN_FILTERED_POPULAR_SCAN_PAGE_CAP)
    desired_buffer_count = target_count + safe_limit

    collected: list[dict[str, Any]] = []
    seen_items: set[str] = set()
    scanned_pages: set[int] = set()
    failed_source_pages: set[int] = set()
    views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)

    def append_payload(payload: Any) -> None:
        for raw_item in _otruyen_payload_items(payload):
            if not isinstance(raw_item, dict):
                continue
            key = _otruyen_item_identity_key(raw_item)
            if key and key in seen_items:
                continue
            if not _otruyen_item_matches_filters(
                raw_item,
                required_genres=effective_required_genres,
                status_value=status_value,
                show_mature=show_mature,
                hidden=hidden,
            ):
                continue
            item = dict(raw_item)
            _otruyen_apply_local_views(item, views_lookup)
            if key:
                seen_items.add(key)
            collected.append(item)

    append_payload(first_payload)
    scanned_pages.add(1)

    semaphore = asyncio.Semaphore(OTRUYEN_FILTERED_FETCH_CHUNK)

    async def load_one(target_page: int) -> tuple[int, dict[str, Any] | None]:
        async with semaphore:
            try:
                return target_page, await fetch_page(target_page)
            except Exception:
                return target_page, None

    for start_page in range(2, scan_page_limit + 1, OTRUYEN_FILTERED_FETCH_CHUNK):
        if not exact_scan and not popular_scan and len(collected) >= desired_buffer_count:
            break
        end_page = min(scan_page_limit, start_page + OTRUYEN_FILTERED_FETCH_CHUNK - 1)
        page_numbers = [target_page for target_page in range(start_page, end_page + 1) if target_page not in scanned_pages]
        if not page_numbers:
            continue
        rows = await asyncio.gather(*(load_one(target_page) for target_page in page_numbers))
        for target_page, payload in sorted(rows, key=lambda row: row[0]):
            scanned_pages.add(target_page)
            if payload is not None:
                append_payload(payload)
            else:
                failed_source_pages.add(target_page)

    scanned_page_count = max(1, len(scanned_pages))
    estimated_total_items = math.ceil(len(collected) * total_source_pages / scanned_page_count)
    estimated_result_pages = math.ceil(estimated_total_items / safe_limit)
    should_complete_sparse_popular_scan = (
        popular_scan
        and not exact_scan
        and not failed_source_pages
        and estimated_result_pages <= OTRUYEN_FILTERED_EXACT_RESULT_PAGE_CAP
    )

    # The initial popular window protects the upstream from an unbounded scan.
    # Complete sparse result sets so the first page never advertises estimated
    # pages that disappear later. Deep pages also extend only as far as needed
    # to fill themselves, avoiding a second latest-sort request from the UI.
    if (
        popular_scan
        and scan_page_limit < total_source_pages
        and (len(collected) < target_count or should_complete_sparse_popular_scan)
    ):
        for start_page in range(scan_page_limit + 1, total_source_pages + 1, OTRUYEN_FILTERED_FETCH_CHUNK):
            end_page = min(total_source_pages, start_page + OTRUYEN_FILTERED_FETCH_CHUNK - 1)
            page_numbers = [target_page for target_page in range(start_page, end_page + 1) if target_page not in scanned_pages]
            if not page_numbers:
                continue
            rows = await asyncio.gather(*(load_one(target_page) for target_page in page_numbers))
            scan_page_limit = end_page
            for target_page, payload in sorted(rows, key=lambda row: row[0]):
                scanned_pages.add(target_page)
                if payload is not None:
                    append_payload(payload)
                else:
                    failed_source_pages.add(target_page)
            if len(collected) >= target_count and not should_complete_sparse_popular_scan:
                break

    sorted_items = _sort_otruyen_filtered_items(collected, sort=sort)
    if popular_scan and not failed_source_pages:
        _cache_otruyen_filtered_popular_snapshot(
            popular_snapshot_key,
            {
                "items": sorted_items,
                "total_source_pages": total_source_pages,
                "scanned_pages": len(scanned_pages),
                "scan_page_limit": scan_page_limit,
            },
        )

    payload = _otruyen_filtered_page_payload(
        sorted_items=sorted_items,
        safe_page=safe_page,
        safe_limit=safe_limit,
        required_genres=required_genres,
        status_value=status_value,
        sort=sort,
        total_source_pages=total_source_pages,
        scanned_page_count=len(scanned_pages),
        scan_page_limit=scan_page_limit,
        popular_scan=popular_scan,
    )
    await _attach_overrides_to_otruyen_payload(payload, db)
    if attach_ratings or _clean_slug(sort) == "rating":
        await _async_attach_ratings_to_items(payload, db, user)
    return payload


@router.get("/list/{list_type}/batch")
async def manga_list_batch(
    list_type: str = "truyen-moi",
    pages: str = Query(..., min_length=1),
    attach_ratings: bool = Query(False),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    page_numbers = _parse_page_batch(pages)
    if not page_numbers:
        return {"pages": {}, "errors": {}}
    hidden = await _get_hidden_slugs(db)
    return await _build_otruyen_page_batch(
        page_numbers,
        lambda target_page: truyenqq_service.get_list(list_type, target_page),
        hidden=hidden,
        db=db,
        user=user,
        attach_ratings=attach_ratings,
    )


@router.get("/list-combined/{list_type}")
async def manga_list_combined(
    list_type: str = "truyen-moi",
    page: int = Query(1, ge=1),
    max_chapters: int = Query(120, ge=1, le=2000),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    cache_key = _combined_cache_key(list_type=list_type, page=page, max_chapters=max_chapters)
    payload = _load_json_cache(cache_key)
    if payload is None:
        stale_payload = _load_json_cache(f"{cache_key}:stale")
        if stale_payload is not None:
            _schedule_combined_refresh(cache_key, list_type=list_type, page=page, max_chapters=max_chapters)
            payload = stale_payload
        else:
            payload = await _build_combined_payload(list_type=list_type, page=page, max_chapters=max_chapters)
            # Only cache if MangaDex data is present — prevents caching empty catalogs
            mdx_mangas = (payload.get("mangadex") or {}).get("mangas") or []
            if mdx_mangas:
                _cache_combined_payload(cache_key, payload)
            else:
                # Trigger background warmup so next request will be fast
                schedule_startup_warmup()

    base_data = payload.get("list") if isinstance(payload, dict) else _fallback_empty_list_payload(page)
    if not isinstance(base_data, dict):
        base_data = _fallback_empty_list_payload(page)

    # Filter hidden manga from both OTruyen list + MangaDex catalog
    hidden = await _get_hidden_slugs(db)
    if hidden and isinstance(base_data, dict):
        items = (base_data.get("data") or {}).get("items") or []
        if isinstance(items, list):
            base_data["data"]["items"] = _filter_hidden(items, hidden)

    await _attach_overrides_to_otruyen_payload(base_data, db)

    await _async_attach_ratings_to_items(base_data, db, user)

    mangadex_payload = payload.get("mangadex") if isinstance(payload, dict) else _fallback_empty_mangadex_payload()
    if not isinstance(mangadex_payload, dict):
        mangadex_payload = _fallback_empty_mangadex_payload()
    if hidden:
        mangadex_payload = _filter_hidden_mangadex_payload(mangadex_payload, hidden)
    await _attach_overrides_to_mangadex_payload(mangadex_payload, db)
    await _async_attach_ratings_to_mangadex_payload(mangadex_payload, db, user)

    return {"list": base_data, "mangadex": mangadex_payload}


@router.get("/categories")
async def categories():
    """Danh sách tất cả thể loại."""
    return await truyenqq_service.get_categories()


@router.get("/category/{slug}")
async def category_manga(
    slug: str,
    page: int = Query(1, ge=1),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Danh sách truyện theo thể loại."""
    data, hidden = await asyncio.gather(
        truyenqq_service.get_category_manga(slug, page),
        _get_hidden_slugs(db),
    )
    if hidden and isinstance(data, dict):
        items = (data.get("data") or {}).get("items") or []
        if isinstance(items, list):
            data["data"]["items"] = _filter_hidden(items, hidden)
    await _async_attach_local_views_to_otruyen_payload(data, db)
    await _async_attach_ratings_to_items(data, db, user)
    return data


@router.get("/category/{slug}/batch")
async def category_manga_batch(
    slug: str,
    pages: str = Query(..., min_length=1),
    attach_ratings: bool = Query(False),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    page_numbers = _parse_page_batch(pages)
    if not page_numbers:
        return {"pages": {}, "errors": {}}
    hidden = await _get_hidden_slugs(db)
    return await _build_otruyen_page_batch(
        page_numbers,
        lambda target_page: truyenqq_service.get_category_manga(slug, target_page),
        hidden=hidden,
        db=db,
        user=user,
        attach_ratings=attach_ratings,
    )


@router.get("/otruyen-filtered", include_in_schema=False)
@router.get("/truyenqq-filtered")
async def otruyen_filtered_manga(
    genre_slugs: str = Query(""),
    status: str = Query(""),
    sort: str = Query("latest"),
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=96),
    show_mature: bool = Query(False),
    base_slug: str = Query(""),
    attach_ratings: bool = Query(False),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
    response: Response = None,
):
    genre_values = [
        _clean_slug(part)
        for part in str(genre_slugs or "").split(",")
        if _clean_slug(part)
    ]
    normalized_status = _normalize_otruyen_status(status)
    normalized_sort = _clean_slug(sort) or "latest"
    normalized_base_slug = _clean_slug(base_slug) or (genre_values[0] if genre_values else "")

    if normalized_status and normalized_status not in {"ongoing", "completed"}:
        return {"status": "success", "data": {"items": [], "params": {"pagination": {
            "currentPage": page, "totalItemsPerPage": limit, "totalItems": 0, "totalPages": 1}}}}

    from fastapi_app.services.local_popular import qq_popular
    hidden_read = create_task(_get_hidden_slugs(db))
    payload = await qq_popular(page=page, limit=limit, genres=genre_values, status=normalized_status,
                               show_mature=show_mature, hidden=hidden_read, db=db, http_response=response,
                               sort=normalized_sort)
    hidden = await hidden_read
    items = payload["data"]["items"]
    payload["data"]["items"] = _filter_hidden(items, hidden)
    if not show_mature:
        payload["data"]["items"] = [item for item in payload["data"]["items"]
                                    if not _is_mature_metadata(item.get("content_rating"), item.get("category"), [])]
    await _attach_overrides_to_otruyen_payload(payload, db, attach_views=normalized_sort != "popular")
    if attach_ratings:
        await _async_attach_ratings_to_items(payload, db, user)
    return payload


def _safe_query(fn):
    """Run a DB query, return None on any error (missing table, etc.)."""
    try:
        return fn()
    except Exception:
        return None


def _sum_manga_views(db: Any, slugs: list[str]) -> int:
    """Return summed local view counters for provided slug aliases."""
    normalized = [str(value or "").strip() for value in slugs]
    normalized = [value for value in dict.fromkeys(normalized) if value]
    if not normalized:
        return 0

    try:
        rows = (
            db.table("manga_views")
            .select("manga_slug,views")
            .in_("manga_slug", normalized)
            .execute()
            .data
            or []
        )
    except Exception:
        return 0

    total = 0
    for row in rows:
        try:
            total += int((row or {}).get("views") or 0)
        except Exception:
            continue
    return total


def _normalize_view_slug(value: Any) -> str:
    slug = str(value or "").strip().strip("/").lower()
    return "" if _is_invalid_manga_slug(slug) else slug


def _fetch_local_views_lookup(db: Any) -> dict[str, int]:
    """Small cached lookup of local DB views, used to keep MangaDex browse sorted like rankings."""
    global _manga_views_lookup_cache, _manga_views_lookup_cache_at

    now = time.time()
    if now - _manga_views_lookup_cache_at < _MANGA_VIEWS_LOOKUP_CACHE_TTL_SECONDS:
        return dict(_manga_views_lookup_cache)

    try:
        rows = (
            db.table("manga_views")
            .select("manga_slug,views")
            .order("views", desc=True)
            .limit(_MANGA_VIEWS_LOOKUP_LIMIT)
            .execute()
            .data
            or []
        )
    except Exception:
        return dict(_manga_views_lookup_cache)

    lookup: dict[str, int] = {}
    for row in rows:
        slug = _normalize_view_slug((row or {}).get("manga_slug"))
        if not slug:
            continue
        views = _safe_int((row or {}).get("views"))
        if views <= 0:
            continue
        lookup[slug] = max(lookup.get(slug, 0), views)
        cleaned = _clean_slug(slug)
        if cleaned and cleaned != slug and not _extract_mangadex_id(slug):
            lookup[cleaned] = max(lookup.get(cleaned, 0), views)

    _manga_views_lookup_cache = lookup
    _manga_views_lookup_cache_at = now
    return dict(lookup)


def _bump_manga_views_lookup_cache(slug: Any, delta: int = 1) -> None:
    """Keep the hot local view cache fresh without forcing the next browse to hit DB."""
    if not _manga_views_lookup_cache:
        return

    normalized = _normalize_view_slug(slug)
    if not normalized:
        return

    aliases = [normalized]
    cleaned = _clean_slug(normalized)
    if cleaned and cleaned != normalized and not _extract_mangadex_id(normalized):
        aliases.append(cleaned)

    for alias in aliases:
        _manga_views_lookup_cache[alias] = max(
            0,
            _safe_int(_manga_views_lookup_cache.get(alias)) + max(1, int(delta or 1)),
        )


def _local_views_for_mangadex_id(views_lookup: dict[str, int], manga_id: str) -> int:
    total = 0
    seen: set[str] = set()
    for candidate in _hidden_slug_candidates(manga_id):
        normalized = _normalize_view_slug(candidate)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        total += _safe_int(views_lookup.get(normalized))
    return total


def _top_local_viewed_mangadex_ids(
    views_lookup: dict[str, int],
    *,
    hidden: dict[str, str] | None = None,
    limit: int = _MANGADEX_LOCAL_VIEWED_INJECT_LIMIT,
) -> list[tuple[str, int]]:
    ids: set[str] = set()
    for slug in views_lookup.keys():
        manga_id = _extract_mangadex_id(slug)
        if not manga_id:
            continue
        if hidden and _hidden_reason_for_slug(hidden, manga_id):
            continue
        ids.add(manga_id)

    ranked: list[tuple[str, int]] = []
    for manga_id in ids:
        views = _local_views_for_mangadex_id(views_lookup, manga_id)
        if views > 0:
            ranked.append((manga_id, views))

    ranked.sort(key=lambda item: item[1], reverse=True)
    return ranked[: max(1, limit)]


def _attach_local_views_to_mangadex_payload(payload: Any, db: Any, *, views_lookup=None) -> None:
    """Attach canonical local DB view counts to MangaDex catalog rows.

    MangaDex does not expose view counts. For our UI, manga_views is the same
    source used by rankings/admin, so overwrite catalog views with that value
    instead of mixing it with MangaDex popularity fallback scores.
    """
    if not isinstance(payload, dict):
        return

    mangas = payload.get("mangas")
    if not isinstance(mangas, list) or not mangas:
        return

    if views_lookup is None:
        views_lookup = _fetch_local_views_lookup(db)
    for manga in mangas:
        if not isinstance(manga, dict):
            continue
        manga_id = _extract_mangadex_id(manga.get("id") or manga.get("slug"))
        if not manga_id:
            continue
        local_views = _local_views_for_mangadex_id(views_lookup, manga_id)
        manga["local_view_count"] = local_views
        manga["view_count"] = local_views
        manga["views"] = local_views


async def _async_attach_local_views_to_mangadex_payload(payload: Any, db: Any) -> None:
    lookup = await cached_public_read(("views", id(db)), lambda: _fetch_local_views_lookup(db),
                                      dict(_manga_views_lookup_cache), ttl=10)
    _attach_local_views_to_mangadex_payload(payload, db, views_lookup=lookup)


def _sort_mangadex_items_by_local_views_first(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    decorated = list(enumerate(items))
    decorated.sort(
        key=lambda entry: (
            0 if _safe_int((entry[1] or {}).get("views") or (entry[1] or {}).get("view_count")) > 0 else 1,
            -_safe_int((entry[1] or {}).get("views") or (entry[1] or {}).get("view_count")),
            entry[0],
        )
    )
    return [item for _, item in decorated]


_MANGADEX_TAG_ALIAS_TO_SLUG = {
    "xuyen-khong": "isekai",
    "chuyen-sinh": "reincarnation",
    "tinh-cam": "romance",
    "ngon-tinh": "romance",
    "lang-man": "romance",
    "hai-huoc": "comedy",
    "hanh-dong": "action",
    "phieu-luu": "adventure",
    "kinh-di": "horror",
    "doi-thuong": "slice-of-life",
    "the-thao": "sports",
    "hoc-duong": "school-life",
    "lich-su": "historical",
    "tam-ly": "psychological",
    "bi-an": "mystery",
    "vo-thuat": "martial-arts",
    "sieu-nhien": "supernatural",
    "khoa-hoc-vien-tuong": "sci-fi",
}


def _mangadex_tag_slug(value: Any) -> str:
    normalized = _normalize_loose_text(value)
    if not normalized:
        normalized = str(value or "").strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return _MANGADEX_TAG_ALIAS_TO_SLUG.get(slug, slug)


def _mangadex_lookup_matches_search_filters(
    manga: dict[str, Any],
    *,
    keyword: str,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
) -> bool:
    normalized_language = str(translated_language or "").strip().lower()
    if normalized_language and normalized_language not in {"all", "any", "*", "non_vi"}:
        available = {
            str(language or "").strip().lower()
            for language in (manga.get("available_translated_languages") or [])
            if str(language or "").strip()
        }
        if normalized_language not in available:
            return False

    normalized_content_rating = str(manga.get("content_rating") or "").strip().lower()
    if content_ratings and normalized_content_rating not in set(content_ratings):
        return False

    normalized_status = str(manga.get("status") or "").strip().lower()
    if status_values and normalized_status not in set(status_values):
        return False

    normalized_original_language = str(manga.get("original_language") or "").strip().lower()
    if original_language_values and normalized_original_language not in set(original_language_values):
        return False

    if genre_values:
        required_slugs = {
            _mangadex_tag_slug(value)
            for value in genre_values
            if _mangadex_tag_slug(value)
        }
        manga_tag_slugs = {
            _mangadex_tag_slug(value)
            for value in (manga.get("genres") or [])
            if _mangadex_tag_slug(value)
        }
        if required_slugs and not required_slugs.issubset(manga_tag_slugs):
            return False

    normalized_keyword = _normalize_loose_text(keyword)
    if normalized_keyword:
        haystack_parts: list[str] = [
            str(manga.get("title") or ""),
            str(manga.get("description") or ""),
            str(manga.get("authors_text") or ""),
            " ".join(str(value or "") for value in (manga.get("genres") or [])),
        ]
        haystack = _normalize_loose_text(" ".join(haystack_parts))
        if normalized_keyword not in haystack:
            return False

    return True


def _parse_sort_timestamp(value: Any) -> float:
    raw = str(value or "").strip()
    if not raw:
        return 0.0
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _sort_mangadex_items_by_rating(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    decorated = list(enumerate(items))
    decorated.sort(
        key=lambda entry: (
            -_safe_float((entry[1] or {}).get("rating_average") or (entry[1] or {}).get("average_rating")),
            -_safe_int((entry[1] or {}).get("rating_count") or (entry[1] or {}).get("ratings_count")),
            -_safe_int((entry[1] or {}).get("views") or (entry[1] or {}).get("view_count")),
            -_parse_sort_timestamp(
                (entry[1] or {}).get("local_last_published_at") or (entry[1] or {}).get("updatedAt")
            ),
            entry[0],
        )
    )
    return [item for _, item in decorated]


def _legacy_mangadex_search_item_from_lookup(manga: dict[str, Any], views: int) -> dict[str, Any]:
    manga_id = str(manga.get("id") or "").strip().lower()
    genres = [str(genre or "").strip() for genre in (manga.get("genres") or []) if str(genre or "").strip()]
    category = [{"name": genre, "slug": _clean_slug(genre)} for genre in genres]
    chapter_name = str(manga.get("last_chapter") or "").strip()
    publish_at = str(manga.get("updated_at") or "").strip()
    chapters_latest: list[dict[str, Any]] = []
    if chapter_name:
        chapters_latest.append(
            {
                "chapter_name": chapter_name,
                "chapter_title": "",
                "chapter_api_data": "",
            }
        )
    author_names = [
        str((author or {}).get("name") or "").strip()
        for author in (manga.get("authors") or [])
        if isinstance(author, dict) and str(author.get("name") or "").strip()
    ] or ["MangaDex"]
    return {
        "name": str(manga.get("title") or "Untitled"),
        "slug": manga_id,
        "origin_name": [str(manga.get("title") or "Untitled")],
        "author": author_names,
        "status": manga.get("status") or "ongoing",
        "thumb_url": manga.get("cover_url") or "",
        "cover_url": manga.get("cover_url") or "",
        "updatedAt": publish_at,
        "local_last_published_at": publish_at,
        "category": category,
        "chaptersLatest": chapters_latest,
        "last_chapter": chapter_name,
        "rating_average": 0,
        "view_count": views,
        "views": views,
        "local_view_count": views,
        "content_rating": str(manga.get("content_rating") or "").strip().lower(),
        "original_language": str(manga.get("original_language") or "").strip().lower(),
        "source": "mangadex",
        "local_view_injected": True,
    }


async def _resolve_local_viewed_mangadex_search_rows(
    ranked: list[tuple[str, int]],
    *,
    offset: int,
    limit: int,
    keyword: str = "",
    translated_language: str = "all",
    genre_values: list[str] | None = None,
    original_language_values: list[str] | None = None,
    status_values: list[str] | None = None,
    content_ratings: list[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    filtering_required = bool(
        str(keyword or "").strip()
        or (genre_values or [])
        or (original_language_values or [])
        or (status_values or [])
    )

    if not filtering_required:
        if limit <= 0:
            return [], len(ranked)
        target = ranked[offset: offset + limit]
        if not target:
            return [], len(ranked)
    else:
        target = ranked

    semaphore = asyncio.Semaphore(max(1, _MANGADEX_LOCAL_VIEWED_LOOKUP_CONCURRENCY))

    async def _resolve(manga_id: str, views: int) -> dict[str, Any] | None:
        async with semaphore:
            try:
                lookup_payload = await asyncio.wait_for(
                    mangadex_service.get_manga_lookup(manga_id),
                    timeout=_MANGADEX_LOCAL_VIEWED_LOOKUP_TIMEOUT_SECONDS,
                )
            except Exception:
                return None
            manga = (lookup_payload or {}).get("manga") if isinstance(lookup_payload, dict) else None
            if not isinstance(manga, dict):
                return None
            if not _mangadex_lookup_matches_search_filters(
                manga,
                keyword=keyword,
                translated_language=translated_language,
                genre_values=genre_values or [],
                original_language_values=original_language_values or [],
                status_values=status_values or [],
                content_ratings=content_ratings or [],
            ):
                return None
            manga = dict(manga)
            manga["id"] = manga_id
            return _legacy_mangadex_search_item_from_lookup(manga, views)

    if not filtering_required:
        resolved = await asyncio.gather(
            *[_resolve(manga_id, views) for manga_id, views in target],
            return_exceptions=True,
        )
        return [item for item in resolved if isinstance(item, dict)], len(ranked)

    matched: list[dict[str, Any]] = []
    batch_size = max(1, _MANGADEX_LOCAL_VIEWED_LOOKUP_CONCURRENCY * 4)
    for start in range(0, len(target), batch_size):
        batch = target[start: start + batch_size]
        resolved = await asyncio.gather(
            *[_resolve(manga_id, views) for manga_id, views in batch],
            return_exceptions=True,
        )
        matched.extend(item for item in resolved if isinstance(item, dict))

    return matched[offset: offset + limit], len(matched)


async def _resolve_local_viewed_mangadex_search_rows_batch(
    ranked: list[tuple[str, int]],
    *,
    limit: int,
    translated_language: str = "all",
    genre_values: list[str] | None = None,
    original_language_values: list[str] | None = None,
    status_values: list[str] | None = None,
    content_ratings: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Resolve locally viewed MangaDex rows in one official /manga query.

    This keeps first-load popular-tag ordering stable without warming dozens of
    individual /manga/{id} lookups first.
    """
    if limit <= 0 or not ranked:
        return []

    target = ranked[: min(100, max(1, limit))]
    views_by_id = {manga_id: views for manga_id, views in target}
    try:
        payload = await mangadex_service.search_manga(
            keyword="",
            page=1,
            limit=len(target),
            translated_language=translated_language,
            attach_latest=False,
            included_tag_slugs=genre_values or [],
            included_tags_mode="AND",
            original_languages=original_language_values or [],
            statuses=status_values or [],
            sort="latest",
            content_ratings=content_ratings or [],
            manga_ids=[manga_id for manga_id, _ in target],
        )
    except Exception:
        return []

    items = ((payload.get("data") or {}).get("items") or [])
    if not isinstance(items, list):
        return []

    resolved: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        manga_id = _extract_mangadex_id(item.get("slug") or item.get("id"))
        if not manga_id:
            continue
        views = _safe_int(views_by_id.get(manga_id))
        item = dict(item)
        item["local_view_count"] = views
        item["view_count"] = views
        item["views"] = views
        item["local_view_injected"] = True
        resolved.append(item)

    resolved.sort(
        key=lambda item: (
            -_safe_int((item or {}).get("local_view_count") or (item or {}).get("views") or (item or {}).get("view_count")),
            str((item or {}).get("slug") or (item or {}).get("id") or ""),
        )
    )
    return resolved


async def _fetch_mangadex_search_total(
    *,
    keyword: str,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
) -> int:
    """Read MangaDex's authoritative filtered total with the smallest payload."""
    payload = await mangadex_service.search_manga(
        keyword=keyword,
        page=1,
        limit=1,
        translated_language=translated_language,
        attach_latest=False,
        included_tag_slugs=genre_values,
        included_tags_mode="AND",
        original_languages=original_language_values,
        statuses=status_values,
        sort="latest",
        content_ratings=content_ratings,
    )
    return _safe_int(
        ((((payload.get("data") or {}).get("params") or {}).get("pagination") or {}).get("totalItems"))
    )


async def _fetch_mangadex_latest_search_fill(
    *,
    keyword: str,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
    exclude_ids: set[str],
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int]:
    if limit <= 0:
        return [], 0

    collected: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
    cursor = max(0, int(offset))
    attempts = 0
    max_attempts = 3

    while len(collected) < limit and attempts < max_attempts:
        remaining = limit - len(collected)
        upstream_limit = min(
            100,
            max(remaining, remaining + min(48, len(exclude_ids))),
        )
        payload = await mangadex_service.search_manga(
            keyword=keyword,
            page=max(1, math.floor(cursor / max(1, upstream_limit)) + 1),
            limit=upstream_limit,
            translated_language=translated_language,
            attach_latest=True,
            included_tag_slugs=genre_values,
            included_tags_mode="AND",
            original_languages=original_language_values,
            statuses=status_values,
            sort="latest",
            content_ratings=content_ratings,
            offset_override=cursor,
        )
        page_data = payload.get("data") or {}
        pagination = (page_data.get("params") or {}).get("pagination") or {}
        total = max(total, _safe_int(pagination.get("totalItems")))
        page_items = page_data.get("items") or []
        if not isinstance(page_items, list) or not page_items:
            break

        for item in page_items:
            manga_id = _extract_mangadex_id((item or {}).get("slug") or (item or {}).get("id"))
            if not manga_id or manga_id in exclude_ids or manga_id in seen:
                continue
            seen.add(manga_id)
            collected.append(item)
            if len(collected) >= limit:
                break

        cursor += len(page_items)
        if len(page_items) < upstream_limit:
            break
        attempts += 1

    return collected, total


async def _build_mangadex_popular_with_local_views(
    *,
    keyword: str,
    page: int,
    limit: int,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
    hidden: dict[str, str],
    db: Any,
) -> dict[str, Any]:
    offset = (max(1, page) - 1) * limit
    views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)
    ranked = _top_local_viewed_mangadex_ids(
        views_lookup,
        hidden=hidden,
        limit=_MANGADEX_POPULAR_LOCAL_VIEW_LIMIT,
    )
    ranked_ids = {manga_id for manga_id, _ in ranked}

    local_rows: list[dict[str, Any]] = []
    local_match_count = len(ranked)
    filtering_required = bool(
        str(keyword or "").strip()
        or genre_values
        or original_language_values
        or status_values
    )
    if offset < len(ranked):
        if not filtering_required:
            ranked_page = ranked[offset: offset + limit]
            ranked_page_ids = {manga_id for manga_id, _ in ranked_page}
            local_rows = await _resolve_local_viewed_mangadex_search_rows_batch(
                ranked_page,
                limit=len(ranked_page),
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            )
            local_rows = [
                row
                for row in local_rows
                if _extract_mangadex_id((row or {}).get("slug") or (row or {}).get("id")) in ranked_page_ids
            ]
            resolved_ids = {
                _extract_mangadex_id((row or {}).get("slug") or (row or {}).get("id"))
                for row in local_rows
            }
            unresolved_ranked = [
                entry for entry in ranked_page if entry[0] not in resolved_ids
            ]
            # A partial ids[] response is authoritative for the active
            # language/content filters. Only fall back to individual lookups
            # when the batch request yielded nothing at all.
            if unresolved_ranked and not local_rows:
                fallback_rows, _ = await _resolve_local_viewed_mangadex_search_rows(
                    unresolved_ranked,
                    offset=0,
                    limit=len(unresolved_ranked),
                    keyword=keyword,
                    translated_language=translated_language,
                    genre_values=genre_values,
                    original_language_values=original_language_values,
                    status_values=status_values,
                    content_ratings=content_ratings,
                )
                local_rows.extend(fallback_rows)

            rank_order = {manga_id: index for index, (manga_id, _) in enumerate(ranked_page)}
            local_rows.sort(
                key=lambda row: rank_order.get(
                    _extract_mangadex_id((row or {}).get("slug") or (row or {}).get("id")) or "",
                    len(rank_order),
                )
            )
        else:
            local_rows, local_match_count = await _resolve_local_viewed_mangadex_search_rows(
                ranked,
                offset=offset,
                limit=limit,
                keyword=keyword,
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            )
    elif filtering_required:
        _, local_match_count = await _resolve_local_viewed_mangadex_search_rows(
            ranked,
            offset=0,
            limit=0,
            keyword=keyword,
            translated_language=translated_language,
            genre_values=genre_values,
            original_language_values=original_language_values,
            status_values=status_values,
            content_ratings=content_ratings,
        )

    fill_offset = max(0, offset - local_match_count)
    if offset < local_match_count:
        fill_offset = 0
    fill_limit = max(0, limit - len(local_rows))
    latest_rows, upstream_total = await _fetch_mangadex_latest_search_fill(
        keyword=keyword,
        translated_language=translated_language,
        genre_values=genre_values,
        original_language_values=original_language_values,
        status_values=status_values,
        content_ratings=content_ratings,
        exclude_ids=ranked_ids,
        offset=fill_offset,
        limit=fill_limit,
    )
    if upstream_total <= 0:
        upstream_total = await _fetch_mangadex_search_total(
            keyword=keyword,
            translated_language=translated_language,
            genre_values=genre_values,
            original_language_values=original_language_values,
            status_values=status_values,
            content_ratings=content_ratings,
        )
    items = local_rows + latest_rows
    payload = {"mangas": items}
    await _async_attach_local_views_to_mangadex_payload(payload, db)

    total = upstream_total if upstream_total > 0 else local_match_count
    return {
        "data": {
            "items": payload.get("mangas") or [],
            "params": {
                "pagination": {
                    "totalItems": total,
                    "totalItemsPerPage": limit,
                    "currentPage": page,
                }
            },
        }
    }


async def _build_mangadex_popular_filtered_search(
    *,
    keyword: str,
    page: int,
    limit: int,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
    db: Any,
) -> dict[str, Any]:
    """Use official MangaDex /manga queries, then prefer local-viewed rows.

    Resolving every locally viewed MangaDex title against filters can fan out
    into hundreds of /manga/{id} calls. For tag/status searches, keep upstream
    traffic to the public /manga query shape, fetch a bounded cached candidate
    window, attach local views, then paginate the locally popular rows first.
    """
    safe_page = max(1, int(page))
    safe_limit = max(1, min(100, int(limit)))
    offset = (safe_page - 1) * safe_limit
    candidate_target = min(
        _MANGADEX_POPULAR_FILTERED_MAX_CANDIDATES,
        max(offset + safe_limit, _MANGADEX_POPULAR_FILTERED_CANDIDATE_LIMIT),
    )
    upstream_limit = min(100, max(safe_limit, 100))
    cache_key = (
        "manga:mangadex-popular-filtered:v10:"
        f"p={safe_page}:l={safe_limit}:target={candidate_target}:ll={_MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT}:"
        f"q={str(keyword or '').strip().lower()}:lang={translated_language}:"
        f"g={','.join(sorted(genre_values))}:orig={','.join(sorted(original_language_values))}:"
        f"s={','.join(sorted(status_values))}:rating={','.join(sorted(content_ratings))}"
    )
    snapshot_cache_key = (
        "manga:mangadex-popular-filtered-snapshot:v10:"
        f"l={safe_limit}:target={candidate_target}:ll={_MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT}:"
        f"q={str(keyword or '').strip().lower()}:lang={translated_language}:"
        f"g={','.join(sorted(genre_values))}:orig={','.join(sorted(original_language_values))}:"
        f"s={','.join(sorted(status_values))}:rating={','.join(sorted(content_ratings))}"
    )
    cached = _load_json_cache(cache_key)
    if cached is not None:
        return cached
    stale = _load_json_cache(f"{cache_key}:stale")
    snapshot = _load_json_cache(snapshot_cache_key)
    if isinstance(snapshot, dict):
        snapshot_items = snapshot.get("items") or []
        if isinstance(snapshot_items, list) and snapshot_items:
            snapshot_total = _safe_int(snapshot.get("totalItems"))
            snapshot_page_items = snapshot_items[offset: offset + safe_limit]
            snapshot_is_complete = snapshot_total <= len(snapshot_items)

            # A snapshot only contains the bounded candidate window used to
            # rank local views. Never use a short final slice as if it covered
            # the full MangaDex result set, or high page numbers become empty.
            if snapshot_is_complete or len(snapshot_page_items) >= safe_limit:
                result = {
                    "data": {
                        "items": snapshot_page_items,
                        "params": {
                            "pagination": {
                                "totalItems": max(snapshot_total, len(snapshot_items)),
                                "totalItemsPerPage": safe_limit,
                                "currentPage": safe_page,
                                "candidateItems": len(snapshot_items),
                                "candidateWindow": candidate_target,
                            }
                        },
                    }
                }
                raw = json.dumps(result, ensure_ascii=False)
                cache.set(cache_key, raw, ttl=MANGADEX_POPULAR_FILTERED_CACHE_TTL_SECONDS)
                cache.set(f"{cache_key}:stale", raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)
                return result

    views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)
    local_view_rows: list[dict[str, Any]] = []
    cached_catalog = (
        _load_mangadex_catalog_cache(None)
        or _load_mangadex_catalog_cache(10000)
        or _load_mangadex_catalog_cache(6000)
        or _load_mangadex_catalog_cache(3000)
        or _load_mangadex_catalog_cache(2000)
    )
    cached_mangas = (cached_catalog or {}).get("mangas") if isinstance(cached_catalog, dict) else []
    cached_by_id: dict[str, dict[str, Any]] = {}
    if isinstance(cached_mangas, list):
        for manga in cached_mangas:
            if not isinstance(manga, dict):
                continue
            manga_id = _extract_mangadex_id(manga.get("id") or manga.get("slug"))
            if manga_id and manga_id not in cached_by_id:
                cached_by_id[manga_id] = manga

    cached_filter_total = 0
    if cached_by_id:
        cached_filter_total = sum(
            1
            for cached_manga in cached_by_id.values()
            if _mangadex_lookup_matches_search_filters(
                cached_manga,
                keyword=keyword,
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            )
        )

    if cached_by_id and views_lookup:
        for manga_id, views in _top_local_viewed_mangadex_ids(
            views_lookup,
            limit=_MANGADEX_POPULAR_LOCAL_VIEW_LIMIT,
        ):
            cached_manga = cached_by_id.get(manga_id)
            if not cached_manga:
                continue
            if not _mangadex_lookup_matches_search_filters(
                cached_manga,
                keyword=keyword,
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            ):
                continue
            row = _legacy_mangadex_search_item_from_lookup(cached_manga, views)
            latest_chapter = None
            chapters = cached_manga.get("chapters")
            if isinstance(chapters, list) and chapters:
                latest_chapter = max(
                    (chapter for chapter in chapters if isinstance(chapter, dict)),
                    key=lambda chapter: (
                        _safe_float(str(chapter.get("chapter") or "").replace(",", ".")),
                        _parse_sort_timestamp(
                            chapter.get("publish_at")
                            or chapter.get("readable_at")
                            or chapter.get("created_at")
                            or chapter.get("updated_at")
                        ),
                    ),
                    default=None,
                )
            if isinstance(latest_chapter, dict) and latest_chapter.get("chapter"):
                row["chaptersLatest"] = [{
                    "chapter_name": str(latest_chapter.get("chapter") or ""),
                    "chapter_title": str(latest_chapter.get("chapter_with_groups") or ""),
                    "chapter_api_data": str(latest_chapter.get("id") or ""),
                    "publish_at": str(
                        latest_chapter.get("readable_at")
                        or latest_chapter.get("publish_at")
                        or latest_chapter.get("created_at")
                        or latest_chapter.get("updated_at")
                        or cached_manga.get("updated_at")
                        or ""
                    ),
                }]
                row["local_last_published_at"] = row["chaptersLatest"][0]["publish_at"]
                row["updatedAt"] = row["chaptersLatest"][0]["publish_at"] or row.get("updatedAt")
            local_view_rows.append(row)

    required_local_rows_for_page = min(
        offset + safe_limit,
        max(safe_limit, _MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT),
    )
    should_resolve_local_view_rows = (
        len(local_view_rows) < required_local_rows_for_page
    )

    if (
        should_resolve_local_view_rows
        and views_lookup
        and _MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT > 0
    ):
        local_lookup_limit = min(
            _MANGADEX_POPULAR_FILTERED_LOCAL_LOOKUP_LIMIT,
            max(
                safe_limit,
                required_local_rows_for_page - len(local_view_rows),
            ),
        )
        ranked_for_lookup = _top_local_viewed_mangadex_ids(
            views_lookup,
            limit=min(
                _MANGADEX_POPULAR_LOCAL_VIEW_LIMIT,
                local_lookup_limit,
            ),
        )
        resolved_local_rows: list[dict[str, Any]] = []
        if not str(keyword or "").strip():
            resolved_local_rows = await _resolve_local_viewed_mangadex_search_rows_batch(
                ranked_for_lookup,
                limit=local_lookup_limit,
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            )
        if not resolved_local_rows:
            resolved_local_rows, _ = await _resolve_local_viewed_mangadex_search_rows(
                ranked_for_lookup,
                offset=0,
                limit=local_lookup_limit,
                keyword=keyword,
                translated_language=translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
            )
        if resolved_local_rows:
            local_view_rows = [*local_view_rows, *resolved_local_rows]

    if local_view_rows and cached_filter_total > 0:
        local_candidates: list[dict[str, Any]] = []
        local_seen: set[str] = set()
        for item in local_view_rows:
            manga_id = _extract_mangadex_id((item or {}).get("slug") or (item or {}).get("id"))
            if not manga_id or manga_id in local_seen:
                continue
            local_seen.add(manga_id)
            local_candidates.append(item)

        local_payload = {"mangas": local_candidates}
        await _async_attach_local_views_to_mangadex_payload(local_payload, db)
        local_sorted_items = _sort_mangadex_items_by_local_views_first(local_payload.get("mangas") or [])
        local_page_items = local_sorted_items[offset: offset + safe_limit]
        if len(local_page_items) >= safe_limit:
            try:
                official_total = await _fetch_mangadex_search_total(
                    keyword=keyword,
                    translated_language=translated_language,
                    genre_values=genre_values,
                    original_language_values=original_language_values,
                    status_values=status_values,
                    content_ratings=content_ratings,
                )
            except RuntimeError:
                official_total = 0
            result_total_items = (
                official_total
                if official_total > 0
                else max(
                    cached_filter_total,
                    len(local_sorted_items),
                    offset + len(local_page_items),
                )
            )
            result = {
                "data": {
                    "items": local_page_items,
                    "params": {
                        "pagination": {
                            "totalItems": result_total_items,
                            "totalItemsPerPage": safe_limit,
                            "currentPage": safe_page,
                            "candidateItems": len(local_sorted_items),
                            "candidateWindow": len(local_sorted_items),
                            "localViewFastPath": True,
                        }
                    },
                }
            }
            raw = json.dumps(result, ensure_ascii=False)
            cache.set(cache_key, raw, ttl=MANGADEX_POPULAR_FILTERED_CACHE_TTL_SECONDS)
            cache.set(f"{cache_key}:stale", raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)
            return result

    collected: list[dict[str, Any]] = []
    seen: set[str] = set()
    upstream_total = 0

    try:
        cursor = 0
        while cursor < candidate_target:
            payload = await mangadex_service.search_manga(
                keyword=keyword,
                page=max(1, math.floor(cursor / max(1, upstream_limit)) + 1),
                limit=upstream_limit,
                translated_language=translated_language,
                attach_latest=False,
                included_tag_slugs=genre_values,
                included_tags_mode="AND",
                original_languages=original_language_values,
                statuses=status_values,
                sort="latest",
                content_ratings=content_ratings,
                offset_override=cursor,
            )
            page_data = payload.get("data") or {}
            pagination = (page_data.get("params") or {}).get("pagination") or {}
            upstream_total = max(upstream_total, _safe_int(pagination.get("totalItems")))
            page_items = page_data.get("items") or []
            if not isinstance(page_items, list) or not page_items:
                break

            for item in page_items:
                manga_id = _extract_mangadex_id((item or {}).get("slug") or (item or {}).get("id"))
                if not manga_id or manga_id in seen:
                    continue
                seen.add(manga_id)
                collected.append(item)

            cursor += len(page_items)
            if len(page_items) < upstream_limit:
                break
            if upstream_total > 0 and cursor >= upstream_total:
                break
    except RuntimeError:
        if stale is not None:
            return stale
        raise

    if not collected:
        data = await mangadex_service.search_manga(
            keyword=keyword,
            page=safe_page,
            limit=safe_limit,
            translated_language=translated_language,
            attach_latest=True,
            included_tag_slugs=genre_values,
            included_tags_mode="AND",
            original_languages=original_language_values,
            statuses=status_values,
            sort="latest",
            content_ratings=content_ratings,
        )
        items = ((data.get("data") or {}).get("items") or [])
        if not isinstance(items, list):
            items = []
        collected = items
        upstream_total = _safe_int(
            ((((data.get("data") or {}).get("params") or {}).get("pagination") or {}).get("totalItems"))
        )

    merged_candidates: list[dict[str, Any]] = []
    merged_by_id: dict[str, dict[str, Any]] = {}
    for item in [*local_view_rows, *collected]:
        manga_id = _extract_mangadex_id((item or {}).get("slug") or (item or {}).get("id"))
        if not manga_id:
            continue
        existing = merged_by_id.get(manga_id)
        if existing is None:
            merged_by_id[manga_id] = item
            merged_candidates.append(item)
            continue
        if (
            isinstance(existing, dict)
            and isinstance(item, dict)
            and not existing.get("chaptersLatest")
            and item.get("chaptersLatest")
        ):
            existing.update({
                "chaptersLatest": item.get("chaptersLatest"),
                "updatedAt": item.get("updatedAt") or existing.get("updatedAt"),
                "latest_uploaded_chapter": item.get("latest_uploaded_chapter")
                or existing.get("latest_uploaded_chapter"),
            })

    payload = {"mangas": merged_candidates}
    await _async_attach_local_views_to_mangadex_payload(payload, db)
    sorted_items = _sort_mangadex_items_by_local_views_first(payload.get("mangas") or [])
    page_items = sorted_items[offset: offset + safe_limit]

    if not page_items and offset >= len(sorted_items) and upstream_total > len(sorted_items):
        fallback = await mangadex_service.search_manga(
            keyword=keyword,
            page=safe_page,
            limit=safe_limit,
            translated_language=translated_language,
            attach_latest=True,
            included_tag_slugs=genre_values,
            included_tags_mode="AND",
            original_languages=original_language_values,
            statuses=status_values,
            sort="latest",
            content_ratings=content_ratings,
        )
        fallback_items = ((fallback.get("data") or {}).get("items") or [])
        if isinstance(fallback_items, list):
            fallback_payload = {"mangas": fallback_items}
            await _async_attach_local_views_to_mangadex_payload(fallback_payload, db)
            page_items = _sort_mangadex_items_by_local_views_first(fallback_payload.get("mangas") or [])
            upstream_total = max(
                upstream_total,
                _safe_int(
                    ((((fallback.get("data") or {}).get("params") or {}).get("pagination") or {}).get("totalItems"))
                ),
            )

    result_total_items = upstream_total if upstream_total > 0 else len(sorted_items)
    result = {
        "data": {
            "items": page_items,
            "params": {
                "pagination": {
                    "totalItems": result_total_items,
                    "totalItemsPerPage": safe_limit,
                    "currentPage": safe_page,
                    "candidateItems": len(sorted_items),
                    "candidateWindow": candidate_target,
                }
            },
        }
    }
    if page_items or result_total_items <= 0:
        if sorted_items:
            snapshot_raw = json.dumps(
                {
                    "items": sorted_items,
                    "totalItems": result_total_items,
                    "candidateWindow": candidate_target,
                },
                ensure_ascii=False,
            )
            cache.set(snapshot_cache_key, snapshot_raw, ttl=MANGADEX_POPULAR_FILTERED_CACHE_TTL_SECONDS)
            cache.set(f"{snapshot_cache_key}:stale", snapshot_raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)
        raw = json.dumps(result, ensure_ascii=False)
        cache.set(cache_key, raw, ttl=MANGADEX_POPULAR_FILTERED_CACHE_TTL_SECONDS)
        cache.set(f"{cache_key}:stale", raw, ttl=COMBINED_LIST_STALE_TTL_SECONDS)
    return result


async def _build_mangadex_rating_search(
    *,
    keyword: str,
    page: int,
    limit: int,
    translated_language: str,
    genre_values: list[str],
    original_language_values: list[str],
    status_values: list[str],
    content_ratings: list[str],
    hidden: dict[str, str],
    user: dict | None,
    db: Any,
) -> dict[str, Any]:
    offset = (max(1, page) - 1) * limit
    candidate_target = min(
        _MANGADEX_RATING_SORT_MAX_CANDIDATES,
        max(_MANGADEX_RATING_SORT_CANDIDATE_LIMIT, offset + limit),
    )
    upstream_limit = max(24, min(100, _MANGADEX_RATING_SORT_PAGE_SIZE))
    max_pages = max(1, math.ceil(candidate_target / upstream_limit))

    collected: list[dict[str, Any]] = []
    seen: set[str] = set()
    upstream_total = 0

    for upstream_page in range(1, max_pages + 1):
        payload = await mangadex_service.search_manga(
            keyword=keyword,
            page=upstream_page,
            limit=upstream_limit,
            translated_language=translated_language,
            attach_latest=True,
            included_tag_slugs=genre_values,
            included_tags_mode="AND",
            original_languages=original_language_values,
            statuses=status_values,
            sort="latest",
            content_ratings=content_ratings,
        )
        page_data = payload.get("data") or {}
        pagination = (page_data.get("params") or {}).get("pagination") or {}
        upstream_total = max(upstream_total, _safe_int(pagination.get("totalItems")))
        page_items = page_data.get("items") or []
        if not isinstance(page_items, list) or not page_items:
            break

        for item in page_items:
            manga_id = _extract_mangadex_id((item or {}).get("slug") or (item or {}).get("id"))
            if not manga_id or manga_id in seen:
                continue
            if hidden and _hidden_reason_for_slug(hidden, manga_id):
                continue
            seen.add(manga_id)
            collected.append(item)
            if len(collected) >= candidate_target:
                break

        if len(collected) >= candidate_target or len(page_items) < upstream_limit:
            break

    local_payload = {"mangas": collected}
    await _async_attach_local_views_to_mangadex_payload(local_payload, db)
    collected = local_payload.get("mangas") or []

    rating_payload = {
        "data": {
            "items": collected,
            "params": {
                "pagination": {
                    "totalItems": upstream_total,
                    "totalItemsPerPage": limit,
                    "currentPage": page,
                }
            },
        }
    }
    await _async_attach_ratings_to_items(rating_payload, db, user)
    sorted_items = _sort_mangadex_items_by_rating((rating_payload.get("data") or {}).get("items") or [])
    paged_items = sorted_items[offset: offset + limit]
    rating_payload["data"]["items"] = paged_items
    rating_payload["data"]["params"]["pagination"]["totalItems"] = max(upstream_total, len(sorted_items))
    return rating_payload


async def _async_inject_local_viewed_mangadex_rows(
    payload: Any,
    db: Any,
    *,
    hidden: dict[str, str] | None = None,
    limit: int = _MANGADEX_LOCAL_VIEWED_INJECT_LIMIT,
) -> None:
    """Ensure DB-viewed MangaDex titles exist in the catalog response.

    The MangaDex catalog is built from upstream feeds, so a locally popular title
    can be missing if it was not in the current MangaDex seed window. This keeps
    /manga?source=mangadex aligned with rankings by inserting those top local
    view rows before the frontend sorts them.
    """
    if not isinstance(payload, dict):
        return

    mangas = payload.get("mangas")
    if not isinstance(mangas, list):
        return

    views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)
    if not views_lookup:
        return

    existing_ids = {
        manga_id
        for manga_id in (
            _extract_mangadex_id((manga or {}).get("id") or (manga or {}).get("slug"))
            for manga in mangas
            if isinstance(manga, dict)
        )
        if manga_id
    }
    candidates = [
        (manga_id, views)
        for manga_id, views in _top_local_viewed_mangadex_ids(views_lookup, hidden=hidden, limit=limit)
        if manga_id not in existing_ids
    ]
    if not candidates:
        return

    semaphore = asyncio.Semaphore(max(1, _MANGADEX_LOCAL_VIEWED_LOOKUP_CONCURRENCY))

    async def _resolve_row(manga_id: str, views: int) -> dict[str, Any] | None:
        async with semaphore:
            try:
                lookup_payload = await asyncio.wait_for(
                    mangadex_service.get_manga_lookup(manga_id),
                    timeout=_MANGADEX_LOCAL_VIEWED_LOOKUP_TIMEOUT_SECONDS,
                )
            except Exception:
                lookup_payload = None

            manga = (lookup_payload or {}).get("manga") if isinstance(lookup_payload, dict) else None
            if not isinstance(manga, dict):
                manga = {
                    "id": manga_id,
                    "url": f"https://mangadex.org/title/{manga_id}",
                    "title": "",
                    "description": "",
                    "cover_url": "",
                    "authors": [],
                    "authors_text": "MangaDex",
                    "artists": [],
                    "genres": [],
                    "status": "",
                    "content_rating": "",
                    "updated_at": "",
                    "mangadex_popularity_rank": 0,
                    "mangadex_popularity_score": 0,
                }

            manga = dict(manga)
            manga["id"] = manga_id
            if not isinstance(manga.get("chapters"), list):
                manga["chapters"] = []
            manga["local_view_count"] = views
            manga["view_count"] = views
            manga["views"] = views
            manga["local_view_injected"] = True
            return manga

    resolved = await asyncio.gather(
        *[_resolve_row(manga_id, views) for manga_id, views in candidates],
        return_exceptions=True,
    )
    injected = [
        row for row in resolved
        if isinstance(row, dict) and _extract_mangadex_id(row.get("id"))
    ]
    if not injected:
        return

    payload["mangas"] = injected + mangas
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    payload["meta"] = {
        **meta,
        "total_manga": len(payload["mangas"]),
        "local_viewed_injected": int(meta.get("local_viewed_injected") or 0) + len(injected),
    }


def _insert_missing_first_seen_rows(db: Any, rows: list[dict[str, Any]]) -> None:
    """Best-effort backfill for chapter_first_seen rows, intentionally fire-and-forget."""
    if not rows:
        return
    try:
        db.table("chapter_first_seen").insert(rows).execute()
    except Exception:
        return


def _public_site_base(request: Request) -> str:
    configured = str(getattr(config, "FRONTEND_URL", "") or "").strip().rstrip("/")
    if configured:
        return configured
    return f"{request.url.scheme}://{request.url.netloc}".rstrip("/")


def _collapse_share_text(value: Any, max_length: int = 220) -> str:
    text = html_unescape(str(value or ""))
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_length:
        return text
    return text[: max(0, max_length - 1)].rstrip() + "..."


def _normalize_share_cover_url(value: Any, slug: str = "") -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("/api/"):
        return raw
    if raw.startswith("//"):
        return f"https:{raw}"
    if raw.startswith(("http://", "https://")):
        return raw

    normalized_raw = raw.lstrip("/")
    if normalized_raw.startswith("uploads/"):
        return f"https://img.otruyenapi.com/{normalized_raw}"
    if normalized_raw.startswith("comics/"):
        return f"https://img.otruyenapi.com/uploads/{normalized_raw}"
    return f"{OTRUYEN_IMG_CDN}{normalized_raw}"


def _absolute_share_url(request: Request, value: str) -> str:
    base = _public_site_base(request)
    url = str(value or "").strip()
    if not url:
        return f"{base}{DEFAULT_SHARE_IMAGE_PATH}"
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith(("http://", "https://")):
        return url
    if not url.startswith("/"):
        url = f"/{url}"
    return f"{base}{url}"


def _default_share_image_url(request: Request) -> str:
    return _absolute_share_url(request, DEFAULT_SHARE_IMAGE_PATH)


def _share_image_url(request: Request, cover_url: str) -> str:
    base = _public_site_base(request)
    normalized = str(cover_url or "").strip()
    if not normalized:
        return _default_share_image_url(request)
    if normalized.startswith("//"):
        normalized = f"https:{normalized}"
    if normalized.startswith(("http://", "https://")):
        return f"{base}/api/manga/og-image.jpg?url={quote(normalized, safe='')}"
    return _absolute_share_url(request, normalized)


def _share_title(value: Any, fallback: str = "MangaHub") -> str:
    title = _collapse_share_text(value, max_length=90)
    return title or fallback


def _chapter_share_label(chapter_number: Any, chapter_title: Any = "") -> str:
    number = _collapse_share_text(chapter_number, max_length=40)
    title = _collapse_share_text(chapter_title, max_length=90)
    if number and title:
        return f"Chương {number}: {title}"
    if number:
        return f"Chương {number}"
    return title or "Chương mới"


def _extract_otruyen_chapter_manga_slug(item: dict[str, Any]) -> str:
    for key in ("comic_slug", "manga_slug", "slug"):
        value = _clean_slug(item.get(key))
        if value and not _is_invalid_manga_slug(value):
            return value

    chapter_path = str(item.get("chapter_path") or item.get("path") or "").strip()
    parts = [part for part in chapter_path.split("/") if part.strip()]
    reserved = {"uploads", "comics", "chapters", "chapter", "api", "img", "images", "v1", "data"}

    def is_invalid_candidate(value: str) -> bool:
        slug = _clean_slug(value)
        if not slug or len(slug) < 3 or slug in reserved:
            return True
        if re.fullmatch(r"\d+", slug) or re.fullmatch(r"[0-9a-f]{20,}", slug):
            return True
        compact = re.sub(r"[-_\s.]+", "", slug)
        return bool(re.match(r"^(c|ch|chap|chapter|chuong|tap|episode|ep)\d", compact))

    for index, part in enumerate(parts):
        if part.lower() == "comics" and index + 1 < len(parts):
            candidate = _clean_slug(parts[index + 1])
            if not is_invalid_candidate(candidate):
                return candidate

    for part in parts:
        candidate = _clean_slug(part)
        if "-" in candidate and not is_invalid_candidate(candidate):
            return candidate
    return ""


async def _resolve_share_identifier(identifier: str) -> tuple[str, str]:
    raw_identifier = str(identifier or "").strip()
    if not raw_identifier:
        raise HTTPException(status_code=404, detail="Manga not found")

    otruyen_object_id = _decode_otruyen_route_id(raw_identifier)
    if otruyen_object_id:
        resolved_slug = await truyenqq_service.resolve_slug_from_id(otruyen_object_id)
        if not resolved_slug:
            raise HTTPException(status_code=404, detail="Manga not found")
        return _clean_slug(resolved_slug), raw_identifier

    return raw_identifier, raw_identifier


async def _build_manga_share_meta(
    request: Request,
    *,
    identifier: str,
    source: str | None,
    db: Any,
) -> dict[str, str]:
    raw_source = str(source or "").strip().lower()
    if raw_source and raw_source not in {"mangadex", "truyenqq"}:
        raise HTTPException(status_code=404, detail="Manga not found")

    normalized_identifier, canonical_token = await _resolve_share_identifier(identifier)
    mangadex_id = _extract_mangadex_id(normalized_identifier)
    if raw_source == "mangadex" and not mangadex_id:
        raise HTTPException(status_code=404, detail="Manga not found")
    if raw_source == "truyenqq":
        mangadex_id = None

    if not mangadex_id and _is_invalid_manga_slug(normalized_identifier):
        raise HTTPException(status_code=404, detail="Manga not found")

    hidden = await _get_hidden_slugs(db)
    hidden_reason = (
        _hidden_reason_for_slug(hidden, normalized_identifier)
        or _hidden_reason_for_slug(hidden, canonical_token)
        or (_hidden_reason_for_slug(hidden, mangadex_id) if mangadex_id else None)
    )
    if hidden_reason:
        raise HTTPException(status_code=451, detail={"hidden": True, "reason": hidden_reason})

    title = ""
    description = ""
    cover_url = ""
    share_source = "mangadex" if mangadex_id else "truyenqq"

    if not mangadex_id:
        uploaded_manga = await asyncio.to_thread(
            lambda: _safe_query(
                lambda: db.table("manga_uploads")
                .select("manga_slug,title,description,cover_url,publish_status,genres,updated_at")
                .eq("manga_slug", normalized_identifier)
                .eq("status", "published")
                .maybe_single()
                .execute()
            )
        )
        uploaded = getattr(uploaded_manga, "data", None) if uploaded_manga is not None else None
        if isinstance(uploaded, dict) and uploaded:
            item = {
                "slug": uploaded.get("manga_slug") or normalized_identifier,
                "name": uploaded.get("title") or "",
                "content": uploaded.get("description") or "",
                "thumb_url": uploaded.get("cover_url") or "",
            }
            override_rows = await _fetch_override_rows_by_slugs(db, [item["slug"], normalized_identifier])
            _apply_override_fields(item, _resolve_override_row(override_rows, item["slug"]))
            title = _share_title(item.get("name"), fallback=normalized_identifier)
            description = _collapse_share_text(item.get("content"))
            cover_url = _normalize_share_cover_url(item.get("thumb_url"), str(item.get("slug") or normalized_identifier))
            share_source = "mangahub"

    if mangadex_id:
        lookup = await mangadex_service.get_manga_lookup(mangadex_id)
        manga = (lookup or {}).get("manga") or {}
        if not isinstance(manga, dict) or not manga:
            raise HTTPException(status_code=404, detail="Manga not found")
        manga = dict(manga)
        override_rows = await _fetch_override_rows_by_slugs(db, [mangadex_id, f"mdx-{mangadex_id}"])
        _apply_override_fields(manga, _resolve_override_row(override_rows, mangadex_id))
        title = _share_title(manga.get("title") or manga.get("name"), fallback=f"MangaDex {mangadex_id[:8]}")
        description = _collapse_share_text(
            manga.get("description") or manga.get("content") or f"Doc {title} tren MangaHub."
        )
        cover_url = _normalize_share_cover_url(manga.get("cover_url") or manga.get("thumb_url"), mangadex_id)
        canonical_token = mangadex_id
        share_source = "mangadex"
    elif not title:
        detail = await truyenqq_service.get_manga_detail(normalized_identifier)
        item = (detail.get("data") or {}).get("item") if isinstance(detail, dict) else None
        if not isinstance(item, dict):
            raise HTTPException(status_code=404, detail="Manga not found")

        item = dict(item)
        detail_slug = str(item.get("slug") or normalized_identifier).strip()
        override_rows = await _fetch_override_rows_by_slugs(db, [detail_slug, normalized_identifier])
        _apply_override_fields(item, _resolve_override_row(override_rows, detail_slug))
        seo = (detail.get("data") or {}).get("seoOnPage") if isinstance(detail, dict) else {}
        if not isinstance(seo, dict):
            seo = {}

        title = _share_title(item.get("name") or seo.get("titleHead"), fallback=detail_slug or normalized_identifier)
        description = _collapse_share_text(
            seo.get("descriptionHead") or item.get("content") or f"Doc {title} tren MangaHub."
        )
        cover_url = _normalize_share_cover_url(item.get("thumb_url") or item.get("cover_url"), detail_slug)
        canonical_token = canonical_token or detail_slug or normalized_identifier

    canonical_url = f"{_public_site_base(request)}/manga/{quote(str(canonical_token or identifier).strip(), safe='')}"
    image_url = _share_image_url(request, cover_url)
    if not description:
        description = f"Doc {title} tren MangaHub."

    return {
        "title": title,
        "description": description,
        "image_url": image_url,
        "canonical_url": canonical_url,
        "source": share_source,
    }


async def _build_chapter_share_meta(
    request: Request,
    *,
    chapter_id: str,
    db: Any,
) -> dict[str, str]:
    raw_chapter_id = str(chapter_id or "").strip()
    if not raw_chapter_id:
        raise HTTPException(status_code=404, detail="Chapter not found")

    canonical_url = f"{_public_site_base(request)}/chapter/{quote(raw_chapter_id, safe='')}"

    if raw_chapter_id.startswith("upload-"):
        upload_id = raw_chapter_id[7:].strip()
        result = await asyncio.to_thread(
            lambda: _safe_query(
                lambda: db.table("chapter_uploads")
                .select("id,manga_slug,chapter_number,chapter_title,status,published_at,created_at")
                .eq("id", upload_id)
                .maybe_single()
                .execute()
            )
        )
        row = getattr(result, "data", None) if result is not None else None
        if isinstance(row, dict) and row:
            status = str(row.get("status") or "published").strip().lower()
            if status and status != "published":
                raise HTTPException(status_code=404, detail="Chapter not found")
            manga_slug = _clean_slug(row.get("manga_slug"))
            manga_meta = await _build_manga_share_meta(
                request,
                identifier=manga_slug,
                source=None,
                db=db,
            )
            chapter_label = _chapter_share_label(row.get("chapter_number"), row.get("chapter_title"))
            manga_title = manga_meta.get("title") or "MangaHub"
            return {
                **manga_meta,
                "title": f"{manga_title} - {chapter_label}",
                "description": f"Đọc {chapter_label} của {manga_title} trên MangaHub.",
                "canonical_url": canonical_url,
                "source": "mangahub-chapter",
            }

    mangadex_chapter_id = _extract_mangadex_id(raw_chapter_id)
    if mangadex_chapter_id:
        try:
            payload = await mangadex_service.get_chapter_metadata(mangadex_chapter_id)
            chapter = (payload or {}).get("data") or {}
            attributes = chapter.get("attributes") or {}
            relationships = chapter.get("relationships") or []
            manga_id = ""
            if isinstance(relationships, list):
                for rel in relationships:
                    if isinstance(rel, dict) and rel.get("type") == "manga":
                        manga_id = _extract_mangadex_id(rel.get("id")) or ""
                        break
            if manga_id:
                manga_meta = await _build_manga_share_meta(
                    request,
                    identifier=manga_id,
                    source="mangadex",
                    db=db,
                )
                chapter_label = _chapter_share_label(
                    attributes.get("chapter"),
                    attributes.get("title"),
                )
                manga_title = manga_meta.get("title") or "MangaHub"
                return {
                    **manga_meta,
                    "title": f"{manga_title} - {chapter_label}",
                    "description": f"Đọc {chapter_label} của {manga_title} trên MangaHub.",
                    "canonical_url": canonical_url,
                    "source": "mangadex-chapter",
                }
        except Exception:
            pass

    try:
        chapter_payload = await truyenqq_service.get_chapter(raw_chapter_id)
    except Exception:
        chapter_payload = None
    item = (chapter_payload or {}).get("data", {}).get("item") if isinstance(chapter_payload, dict) else None
    if isinstance(item, dict):
        manga_slug = _extract_otruyen_chapter_manga_slug(item)
        chapter_label = _chapter_share_label(
            item.get("chapter_name") or item.get("chapter"),
            item.get("chapter_title") or item.get("name") or item.get("title"),
        )
        if manga_slug:
            manga_meta = await _build_manga_share_meta(
                request,
                identifier=manga_slug,
                source="truyenqq",
                db=db,
            )
            manga_title = manga_meta.get("title") or "MangaHub"
            return {
                **manga_meta,
                "title": f"{manga_title} - {chapter_label}",
                "description": f"Đọc {chapter_label} của {manga_title} trên MangaHub.",
                "canonical_url": canonical_url,
                "source": "otruyen-chapter",
            }

        return {
            "title": f"MangaHub - {chapter_label}",
            "description": f"Đọc {chapter_label} trên MangaHub.",
            "image_url": _default_share_image_url(request),
            "canonical_url": canonical_url,
            "source": "chapter",
        }

    return {
        "title": "MangaHub - Đọc truyện tranh online",
        "description": "Đọc truyện tranh online trên MangaHub.",
        "image_url": _default_share_image_url(request),
        "canonical_url": canonical_url,
        "source": "chapter",
    }


def _render_manga_share_html(meta: dict[str, str]) -> str:
    title = html_escape(meta.get("title") or "MangaHub", quote=True)
    description = html_escape(meta.get("description") or "Doc truyen tranh online tren MangaHub.", quote=True)
    image_url = html_escape(meta.get("image_url") or "", quote=True)
    canonical_url = html_escape(meta.get("canonical_url") or "", quote=True)
    source = html_escape(meta.get("source") or "mangahub", quote=True)
    is_default_image = DEFAULT_SHARE_IMAGE_PATH in str(meta.get("image_url") or "")
    image_width = "1200" if is_default_image else "512"
    image_height = "630" if is_default_image else "768"
    image_type_tag = '<meta property="og:image:type" content="image/png">' if is_default_image else ""

    return f"""<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title} | MangaHub</title>
    <meta name="description" content="{description}">
    <link rel="canonical" href="{canonical_url}">
    <meta property="og:site_name" content="MangaHub">
    <meta property="og:type" content="article">
    <meta property="og:locale" content="vi_VN">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{description}">
    <meta property="og:url" content="{canonical_url}">
    <meta property="og:image" content="{image_url}">
    <meta property="og:image:secure_url" content="{image_url}">
    <meta property="og:image:alt" content="{title}">
    {image_type_tag}
    <meta property="og:image:width" content="{image_width}">
    <meta property="og:image:height" content="{image_height}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{image_url}">
    <meta name="mangahub:source" content="{source}">
    <meta http-equiv="refresh" content="1;url={canonical_url}">
  </head>
  <body>
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      <p><a href="{canonical_url}">Mo tren MangaHub</a></p>
    </main>
    <script>setTimeout(function(){{location.replace({json.dumps(meta.get("canonical_url") or "/")});}}, 150);</script>
  </body>
</html>"""


def _render_manga_seo_html(meta: dict[str, str]) -> str:
    raw_title = meta.get("title") or "MangaHub"
    raw_description = meta.get("description") or "Doc truyen tranh online tren MangaHub."
    raw_image_url = meta.get("image_url") or ""
    raw_canonical_url = meta.get("canonical_url") or ""
    raw_site_url = raw_canonical_url.split("/manga/", 1)[0] if "/manga/" in raw_canonical_url else raw_canonical_url

    title = html_escape(raw_title, quote=True)
    description = html_escape(raw_description, quote=True)
    image_url = html_escape(raw_image_url, quote=True)
    canonical_url = html_escape(raw_canonical_url, quote=True)
    source = html_escape(meta.get("source") or "mangahub", quote=True)
    is_default_image = DEFAULT_SHARE_IMAGE_PATH in raw_image_url
    image_width = "1200" if is_default_image else "512"
    image_height = "630" if is_default_image else "768"
    image_type_tag = '<meta property="og:image:type" content="image/png">' if is_default_image else ""
    image_html = f'<img src="{image_url}" alt="{title}" width="{image_width}" height="{image_height}">' if image_url else ""
    json_ld = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "Book",
            "name": raw_title,
            "description": raw_description,
            "image": raw_image_url,
            "url": raw_canonical_url,
            "inLanguage": "vi",
            "isAccessibleForFree": True,
            "publisher": {
                "@type": "Organization",
                "name": "MangaHub",
                "url": raw_site_url,
            },
        },
        ensure_ascii=False,
    )
    safe_json_ld = (
        json_ld
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )

    return f"""<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title} - MangaHub</title>
    <meta name="description" content="{description}">
    <link rel="canonical" href="{canonical_url}">
    <meta name="robots" content="index, follow, max-image-preview:large">
    <meta property="og:site_name" content="MangaHub">
    <meta property="og:type" content="article">
    <meta property="og:locale" content="vi_VN">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{description}">
    <meta property="og:url" content="{canonical_url}">
    <meta property="og:image" content="{image_url}">
    <meta property="og:image:secure_url" content="{image_url}">
    <meta property="og:image:alt" content="{title}">
    {image_type_tag}
    <meta property="og:image:width" content="{image_width}">
    <meta property="og:image:height" content="{image_height}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{image_url}">
    <meta name="mangahub:source" content="{source}">
    <script type="application/ld+json">{safe_json_ld}</script>
  </head>
  <body>
    <main>
      <article>
        <h1>{title}</h1>
        <p>{description}</p>
        {image_html}
        <p><a href="{canonical_url}">Đọc {title} trên MangaHub</a></p>
      </article>
    </main>
  </body>
</html>"""


def _parse_share_path(share_path: str) -> tuple[str | None, str]:
    parts = [part for part in str(share_path or "").strip("/").split("/") if part]
    if len(parts) == 1:
        return None, parts[0]
    if len(parts) == 2 and parts[0].lower() in {"mangadex", "truyenqq"}:
        return parts[0].lower(), parts[1]
    raise HTTPException(status_code=404, detail="Manga not found")


def _sitemap_lastmod(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", raw)
    if match:
        return match.group(1)
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except Exception:
        return ""


def _sitemap_pick_lastmod(item: dict[str, Any]) -> str:
    for key in (
        "updated_at",
        "updatedAt",
        "local_last_published_at",
        "last_published_at",
        "published_at",
        "created_at",
        "createdAt",
    ):
        lastmod = _sitemap_lastmod((item or {}).get(key))
        if lastmod:
            return lastmod
    return ""


def _sitemap_xml_response(
    xml: str,
    max_age: int = 1800,
    extra_headers: dict[str, str] | None = None,
) -> Response:
    headers = {
        "Cache-Control": f"public, max-age={max_age}, stale-while-revalidate=86400",
        "X-Robots-Tag": "index, follow",
        "X-MangaHub-Sitemap-Version": SITEMAP_CACHE_VERSION,
        "X-MangaHub-Sitemap-Url-Count": str(xml.count("<url>")),
    }
    if extra_headers:
        headers.update(extra_headers)
    return Response(
        content=xml,
        media_type="application/xml; charset=utf-8",
        headers=headers,
    )


def _render_sitemap_urlset(entries: list[dict[str, str]]) -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for entry in entries:
        loc = html_escape(str(entry.get("loc") or ""), quote=True)
        if not loc:
            continue
        lastmod = html_escape(str(entry.get("lastmod") or ""), quote=True)
        changefreq = html_escape(str(entry.get("changefreq") or "weekly"), quote=True)
        priority = html_escape(str(entry.get("priority") or "0.7"), quote=True)
        lines.append("  <url>")
        lines.append(f"    <loc>{loc}</loc>")
        if lastmod:
            lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <changefreq>{changefreq}</changefreq>")
        lines.append(f"    <priority>{priority}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines)


def _add_sitemap_entry(
    entries: list[dict[str, str]],
    seen: set[str],
    *,
    loc: str,
    lastmod: str = "",
    changefreq: str = "weekly",
    priority: str = "0.7",
) -> None:
    clean_loc = str(loc or "").strip()
    if not clean_loc or clean_loc in seen:
        return
    seen.add(clean_loc)
    entries.append(
        {
            "loc": clean_loc,
            "lastmod": lastmod,
            "changefreq": changefreq,
            "priority": priority,
        }
    )


async def _collect_uploaded_sitemap_entries(
    request: Request,
    db: Any,
    hidden: dict[str, str],
    entries: list[dict[str, str]],
    seen: set[str],
    limit: int,
) -> None:
    if limit <= 0:
        return
    base = _public_site_base(request)
    try:
        result = await asyncio.to_thread(
            lambda: db.table("manga_uploads")
            .select("manga_slug,updated_at,created_at")
            .eq("status", "published")
            .order("updated_at", desc=True)
            .limit(limit)
            .execute()
        )
        rows = getattr(result, "data", None) or []
    except Exception:
        rows = []

    for row in rows:
        if not isinstance(row, dict):
            continue
        slug = _clean_slug(row.get("manga_slug"))
        if not slug or _hidden_reason_for_slug(hidden, slug):
            continue
        _add_sitemap_entry(
            entries,
            seen,
            loc=f"{base}/manga/{quote(slug, safe='')}",
            lastmod=_sitemap_pick_lastmod(row),
            changefreq="weekly",
            priority="0.8",
        )


async def _collect_local_activity_sitemap_entries(
    request: Request,
    db: Any,
    hidden: dict[str, str],
    entries: list[dict[str, str]],
    seen: set[str],
    limit: int,
) -> None:
    if limit <= 0:
        return

    base = _public_site_base(request)
    local_seen: set[str] = set()
    table_specs: tuple[tuple[str, str, str, str, str], ...] = (
        ("manga_views", "manga_slug,updated_at", "views", "updated_at", "0.86"),
        ("reading_history", "manga_slug,read_at", "read_at", "read_at", "0.84"),
        ("bookmarks", "manga_slug,created_at", "created_at", "created_at", "0.82"),
        ("follows", "manga_slug,created_at", "created_at", "created_at", "0.82"),
        ("ratings", "manga_slug,updated_at,created_at", "updated_at", "updated_at", "0.8"),
        ("comments", "manga_slug,updated_at,created_at", "updated_at", "updated_at", "0.78"),
    )

    for table, select_expr, order_col, lastmod_col, priority in table_specs:
        remaining = limit - len(local_seen)
        if remaining <= 0:
            break
        try:
            result = await asyncio.to_thread(
                lambda table=table, select_expr=select_expr, order_col=order_col, remaining=remaining: (
                    db.table(table)
                    .select(select_expr)
                    .order(order_col, desc=True)
                    .limit(min(remaining, 1000))
                    .execute()
                )
            )
            rows = getattr(result, "data", None) or []
        except Exception:
            rows = []

        for row in rows:
            if not isinstance(row, dict):
                continue
            slug = _clean_slug(row.get("manga_slug"))
            if (
                not slug
                or slug in local_seen
                or _is_invalid_manga_slug(slug)
                or _hidden_reason_for_slug(hidden, slug)
            ):
                continue
            local_seen.add(slug)
            _add_sitemap_entry(
                entries,
                seen,
                loc=f"{base}/manga/{quote(slug, safe='')}",
                lastmod=_sitemap_pick_lastmod({
                    "updated_at": row.get(lastmod_col) or row.get("updated_at") or row.get("created_at"),
                }),
                changefreq="daily",
                priority=priority,
            )


async def _load_sitemap_mangadex_payload() -> dict[str, Any] | None:
    cached_payload = _load_best_mangadex_catalog_cache(None, min_count=700)
    if _payload_manga_count(cached_payload) >= 700:
        return cached_payload

    live_payload: dict[str, Any] | None = None
    try:
        live_result = await asyncio.wait_for(
            mangadex_service.get_popular_first_catalog(max_chapters=None),
            timeout=SITEMAP_MANGADEX_TIMEOUT_SECONDS,
        )
        if isinstance(live_result, dict):
            live_payload = live_result
    except Exception:
        live_payload = None

    if _payload_manga_count(live_payload) > _payload_manga_count(cached_payload):
        return live_payload
    return cached_payload


async def _collect_mangadex_sitemap_entries(
    request: Request,
    hidden: dict[str, str],
    entries: list[dict[str, str]],
    seen: set[str],
    limit: int,
) -> None:
    if limit <= 0:
        return
    base = _public_site_base(request)
    payload = await _load_sitemap_mangadex_payload()
    mangas = (payload or {}).get("mangas") if isinstance(payload, dict) else []
    if not isinstance(mangas, list):
        return

    added = 0
    for manga in mangas:
        if not isinstance(manga, dict) or added >= limit:
            break
        manga_id = _extract_mangadex_id(manga.get("id"))
        if not manga_id or _hidden_reason_for_slug(hidden, manga_id):
            continue
        before = len(seen)
        _add_sitemap_entry(
            entries,
            seen,
            loc=f"{base}/manga/{quote(manga_id, safe='')}",
            lastmod=_sitemap_pick_lastmod(manga),
            changefreq="weekly",
            priority="0.75",
        )
        if len(seen) > before:
            added += 1


def _otruyen_items_from_payload(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    candidates = [
        data.get("items"),
        payload.get("items"),
        data.get("mangas"),
        payload.get("mangas"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return []


async def _collect_otruyen_sitemap_entries(
    request: Request,
    hidden: dict[str, str],
    entries: list[dict[str, str]],
    seen: set[str],
    limit: int,
) -> None:
    if limit <= 0:
        return
    base = _public_site_base(request)
    started_at = time.monotonic()
    jobs: list[tuple[str, str, int]] = [("home", "", 1)]
    for list_type in ("truyen-moi", "dang-phat-hanh", "hoan-thanh", "sap-ra-mat"):
        for page in range(1, SITEMAP_OTRUYEN_PAGE_LIMIT + 1):
            jobs.append(("list", list_type, page))

    results: list[Any] = []
    for start in range(0, len(jobs), SITEMAP_OTRUYEN_BATCH_SIZE):
        remaining = SITEMAP_OTRUYEN_TIMEOUT_SECONDS - (time.monotonic() - started_at)
        if remaining <= 0:
            break
        batch_specs = jobs[start : start + SITEMAP_OTRUYEN_BATCH_SIZE]
        batch = [
            truyenqq_service.get_home()
            if kind == "home"
            else truyenqq_service.get_list(list_type, page)
            for kind, list_type, page in batch_specs
        ]
        try:
            batch_results = await asyncio.wait_for(
                asyncio.gather(*batch, return_exceptions=True),
                timeout=remaining,
            )
            results.extend(batch_results)
        except Exception:
            break

    added = 0
    for payload in results:
        if added >= limit or not isinstance(payload, dict):
            continue
        for item in _otruyen_items_from_payload(payload):
            if added >= limit:
                break
            slug = _clean_slug(item.get("slug"))
            if not slug or _is_invalid_manga_slug(slug) or _hidden_reason_for_slug(hidden, slug):
                continue
            before = len(seen)
            _add_sitemap_entry(
                entries,
                seen,
                loc=f"{base}/manga/{quote(slug, safe='')}",
                lastmod=_sitemap_pick_lastmod(item),
                changefreq="weekly",
                priority="0.7",
            )
            if len(seen) > before:
                added += 1


@router.get("/og-image.jpg")
async def manga_og_image(url: str, request: Request, retry: int = 0):
    """Stable .jpg-looking image proxy URL for OpenGraph crawlers."""
    from fastapi_app.routers import images as image_proxy

    validation_error = await image_proxy._validate_image_url(url)
    if validation_error:
        return RedirectResponse(_default_share_image_url(request), status_code=302)

    key = image_proxy._cache_key(url)
    cached_path = image_proxy.CACHE_DIR / key
    force_refetch = retry > 0
    if not force_refetch:
        cached = image_proxy._cached_image_response(cached_path, request)
        if cached is not None:
            return cached

    lock = image_proxy._cache_lock_for_key(key)
    async with lock:
        if not force_refetch:
            cached = image_proxy._cached_image_response(cached_path, request)
            if cached is not None:
                return cached
        data, fetch_info, content_type, transport = await image_proxy._fetch_image(url, retry_hint=retry)

    if data is None:
        stale = image_proxy._cached_image_response(cached_path, request, cache_status="STALE")
        if stale is not None:
            return stale
        logger.warning("OG image fetch failed: %s - %s", url, fetch_info)
        return RedirectResponse(_default_share_image_url(request), status_code=302)

    try:
        image_proxy._write_cache_atomic(cached_path, data)
        image_proxy.schedule_image_cache_prune()
    except Exception as exc:
        logger.warning("OG image cache write failed: %s", exc)

    return Response(
        content=data,
        media_type=content_type or image_proxy.EXT_CONTENT_TYPE.get(cached_path.suffix, "image/jpeg"),
        headers={
            **image_proxy.COMMON_HEADERS,
            "X-Cache": "MISS",
            "X-Upstream-Transport": transport or "unknown",
        },
    )


@router.get("/share-chapter/{chapter_id:path}", response_class=HTMLResponse)
async def chapter_share_preview(
    request: Request,
    chapter_id: str,
    db=Depends(get_supabase_public),
):
    meta = await _build_chapter_share_meta(request, chapter_id=chapter_id, db=db)
    return HTMLResponse(
        content=_render_manga_share_html(meta),
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
            "X-Robots-Tag": "index, follow",
        },
    )


@router.get("/seo-chapter/{chapter_id:path}", response_class=HTMLResponse)
async def chapter_seo_preview(
    request: Request,
    chapter_id: str,
    db=Depends(get_supabase_public),
):
    meta = await _build_chapter_share_meta(request, chapter_id=chapter_id, db=db)
    return HTMLResponse(
        content=_render_manga_seo_html(meta),
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
            "X-Robots-Tag": "index, follow, max-image-preview:large",
        },
    )


@router.get("/share/{share_path:path}", response_class=HTMLResponse)
async def manga_share_preview(
    request: Request,
    share_path: str,
    db=Depends(get_supabase_public),
):
    source, identifier = _parse_share_path(share_path)

    meta = await _build_manga_share_meta(
        request,
        identifier=identifier,
        source=source,
        db=db,
    )
    return HTMLResponse(
        content=_render_manga_share_html(meta),
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
            "X-Robots-Tag": "index, follow",
        },
    )


@router.get("/seo/{share_path:path}", response_class=HTMLResponse)
async def manga_seo_preview(
    request: Request,
    share_path: str,
    db=Depends(get_supabase_public),
):
    source, identifier = _parse_share_path(share_path)
    meta = await _build_manga_share_meta(
        request,
        identifier=identifier,
        source=source,
        db=db,
    )
    return HTMLResponse(
        content=_render_manga_seo_html(meta),
        media_type="text/html; charset=utf-8",
        headers={
            "Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
            "X-Robots-Tag": "index, follow, max-image-preview:large",
        },
    )


@router.get("/sitemap-manga.xml")
async def manga_sitemap_xml(
    request: Request,
    limit: int = Query(15000, ge=1, le=50000),
    db=Depends(get_supabase_public),
):
    cache_key = f"manga:sitemap:{SITEMAP_CACHE_VERSION}:{limit}"
    cached_xml = cache.get(cache_key)
    if cached_xml:
        return _sitemap_xml_response(
            cached_xml,
            max_age=SITEMAP_CACHE_TTL_SECONDS,
            extra_headers={"X-MangaHub-Sitemap-Cache": "HIT"},
        )

    hidden = await _get_hidden_slugs(db)
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    upload_limit = min(2000, limit)

    await _collect_uploaded_sitemap_entries(
        request,
        db,
        hidden,
        entries,
        seen,
        upload_limit,
    )
    uploaded_count = len(entries)

    local_activity_limit = max(0, min(SITEMAP_LOCAL_ACTIVITY_LIMIT, limit - len(entries)))
    await _collect_local_activity_sitemap_entries(
        request,
        db,
        hidden,
        entries,
        seen,
        local_activity_limit,
    )
    local_activity_count = len(entries) - uploaded_count

    mangadex_limit = max(0, min(5000, limit - len(entries)))
    await _collect_mangadex_sitemap_entries(
        request,
        hidden,
        entries,
        seen,
        mangadex_limit,
    )
    mangadex_count = len(entries) - uploaded_count

    otruyen_limit = max(0, limit - len(entries))
    await _collect_otruyen_sitemap_entries(
        request,
        hidden,
        entries,
        seen,
        otruyen_limit,
    )
    otruyen_count = len(entries) - uploaded_count - local_activity_count - mangadex_count

    xml = _render_sitemap_urlset(entries)
    cache.set(cache_key, xml, SITEMAP_CACHE_TTL_SECONDS)
    return _sitemap_xml_response(
        xml,
        max_age=SITEMAP_CACHE_TTL_SECONDS,
        extra_headers={
            "X-MangaHub-Sitemap-Cache": "MISS",
            "X-MangaHub-Sitemap-Uploads": str(uploaded_count),
            "X-MangaHub-Sitemap-Local-Activity": str(local_activity_count),
            "X-MangaHub-Sitemap-MangaDex": str(mangadex_count),
            "X-MangaHub-Sitemap-OTruyen": str(otruyen_count),
        },
    )


@router.get("/detail/{slug}")
async def manga_detail(slug: str, db=Depends(get_supabase_public)):
    """Chi tiết truyện — parallelized DB lookups for speed."""
    import asyncio

    raw_identifier = str(slug or "").strip()
    normalized_slug = raw_identifier
    otruyen_object_id = _decode_otruyen_route_id(raw_identifier)
    if otruyen_object_id:
        resolved_slug = await truyenqq_service.resolve_slug_from_id(otruyen_object_id)
        if not resolved_slug:
            raise HTTPException(status_code=404, detail="Manga not found")
        normalized_slug = resolved_slug

    if _is_invalid_manga_slug(normalized_slug):
        raise HTTPException(status_code=404, detail="Manga not found")

    # ── Block hidden manga ──────────────────────────────────────
    hidden_task = _get_hidden_slugs(db)

    # ── Check user-uploaded manga (manga_uploads table) ─────────
    hidden, uploaded_manga = await asyncio.gather(hidden_task, asyncio.to_thread(
        lambda: _safe_query(
            lambda: db.table("manga_uploads")
            .select("*")
            .eq("manga_slug", normalized_slug)
            .eq("status", "published")
            .maybe_single()
            .execute()
        )
    ))
    hidden_reason = _hidden_reason_for_slug(hidden, normalized_slug) or _hidden_reason_for_slug(hidden, raw_identifier)
    if hidden_reason:
        raise HTTPException(status_code=451, detail={"hidden": True, "reason": hidden_reason})
    if uploaded_manga and hasattr(uploaded_manga, "data") and uploaded_manga.data:
        um = uploaded_manga.data
        # Fetch published chapters for this manga
        uploaded_chapters = await asyncio.to_thread(
            lambda: _safe_query(
                lambda: db.table("chapter_uploads")
                .select("id, chapter_number, chapter_title, pages, language, created_at, published_at, uploader_id")
                .eq("manga_slug", normalized_slug)
                .eq("status", "published")
                .order("chapter_number", desc=False)
                .execute()
            )
        )
        chapters_data = []
        if uploaded_chapters and hasattr(uploaded_chapters, "data"):
            for ch in (uploaded_chapters.data or []):
                chapters_data.append({
                    "chapter_name": str(ch.get("chapter_number", "")),
                    "chapter_title": ch.get("chapter_title", ""),
                    "chapter_id": f"upload-{ch['id']}",
                    "chapter_api_data": f"upload-{ch['id']}",
                    "pages": ch.get("pages", []),
                    "uploader": "",
                    "created_at": ch.get("published_at") or ch.get("created_at", ""),
                })

        # Fetch uploader name separately
        uploader_name = ""
        try:
            uploader_id = um.get("uploader_id", "")
            if uploader_id:
                profile_res = db.table("profiles").select("display_name, username").eq("id", uploader_id).maybe_single().execute()
                if profile_res and profile_res.data:
                    uploader_name = profile_res.data.get("display_name") or profile_res.data.get("username") or ""
        except Exception:
            pass
        # Fetch local view count
        local_views = 0
        views_result = await asyncio.to_thread(
            lambda: _safe_query(
                lambda: db.table("manga_views").select("views").eq("manga_slug", normalized_slug).maybe_single().execute()
            )
        )
        if views_result and hasattr(views_result, "data") and views_result.data:
            local_views = int(views_result.data.get("views", 0) or 0)

        return {
            "data": {
                "item": {
                    "name": um.get("title", ""),
                    "slug": um.get("manga_slug", normalized_slug),
                    "origin_name": [um.get("title", "")],
                    "content": um.get("description", ""),
                    "status": um.get("publish_status", "ongoing"),
                    "thumb_url": um.get("cover_url", ""),
                    "author": [um.get("author", "")],
                    "category": [{"name": g, "slug": g.lower().replace(" ", "-")} for g in (um.get("genres") or [])],
                    "chapters": [{"server_name": "User Upload", "server_data": chapters_data}] if chapters_data else [],
                    "view_count": local_views,
                    "updatedAt": um.get("updated_at", ""),
                    "is_user_upload": True,
                    "uploader": uploader_name,
                    "manga_type": um.get("manga_type", "manga"),
                },
                "seoOnPage": {
                    "titleHead": um.get("title", ""),
                    "descriptionHead": (um.get("description") or "")[:160],
                },
            },
        }

    mangadex_id = _extract_mangadex_id(normalized_slug)
    if mangadex_id:
        manga_id = mangadex_id
        data = await mangadex_service.get_manga_detail(manga_id=manga_id, max_chapters=None)
        manga = (data or {}).get("manga") or {}
        if isinstance(manga, dict):
            local_count = await asyncio.to_thread(
                _sum_manga_views,
                db,
                [manga_id, f"mdx-{manga_id}"],
            )
            manga["local_view_count"] = local_count
            manga["view_count"] = local_count
            manga["views"] = manga["view_count"]
            manga["slug"] = manga_id
            override_rows = await _fetch_override_rows_by_slugs(db, [manga_id, f"mdx-{manga_id}"])
            _apply_override_fields(manga, _resolve_override_row(override_rows, manga_id))
            data["manga"] = manga
        return data

    detail = await truyenqq_service.get_manga_detail(normalized_slug)
    if not isinstance(detail, dict):
        return detail

    item = detail.get("data", {}).get("item")
    if not isinstance(item, dict):
        return detail

    detail_slug = str(item.get("slug") or normalized_slug).strip()
    source_slug = str(item.get("source_slug") or detail_slug).strip()
    source_hidden_reason = (_hidden_reason_for_slug(hidden, source_slug)
                            or _hidden_reason_for_slug(hidden, source_slug.rsplit("-", 1)[0]))
    if source_hidden_reason:
        raise HTTPException(status_code=451, detail={"hidden": True, "reason": source_hidden_reason})
    loop = asyncio.get_running_loop()

    from fastapi_app.services.qq_statistics import item_slugs
    view_slugs = item_slugs(item) or [normalized_slug]
    views_future = loop.run_in_executor(
        None,
        lambda: _safe_query(
            lambda: (db.table("manga_views").select("manga_slug,views").in_("manga_slug", view_slugs).execute()
                     if len(view_slugs) > 1 else
                     db.table("manga_views").select("views").eq("manga_slug", normalized_slug).maybe_single().execute())
        ),
    )
    first_seen_future = loop.run_in_executor(
        None,
        lambda: _safe_query(
            lambda: db.table("chapter_first_seen").select("chapter_id,first_seen_at").eq("manga_slug", normalized_slug).execute()
        ),
    )
    uploads_future = loop.run_in_executor(
        None,
        lambda: _safe_query(
            lambda: db.table("chapter_uploads").select("chapter_number,published_at,created_at").eq("manga_slug", normalized_slug).eq("status", "published").execute()
        ),
    )

    views_result, first_seen_result, uploads_result, override_rows = await asyncio.gather(
        views_future, first_seen_future, uploads_future,
        _fetch_override_rows_by_slugs(db, [detail_slug, normalized_slug, source_slug]),
    )
    _apply_override_fields(item, _resolve_override_row(override_rows, detail_slug)
                           or _resolve_override_row(override_rows, source_slug))

    local_count = 0
    if views_result and hasattr(views_result, "data"):
        local_count = (sum(_safe_int(row.get("views")) for row in views_result.data)
                       if isinstance(views_result.data, list) else (views_result.data or {}).get("views", 0))

    item["view_count"] = int(local_count or 0)
    item["local_view_count"] = item["view_count"]
    item["views"] = item["view_count"]

    chapters = item.get("chapters") or []
    chapter_meta: list[tuple[str, str]] = []
    for server in chapters:
        for ch in server.get("server_data") or []:
            chapter_id = _extract_chapter_id(ch.get("chapter_api_data"))
            if not chapter_id:
                continue
            chapter_no = str(ch.get("chapter_name") or "").strip()
            chapter_meta.append((chapter_id, chapter_no))

    first_seen_map = {}
    if first_seen_result and hasattr(first_seen_result, "data"):
        first_seen_map = {
            str(r.get("chapter_id")): r.get("first_seen_at")
            for r in (first_seen_result.data or [])
            if r.get("chapter_id")
        }

    if chapter_meta and first_seen_result is not None:
        missing_rows = [
            {
                "chapter_id": cid,
                "manga_slug": slug,
                "chapter_number": cno,
                "source": "otruyen_detail",
            }
            for cid, cno in chapter_meta
            if cid not in first_seen_map
        ]
        if missing_rows:
            # Do not block detail response on large backfills; write missing rows in background.
            service_db = get_supabase()
            create_task(
                asyncio.to_thread(_insert_missing_first_seen_rows, service_db, missing_rows)
            )

    if first_seen_map:
        for server in chapters:
            for ch in server.get("server_data") or []:
                chapter_id = _extract_chapter_id(ch.get("chapter_api_data"))
                if chapter_id:
                    ts = first_seen_map.get(chapter_id)
                    if ts:
                        ch["first_seen_at"] = ts

    if uploads_result and hasattr(uploads_result, "data"):
        local_map = {}
        for row in uploads_result.data or []:
            ch_no = row.get("chapter_number")
            if ch_no is None:
                continue
            key = str(ch_no).strip()
            ts = row.get("published_at") or row.get("created_at")
            if key and ts:
                local_map[key] = ts

        newest_local = None
        for server in chapters:
            for ch in server.get("server_data") or []:
                key = str(ch.get("chapter_name", "")).strip()
                local_ts = local_map.get(key)
                if local_ts:
                    ch["local_published_at"] = local_ts
                    if not newest_local or str(local_ts) > str(newest_local):
                        newest_local = local_ts

        if newest_local:
            item["local_last_published_at"] = newest_local

    return detail


@router.post("/{slug}/view-session")
async def start_view_session(
    request: Request,
    slug: str,
    payload: ViewSessionPayload,
    user=Depends(get_optional_user),
    db=Depends(get_supabase),
):
    """Start a server-side read session before a view can be counted."""
    normalized_slug = str(slug or "").strip()
    view_slug = await _canonical_view_slug(normalized_slug)
    if _is_invalid_manga_slug(view_slug):
        raise HTTPException(status_code=400, detail="Invalid manga slug")

    session_id = _normalize_read_session_id(payload.read_session_id)
    if not session_id:
        raise HTTPException(status_code=400, detail="read_session_id is required")

    chapter_id = _normalize_view_chapter_id(payload.chapter_id)
    viewer_key = request_fingerprint(request, user.get("id") if user else None)
    client_ip = get_client_ip(request)
    client_ip_key = hash_value(client_ip)

    for key, limit, window_seconds in (
        (f"view-session:min:{viewer_key}", VIEW_SESSION_START_LIMIT_PER_MINUTE, 60),
        (f"view-session:10m:{viewer_key}", VIEW_SESSION_START_LIMIT_PER_10_MINUTES, 10 * 60),
        (f"view-session-ip:min:{client_ip_key}", VIEW_IP_BURST_LIMIT_PER_MINUTE, 60),
        (f"view-session-ip:10m:{client_ip_key}", VIEW_IP_BURST_LIMIT_PER_10_MINUTES, 10 * 60),
    ):
        allowed, _, reset_after = await asyncio.to_thread(check_fixed_window, key, limit, window_seconds)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"Tạo phiên đọc quá nhanh, thử lại sau {reset_after}s",
            )

    chapter_validation = await _validate_view_chapter_owner(db, view_slug, chapter_id)
    if chapter_validation != "valid":
        reason = (
            "chapter-validation-unavailable"
            if chapter_validation == "unavailable"
            else "chapter-manga-mismatch"
        )
        return {"ok": False, "session_started": False, "reason": reason}

    result = await asyncio.to_thread(_start_manga_read_session_rpc,
        db,
        manga_slug=view_slug,
        chapter_id=chapter_id,
        user_id=user.get("id") if user else None,
        viewer_hash=hash_value(viewer_key),
        ip_hash=hash_value(client_ip),
        user_agent_hash=hash_value(request.headers.get("user-agent", "")),
        session_id=session_id,
    )
    if result is None:
        return {"ok": False, "session_started": False, "reason": "tracking-unavailable"}
    return {"ok": bool(result.get("ok", True)), "session_started": bool(result.get("ok", True))}


@router.post("/{slug}/view")
async def add_view(
    request: Request,
    slug: str,
    payload: ViewPayload,
    user=Depends(get_optional_user),
    db=Depends(get_supabase),
):
    """Tăng view local cho manga khi user mở chapter."""
    normalized_slug = str(slug or "").strip()
    view_slug = await _canonical_view_slug(normalized_slug)
    if _is_invalid_manga_slug(view_slug):
        raise HTTPException(status_code=400, detail="Invalid manga slug")

    chapter_id = _normalize_view_chapter_id(payload.chapter_id)
    session_id = _normalize_read_session_id(payload.read_session_id)
    elapsed_seconds = max(0, int(payload.elapsed_seconds or 0))
    progress = max(0.0, min(100.0, float(payload.progress or 0)))
    page_seen = max(0, int(payload.page_seen or 0))
    total_pages = max(0, int(payload.total_pages or 0))
    min_page_seen = 1 if total_pages <= 1 else VIEW_MIN_PAGE_SEEN
    viewer_key = request_fingerprint(request, user.get("id") if user else None)
    client_ip = get_client_ip(request)
    client_ip_key = hash_value(client_ip)

    if not session_id:
        return {"ok": True, "counted": False, "reason": "missing-read-session"}

    for key, limit, window_seconds in (
        (f"view:min:{viewer_key}", VIEW_BURST_LIMIT_PER_MINUTE, 60),
        (f"view:10m:{viewer_key}", VIEW_BURST_LIMIT_PER_10_MINUTES, 10 * 60),
        (f"view-ip:min:{client_ip_key}", VIEW_IP_BURST_LIMIT_PER_MINUTE, 60),
        (f"view-ip:10m:{client_ip_key}", VIEW_IP_BURST_LIMIT_PER_10_MINUTES, 10 * 60),
    ):
        allowed, _, reset_after = await asyncio.to_thread(check_fixed_window, key, limit, window_seconds)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"Request view quá nhanh, thử lại sau {reset_after}s",
            )

    if elapsed_seconds < VIEW_MIN_ELAPSED_SECONDS:
        return {"ok": True, "counted": False, "reason": "too-short"}

    if progress < VIEW_MIN_PROGRESS_PERCENT and page_seen < min_page_seen:
        return {"ok": True, "counted": False, "reason": "not-enough-progress"}

    chapter_validation = await _validate_view_chapter_owner(db, view_slug, chapter_id)
    if chapter_validation != "valid":
        reason = (
            "chapter-validation-unavailable"
            if chapter_validation == "unavailable"
            else "chapter-manga-mismatch"
        )
        return {"ok": False, "counted": False, "reason": reason}

    once_key = f"view:once:{viewer_key}:{view_slug}"
    is_new_view, wait_seconds = check_recent_once(once_key, VIEW_DEDUP_SECONDS, mark=False)
    if not is_new_view:
        return {"ok": True, "counted": False, "reason": "duplicate", "retry_after": wait_seconds}

    user_id = user.get("id") if user else None
    if user_id and await asyncio.to_thread(_recent_user_view_exists, db, user_id, view_slug):
        return {"ok": True, "counted": False, "reason": "recent-user-view"}

    checked_rpc_result = await asyncio.to_thread(_track_manga_view_checked_rpc,
        db,
        manga_slug=view_slug,
        chapter_id=chapter_id,
        user_id=user_id,
        viewer_hash=hash_value(viewer_key),
        ip_hash=hash_value(client_ip),
        user_agent_hash=hash_value(request.headers.get("user-agent", "")),
        session_id=session_id,
        elapsed_seconds=elapsed_seconds,
        progress=progress,
        page_seen=page_seen,
        min_page_seen=min_page_seen,
    )
    if checked_rpc_result is None:
        return {"ok": False, "counted": False, "reason": "tracking-unavailable"}

    if checked_rpc_result.get("counted"):
        check_recent_once(once_key, VIEW_DEDUP_SECONDS, mark=True)
        _bump_manga_views_lookup_cache(view_slug)
        return {"ok": True, "counted": True}
    return {
        "ok": bool(checked_rpc_result.get("ok", True)),
        "counted": False,
        "reason": checked_rpc_result.get("reason") or "not-counted",
    }


def _search_payload(items, total, page, limit, unavailable=()):
    return {"data": {"items": items, "params": {"pagination": {
        "totalItems": total, "totalItemsPerPage": limit, "currentPage": page,
        "totalPages": max(1, math.ceil(total / limit)),
    }}}, "meta": {"unavailable_sources": list(unavailable)}}


async def _search_uploads(keyword, db, limit=None):
    # Include every published match in stable order; never repeat the first ten
    # uploads on every page or omit them from the combined result count.
    def load():
        rows, offset = [], 0
        while True:
            size = min(500, limit - offset) if limit else 500
            result = (db.table("manga_uploads")
                .select("manga_slug, title, author, cover_url, manga_type, genres, description, publish_status")
                .eq("status", "published").ilike("title", f"%{keyword}%")
                .order("manga_slug").range(offset, offset + size - 1).execute())
            batch = result.data or []
            rows.extend(batch)
            if len(batch) < size or (limit and len(rows) >= limit):
                return rows
            offset += len(batch)
    rows = await asyncio.to_thread(load)
    return [{"name": row.get("title", ""), "slug": row.get("manga_slug", ""),
        "thumb_url": row.get("cover_url", ""),
        "category": [{"name": g, "slug": g.lower().replace(" ", "-")} for g in (row.get("genres") or [])],
        "status": row.get("publish_status", "ongoing"), "content": (row.get("description") or "")[:200],
        "author": [row.get("author", "")], "is_user_upload": True,
        "manga_type": row.get("manga_type", "manga")} for row in rows]


async def _search_mangadex_window(*, keyword, offset, limit, translated_language,
                                attach_latest, genres, show_mature):
    # Stable native blocks share the existing bounded source cache across UI
    # pages. Page two no longer creates a different upstream query just because
    # page one contained twenty QQ results and only four MangaDex results.
    block_size = 96
    start = offset // block_size * block_size
    async def load(begin):
        return await mangadex_service.search_manga(
            keyword=keyword, page=begin // block_size + 1, limit=block_size, offset_override=begin,
            translated_language=translated_language, attach_latest=attach_latest,
            included_tag_slugs=genres,
            content_ratings=["safe", "suggestive", "erotica", "pornographic"] if show_mature else ["safe", "suggestive"])
    first = await load(start)
    pagination = ((first.get("data") or {}).get("params") or {}).get("pagination") or {}
    total = min(10000, int(pagination.get("totalItems") or 0))
    rows = _otruyen_payload_items(first)
    # Do not ask beyond the source's end: native search can redirect that
    # offset back to its last page, which would repeat titles at the tail.
    if limit and offset + limit > start + block_size and start + block_size < total:
        second = await load(start + block_size)
        rows = [*rows, *_otruyen_payload_items(second)]
    # Slice before moderation filtering: removing an earlier hidden title must
    # never shift a later page backward and repeat an already displayed title.
    selected = rows[offset - start:offset - start + limit] if offset < total else []
    return _search_payload(selected, total, 1, limit or 1)


@router.get("/search")
async def search(
    keyword: str = Query(..., min_length=1),
    page: int = Query(1, ge=1),
    include_mangadex: bool = Query(True),
    attach_ratings: bool = Query(True),
    mangadex_limit: int = Query(24, ge=1, le=24),
    mangadex_timeout_ms: int = Query(0, ge=0, le=15000),
    mangadex_translated_language: str = Query("vi"),
    mangadex_attach_latest: bool = Query(True),
    limit: int = 24,
    show_mature: bool = True,
    genre_slugs: str = "",
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
    response: Response = None,
):
    """One result window across uploads, QQ's finite matches and MangaDex."""
    limit = max(1, min(24, limit))
    offset = (page - 1) * limit
    genres = {slug.strip().lower() for slug in genre_slugs.split(",") if slug.strip()}
    # QQ's AJAX endpoint has one finite match set. Reuse it on every UI page
    # to calculate its prefix length, not as a second independently paged list.
    qq, uploads, hidden = await asyncio.gather(
        truyenqq_service.search_manga(keyword, page=1), _search_uploads(keyword, db),
        _get_hidden_slugs(db), return_exceptions=True)
    if isinstance(hidden, Exception):
        raise hidden
    unavailable = ["truyenqq"] if isinstance(qq, Exception) else []
    if isinstance(uploads, Exception):
        unavailable.append("uploaded")
        uploads = []
    if isinstance(qq, HTTPException) and response is not None and qq.headers:
        response.headers.update(qq.headers)
    prefix, seen = [], set()
    for item in [*uploads, *_otruyen_payload_items(qq)]:
        slug = str(item.get("slug") or item.get("id") or "").lower()
        if not slug or slug in seen or not _otruyen_item_matches_filters(item,
            required_genres=genres, status_value="", show_mature=show_mature, hidden=hidden):
            continue
        seen.add(slug)
        prefix.append(item)
    items = prefix[offset:offset + limit]
    mdx_total = 0
    if include_mangadex:
        # Offset the MDX window by the finite prefix so surplus results carry
        # into page two while adjacent pages reuse the same source blocks.
        mdx_offset = max(0, offset - len(prefix))
        slots = limit - len(items)
        try:
            task = _search_mangadex_window(keyword=keyword, offset=mdx_offset, limit=slots,
                translated_language=mangadex_translated_language,
                attach_latest=mangadex_attach_latest, genres=sorted(genres), show_mature=show_mature)
            mdx = await asyncio.wait_for(task, mangadex_timeout_ms / 1000) if mangadex_timeout_ms > 0 else await task
            pagination = ((mdx.get("data") or {}).get("params") or {}).get("pagination") or {}
            mdx_total = min(10000, int(pagination.get("totalItems") or 0))
            if slots:
                items.extend(_filter_hidden(_otruyen_payload_items(mdx), hidden)[:slots])
        except Exception:
            unavailable.append("mangadex")
    if not prefix and "truyenqq" in unavailable and (not include_mangadex or "mangadex" in unavailable):
        raise HTTPException(503, "Các nguồn tìm kiếm tạm thời không khả dụng. Vui lòng thử lại.",
            headers=qq.headers if isinstance(qq, HTTPException) else None)
    data = _search_payload(items, len(prefix) + mdx_total, page, limit, unavailable)
    if attach_ratings:
        await _async_attach_ratings_to_items(data, db, user)
    return data


@router.get("/suggestions")
async def search_suggestions(keyword: str = Query(..., min_length=2, max_length=200),
    source: str = Query(..., pattern="^(truyenqq|mangadex|uploaded)$"),
    limit: int = Query(6, ge=1, le=6), show_mature: bool = False,
    db=Depends(get_supabase_public)):
    # Each source returns independently. Suggestions need covers/titles, not
    # chapter, rating or view enrichment. Uploaded suggestions read six rows
    # independently so a slow external source cannot hold them back.
    async def load():
        if source == "truyenqq":
            return await truyenqq_service.search_manga(keyword, page=1)
        if source == "uploaded":
            items = await _search_uploads(keyword, db, limit=limit)
            return _search_payload(items, len(items), 1, limit)
        return await mangadex_service.search_manga(keyword=keyword, page=1, limit=limit,
            translated_language="vi", attach_latest=False,
            content_ratings=["safe", "suggestive", "erotica", "pornographic"] if show_mature else ["safe", "suggestive"])
    try:
        payload, hidden = await asyncio.gather(load(), _get_hidden_slugs(db))
    except HTTPException:
        raise
    except RuntimeError as error:
        raise HTTPException(503, "Gợi ý tạm thời không khả dụng.") from error
    items = [item for item in _otruyen_payload_items(payload) if _otruyen_item_matches_filters(item,
        required_genres=set(), status_value="", show_mature=show_mature, hidden=hidden)][:limit]
    return _search_payload(items, len(items), 1, limit)


@router.get("/mangadex/search")
async def mangadex_search(
    keyword: str = Query(""),
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=100),
    genre_slugs: str = Query(""),
    translated_language: str = Query("vi"),
    original_language: str = Query(""),
    status: str = Query(""),
    sort: str = Query("latest"),
    show_mature: bool = Query(False),
    attach_ratings: bool = Query(False),
    filter_hidden: bool = Query(True),
    year: int | None = Query(None, ge=1000, le=3000),
    min_rating: float = Query(0, ge=0, le=5),
    feed_snapshot: str = Query(""),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    genre_values = [
        part.strip().lower()
        for part in str(genre_slugs or "").split(",")
        if part.strip()
    ]
    original_language_values = [
        part.strip().lower()
        for part in str(original_language or "").split(",")
        if part.strip()
    ]
    status_values = [
        part.strip().lower()
        for part in str(status or "").split(",")
        if part.strip()
    ]
    content_ratings = (
        ["safe", "suggestive", "erotica", "pornographic"]
        if show_mature
        else ["safe", "suggestive"]
    )
    effective_translated_language = (
        str(translated_language or "vi").strip().lower() or "vi"
    )
    hidden: dict[str, str] = {}
    if filter_hidden:
        hidden = await _get_hidden_slugs(db)

    normalized_sort = str(sort or "").strip().lower()
    if effective_translated_language == "vi":
        return await _indexed_mangadex_browse(db=db, page=page, limit=limit,
            ratings=content_ratings, hidden=hidden, genres=genre_values,
            statuses=status_values, keyword=keyword, sort=normalized_sort,
            year=year, min_rating=min_rating, original_languages=original_language_values,
            feed_snapshot=feed_snapshot)
    try:
        if normalized_sort == "rating":
            data = await _build_mangadex_rating_search(
                keyword=keyword,
                page=page,
                limit=limit,
                translated_language=effective_translated_language,
                genre_values=genre_values,
                original_language_values=original_language_values,
                status_values=status_values,
                content_ratings=content_ratings,
                hidden=hidden,
                user=user,
                db=db,
            )
        elif normalized_sort == "popular":
            data = await _build_mangadex_popular_with_local_views(
                keyword=keyword, page=page, limit=limit, translated_language=effective_translated_language,
                genre_values=genre_values, original_language_values=original_language_values,
                status_values=status_values, content_ratings=content_ratings, hidden=hidden, db=db,
            )
        else:
            data = await mangadex_service.search_manga(
                keyword=keyword,
                page=page,
                limit=limit,
                translated_language=effective_translated_language,
                attach_latest=False,
                included_tag_slugs=genre_values,
                included_tags_mode="AND",
                original_languages=original_language_values,
                statuses=status_values,
                sort=sort,
                content_ratings=content_ratings,
            )
    except RuntimeError as error:
        logger.warning("MangaDex search source unavailable (%s)", type(error).__name__)
        return _mangadex_unavailable_response()

    items = ((data.get("data") or {}).get("items") or [])
    if not isinstance(items, list):
        items = []

    if hidden:
        items = _filter_hidden(items, hidden)

    payload = {"mangas": items}
    await _async_attach_local_views_to_mangadex_payload(payload, db)
    items = payload.get("mangas") or []
    data.setdefault("data", {})["items"] = items

    if attach_ratings and normalized_sort != "rating":
        await _async_attach_ratings_to_items(data, db, user)

    return data


@router.get("/mangadex/home-banner")
async def mangadex_home_banner(
    limit: int = Query(8, ge=1, le=24),
    show_mature: bool = Query(False),
    filter_hidden: bool = Query(True),
    attach_ratings: bool = Query(True),
    lightweight: bool = False,
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    content_ratings = (
        ["safe", "suggestive", "erotica", "pornographic"]
        if show_mature
        else ["safe", "suggestive"]
    )
    hidden: dict[str, str] = {}
    if filter_hidden:
        hidden = await _get_hidden_slugs(db)
    excluded_manga_ids = [
        manga_id
        for manga_id in (_extract_mangadex_id(key) for key in hidden.keys())
        if manga_id
    ]
    try:
        data = await mangadex_service.get_latest_vi_chapter_feed(
            page=1,
            limit=limit,
            content_ratings=content_ratings,
            excluded_manga_ids=excluded_manga_ids,
            snapshot=True,
        )
    except RuntimeError as error:
        raise _mangadex_upstream_http_exception(error) from error

    if filter_hidden:
        items = ((data.get("data") or {}).get("items") or [])
        if hidden and isinstance(items, list):
            data.setdefault("data", {})["items"] = _filter_hidden(items, hidden)

    payload = {"mangas": ((data.get("data") or {}).get("items") or [])}
    if not lightweight:
        await _async_attach_local_views_to_mangadex_payload(payload, db)
    data.setdefault("data", {})["items"] = payload.get("mangas") or []
    if attach_ratings:
        await _async_attach_ratings_to_items(data, db, user)
    return data


@router.get("/mangadex/vi-catalog")
async def mangadex_vi_catalog(
    max_chapters: str = Query("2000"),
    attach_overrides: bool = Query(True),
    attach_ratings: bool = Query(True),
    filter_hidden: bool = Query(True),
    prefer_latest: bool = Query(False),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    normalized = str(max_chapters or "").strip().lower()
    if normalized == "all":
        parsed_max_chapters: int | None = None
    elif normalized.isdigit():
        parsed_max_chapters = int(normalized)
        # Keep chapter sampling bounded but deep enough for browse pagination.
        parsed_max_chapters = min(parsed_max_chapters, 10000)
    else:
        raise HTTPException(
            status_code=400,
            detail="max_chapters phải là số nguyên dương hoặc 'all'",
        )

    normalized_cache_limit = "all" if parsed_max_chapters is None else str(parsed_max_chapters)
    min_expected_count = _min_expected_manga_count(parsed_max_chapters)
    ready_count = _ready_mangadex_catalog_count(parsed_max_chapters, min_expected_count)
    use_light_cache = filter_hidden and (not attach_overrides) and (not attach_ratings)
    light_cache_mode = "latest" if prefer_latest else "default"
    light_cache_key = f"mangadex:vi-catalog:public:{light_cache_mode}:{normalized_cache_limit}"
    if use_light_cache:
        async def _popular_first_response() -> dict[str, Any] | None:
            try:
                popular_payload = await mangadex_service.get_popular_first_catalog(
                    max_chapters=parsed_max_chapters,
                )
            except Exception:
                return None
            hidden: dict[str, str] = {}
            if filter_hidden:
                hidden = await _get_hidden_slugs(db)
                if hidden and isinstance(popular_payload, dict):
                    popular_payload = _filter_hidden_mangadex_payload(popular_payload, hidden)
            await _async_attach_local_views_to_mangadex_payload(popular_payload, db)
            await _async_inject_local_viewed_mangadex_rows(popular_payload, db, hidden=hidden)
            return _mark_mangadex_catalog_refreshing(
                popular_payload,
                requested_limit=normalized_cache_limit,
                served_from="popular-first",
            )

        cached_raw = cache.get(light_cache_key)
        if cached_raw:
            try:
                cached_payload = json.loads(cached_raw)
                cached_count = _payload_manga_count(cached_payload)
                cached_has_latest_signal = _payload_has_mangadex_latest_signal(cached_payload)
                if (
                    isinstance(cached_payload, dict) and
                    cached_count >= ready_count and
                    ((not prefer_latest) or cached_has_latest_signal)
                ):
                    if _payload_missing_mangadex_popularity_count(cached_payload) > 0 and not prefer_latest:
                        cache.delete(light_cache_key)
                        popular_payload = await _popular_first_response()
                        if popular_payload:
                            return popular_payload
                    hidden: dict[str, str] = {}
                    if filter_hidden:
                        hidden = await _get_hidden_slugs(db)
                        if hidden:
                            cached_payload = _filter_hidden_mangadex_payload(cached_payload, hidden)
                    await _async_attach_local_views_to_mangadex_payload(cached_payload, db)
                    await _async_inject_local_viewed_mangadex_rows(cached_payload, db, hidden=hidden)
                    return cached_payload
                cache.delete(light_cache_key)
            except Exception:
                cache.delete(light_cache_key)

        exact_cached_payload = _load_mangadex_catalog_cache(parsed_max_chapters)
        exact_cached_count = _payload_manga_count(exact_cached_payload)
        exact_has_latest_signal = _payload_has_mangadex_latest_signal(exact_cached_payload)
        if (
            isinstance(exact_cached_payload, dict) and
            exact_cached_count >= min_expected_count and
            ((not prefer_latest) or exact_has_latest_signal)
        ):
            needs_popularity_refresh = _payload_missing_mangadex_popularity_count(exact_cached_payload) > 0
            cache_is_too_shallow = exact_cached_count < ready_count
            if cache_is_too_shallow and not prefer_latest:
                popular_payload = await _popular_first_response()
                if _payload_manga_count(popular_payload) > exact_cached_count:
                    return popular_payload
            if needs_popularity_refresh and not prefer_latest:
                popular_payload = await _popular_first_response()
                if popular_payload:
                    return popular_payload
            if exact_cached_count < ready_count or needs_popularity_refresh:
                mangadex_service.schedule_vi_catalog_refresh(
                    parsed_max_chapters,
                    force=needs_popularity_refresh,
                )
            if filter_hidden:
                hidden = await _get_hidden_slugs(db)
                if hidden:
                    exact_cached_payload = _filter_hidden_mangadex_payload(exact_cached_payload, hidden)
            else:
                hidden = {}
            await _async_attach_local_views_to_mangadex_payload(exact_cached_payload, db)
            await _async_inject_local_viewed_mangadex_rows(exact_cached_payload, db, hidden=hidden)
            response_count = _payload_manga_count(exact_cached_payload)
            response_missing_popularity = _payload_missing_mangadex_popularity_count(exact_cached_payload)
            if response_count >= ready_count and (prefer_latest or response_missing_popularity <= 0):
                cache.set(light_cache_key, json.dumps(exact_cached_payload, ensure_ascii=False), ttl=90)
                return exact_cached_payload
            return _mark_mangadex_catalog_refreshing(
                exact_cached_payload,
                requested_limit=normalized_cache_limit,
                served_from="partial-cache",
            )

        fallback_payload = _load_best_mangadex_catalog_cache(parsed_max_chapters, min_count=1)
        fallback_count = _payload_manga_count(fallback_payload)
        fallback_has_latest_signal = _payload_has_mangadex_latest_signal(fallback_payload)
        if (
            isinstance(fallback_payload, dict) and
            fallback_count > 0 and
            ((not prefer_latest) or fallback_has_latest_signal)
        ):
            if fallback_count < ready_count and not prefer_latest:
                popular_payload = await _popular_first_response()
                if _payload_manga_count(popular_payload) > fallback_count:
                    return popular_payload
            if _payload_missing_mangadex_popularity_count(fallback_payload) > 0 and not prefer_latest:
                popular_payload = await _popular_first_response()
                if popular_payload:
                    return popular_payload
            mangadex_service.schedule_vi_catalog_refresh(parsed_max_chapters)
            if filter_hidden:
                hidden = await _get_hidden_slugs(db)
                if hidden:
                    fallback_payload = _filter_hidden_mangadex_payload(fallback_payload, hidden)
            else:
                hidden = {}
            await _async_attach_local_views_to_mangadex_payload(fallback_payload, db)
            await _async_inject_local_viewed_mangadex_rows(fallback_payload, db, hidden=hidden)
            return _mark_mangadex_catalog_refreshing(
                fallback_payload,
                requested_limit=normalized_cache_limit,
                served_from="fallback-cache",
            )

    try:
        payload = await mangadex_service.get_vi_catalog(
            max_chapters=parsed_max_chapters,
            prefer_latest=prefer_latest,
        )
        if filter_hidden:
            hidden = await _get_hidden_slugs(db)
            if hidden and isinstance(payload, dict):
                payload = _filter_hidden_mangadex_payload(payload, hidden)
        else:
            hidden = {}
        if attach_overrides:
            await _attach_overrides_to_mangadex_payload(payload, db)
        if attach_ratings:
            await _async_attach_ratings_to_mangadex_payload(payload, db, user)
        await _async_attach_local_views_to_mangadex_payload(payload, db)
        await _async_inject_local_viewed_mangadex_rows(payload, db, hidden=hidden)

        payload_count = _payload_manga_count(payload)
        if payload_count < min_expected_count:
            fallback_payload = _load_best_mangadex_catalog_cache(parsed_max_chapters, min_expected_count)
            fallback_count = _payload_manga_count(fallback_payload)
            fallback_has_latest_signal = _payload_has_mangadex_latest_signal(fallback_payload)
            if fallback_count > payload_count and ((not prefer_latest) or fallback_has_latest_signal):
                payload = fallback_payload
                payload_count = fallback_count
                if filter_hidden:
                    hidden = await _get_hidden_slugs(db)
                    if hidden and isinstance(payload, dict):
                        payload = _filter_hidden_mangadex_payload(payload, hidden)
                else:
                    hidden = {}
                if attach_overrides:
                    await _attach_overrides_to_mangadex_payload(payload, db)
                if attach_ratings:
                    await _async_attach_ratings_to_mangadex_payload(payload, db, user)
                await _async_attach_local_views_to_mangadex_payload(payload, db)
                await _async_inject_local_viewed_mangadex_rows(payload, db, hidden=hidden)

        if (
            use_light_cache and
            isinstance(payload, dict) and
            payload_count >= ready_count and
            ((not prefer_latest) or _payload_has_mangadex_latest_signal(payload))
        ):
            cache.set(light_cache_key, json.dumps(payload, ensure_ascii=False), ttl=90)
        return payload
    except RuntimeError as error:
        fallback_payload = _load_best_mangadex_catalog_cache(parsed_max_chapters, min_count=1)
        served_from = "fallback-cache-after-error"
        if not isinstance(fallback_payload, dict) or _payload_manga_count(fallback_payload) <= 0:
            fallback_payload = _fallback_empty_mangadex_payload()
            served_from = "empty-after-error"
        fallback_payload = _mark_mangadex_catalog_refreshing(
            fallback_payload,
            requested_limit=normalized_cache_limit,
            served_from=served_from,
        )
        meta = fallback_payload.get("meta") if isinstance(fallback_payload, dict) else {}
        if not isinstance(meta, dict):
            meta = {}
        fallback_payload["meta"] = {
            **meta,
            "upstream_error": str(error),
            "upstream_unavailable": True,
        }
        return await _prepare_mangadex_catalog_response(
            fallback_payload,
            db=db,
            user=user,
            attach_overrides=attach_overrides,
            attach_ratings=attach_ratings,
            filter_hidden=filter_hidden,
        )


async def _indexed_mangadex_browse(**options):
    from fastapi_app.services import mangadex_browse
    from fastapi_app.services.mangadex_release_index import IndexBuilding
    hidden = options.pop("hidden", {})
    options["excluded"] = [mid for mid in (_extract_mangadex_id(key) for key in hidden) if mid]
    try:
        return await mangadex_browse.page(**options)
    except IndexBuilding:
        return JSONResponse(status_code=202, content={"data": {"items": [], "index_pending": True}},
                            headers={"Cache-Control": "no-store", "Retry-After": "3"})
    except RuntimeError as error:
        logger.warning("MangaDex shared catalog unavailable (%s)", type(error).__name__)
        return _mangadex_unavailable_response()


@router.get("/mangadex/browse")
async def mangadex_browse(
    page: int = Query(1, ge=1), limit: int = Query(24, ge=1, le=24),
    sort: str = Query("latest", pattern="^(latest|popular|rating|title|alphabetical)$"),
    genre_slugs: str = Query(""), status: str = Query(""), keyword: str = Query(""),
    translated_language: str = Query("vi"),
    year: int | None = Query(None, ge=1000, le=3000), min_rating: float = Query(0, ge=0, le=5),
    show_mature: bool = Query(False), filter_hidden: bool = Query(True), feed_snapshot: str = Query(""),
    db=Depends(get_supabase_public),
):
    if translated_language != "vi":
        raise HTTPException(status_code=400, detail="Unsupported catalog language")
    return await _indexed_mangadex_browse(db=db, page=page, limit=limit, sort=sort,
        ratings=["safe", "suggestive", "erotica", "pornographic"] if show_mature else ["safe", "suggestive"],
        hidden=await _get_hidden_slugs(db) if filter_hidden else {},
        genres=[v.strip().lower() for v in genre_slugs.split(",") if v.strip()],
        statuses=[v.strip().lower() for v in status.split(",") if v.strip()], keyword=keyword,
        year=year, min_rating=min_rating, feed_snapshot=feed_snapshot)


@router.get("/mangadex/latest-feed")
async def mangadex_latest_feed(
    page: int = Query(1, ge=1),
    limit: int = Query(32, ge=1, le=100),
    show_mature: bool = Query(False),
    filter_hidden: bool = Query(True),
    genre_slugs: str = Query(""),
    translated_language: str = Query("vi"),
    status: str = Query(""),
    keyword: str = Query(""),
    feed_snapshot: str = Query(""),
    db=Depends(get_supabase_public),
):
    content_ratings = (
        ["safe", "suggestive", "erotica", "pornographic"]
        if show_mature
        else ["safe", "suggestive"]
    )
    hidden: dict[str, str] = {}
    if filter_hidden:
        hidden = await _get_hidden_slugs(db)
    excluded_manga_ids = [
        manga_id
        for manga_id in (_extract_mangadex_id(key) for key in hidden.keys())
        if manga_id
    ]
    try:
        data = await mangadex_service.get_latest_vi_chapter_feed(
            page=page,
            limit=limit,
            content_ratings=content_ratings,
            excluded_manga_ids=excluded_manga_ids,
            translated_language=translated_language,
            included_tag_slugs=[value.strip().lower() for value in genre_slugs.split(",") if value.strip()],
            statuses=[value.strip().lower() for value in status.split(",") if value.strip()],
            keyword=keyword,
            feed_snapshot=feed_snapshot,
        )
    except RuntimeError as error:
        from fastapi_app.services.mangadex_release_index import IndexBuilding
        if isinstance(error, IndexBuilding):
            return JSONResponse(status_code=202, content={"data": {"items": [], "index_pending": True,
                "params": {"pagination": {"totalItems": page * min(limit, 24),
                    "totalItemsPerPage": min(limit, 24), "currentPage": page}}}},
                headers={"Cache-Control": "no-store", "Retry-After": "3"})
        # A manga metadata search orders updates in ANY language. Returning it
        # here silently changes the requested chapter ordering and filters.
        raise _mangadex_upstream_http_exception(error) from error

    if filter_hidden:
        items = ((data.get("data") or {}).get("items") or [])
        if hidden and isinstance(items, list):
            data.setdefault("data", {})["items"] = _filter_hidden(items, hidden)

    payload = {"mangas": ((data.get("data") or {}).get("items") or [])}
    await _async_attach_local_views_to_mangadex_payload(payload, db)
    data.setdefault("data", {})["items"] = payload.get("mangas") or []
    return data


@router.get("/mangadex/latest-chapters")
async def mangadex_latest_chapters(
    ids: str = Query(..., min_length=1),
    fast: bool = Query(False),
    translated_language: str = Query("vi"),
):
    raw_ids = [str(segment or "").strip().lower() for segment in str(ids or "").split(",")]

    manga_ids: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        manga_id = _extract_mangadex_id(raw)
        if not manga_id or manga_id in seen:
            continue
        seen.add(manga_id)
        manga_ids.append(manga_id)
        if len(manga_ids) >= 120:
            break

    if not manga_ids:
        return {"items": {}}

    effective_translated_language = str(translated_language or "vi").strip().lower() or "vi"
    if effective_translated_language in {"all", "any", "*", "non_vi"}:
        return {"items": {}}

    try:
        latest_map = await mangadex_service.get_latest_chapters_for_manga_ids(
            manga_ids,
            translated_language=effective_translated_language,
            allow_individual_fallback=not fast,
        )
    except RuntimeError as error:
        raise _mangadex_upstream_http_exception(error) from error

    items: dict[str, dict[str, str]] = {}
    for manga_id in manga_ids:
        chapter_info = latest_map.get(manga_id) or {
            "chapter_name": "",
            "chapter_title": "",
            "publish_at": "",
        }
        items[manga_id] = chapter_info
        items[f"mdx-{manga_id}"] = chapter_info

    return {"items": items}


@router.get("/mangadex/chapter-pages/{chapter_id}")
async def mangadex_chapter_pages(
    chapter_id: str,
    mode: str = Query("data"),
    refresh: bool = Query(False),
):
    try:
        return await mangadex_service.get_chapter_pages(chapter_id=chapter_id, mode=mode, refresh=refresh)
    except RuntimeError as error:
        raise _mangadex_upstream_http_exception(error) from error


@router.get("/mangadex/lookup/{manga_id}")
async def mangadex_lookup(
    manga_id: str,
    db=Depends(get_supabase_public),
):
    try:
        hidden = await _get_hidden_slugs(db)
        hidden_reason = _hidden_reason_for_slug(hidden, manga_id)
        if hidden_reason:
            raise HTTPException(
                status_code=451,
                detail={"hidden": True, "reason": hidden_reason},
            )

        payload = await mangadex_service.get_manga_lookup(manga_id=manga_id)
        manga = (payload or {}).get("manga")
        if isinstance(manga, dict):
            await _attach_overrides_to_mangadex_payload({"mangas": [manga]}, db)
        return payload
    except RuntimeError as error:
        raise _mangadex_upstream_http_exception(error) from error


@router.get("/mangadex/detail/{manga_id}")
async def mangadex_detail(
    manga_id: str,
    max_chapters: str = Query("all"),
    translated_language: str = Query("vi"),
    scanlation_group_id: str = Query(""),
    db=Depends(get_supabase_public),
):
    try:
        hidden = await _get_hidden_slugs(db)
        hidden_reason = _hidden_reason_for_slug(hidden, manga_id)
        if hidden_reason:
            raise HTTPException(
                status_code=451,
                detail={"hidden": True, "reason": hidden_reason},
            )

        normalized = str(max_chapters or "").strip().lower()
        if normalized == "all":
            parsed_max_chapters: int | None = None
        else:
            try:
                parsed_max_chapters = int(normalized)
            except ValueError as error:
                raise HTTPException(
                    status_code=422,
                    detail="max_chapters phải từ 1-3000 hoặc 'all'",
                ) from error
            if parsed_max_chapters < 1 or parsed_max_chapters > 3000:
                raise HTTPException(
                    status_code=422,
                    detail="max_chapters phải từ 1-3000 hoặc 'all'",
                )
        data = await mangadex_service.get_manga_detail(
            manga_id=manga_id,
            max_chapters=parsed_max_chapters,
            translated_language=translated_language,
            scanlation_group_id=scanlation_group_id,
        )
        manga = (data or {}).get("manga") or {}
        if isinstance(manga, dict):
            slug = manga_id
            legacy_slug = f"mdx-{manga_id}"
            local_count = await asyncio.to_thread(
                _sum_manga_views,
                db,
                [slug, legacy_slug],
            )
            manga["local_view_count"] = local_count
            manga["view_count"] = local_count
            manga["views"] = manga["view_count"]
            manga["slug"] = slug
            override_rows = await _fetch_override_rows_by_slugs(db, [slug, legacy_slug])
            _apply_override_fields(manga, _resolve_override_row(override_rows, slug))
            data["manga"] = manga
        return data
    except RuntimeError as error:
        raise _mangadex_upstream_http_exception(error) from error


@router.get("/chapter/{chapter_id}")
async def chapter_detail(chapter_id: str):
    """Chi tiết chapter + danh sách trang."""
    import logging
    import re

    logger = logging.getLogger(__name__)

    data = await truyenqq_service.get_chapter(chapter_id)

    # Inject correct comic_slug from chapter_path
    if isinstance(data, dict):
        item = data.get("data", {}).get("item")
        if isinstance(item, dict):
            chapter_path = item.get("chapter_path") or ""
            logger.info(
                f"[chapter_detail] chapter_path={chapter_path!r}, existing slug={item.get('slug')!r}, comic_slug={item.get('comic_slug')!r}"
            )

            parts = [p for p in chapter_path.split("/") if p.strip()]
            reserved = {
                "uploads",
                "comics",
                "chapters",
                "chapter",
                "api",
                "img",
                "images",
                "v1",
                "data",
            }

            def clean_slug(value: str) -> str:
                return re.sub(r"[^a-z0-9-]", "", (value or "").strip().lower())

            def is_invalid_slug(value: str) -> bool:
                s = clean_slug(value)
                if not s or len(s) < 3:
                    return True
                if s in reserved:
                    return True
                if re.match(r"^\d+$", s) or re.match(r"^[0-9a-f]{20,}$", s):
                    return True
                compact = re.sub(r"[-_\s.]+", "", s)
                return bool(re.match(r"^(c|ch|chap|chapter|chuong|tap|episode|ep)\d", compact))

            # Strategy 1: Find "comics" segment → next is the manga slug
            extracted_slug = None
            for i, p in enumerate(parts):
                if p.lower() == "comics" and i + 1 < len(parts):
                    candidate = clean_slug(parts[i + 1])
                    if not is_invalid_slug(candidate):
                        extracted_slug = candidate
                    break

            # Strategy 2: If no "comics" found, find best slug-like segment
            # Valid manga slugs: contain hyphens, aren't pure numbers/hex, aren't reserved words
            if not extracted_slug:
                for p in parts:
                    s = clean_slug(p)
                    if is_invalid_slug(s):
                        continue
                    # Good candidate — has hyphens or looks like a slug
                    if "-" in s:
                        extracted_slug = s
                        break

            if extracted_slug:
                item["comic_slug"] = extracted_slug
                logger.info(f"[chapter_detail] injected comic_slug={extracted_slug}")

    return data


@router.get("/random")
async def random_manga(db=Depends(get_supabase_public)):
    """
    Truyện ngẫu nhiên — instant pick from in-memory pool.
    Pool is populated during cache warmup and refreshed every 5 min.
    """
    hidden = await _get_hidden_slugs(db)

    # Instant path: pick from pre-loaded pool
    for _ in range(8):
        pick = truyenqq_service.get_random_item()
        if not pick:
            break
        if _hidden_reason_for_slug(hidden, pick.get("slug") or pick.get("id")) is None:
            return {
                "id": pick.get("_id") or pick.get("id") or pick.get("slug"),
                "slug": pick.get("slug"),
                "source": "truyenqq",
                "item": pick,
            }

    # Fallback: pool not yet ready (server just started)
    import asyncio

    latest, ongoing = await asyncio.gather(
        truyenqq_service.get_list("truyen-moi", 1),
        truyenqq_service.get_list("dang-phat-hanh", 1),
    )
    items = []
    for src in [latest, ongoing]:
        if isinstance(src, dict) and src.get("status") != "error":
            items.extend(src.get("data", {}).get("items") or [])
    items = _filter_hidden(items, hidden)
    if items:
        pick = random.choice(items)
        return {
            "id": pick.get("_id") or pick.get("id") or pick.get("slug"),
            "slug": pick.get("slug"),
            "source": "truyenqq",
            "item": pick,
        }

    return {"status": "error", "message": "Không tìm thấy truyện ngẫu nhiên"}


@router.get("/trending")
async def trending_manga(
    limit: int = Query(20, ge=1, le=300),
    source: str = Query("all", pattern="^(all|truyenqq|mangadex)$"),
    db=Depends(get_supabase_public),
    user=Depends(get_optional_user),
):
    """Bảng xếp hạng truyện theo lượt xem local. Falls back to OTruyen data if no local views."""
    import asyncio

    trending: list[dict] = []
    normalized_source = _normalize_trending_source(source)
    hidden = await _get_hidden_slugs(db)
    revisions = ":".join(await asyncio.gather(*(asyncio.to_thread(_source_revision, name)
        for name in ("truyenqq", "mangadex") if normalized_source in {"all", name})))
    cache_suffix = (f"{limit}" if normalized_source == "all" else f"{normalized_source}:{limit}") + f":rev={revisions}"
    cache_key = f"manga:trending:{TRENDING_CACHE_VERSION}:{cache_suffix}"
    memory_key = f"{TRENDING_CACHE_VERSION}:{cache_suffix}"

    # --- Fast path: serve from memory cache (instant) ---
    memory_cached = _trending_memory_cache.get(memory_key)
    if memory_cached:
        cached_items, cached_at = memory_cached
        age = time.time() - cached_at
        if cached_items:
            items = await asyncio.to_thread(_filter_trending_items, cached_items, hidden, normalized_source)
            if items and _has_positive_trending_views(items):
                trimmed = items[:limit]
                # If cache is stale, schedule background refresh
                if age >= TRENDING_CACHE_TTL_SECONDS:
                    _schedule_trending_refresh(cache_key, memory_key, limit, db, normalized_source)
                return {"trending": trimmed, "total": len(trimmed)}

    # --- Medium path: serve from disk cache (fast) ---
    cached_payload = await asyncio.to_thread(_load_json_cache, cache_key)
    if isinstance(cached_payload, dict):
        cached_items = cached_payload.get("trending") or []
        if isinstance(cached_items, list) and cached_items and _has_positive_trending_views(cached_items):
            _trending_memory_cache[memory_key] = (cached_items, time.time())
            cached_items = await asyncio.to_thread(_filter_trending_items, cached_items, hidden, normalized_source)
            if cached_items:
                trimmed = cached_items[:limit]
                return {"trending": trimmed, "total": len(trimmed)}

    # --- Cold start: compute trending synchronously from DB (first load may be slow) ---
    trending = await _compute_trending_from_db(limit, db, normalized_source)
    trending = await asyncio.to_thread(_filter_trending_items, trending, hidden, normalized_source)
    if trending and _has_positive_trending_views(trending):
        _trending_memory_cache[memory_key] = (trending, time.time())
        try:
            await asyncio.to_thread(cache.set,
                cache_key,
                json.dumps({"trending": trending, "total": len(trending)}, ensure_ascii=False),
                ttl=TRENDING_CACHE_TTL_SECONDS,
            )
        except Exception:
            pass
        return {"trending": trending[:limit], "total": len(trending[:limit])}

    # Last resort: try to load from any recent cache
    fallback_items = await asyncio.to_thread(_load_recent_trending_fallback, limit=limit, hidden=hidden, source=normalized_source)
    if fallback_items:
        return {"trending": fallback_items, "total": len(fallback_items)}

    return {"trending": [], "total": 0}


_trending_refresh_tasks: dict[str, asyncio.Task] = {}


def _schedule_trending_refresh(
    cache_key: str,
    memory_key: str,
    limit: int,
    db: Any,
    source: str = "all",
) -> None:
    """Schedule a background task to compute real trending data from DB."""
    if cache_key in _trending_refresh_tasks:
        task = _trending_refresh_tasks[cache_key]
        if not task.done():
            return  # Already refreshing

    async def _do_refresh():
        try:
            trending = await _compute_trending_from_db(limit, db, source)
            if trending and _has_positive_trending_views(trending):
                _trending_memory_cache[memory_key] = (trending, time.time())
                try:
                    await asyncio.to_thread(cache.set,
                        cache_key,
                        json.dumps({"trending": trending, "total": len(trending)}, ensure_ascii=False),
                        ttl=TRENDING_CACHE_TTL_SECONDS,
                    )
                except Exception:
                    pass
        except Exception:
            logger.exception("[trending] background refresh failed")
        finally:
            _trending_refresh_tasks.pop(cache_key, None)

    import asyncio
    task = create_task(_do_refresh())
    _trending_refresh_tasks[cache_key] = task


async def _build_otruyen_fallback_trending(limit: int, hidden: dict) -> list[dict]:
    """Build trending data from OTruyen list API — instant, no DB queries needed."""
    import asyncio
    try:
        page_count = min(max(math.ceil(limit / 24), 1), 6)
        payloads = await asyncio.gather(
            *[
                truyenqq_service.get_list(list_type, page)
                for list_type in ("dang-phat-hanh", "truyen-moi")
                for page in range(1, page_count + 1)
            ],
            return_exceptions=True,
        )
        items: list[dict] = []
        seen: set[str] = set()
        for src in payloads:
            if isinstance(src, Exception):
                continue
            if isinstance(src, dict) and src.get("status") != "error":
                for it in (src.get("data", {}).get("items") or []):
                    slug = (it or {}).get("slug", "")
                    if not slug or slug in seen or _is_invalid_manga_slug(slug):
                        continue
                    views = _safe_int(it.get("view_count") or it.get("views"))
                    if views <= 0:
                        continue
                    if _hidden_reason_for_slug(hidden, slug):
                        continue
                    seen.add(slug)
                    genres, tags = _extract_item_categories(it)
                    items.append({
                        "slug": slug,
                        "title": _pick_best_trending_title(
                            slug,
                            _repair_mojibake_text(it.get("name") or ""),
                        ),
                        "thumb": it.get("thumb_url", "") or _fallback_trending_thumb(slug),
                        "views": views,
                        "genres": genres,
                        "tags": tags,
                        "status": str(it.get("status") or "").strip(),
                        "latest_chapter": _pick_item_latest_chapter(it),
                        "latest_chapter_updated_at": _pick_item_latest_chapter_updated_at(it),
                        "last_updated": _pick_item_last_updated(it),
                        "content_rating": str(it.get("content_rating") or it.get("contentRating") or "").strip().lower(),
                        "is_mature": _is_mature_metadata(
                            str(it.get("content_rating") or it.get("contentRating") or "").strip().lower(),
                            genres,
                            tags,
                        ),
                    })
                    if len(items) >= limit:
                        break
            if len(items) >= limit:
                break
        items.sort(key=lambda x: x.get("views", 0), reverse=True)
        return items[:limit]
    except Exception:
        return []


def _merge_trending_fill(primary: list[dict], fallback: list[dict], limit: int) -> list[dict]:
    """Keep local ranking first, then fill missing rows from OTruyen fallback."""
    merged: list[dict] = []
    by_slug: dict[str, dict] = {}

    def add(item: dict) -> None:
        slug = _clean_slug((item or {}).get("slug") or (item or {}).get("id") or "")
        if not slug or _is_invalid_manga_slug(slug):
            return
        item_views = _safe_int((item or {}).get("views") or (item or {}).get("view_count"))
        if item_views <= 0:
            return

        existing = by_slug.get(slug)
        if existing is not None:
            existing["title"] = _pick_best_trending_title(slug, existing.get("title"), item.get("title"))
            existing["views"] = max(_safe_int(existing.get("views")), item_views)
            for field in (
                "id",
                "source",
                "thumb",
                "genres",
                "tags",
                "status",
                "latest_chapter",
                "latest_chapter_updated_at",
                "last_updated",
                "content_rating",
            ):
                if not existing.get(field) and item.get(field):
                    existing[field] = item.get(field)
            existing["is_mature"] = bool(existing.get("is_mature") or item.get("is_mature"))
            return

        normalized = dict(item or {})
        normalized["slug"] = slug
        normalized["views"] = item_views
        by_slug[slug] = normalized
        merged.append(normalized)

    for row in primary or []:
        add(row)

    if len(merged) < limit:
        for row in fallback or []:
            add(row)
            if len(merged) >= limit:
                break

    return merged[:limit]


def _load_trending_snapshots(slugs: list[str], revision: str) -> dict[str, Any]:
    """Fetch optional display snapshots in one Redis round trip per ranking."""
    bases = [_combined_cache_key(kind, page, 120, revision=revision)
             for kind in ("truyen-moi", "dang-phat-hanh") for page in range(1, 13)]
    bases += [f"truyenqq:list:{kind}:{page}"
              for kind in ("truyen-moi", "dang-phat-hanh", "hoan-thanh") for page in range(1, 21)]
    bases += [f"mangadex:vi-catalog:{limit}" for limit in
              (120, 96, 160, 240, 300, 500, 800, 1000, 1200, 2000, 3000, 5000, "all")]
    for slug in slugs:
        manga_id = _extract_mangadex_id(slug)
        bases.append(f"mangadex:lookup:{manga_id}" if manga_id else f"truyenqq:detail:{slug}")
    values = cache.get_many([base + suffix for base in bases for suffix in ("", ":stale")])
    snapshots = {}
    for key, raw in values.items():
        if isinstance(raw, str):
            try:
                snapshots[key] = json.loads(raw)
            except ValueError:
                pass
    return snapshots


@coalesce_reads
async def _compute_trending_from_db(limit: int, db: Any, source: str = "all") -> list[dict]:
    """Heavy computation: build trending from manga_views + reading_history DB tables."""
    import asyncio
    normalized_source = _normalize_trending_source(source)
    hidden = await _get_hidden_slugs(db)
    trending: list[dict] = []

    try:
        db_row_limit = min(max(limit * 30, 1000), 5000)
        views_rows = await asyncio.to_thread(
            lambda: db.table("manga_views")
            .select("manga_slug, views")
            .order("views", desc=True)
            .limit(db_row_limit)
            .execute()
        )
        valid_rows: list[dict] = []
        for r in views_rows.data or []:
            row_views = _safe_int(r.get("views"))
            if row_views <= 0:
                continue
            raw_slug = r.get("manga_slug")
            slug = await _canonical_view_slug(raw_slug)
            if not slug or _is_invalid_manga_slug(slug):
                continue
            if not _trending_source_matches(slug, normalized_source):
                continue
            if _hidden_reason_for_slug(hidden, slug):
                continue
            valid_rows.append(
                {
                    "slug": slug,
                    "views": row_views,
                }
            )
            if len(valid_rows) >= max(limit * 3, limit):
                break

        if not valid_rows:
            try:
                history_limit = min(max(limit * 120, 600), 4000)
                history_rows = await asyncio.to_thread(
                    lambda: db.table("reading_history")
                    .select("manga_slug")
                    .neq("manga_slug", "")
                    .order("read_at", desc=True)
                    .limit(history_limit)
                    .execute()
                )
                history_counts: dict[str, int] = {}
                for history_row in history_rows.data or []:
                    slug = await _canonical_view_slug(history_row.get("manga_slug", ""))
                    if not slug or _is_invalid_manga_slug(slug):
                        continue
                    if not _trending_source_matches(slug, normalized_source):
                        continue
                    if _hidden_reason_for_slug(hidden, slug):
                        continue
                    history_counts[slug] = history_counts.get(slug, 0) + 1

                if history_counts:
                    valid_rows = [
                        {"slug": slug, "views": int(count)}
                        for slug, count in sorted(
                            history_counts.items(),
                            key=lambda item: item[1],
                            reverse=True,
                        )
                    ][: max(limit * 3, limit)]
            except Exception:
                pass

        if normalized_source in {"all", "mangadex"}:
            try:
                views_lookup = await asyncio.to_thread(_fetch_local_views_lookup, db)
                row_by_slug = {
                    str(row.get("slug") or "").strip().lower(): row
                    for row in valid_rows
                    if str(row.get("slug") or "").strip()
                }
                mdx_limit = min(max(limit * 3, _MANGADEX_LOCAL_VIEWED_INJECT_LIMIT), 300)
                for manga_id, views in _top_local_viewed_mangadex_ids(
                    views_lookup,
                    hidden=hidden,
                    limit=mdx_limit,
                ):
                    if not _trending_source_matches(manga_id, normalized_source):
                        continue
                    if _hidden_reason_for_slug(hidden, manga_id):
                        continue
                    existing = row_by_slug.get(manga_id)
                    if existing is not None:
                        existing["views"] = max(_safe_int(existing.get("views")), views)
                        continue
                    row = {"slug": manga_id, "views": views}
                    valid_rows.append(row)
                    row_by_slug[manga_id] = row

                valid_rows.sort(key=lambda row: _safe_int(row.get("views")), reverse=True)
                valid_rows = valid_rows[: max(limit * 3, limit)]
            except Exception:
                pass

        slugs = [r["slug"] for r in valid_rows]
        if slugs:
            source_map: dict[str, dict] = {}
            revision = await asyncio.to_thread(_source_revision, "truyenqq")
            snapshots = await asyncio.to_thread(_load_trending_snapshots, slugs, revision)
            # Avoid network calls in hot endpoint path; enrich only from cached list-combined payloads.
            for list_type in ("truyen-moi", "dang-phat-hanh"):
                for cached_page in range(1, 13):
                    combined_key = _combined_cache_key(list_type=list_type, page=cached_page, max_chapters=120, revision=revision)
                    combined_payload = snapshots.get(combined_key) or snapshots.get(f"{combined_key}:stale")
                    if not isinstance(combined_payload, dict):
                        continue
                    list_payload = combined_payload.get("list")
                    if not isinstance(list_payload, dict):
                        continue
                    for it in (list_payload.get("data") or {}).get("items") or []:
                        source_slug = _clean_slug((it or {}).get("slug"))
                        if not source_slug:
                            continue
                        origin_names = it.get("origin_name") if isinstance(it.get("origin_name"), list) else [it.get("origin_name")]
                        source_title = _pick_best_trending_title(
                            source_slug,
                            _repair_mojibake_text(it.get("name") or ""),
                            *[_repair_mojibake_text(name or "") for name in (origin_names or [])],
                        )
                        genres, tags = _extract_item_categories(it)
                        source_content_rating = str(it.get("content_rating") or it.get("contentRating") or "").strip().lower()
                        source_latest_chapter = _pick_item_latest_chapter(it)
                        source_latest_chapter_updated_at = _pick_item_latest_chapter_updated_at(it)
                        source_last_updated = _pick_item_last_updated(it)

                        existing_source = source_map.get(source_slug, {})
                        merged_title = _pick_best_trending_title(
                            source_slug,
                            existing_source.get("title"),
                            source_title,
                        )
                        merged_thumb = str(existing_source.get("thumb") or it.get("thumb_url") or "").strip()
                        merged_genres = existing_source.get("genres") or genres
                        merged_tags = existing_source.get("tags") or tags
                        merged_status = str(existing_source.get("status") or it.get("status") or "").strip()
                        merged_latest_chapter = str(existing_source.get("latest_chapter") or source_latest_chapter or "").strip()
                        merged_latest_chapter_updated_at = str(
                            existing_source.get("latest_chapter_updated_at")
                            or source_latest_chapter_updated_at
                            or ""
                        ).strip()
                        merged_last_updated = str(existing_source.get("last_updated") or source_last_updated or "").strip()
                        merged_content_rating = str(existing_source.get("content_rating") or source_content_rating or "").strip().lower()
                        merged_is_mature = bool(
                            existing_source.get("is_mature")
                            or _is_mature_metadata(merged_content_rating, merged_genres, merged_tags)
                        )

                        source_map[source_slug] = {
                            "title": merged_title,
                            "thumb": merged_thumb,
                            "genres": merged_genres,
                            "tags": merged_tags,
                            "status": merged_status,
                            "latest_chapter": merged_latest_chapter,
                            "latest_chapter_updated_at": merged_latest_chapter_updated_at,
                            "last_updated": merged_last_updated,
                            "content_rating": merged_content_rating,
                            "is_mature": merged_is_mature,
                        }

            # Plain OTruyen list caches usually have the best Vietnamese titles;
            # use them too so viewed rows do not fall back to slug-like text.
            for list_type in ("truyen-moi", "dang-phat-hanh", "hoan-thanh"):
                for cached_page in range(1, 21):
                    list_payload = (
                        snapshots.get(f"truyenqq:list:{list_type}:{cached_page}")
                        or snapshots.get(f"truyenqq:list:{list_type}:{cached_page}:stale")
                    )
                    if not isinstance(list_payload, dict):
                        continue
                    for it in (list_payload.get("data") or {}).get("items") or []:
                        if not isinstance(it, dict):
                            continue
                        source_slug = _clean_slug(it.get("slug"))
                        if not source_slug:
                            continue
                        origin_names = it.get("origin_name") if isinstance(it.get("origin_name"), list) else [it.get("origin_name")]
                        source_title = _pick_best_trending_title(
                            source_slug,
                            _repair_mojibake_text(it.get("name") or ""),
                            *[_repair_mojibake_text(name or "") for name in (origin_names or [])],
                        )
                        genres, tags = _extract_item_categories(it)
                        source_content_rating = str(it.get("content_rating") or it.get("contentRating") or "").strip().lower()
                        source_latest_chapter = _pick_item_latest_chapter(it)
                        source_latest_chapter_updated_at = _pick_item_latest_chapter_updated_at(it)
                        source_last_updated = _pick_item_last_updated(it)

                        existing_source = source_map.get(source_slug, {})
                        merged_title = _pick_best_trending_title(
                            source_slug,
                            existing_source.get("title"),
                            source_title,
                        )
                        merged_thumb = str(existing_source.get("thumb") or it.get("thumb_url") or "").strip()
                        merged_genres = existing_source.get("genres") or genres
                        merged_tags = existing_source.get("tags") or tags
                        merged_status = str(existing_source.get("status") or it.get("status") or "").strip()
                        merged_latest_chapter = str(existing_source.get("latest_chapter") or source_latest_chapter or "").strip()
                        merged_latest_chapter_updated_at = str(
                            existing_source.get("latest_chapter_updated_at")
                            or source_latest_chapter_updated_at
                            or ""
                        ).strip()
                        merged_last_updated = str(existing_source.get("last_updated") or source_last_updated or "").strip()
                        merged_content_rating = str(existing_source.get("content_rating") or source_content_rating or "").strip().lower()
                        merged_is_mature = bool(
                            existing_source.get("is_mature")
                            or _is_mature_metadata(merged_content_rating, merged_genres, merged_tags)
                        )

                        source_map[source_slug] = {
                            "title": merged_title,
                            "thumb": merged_thumb,
                            "genres": merged_genres,
                            "tags": merged_tags,
                            "status": merged_status,
                            "latest_chapter": merged_latest_chapter,
                            "latest_chapter_updated_at": merged_latest_chapter_updated_at,
                            "last_updated": merged_last_updated,
                            "content_rating": merged_content_rating,
                            "is_mature": merged_is_mature,
                        }

            title_rows = await asyncio.to_thread(
                lambda: db.table("reading_history")
                .select("manga_slug, manga_title, manga_thumb, chapter_name, read_at")
                .in_("manga_slug", slugs)
                .order("read_at", desc=True)
                .limit(min(max(len(slugs) * 3, limit * 8), 320))
                .execute()
            )
            meta_map: dict[str, dict] = {}
            for r in title_rows.data or []:
                s = _clean_slug(r.get("manga_slug", ""))
                if not s:
                    continue

                title = _repair_mojibake_text(r.get("manga_title") or "").strip()
                thumb = str(r.get("manga_thumb") or "").strip()
                latest_chapter = str(r.get("chapter_name") or "").strip()
                latest_chapter_updated_at = str(r.get("read_at") or "").strip()

                current_meta = meta_map.get(s)
                if current_meta is None:
                    current_meta = {}
                    meta_map[s] = current_meta

                if title and not current_meta.get("title") and not _is_slug_like_title(title, s):
                    current_meta["title"] = title
                if thumb and not current_meta.get("thumb"):
                    current_meta["thumb"] = thumb
                if latest_chapter and not current_meta.get("latest_chapter"):
                    current_meta["latest_chapter"] = latest_chapter
                if latest_chapter_updated_at and not current_meta.get("latest_chapter_updated_at"):
                    current_meta["latest_chapter_updated_at"] = latest_chapter_updated_at
                if latest_chapter_updated_at and not current_meta.get("last_updated"):
                    current_meta["last_updated"] = latest_chapter_updated_at

            unresolved_slugs: list[str] = []
            for s in list(dict.fromkeys(slugs)):
                is_mangadex_slug = bool(_extract_mangadex_id(s))
                has_source = s in source_map
                history_meta_for_slug = meta_map.get(s, {})
                has_meta = bool(
                    str(history_meta_for_slug.get("title") or "").strip()
                    or str(history_meta_for_slug.get("thumb") or "").strip()
                )
                source_title = str(source_map.get(s, {}).get("title") or "").strip()
                source_genres = source_map.get(s, {}).get("genres") or []
                source_tags = source_map.get(s, {}).get("tags") or []
                source_content_rating = str(source_map.get(s, {}).get("content_rating") or "").strip().lower()
                existing_thumb = str(
                    source_map.get(s, {}).get("thumb")
                    or history_meta_for_slug.get("thumb")
                    or ""
                ).strip()
                needs_mangadex_cover = is_mangadex_slug and not existing_thumb
                needs_mangadex_mature_meta = is_mangadex_slug and not source_content_rating
                needs_otruyen_meta_refresh = (
                    not is_mangadex_slug
                    and not source_genres
                    and not source_tags
                    and not source_content_rating
                )
                needs_otruyen_chapter_refresh = (
                    not is_mangadex_slug
                    and not str(source_map.get(s, {}).get("latest_chapter") or "").strip()
                    and not str(history_meta_for_slug.get("latest_chapter") or "").strip()
                )
                needs_otruyen_title_quality_refresh = (
                    not is_mangadex_slug
                    and bool(source_title)
                    and not _NON_ASCII_RE.search(source_title)
                )
                needs_otruyen_title_refresh = (
                    not is_mangadex_slug
                    and (not source_title or _is_slug_like_title(source_title, s))
                )
                if (
                    (not has_source and not has_meta)
                    or needs_mangadex_cover
                    or needs_mangadex_mature_meta
                    or needs_otruyen_title_refresh
                    or needs_otruyen_meta_refresh
                    or needs_otruyen_chapter_refresh
                    or needs_otruyen_title_quality_refresh
                ):
                    unresolved_slugs.append(s)
            detail_meta_map: dict[str, dict] = {}
            unresolved_mangadex_slug_map: dict[str, str] = {}
            for unresolved_slug in unresolved_slugs:
                mangadex_id = _extract_mangadex_id(unresolved_slug)
                if mangadex_id:
                    unresolved_mangadex_slug_map[unresolved_slug] = mangadex_id

            # Keep trending endpoint fast: enrich from cached MangaDex catalogs only,
            # avoid extra network/detail calls in request path.
            if unresolved_mangadex_slug_map:
                catalog_meta_map: dict[str, dict[str, Any]] = {}
                for catalog_limit in (120, 96, 160, 240, 300, 500, 800, 1000, 1200, 2000, 3000, 5000, None):
                    catalog_key = f"mangadex:vi-catalog:{'all' if catalog_limit is None else catalog_limit}"
                    catalog_payload = snapshots.get(catalog_key) or snapshots.get(catalog_key + ":stale")
                    if not isinstance(catalog_payload, dict):
                        continue
                    for manga in (catalog_payload.get("mangas") or []):
                        if not isinstance(manga, dict):
                            continue
                        manga_id = _extract_mangadex_id(manga.get("id") or manga.get("slug"))
                        if not manga_id:
                            continue
                        catalog_genres = [
                            str(genre or "").strip()
                            for genre in (manga.get("genres") or [])
                            if str(genre or "").strip()
                        ]
                        existing_catalog_meta = catalog_meta_map.get(manga_id, {})
                        catalog_meta_map[manga_id] = {
                            "title": _repair_mojibake_text(manga.get("title") or "").strip(),
                            "thumb": str(manga.get("cover_url") or existing_catalog_meta.get("thumb") or "").strip(),
                            "genres": catalog_genres or existing_catalog_meta.get("genres") or [],
                            "content_rating": str(
                                manga.get("content_rating")
                                or manga.get("contentRating")
                                or existing_catalog_meta.get("content_rating")
                                or ""
                            ).strip().lower(),
                        }

                for source_slug, manga_id in unresolved_mangadex_slug_map.items():
                    catalog_meta = dict(catalog_meta_map.get(manga_id, {}) or {})
                    lookup_payload = (
                        snapshots.get(f"mangadex:lookup:{manga_id}")
                        or snapshots.get(f"mangadex:lookup:{manga_id}:stale")
                    )
                    lookup_manga = (lookup_payload or {}).get("manga") if isinstance(lookup_payload, dict) else None
                    if isinstance(lookup_manga, dict):
                        lookup_genres = [
                            str(genre or "").strip()
                            for genre in (lookup_manga.get("genres") or [])
                            if str(genre or "").strip()
                        ]
                        catalog_meta = {
                            "title": _repair_mojibake_text(
                                lookup_manga.get("title")
                                or catalog_meta.get("title")
                                or ""
                            ).strip(),
                            "thumb": str(lookup_manga.get("cover_url") or catalog_meta.get("thumb") or "").strip(),
                            "genres": lookup_genres or catalog_meta.get("genres") or [],
                            "content_rating": str(
                                lookup_manga.get("content_rating")
                                or lookup_manga.get("contentRating")
                                or catalog_meta.get("content_rating")
                                or ""
                            ).strip().lower(),
                        }
                    title = str(catalog_meta.get("title") or "").strip()
                    thumb = str(catalog_meta.get("thumb") or "").strip()
                    genres = [
                        str(genre or "").strip()
                        for genre in (catalog_meta.get("genres") or [])
                        if str(genre or "").strip()
                    ]
                    content_rating = str(catalog_meta.get("content_rating") or "").strip().lower()
                    if not title and not thumb:
                        title = f"MangaDex {manga_id[:8]}"
                    if title or thumb or genres or content_rating:
                        detail_meta_map[source_slug] = {
                            "title": title,
                            "thumb": thumb,
                            "genres": genres,
                            "content_rating": content_rating,
                            "is_mature": _is_mature_metadata(content_rating, genres, []),
                        }

                missing_mangadex_detail: list[tuple[str, str]] = []
                for source_slug, manga_id in unresolved_mangadex_slug_map.items():
                    existing_meta = detail_meta_map.get(source_slug) or {}
                    existing_content_rating = str(existing_meta.get("content_rating") or "").strip().lower()
                    if existing_content_rating:
                        continue
                    missing_mangadex_detail.append((source_slug, manga_id))

                if missing_mangadex_detail and TRENDING_ENABLE_NETWORK_DETAIL_ENRICH:
                    mdx_candidates = missing_mangadex_detail[: min(max(limit, 8), 18)]
                    mdx_semaphore = asyncio.Semaphore(2)

                    async def _fetch_mangadex_detail_meta(target_slug: str, target_id: str) -> tuple[str, dict[str, Any]]:
                        async with mdx_semaphore:
                            try:
                                payload = await asyncio.wait_for(
                                    mangadex_service.get_manga_detail(target_id, max_chapters=1),
                                    timeout=8.0,
                                )
                            except Exception:
                                return target_slug, {}

                            item = (payload or {}).get("manga") or {}
                            if not isinstance(item, dict):
                                return target_slug, {}

                            title = _repair_mojibake_text(item.get("title") or "").strip()
                            thumb = str(item.get("cover_url") or "").strip()
                            genres = [
                                str(genre or "").strip()
                                for genre in (item.get("genres") or [])
                                if str(genre or "").strip()
                            ]
                            content_rating = str(
                                item.get("content_rating")
                                or item.get("contentRating")
                                or ""
                            ).strip().lower()

                            if not (title or thumb or genres or content_rating):
                                return target_slug, {}

                            return target_slug, {
                                "title": title,
                                "thumb": thumb,
                                "genres": genres,
                                "content_rating": content_rating,
                                "is_mature": _is_mature_metadata(content_rating, genres, []),
                            }

                    mdx_results = await asyncio.gather(
                        *[_fetch_mangadex_detail_meta(target_slug, target_id) for target_slug, target_id in mdx_candidates],
                        return_exceptions=True,
                    )

                    for mdx_result in mdx_results:
                        if isinstance(mdx_result, Exception):
                            continue
                        source_slug, extracted_meta = mdx_result
                        if not extracted_meta:
                            continue
                        merged_meta = dict(detail_meta_map.get(source_slug) or {})
                        merged_meta.update({k: v for k, v in extracted_meta.items() if v})
                        if merged_meta:
                            detail_meta_map[source_slug] = merged_meta

            unresolved_otruyen_slugs = [
                source_slug
                for source_slug in unresolved_slugs
                if not _extract_mangadex_id(source_slug)
            ]
            if unresolved_otruyen_slugs:
                cached_detail_candidates = list(dict.fromkeys(unresolved_otruyen_slugs))[ : min(max(limit * 2, 24), 240) ]
                for source_slug in cached_detail_candidates:
                    detail_payload = snapshots.get(f"truyenqq:detail:{source_slug}") or snapshots.get(f"truyenqq:detail:{source_slug}:stale")
                    if not isinstance(detail_payload, dict):
                        continue
                    extracted_meta = _extract_otruyen_detail_meta(source_slug, detail_payload)
                    if not extracted_meta:
                        continue
                    merged_meta = dict(detail_meta_map.get(source_slug) or {})
                    merged_meta.update({k: v for k, v in extracted_meta.items() if v})
                    if merged_meta:
                        detail_meta_map[source_slug] = merged_meta

            if unresolved_otruyen_slugs and TRENDING_ENABLE_NETWORK_DETAIL_ENRICH:
                detail_candidates = list(dict.fromkeys(unresolved_otruyen_slugs))[ : min(max(limit, 12), 24) ]
                detail_semaphore = asyncio.Semaphore(2)

                async def _fetch_detail_meta_for_slug(target_slug: str) -> tuple[str, dict[str, Any]]:
                    async with detail_semaphore:
                        try:
                            detail_payload = await asyncio.wait_for(
                                truyenqq_service.get_manga_detail(target_slug),
                                timeout=8.0,
                            )
                        except Exception:
                            return target_slug, {}
                        return target_slug, _extract_otruyen_detail_meta(target_slug, detail_payload)

                detail_results = await asyncio.gather(
                    *[_fetch_detail_meta_for_slug(target_slug) for target_slug in detail_candidates],
                    return_exceptions=True,
                )
                for detail_result in detail_results:
                    if isinstance(detail_result, Exception):
                        continue
                    source_slug, extracted_meta = detail_result
                    if not extracted_meta:
                        continue
                    merged_meta = dict(detail_meta_map.get(source_slug) or {})
                    merged_meta.update({k: v for k, v in extracted_meta.items() if v})
                    if merged_meta:
                        detail_meta_map[source_slug] = merged_meta

            from fastapi_app.services.card_metadata import get_many
            mdx_ids = [slug for slug in slugs if _extract_mangadex_id(slug)]
            mdx_labels = {}
            for start in range(0, len(mdx_ids), 48):
                labels = await get_many(mdx_ids[start:start + 48])
                mdx_labels.update(labels)
                for slug, label in labels.items():
                    if not label:
                        continue
                    detail_meta_map[slug] = {**detail_meta_map.get(slug, {}),
                        "title": label["title"], "thumb": label.get("cover_url", ""),
                        "genres": label.get("genres", []), "content_rating": label.get("content_rating", "")}

            merged_items: list[dict] = []
            for row in valid_rows:
                slug = row["slug"]
                is_mangadex_slug = bool(_extract_mangadex_id(slug))
                source_meta = source_map.get(slug, {})
                history_meta = meta_map.get(slug, {})
                detail_meta = detail_meta_map.get(slug, {})
                has_resolved_meta = bool(
                    str(source_meta.get("title") or source_meta.get("thumb") or "").strip()
                    or str(history_meta.get("title") or history_meta.get("thumb") or "").strip()
                    or str(detail_meta.get("title") or detail_meta.get("thumb") or "").strip()
                )
                if is_mangadex_slug and slug in mdx_labels and mdx_labels[slug] is None and not has_resolved_meta:
                    continue
                resolved_title = _pick_best_trending_title(
                    slug,
                    detail_meta.get("title"),
                    source_meta.get("title"),
                    history_meta.get("title"),
                )
                resolved_thumb = (
                    source_meta.get("thumb")
                    or detail_meta.get("thumb")
                    or history_meta.get("thumb")
                    or (f"/api/manga/mangadex-cover/{_extract_mangadex_id(slug)}" if is_mangadex_slug else _fallback_trending_thumb(slug))
                )
                resolved_genres = source_meta.get("genres") or detail_meta.get("genres") or []
                resolved_tags = source_meta.get("tags") or detail_meta.get("tags") or []
                resolved_status = source_meta.get("status") or detail_meta.get("status") or ""
                resolved_latest_chapter = (
                    source_meta.get("latest_chapter")
                    or detail_meta.get("latest_chapter")
                    or history_meta.get("latest_chapter")
                    or ""
                )
                resolved_latest_chapter_updated_at = (
                    source_meta.get("latest_chapter_updated_at")
                    or detail_meta.get("latest_chapter_updated_at")
                    or history_meta.get("latest_chapter_updated_at")
                    or ""
                )
                resolved_last_updated = (
                    source_meta.get("last_updated")
                    or detail_meta.get("last_updated")
                    or history_meta.get("last_updated")
                    or resolved_latest_chapter_updated_at
                    or ""
                )
                resolved_content_rating = (
                    source_meta.get("content_rating")
                    or detail_meta.get("content_rating")
                    or ""
                )
                resolved_is_mature = bool(
                    source_meta.get("is_mature")
                    or detail_meta.get("is_mature")
                    or _is_mature_metadata(resolved_content_rating, resolved_genres, resolved_tags)
                )
                if not str(resolved_title or "").strip() and not str(resolved_thumb or "").strip():
                    continue
                trending.append(
                    {
                        "id": slug,
                        "slug": slug,
                        "source": "mangadex" if is_mangadex_slug else "truyenqq",
                        "title": resolved_title,
                        "thumb": resolved_thumb,
                        "views": row["views"],
                        "genres": resolved_genres,
                        "tags": resolved_tags,
                        "status": resolved_status,
                        "latest_chapter": resolved_latest_chapter,
                        "latest_chapter_updated_at": resolved_latest_chapter_updated_at,
                        "last_updated": resolved_last_updated,
                        "content_rating": str(resolved_content_rating or "").strip().lower(),
                        "is_mature": resolved_is_mature,
                    }
                )
            for item in trending:
                key = item.get("slug", "")
                existing = next((x for x in merged_items if x.get("key") == key), None)
                if existing:
                    existing["views"] += int(item.get("views") or 0)
                    current_title = str(existing.get("title") or "")
                    next_title = str(item.get("title") or "")
                    if current_title and "[" in current_title and "[" not in next_title:
                        existing["title"] = next_title
                    if not existing.get("thumb") and item.get("thumb"):
                        existing["thumb"] = item.get("thumb")
                    if not existing.get("id") and item.get("id"):
                        existing["id"] = item.get("id")
                    if not existing.get("source") and item.get("source"):
                        existing["source"] = item.get("source")
                    if not existing.get("genres") and item.get("genres"):
                        existing["genres"] = item.get("genres")
                    if not existing.get("tags") and item.get("tags"):
                        existing["tags"] = item.get("tags")
                    if not existing.get("status") and item.get("status"):
                        existing["status"] = item.get("status")
                    if not existing.get("latest_chapter") and item.get("latest_chapter"):
                        existing["latest_chapter"] = item.get("latest_chapter")
                    if not existing.get("latest_chapter_updated_at") and item.get("latest_chapter_updated_at"):
                        existing["latest_chapter_updated_at"] = item.get("latest_chapter_updated_at")
                    if not existing.get("last_updated") and item.get("last_updated"):
                        existing["last_updated"] = item.get("last_updated")
                    if not existing.get("content_rating") and item.get("content_rating"):
                        existing["content_rating"] = item.get("content_rating")
                    if not existing.get("is_mature") and item.get("is_mature"):
                        existing["is_mature"] = item.get("is_mature")
                else:
                    merged_items.append(
                        {
                            "key": key,
                            "id": item.get("id") or item.get("slug"),
                            "slug": item.get("slug"),
                            "source": item.get("source") or "",
                            "title": item.get("title"),
                            "thumb": item.get("thumb"),
                            "views": int(item.get("views") or 0),
                            "genres": item.get("genres") or [],
                            "tags": item.get("tags") or [],
                            "status": item.get("status") or "",
                            "latest_chapter": item.get("latest_chapter") or "",
                            "latest_chapter_updated_at": item.get("latest_chapter_updated_at") or "",
                            "last_updated": item.get("last_updated") or "",
                            "content_rating": item.get("content_rating") or "",
                            "is_mature": bool(item.get("is_mature")),
                        }
                    )
            trending = [
                {
                    "slug": x.get("slug"),
                    "id": x.get("id") or x.get("slug"),
                    "source": x.get("source") or "",
                    "title": x.get("title"),
                    "thumb": x.get("thumb"),
                    "views": int(x.get("views") or 0),
                    "genres": x.get("genres") or [],
                    "tags": x.get("tags") or [],
                    "status": x.get("status") or "",
                    "latest_chapter": x.get("latest_chapter") or "",
                    "latest_chapter_updated_at": x.get("latest_chapter_updated_at") or "",
                    "last_updated": x.get("last_updated") or "",
                    "content_rating": x.get("content_rating") or "",
                    "is_mature": bool(x.get("is_mature")),
                }
                for x in merged_items
            ]
            trending.sort(key=lambda x: x.get("views", 0), reverse=True)
            trending = trending[:limit]
    except Exception:
        pass

    # A ranking must not fetch unrelated latest releases to fill empty slots.
    # Besides adding an external source wait, those cards are not ranked by
    # local views. A short real ranking is preferable to invented entries.
    if not trending:
        trending = await asyncio.to_thread(_load_recent_trending_fallback, limit=limit, hidden=hidden, source=normalized_source)

    return trending[:limit]


@router.get("/mangadex-cover/{manga_id}")
async def mangadex_cover(manga_id: str, request: Request, size: int = 512):
    """Resolve a saved cover and serve it through the existing image cache."""
    manga_id = manga_id.strip()
    if size not in {256, 512}:
        raise HTTPException(status_code=400, detail="Invalid cover size")
    if not mangadex_service._MANGADEX_UUID_RE.fullmatch(manga_id):
        raise HTTPException(status_code=400, detail="Invalid manga ID")
    manga_id = manga_id.lower()
    try:
        cover_url = await mangadex_service.get_cover_url(manga_id)
    except RuntimeError as error:
        if getattr(error, "status_code", None) in {404, 410}:
            raise HTTPException(status_code=404, detail="Cover not found") from error
        logger.warning("MangaDex cover source unavailable for %s (%s)", manga_id, type(error).__name__)
        return _mangadex_unavailable_response()

    if not cover_url:
        raise HTTPException(status_code=404, detail="Cover not found")

    if size == 256:
        source = urlsplit(cover_url)
        if source.hostname == 'uploads.mangadex.org' and source.path.startswith('/covers/'):
            small = re.sub(r'\.(?:256|512)\.jpg$', '', source.path, flags=re.I) + '.256.jpg'
            cover_url = urlunsplit(source._replace(path=small))

    # A redirect made saved covers pay for a second network round trip and
    # access check before showing any bytes. Reuse the same validated cache
    # and ETag handling directly, after this request's normal access gate.
    from fastapi_app.routers.images import proxy_image
    return await proxy_image(cover_url, request)


@router.get("/image-url")
async def image_url(path: str):
    """Build full CDN image URL."""
    return {"url": truyenqq_service.get_image_url(path)}
