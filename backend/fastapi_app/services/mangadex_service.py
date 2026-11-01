import asyncio
from serverless_runtime import create_task
import hashlib
import json
import logging
import math
import os
import re
import time
import threading
import httpx
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit
from fastapi_app.services.cache_service import cache
from fastapi_app.services.request_coalescing import coalesce_reads

try:
    from curl_cffi.requests import Session as CurlSession
except Exception:  # pragma: no cover - fallback to httpx-only mode
    CurlSession = None


logger = logging.getLogger(__name__)

_CHAPTER_NUMBER_RE = re.compile(r"(\d+(?:[\.,]\d+)?)")
_MANGADEX_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


BASE_URL = "https://api.mangadex.org"
REQUEST_HEADERS = {
    "Accept": "application/json",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
    # Identify server-to-server API traffic honestly. Browser User-Agents can
    # be redirected to an interactive edge challenge instead of receiving JSON.
    "User-Agent": "MangaHub/1.0 (MangaDex API client)",
}

TRANSPORT_HTTPX = "httpx"
TRANSPORT_CURL_CFFI = "curl_cffi"
TRANSPORT_AUTO = "auto"


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


MANGADEX_TRANSPORT = str(
    os.getenv("MANGADEX_TRANSPORT", TRANSPORT_CURL_CFFI) or TRANSPORT_CURL_CFFI
).strip().lower()
REQUEST_RETRIES = _env_int("MANGADEX_RETRIES", 1, minimum=1)
REQUEST_TIMEOUT_SECONDS = _env_float("MANGADEX_TIMEOUT_SECONDS", 12.0, minimum=5.0)
REQUEST_CONNECT_TIMEOUT_SECONDS = _env_float("MANGADEX_CONNECT_TIMEOUT_SECONDS", 10.0, minimum=1.0)
REQUEST_CONNECT_TIMEOUT_SECONDS = min(REQUEST_CONNECT_TIMEOUT_SECONDS, REQUEST_TIMEOUT_SECONDS)
REQUEST_RETRY_BACKOFF_SECONDS = _env_float("MANGADEX_RETRY_BACKOFF_SECONDS", 0.35, minimum=0.05)
HTTP_KEEPALIVE_CONNECTIONS = _env_int("MANGADEX_HTTP_KEEPALIVE_CONNECTIONS", 8, minimum=0)
HTTP_KEEPALIVE_EXPIRY_SECONDS = _env_float("MANGADEX_HTTP_KEEPALIVE_EXPIRY_SECONDS", 30.0, minimum=0.1)
CURL_WORKERS = _env_int("MANGADEX_CURL_WORKERS", 8, minimum=1)
CURL_IMPERSONATE = str(os.getenv("MANGADEX_CURL_IMPERSONATE", "chrome131") or "chrome131").strip() or "chrome131"
DETAIL_CHAPTER_PAGE_CONCURRENCY = _env_int(
    "MANGADEX_DETAIL_CHAPTER_PAGE_CONCURRENCY", 3, minimum=1
)
UPSTREAM_REQUEST_CONCURRENCY = _env_int(
    "MANGADEX_UPSTREAM_REQUEST_CONCURRENCY", 2, minimum=1
)
THROTTLE_BACKOFF_SECONDS = _env_float(
    "MANGADEX_THROTTLE_BACKOFF_SECONDS", 2.0, minimum=0.1
)
THROTTLE_GLOBAL_COOLDOWN_SECONDS = _env_float(
    "MANGADEX_THROTTLE_GLOBAL_COOLDOWN_SECONDS", 2.5, minimum=0.0
)
THROTTLE_ENHANCE_YOUR_CALM_COOLDOWN_SECONDS = _env_float(
    "MANGADEX_ENHANCE_YOUR_CALM_COOLDOWN_SECONDS", 45.0, minimum=5.0
)
COOLDOWN_FAST_FAIL_SECONDS = _env_float(
    "MANGADEX_COOLDOWN_FAST_FAIL_SECONDS", 4.0, minimum=0.0
)

_http_client: httpx.AsyncClient | None = None
_curl_executor = ThreadPoolExecutor(max_workers=CURL_WORKERS)
_curl_session: Any = None
_curl_session_lock = threading.Lock()
_request_semaphore = asyncio.Semaphore(UPSTREAM_REQUEST_CONCURRENCY)
_throttle_until_ts: float = 0.0
_inflight_request_tasks: dict[str, asyncio.Task] = {}
_vi_catalog_cover_enrich_tasks: dict[str, asyncio.Task] = {}
_vi_catalog_top_up_tasks: dict[str, asyncio.Task] = {}
_vi_catalog_refresh_tasks: dict[str, asyncio.Task] = {}
_vi_catalog_manga_feed_safe_offsets: dict[str, int] = {}
_vi_catalog_lookup_index: dict[str, dict[str, Any]] = {}
_vi_catalog_lookup_index_at: float = 0.0
VI_CATALOG_TTL = 180
MANGA_DETAIL_TTL = 300
MANGA_DETAIL_CACHE_VERSION = 3
CHAPTER_PAGES_TTL = 120
TOTAL_COUNT_TTL = 600
STALE_TTL = 3600
COVER_URL_STALE_TTL = 7 * 24 * 60 * 60
SEARCH_SNAPSHOT_TTL = 24 * 60 * 60
VI_CATALOG_LOOKUP_INDEX_TTL = 90
LATEST_CHAPTER_CACHE_VERSION = 4
LATEST_CHAPTER_LOW_CONFIDENCE_FALLBACK_MAX = _env_int(
    "MANGADEX_LATEST_LOW_CONFIDENCE_FALLBACK_MAX", 16, minimum=1
)
LATEST_CHAPTER_FALLBACK_CONCURRENCY = _env_int(
    "MANGADEX_LATEST_FALLBACK_CONCURRENCY", 2, minimum=1
)
LATEST_CHAPTER_BATCH_TIMEOUT_SECONDS = _env_float(
    "MANGADEX_LATEST_BATCH_TIMEOUT_SECONDS", 2.8, minimum=0.5
)
VI_CATALOG_COVER_ENRICH_TIMEOUT_SECONDS = _env_float(
    "MANGADEX_VI_CATALOG_COVER_ENRICH_TIMEOUT_SECONDS", 2.0, minimum=0.0
)
VI_CATALOG_FALLBACK_LIMITS = (160, 120, 200, 240, 300, 500, 1000, 2000, 3000, 5000, 10000)
VI_CATALOG_TOP_UP_MIN_CHAPTERS = _env_int(
    "MANGADEX_VI_CATALOG_TOP_UP_MIN_CHAPTERS", 500, minimum=120
)
VI_CATALOG_MANGA_FEED_PAGE_SIZE = _env_int(
    "MANGADEX_VI_CATALOG_MANGA_FEED_PAGE_SIZE", 100, minimum=20
)
VI_CATALOG_MANGA_FEED_MAX_OFFSET = _env_int(
    "MANGADEX_VI_CATALOG_MANGA_FEED_MAX_OFFSET", 1600, minimum=200
)
VI_CATALOG_MANGA_FEED_MAX_PAGES = _env_int(
    "MANGADEX_VI_CATALOG_MANGA_FEED_MAX_PAGES", 40, minimum=8
)
VI_CATALOG_MANGA_FEED_TOP_UP_MAX_SECONDS = _env_float(
    "MANGADEX_VI_CATALOG_MANGA_FEED_TOP_UP_MAX_SECONDS", 5.0, minimum=1.0
)
VI_CATALOG_TARGET_MANGA_MIN = _env_int(
    "MANGADEX_VI_CATALOG_TARGET_MANGA_MIN", 360, minimum=120
)
VI_CATALOG_TARGET_MANGA_MAX = _env_int(
    "MANGADEX_VI_CATALOG_TARGET_MANGA_MAX",
    6000,
    minimum=max(VI_CATALOG_TARGET_MANGA_MIN, 2000),
)
VI_CATALOG_TARGET_MANGA_ALL = _env_int(
    "MANGADEX_VI_CATALOG_TARGET_MANGA_ALL",
    5000,
    minimum=max(VI_CATALOG_TARGET_MANGA_MIN, 600),
)
VI_CATALOG_ALL_SYNC_TARGET_MANGA = _env_int(
    "MANGADEX_VI_CATALOG_ALL_SYNC_TARGET_MANGA",
    700,
    minimum=max(VI_CATALOG_TARGET_MANGA_MIN, 600),
)
VI_CATALOG_FAST_BREAK_MIN_CHAPTERS = _env_int(
    "MANGADEX_VI_CATALOG_FAST_BREAK_MIN_CHAPTERS", 300, minimum=100
)
VI_CATALOG_ALL_INITIAL_CHAPTERS = _env_int(
    "MANGADEX_VI_CATALOG_ALL_INITIAL_CHAPTERS", 900, minimum=300
)
VI_CATALOG_POPULAR_FIRST_COUNT = _env_int(
    "MANGADEX_VI_CATALOG_POPULAR_FIRST_COUNT", 720, minimum=24
)
VI_CATALOG_POPULAR_FIRST_MAX_SECONDS = _env_float(
    "MANGADEX_VI_CATALOG_POPULAR_FIRST_MAX_SECONDS", 3.0, minimum=0.2
)
VI_CATALOG_POPULAR_FIRST_CHAPTER_BUDGET = _env_int(
    "MANGADEX_VI_CATALOG_POPULAR_FIRST_CHAPTER_BUDGET", 300, minimum=0
)
MANGADEX_POPULARITY_SCORE_BASE = 1_000_000
LATEST_FEED_CHAPTER_PAGE_SIZE = _env_int(
    "MANGADEX_LATEST_FEED_CHAPTER_PAGE_SIZE", 100, minimum=24
)


class _MangaDexStatusError(RuntimeError):
    """Raised for non-success HTTP responses from MangaDex."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


class _MangaDexNetworkError(RuntimeError):
    """Raised for network/transport failures when calling MangaDex."""


def _cache_payload(cache_key: str, payload: dict[str, Any], ttl: int) -> None:
    json_payload = json.dumps(payload, ensure_ascii=False)
    cache.set(cache_key, json_payload, ttl=ttl)
    cache.set(f"{cache_key}:stale", json_payload, ttl=STALE_TTL)


def _payload_has_mangas(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    mangas = payload.get("mangas")
    return isinstance(mangas, list) and len(mangas) > 0


def _load_json_cache_payload(cache_key: str) -> dict[str, Any] | None:
    raw = cache.get(cache_key)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        cache.delete(cache_key)
        return None
    if isinstance(data, dict):
        if cache_key.startswith("mangadex:vi-catalog:") and isinstance(data.get("mangas"), list):
            _overlay_live_catalog_chapters(data)
        return data
    cache.delete(cache_key)
    return None


def _overlay_live_catalog_chapters(payload: dict[str, Any]) -> None:
    """Keep large discovery snapshots current without crawling the catalog again."""
    probe = _load_json_cache_payload("catalog:probe:mangadex") or {}
    by_manga = {}
    for raw in probe.get("data") or []:
        manga_id = _extract_manga_id_from_chapter(raw)
        if manga_id:
            by_manga.setdefault(manga_id, []).append(raw)
    for manga in payload["mangas"]:
        if not isinstance(manga, dict):
            continue
        rows = by_manga.get(manga.get("id"))
        if not rows:
            continue
        chapters = manga.get("chapters")
        if not isinstance(chapters, list):
            chapters = manga["chapters"] = []
        by_id = {chapter.get("id"): chapter for chapter in chapters if isinstance(chapter, dict)}
        for raw in rows:
            attributes = raw.get("attributes") or {}
            if attributes.get("translatedLanguage") != "vi":
                continue
            groups = _parse_scanlation_groups(_relation_bucket(raw).get("scanlation_group", []))
            number = str(attributes.get("chapter") or "0")
            entry = {"id": raw.get("id"), "chapter": number, "title": attributes.get("title", ""),
                     "translated_language": "vi", "external_url": attributes.get("externalUrl", ""),
                     "publish_at": attributes.get("publishAt", ""), "readable_at": attributes.get("readableAt", ""),
                     "created_at": attributes.get("createdAt", ""), "updated_at": attributes.get("updatedAt", ""),
                     "scanlation_groups": groups, "chapter_with_groups": _build_chapter_with_groups(number, groups),
                     "translation_source": "mangadex", "translation_source_label": "MangaDex"}
            if entry["id"] in by_id:
                by_id[entry["id"]].update(entry)
            else:
                chapters.append(entry)
            timestamp = entry["readable_at"] or entry["publish_at"] or entry["updated_at"]
            if timestamp and timestamp > str(manga.get("local_last_published_at") or ""):
                manga["local_last_published_at"] = timestamp


def _load_non_empty_vi_catalog_fallback(max_chapters: int | None) -> dict[str, Any] | None:
    preferred_limits: list[int] = []
    known_limits_desc = sorted(set(int(limit) for limit in VI_CATALOG_FALLBACK_LIMITS), reverse=True)

    if max_chapters is not None:
        target = int(max_chapters)
        preferred_limits.append(target)

        # Prefer nearest-larger datasets first so browse pagination is not
        # silently truncated to tiny caches (e.g. 120/160) when high limits fail.
        lower_or_equal = [limit for limit in known_limits_desc if limit <= target and limit != target]
        higher = [limit for limit in known_limits_desc if limit > target]
        preferred_limits.extend(higher)
        preferred_limits.extend(lower_or_equal)
    else:
        # For 'all', try the largest cached catalogs first.
        preferred_limits.extend(known_limits_desc)

    checked: set[str] = set()

    if max_chapters is None:
        for suffix in ("", ":stale"):
            all_key = f"mangadex:vi-catalog:all{suffix}"
            if all_key in checked:
                continue
            checked.add(all_key)
            payload = _load_json_cache_payload(all_key)
            if _payload_has_mangas(payload):
                return payload

    for limit in preferred_limits:
        key = f"mangadex:vi-catalog:{limit}"
        for suffix in ("", ":stale"):
            candidate_key = f"{key}{suffix}"
            if candidate_key in checked:
                continue
            checked.add(candidate_key)
            payload = _load_json_cache_payload(candidate_key)
            if _payload_has_mangas(payload):
                return payload
    return None


def _build_vi_catalog_lookup_index() -> dict[str, dict[str, Any]]:
    preferred_keys: list[str] = ["mangadex:vi-catalog:all"]
    for limit in sorted({*VI_CATALOG_FALLBACK_LIMITS, 2000, 3000, 5000}, reverse=True):
        preferred_keys.append(f"mangadex:vi-catalog:{int(limit)}")

    keys = [key + suffix for key in preferred_keys for suffix in ("", ":stale")]
    values = cache.get_many(keys)
    seen: set[str] = set()
    for base_key in preferred_keys:
        for suffix in ("", ":stale"):
            key = f"{base_key}{suffix}"
            if key in seen:
                continue
            seen.add(key)
            raw = values.get(key)
            try:
                payload = json.loads(raw) if isinstance(raw, str) else None
            except ValueError:
                payload = None
            if not _payload_has_mangas(payload):
                continue

            _overlay_live_catalog_chapters(payload)

            index: dict[str, dict[str, Any]] = {}
            for manga in (payload or {}).get("mangas") or []:
                manga_id = str((manga or {}).get("id") or "").strip().lower()
                if not manga_id or not isinstance(manga, dict):
                    continue
                index[manga_id] = manga
            if index:
                return index

    return {}


def _get_cached_vi_catalog_manga(manga_id: str) -> dict[str, Any] | None:
    global _vi_catalog_lookup_index, _vi_catalog_lookup_index_at

    normalized_id = str(manga_id or "").strip().lower()
    if not normalized_id:
        return None

    now = time.time()
    if (
        _vi_catalog_lookup_index_at <= 0
        or now - _vi_catalog_lookup_index_at >= VI_CATALOG_LOOKUP_INDEX_TTL
    ):
        _vi_catalog_lookup_index = _build_vi_catalog_lookup_index()
        _vi_catalog_lookup_index_at = now

    manga = _vi_catalog_lookup_index.get(normalized_id)
    if not isinstance(manga, dict):
        return None

    try:
        return json.loads(json.dumps(manga, ensure_ascii=False))
    except Exception:
        return dict(manga)


def _manga_map_from_payload(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    mangas = payload.get("mangas") or []
    return {
        str((manga or {}).get("id") or ""): manga
        for manga in mangas
        if isinstance(manga, dict) and str((manga or {}).get("id") or "")
    }


def _count_missing_cover_urls(mangas_map: dict[str, dict[str, Any]]) -> int:
    return sum(
        1
        for manga in mangas_map.values()
        if not str((manga or {}).get("cover_url") or "").strip()
    )


def _popularity_score_from_rank(rank: int) -> int:
    return max(1, MANGADEX_POPULARITY_SCORE_BASE - max(0, rank))


def _apply_mangadex_popularity_rank(manga: dict[str, Any], rank: int) -> None:
    if rank <= 0:
        return
    score = _popularity_score_from_rank(rank)
    try:
        current_score = int(manga.get("mangadex_popularity_score") or 0)
    except Exception:
        current_score = 0
    if current_score >= score:
        return
    manga["mangadex_popularity_rank"] = rank
    manga["mangadex_popularity_score"] = score


def _count_missing_popularity_scores(mangas_map: dict[str, dict[str, Any]]) -> int:
    return sum(
        1
        for manga in mangas_map.values()
        if int((manga or {}).get("mangadex_popularity_score") or 0) <= 0
    )


def _schedule_vi_catalog_cover_enrich(
    cache_key: str,
    payload: dict[str, Any],
    *,
    reason: str,
) -> None:
    existing = _vi_catalog_cover_enrich_tasks.get(cache_key)
    if existing and not existing.done():
        return

    try:
        payload_copy = json.loads(json.dumps(payload, ensure_ascii=False))
    except Exception:
        payload_copy = payload

    async def _job() -> None:
        try:
            mangas_map = _manga_map_from_payload(payload_copy)
            if not mangas_map:
                return
            before_missing = _count_missing_cover_urls(mangas_map)
            if before_missing <= 0:
                return

            await _enrich_missing_cover_urls(mangas_map)
            after_missing = _count_missing_cover_urls(mangas_map)
            payload_copy["mangas"] = list(mangas_map.values())

            if after_missing < before_missing and _payload_has_mangas(payload_copy):
                _cache_payload(cache_key, payload_copy, ttl=VI_CATALOG_TTL)
                logger.info(
                    "MangaDex vi-catalog background cover enrich improved covers (%s -> %s, reason=%s)",
                    before_missing,
                    after_missing,
                    reason,
                )
        except Exception as error:
            logger.warning(
                "MangaDex vi-catalog background cover enrich failed (%s): %s",
                reason,
                error,
            )
        finally:
            _vi_catalog_cover_enrich_tasks.pop(cache_key, None)

    _vi_catalog_cover_enrich_tasks[cache_key] = create_task(_job())


def _schedule_vi_catalog_top_up(
    cache_key: str,
    payload: dict[str, Any],
    *,
    target_count: int,
    reason: str,
) -> None:
    if target_count <= 0:
        return

    existing = _vi_catalog_top_up_tasks.get(cache_key)
    if existing and not existing.done():
        return

    try:
        payload_copy = json.loads(json.dumps(payload, ensure_ascii=False))
    except Exception:
        payload_copy = payload

    async def _job() -> None:
        try:
            mangas_map = _manga_map_from_payload(payload_copy)
            if not mangas_map:
                return
            if len(mangas_map) >= target_count:
                return

            before_count = len(mangas_map)
            before_missing_popularity = _count_missing_popularity_scores(mangas_map)
            await _top_up_vi_catalog_from_manga_feed(
                mangas_map,
                target_count=target_count,
            )

            after_count = len(mangas_map)
            after_missing_popularity = _count_missing_popularity_scores(mangas_map)

            if after_count <= before_count and after_missing_popularity >= before_missing_popularity:
                return

            meta = payload_copy.get("meta") if isinstance(payload_copy, dict) else {}
            if not isinstance(meta, dict):
                meta = {}

            payload_copy["meta"] = {
                **meta,
                "total_manga": after_count,
                "target_manga": target_count,
            }
            payload_copy["mangas"] = list(mangas_map.values())
            _cache_payload(cache_key, payload_copy, ttl=VI_CATALOG_TTL)

            logger.info(
                "MangaDex vi-catalog background top-up improved manga count (%s -> %s, reason=%s)",
                before_count,
                after_count,
                reason,
            )
        except Exception as error:
            logger.warning(
                "MangaDex vi-catalog background top-up failed (%s): %s",
                reason,
                error,
            )
        finally:
            _vi_catalog_top_up_tasks.pop(cache_key, None)

    _vi_catalog_top_up_tasks[cache_key] = create_task(_job())


def schedule_vi_catalog_refresh(max_chapters: int | None, *, force: bool = False) -> None:
    """Refresh a catalog cache in the background without blocking a user request."""
    cache_key = f"mangadex:vi-catalog:{'all' if max_chapters is None else max_chapters}"
    task_key = f"{cache_key}:force" if force else cache_key
    existing = _vi_catalog_refresh_tasks.get(task_key)
    if existing and not existing.done():
        return

    async def _job() -> None:
        try:
            if force:
                cache.delete(cache_key)
            await get_vi_catalog(max_chapters=max_chapters)
        except Exception as error:
            logger.warning(
                "MangaDex vi-catalog background refresh failed (%s): %s",
                cache_key,
                error,
            )
        finally:
            _vi_catalog_refresh_tasks.pop(task_key, None)

    try:
        _vi_catalog_refresh_tasks[task_key] = create_task(_job())
    except RuntimeError:
        logger.debug("MangaDex vi-catalog refresh skipped; no running event loop")


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=REQUEST_CONNECT_TIMEOUT_SECONDS),
            headers=REQUEST_HEADERS,
            limits=httpx.Limits(
                max_connections=max(1, UPSTREAM_REQUEST_CONCURRENCY),
                max_keepalive_connections=HTTP_KEEPALIVE_CONNECTIONS,
                keepalive_expiry=HTTP_KEEPALIVE_EXPIRY_SECONDS,
            ),
            trust_env=False,
        )
    return _http_client


async def _reset_client() -> None:
    global _http_client
    if _http_client and not _http_client.is_closed:
        try:
            await _http_client.aclose()
        except Exception:
            pass
    _http_client = None


def _format_exception(error: BaseException) -> str:
    message = str(error).strip()
    if not message:
        message = repr(error)
    cause = getattr(error, "__cause__", None) or getattr(error, "__context__", None)
    if cause:
        cause_text = str(cause).strip() or repr(cause)
        return f"{type(error).__name__}: {message} | cause={type(cause).__name__}: {cause_text}"
    return f"{type(error).__name__}: {message}"


def _compact_error_body(body: str, max_len: int = 360) -> str:
    text = str(body or "").strip().replace("\r", " ").replace("\n", " ")
    if len(text) <= max_len:
        return text
    return f"{text[:max_len]} ...(truncated {len(text) - max_len} chars)"


def _retry_after_delay_seconds(raw_value: str | None) -> float | None:
    raw = str(raw_value or "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except Exception:
        return None

    now_epoch = time.time()
    if value > now_epoch:
        return max(0.0, min(value - now_epoch, 60.0))
    return max(0.0, min(value, 60.0))


def _transport_order() -> list[str]:
    preferred = MANGADEX_TRANSPORT
    if preferred == TRANSPORT_HTTPX:
        return [TRANSPORT_HTTPX]
    if preferred == TRANSPORT_CURL_CFFI:
        return [TRANSPORT_CURL_CFFI] if CurlSession is not None else []
    if CurlSession is not None:
        return [TRANSPORT_CURL_CFFI, TRANSPORT_HTTPX]
    return [TRANSPORT_HTTPX]


def _get_curl_session() -> Any:
    if CurlSession is None:
        raise _MangaDexNetworkError("curl_cffi is not installed")
    global _curl_session
    if _curl_session is None:
        with _curl_session_lock:
            if _curl_session is None:
                _curl_session = CurlSession(
                    impersonate=CURL_IMPERSONATE,
                    headers=REQUEST_HEADERS,
                    allow_redirects=False,
                )
    return _curl_session


def _reset_curl_session() -> None:
    global _curl_session
    with _curl_session_lock:
        if _curl_session is not None:
            try:
                _curl_session.close()
            except Exception:
                pass
        _curl_session = None


def _request_json_via_curl_sync(url: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        session = _get_curl_session()
        response = session.get(
            url,
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
            allow_redirects=False,
        )
    except _MangaDexNetworkError:
        raise
    except Exception as error:
        _reset_curl_session()
        raise _MangaDexNetworkError(_format_exception(error)) from error

    return _decode_api_response(response)


def _decode_api_response(response: Any) -> dict[str, Any]:
    """Accept API objects only; never follow or cache an interactive challenge."""
    location = response.headers.get("Location", "")
    content_type = response.headers.get("Content-Type", "").lower()
    # Do not include Location/body in this error: challenge URLs can contain
    # client identifiers and IP addresses. A browser cookie is not an API key.
    if "/edge/challenge" in urlsplit(location).path or "text/html" in content_type:
        raise _MangaDexStatusError(
            "MangaDex API returned browser verification instead of JSON",
            status_code=503,
            retry_after="30",
        )
    if 300 <= response.status_code < 400:
        raise _MangaDexStatusError(
            f"MangaDex API returned an unexpected redirect (HTTP {response.status_code})",
            status_code=503,
            retry_after="30",
        )
    if response.status_code >= 400:
        request_id = response.headers.get("X-Request-ID", "")
        retry_after = response.headers.get("X-RateLimit-Retry-After") or response.headers.get("Retry-After")
        body = _compact_error_body(response.text)
        raise _MangaDexStatusError(
            f"HTTP {response.status_code} | X-Request-ID: {request_id} | body: {body}",
            status_code=response.status_code,
            retry_after=retry_after,
        )

    try:
        payload = response.json()
    except Exception as error:
        raise _MangaDexNetworkError("MangaDex API returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise _MangaDexNetworkError("MangaDex API returned a non-object JSON response")
    return payload


async def _request_json_via_curl(url: str, params: dict[str, Any]) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_curl_executor, _request_json_via_curl_sync, url, params)


async def _request_json_via_httpx(url: str, params: dict[str, Any]) -> dict[str, Any]:
    client = await _get_client()
    try:
        response = await client.get(url, params=params, follow_redirects=False)
    except httpx.HTTPError as error:
        await _reset_client()
        raise _MangaDexNetworkError(_format_exception(error)) from error

    return _decode_api_response(response)


def _stable_request_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _stable_request_value(value[key])
            for key in sorted(value.keys(), key=lambda item: str(item))
        }
    if isinstance(value, (list, tuple)):
        return [_stable_request_value(item) for item in value]
    return value


def _request_fingerprint(path: str, params: dict[str, Any] | None) -> str:
    try:
        body = json.dumps(
            _stable_request_value(params or {}),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    except Exception:
        body = repr(params or {})
    return f"{path}?{body}"


def _live_revision(manga_id: str = "") -> str:
    key = (f"catalog:book-version:mangadex:{manga_id}" if manga_id else
           "catalog:source-version:mangadex")
    value = cache.get(key)
    return value if isinstance(value, str) else ""


async def _request_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    key = _request_fingerprint(path, params) + ":rev=" + await asyncio.to_thread(_live_revision)
    existing = _inflight_request_tasks.get(key)
    if existing and not existing.done():
        return await asyncio.shield(existing)

    task = create_task(_request_json_direct(path, params))
    _inflight_request_tasks[key] = task
    def finished(done):
        if _inflight_request_tasks.get(key) is task:
            _inflight_request_tasks.pop(key, None)
        if not done.cancelled():
            done.exception()
    task.add_done_callback(finished)
    return await asyncio.shield(task)


async def _request_json_direct(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    global _throttle_until_ts
    url = f"{BASE_URL}{path}"
    request_params = params or {}
    transport_errors: list[str] = []
    transports = _transport_order()

    if not transports:
        raise RuntimeError(
            "Network error: curl_cffi transport requested but unavailable. "
            "Please install curl_cffi and set MANGADEX_TRANSPORT=curl_cffi"
        )

    now = time.monotonic()
    if _throttle_until_ts > now:
        cooldown_remaining = _throttle_until_ts - now
        if cooldown_remaining > COOLDOWN_FAST_FAIL_SECONDS:
            raise RuntimeError(
                f"MangaDex upstream cooldown active; retry_after={cooldown_remaining:.1f}s"
            )
        await asyncio.sleep(cooldown_remaining)

    for attempt in range(REQUEST_RETRIES):
        saw_throttle_signal = False
        saw_hard_throttle_signal = False
        status_retry_delay: float | None = None
        for transport in transports:
            try:
                if transport == TRANSPORT_CURL_CFFI:
                    async with _request_semaphore:
                        return await _request_json_via_curl(url, request_params)
                async with _request_semaphore:
                    return await _request_json_via_httpx(url, request_params)
            except _MangaDexStatusError as error:
                if error.status_code == 429 and attempt < REQUEST_RETRIES - 1:
                    status_retry_delay = (
                        _retry_after_delay_seconds(error.retry_after)
                        or THROTTLE_BACKOFF_SECONDS * (attempt + 1)
                    )
                    saw_throttle_signal = True
                    break
                raise RuntimeError(str(error)) from error
            except _MangaDexNetworkError as error:
                transport_errors.append(f"{transport}: {error}")
                error_text = str(error)
                if (
                    "ENHANCE_YOUR_CALM" in error_text
                    or "curl: (92)" in error_text
                    or "429" in error_text
                ):
                    saw_throttle_signal = True
                    if "ENHANCE_YOUR_CALM" in error_text or "curl: (92)" in error_text:
                        saw_hard_throttle_signal = True
                        _throttle_until_ts = max(
                            _throttle_until_ts,
                            time.monotonic() + THROTTLE_ENHANCE_YOUR_CALM_COOLDOWN_SECONDS,
                        )
                if transport == TRANSPORT_HTTPX:
                    await _reset_client()
                else:
                    _reset_curl_session()

        if status_retry_delay is not None:
            _throttle_until_ts = max(
                _throttle_until_ts,
                time.monotonic() + status_retry_delay,
            )
            if status_retry_delay > COOLDOWN_FAST_FAIL_SECONDS:
                raise RuntimeError(
                    f"MangaDex upstream rate limited; retry_after={status_retry_delay:.1f}s"
                )
            await asyncio.sleep(status_retry_delay)
            continue

        if saw_hard_throttle_signal:
            break

        if attempt < REQUEST_RETRIES - 1:
            retry_delay = REQUEST_RETRY_BACKOFF_SECONDS * (attempt + 1)
            if saw_throttle_signal:
                _throttle_until_ts = max(
                    _throttle_until_ts,
                    time.monotonic() + (THROTTLE_GLOBAL_COOLDOWN_SECONDS * (attempt + 1)),
                )
                retry_delay = max(retry_delay, THROTTLE_BACKOFF_SECONDS * (attempt + 1))
            await asyncio.sleep(retry_delay)

    last_error = transport_errors[-1] if transport_errors else "Unknown network failure"
    raise RuntimeError(f"Network error: {last_error}")


def _pick_title(attributes: dict[str, Any]) -> str:
    title_maps: list[dict[str, Any]] = []
    titles = attributes.get("title") or {}
    if isinstance(titles, dict):
        title_maps.append(titles)
    for title_map in attributes.get("altTitles", []):
        if isinstance(title_map, dict):
            title_maps.append(title_map)

    for language_keys in (("vi",), ("ja", "ja-ro", "jp"), ("en",)):
        for title_map in title_maps:
            for key in language_keys:
                value = str(title_map.get(key) or "").strip()
                if value:
                    return value

    for title_map in title_maps:
        for value in title_map.values():
            value = str(value or "").strip()
            if value:
                return value
    return "Untitled"


def _pick_description(attributes: dict[str, Any]) -> str:
    description_map = attributes.get("description") or {}
    if description_map.get("vi"):
        return str(description_map["vi"])
    if description_map.get("en"):
        return str(description_map["en"])
    for value in description_map.values():
        if value:
            return str(value)
    return ""


def _extract_genres(attributes: dict[str, Any]) -> list[str]:
    genres: list[str] = []
    for tag in attributes.get("tags", []):
        tag_attributes = tag.get("attributes") or {}
        name_map = tag_attributes.get("name") or {}
        value = str(name_map.get("vi") or name_map.get("en") or "")
        if value:
            genres.append(value)
    return genres


def _slugify_tag(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


async def _get_mangadex_tag_id_by_slug() -> dict[str, str]:
    cache_key = "mangadex:tag-id-by-slug:v1"
    cached = cache.get(cache_key)
    if cached:
        try:
            parsed = json.loads(cached)
            if isinstance(parsed, dict):
                return {str(k): str(v) for k, v in parsed.items() if k and v}
        except Exception:
            cache.delete(cache_key)

    payload = await _request_json("/manga/tag")
    tag_map: dict[str, str] = {}
    for tag in payload.get("data") or []:
        tag_id = str(tag.get("id") or "").strip()
        attributes = tag.get("attributes") or {}
        names = attributes.get("name") or {}
        if not tag_id or not isinstance(names, dict):
            continue
        for name in names.values():
            slug = _slugify_tag(name)
            if slug:
                tag_map.setdefault(slug, tag_id)

    # Common front-end aliases that do not exactly match MangaDex tag names.
    alias_to_slug = {
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
    for alias, target in alias_to_slug.items():
        if target in tag_map:
            tag_map.setdefault(alias, tag_map[target])

    cache.set(cache_key, json.dumps(tag_map, ensure_ascii=False), ttl=24 * 60 * 60)
    return tag_map


async def _resolve_mangadex_tag_ids(slugs: list[str] | None) -> list[str] | None:
    normalized = [_slugify_tag(slug) for slug in (slugs or [])]
    normalized = [slug for slug in dict.fromkeys(normalized) if slug and slug not in {"all", "any", "*"}]
    if not normalized:
        return []
    try:
        tag_map = await _get_mangadex_tag_id_by_slug()
    except Exception as error:
        raise RuntimeError("Không tải được bộ lọc thể loại MangaDex") from error
    if any(slug not in tag_map for slug in normalized):
        return None  # Unknown filters cannot silently broaden the request.
    return list(dict.fromkeys(tag_map[slug] for slug in normalized))


def _relation_bucket(item: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    bucket: dict[str, list[dict[str, Any]]] = {}
    for relation in item.get("relationships", []):
        relation_type = str(relation.get("type") or "")
        if relation_type:
            bucket.setdefault(relation_type, []).append(relation)
    return bucket


def _extract_related_ids(relationships: list[dict[str, Any]], relation_type: str) -> list[str]:
    ids: list[str] = []
    for relation in relationships:
        if str(relation.get("type") or "") == relation_type:
            relation_id = str(relation.get("id") or "")
            if relation_id:
                ids.append(relation_id)
    return ids


def _extract_cover_url(manga_id: str, relationships: list[dict[str, Any]]) -> str:
    for relation in relationships:
        if str(relation.get("type") or "") != "cover_art":
            continue
        attributes = relation.get("attributes") or {}
        file_name = str(attributes.get("fileName") or "").strip()
        if file_name:
            return f"https://uploads.mangadex.org/covers/{manga_id}/{file_name}.512.jpg"
    return ""


def _extract_manga_id_from_cover_relationships(relationships: list[dict[str, Any]]) -> str:
    for relation in relationships:
        if str(relation.get("type") or "") == "manga":
            manga_id = str(relation.get("id") or "")
            if manga_id:
                return manga_id
    return ""


async def _fetch_cover_url_by_manga_id(manga_id: str) -> str:
    payload = await _request_json(
        f"/manga/{manga_id}",
        {"includes[]": "cover_art"},
    )
    data = payload.get("data") or {}
    relationships = data.get("relationships") or []
    return _extract_cover_url(manga_id, relationships)


def _valid_cover_url(manga_id: str, value: Any) -> str:
    value = str(value or "").strip()
    prefix = f"https://uploads.mangadex.org/covers/{manga_id}/"
    return value if value.startswith(prefix) and len(value) > len(prefix) else ""


def _cache_stale_cover_urls(values: dict[str, str], cache_client=None) -> None:
    # Only newly resolved/observed URLs call this; reading an old hint must not
    # extend its lifetime indefinitely. Store URLs, never account credentials.
    target = cache if cache_client is None else cache_client
    target.set_many({f"mangadex:cover-url:v2:{mid}:stale": url
                     for mid, url in values.items() if _valid_cover_url(mid, url)},
                    ttl=COVER_URL_STALE_TTL)


def _cached_cover_url(manga_id: str) -> str:
    key = f"mangadex:cover-url:v2:{manga_id}"
    card_key = f"catalog:card-metadata:v1:{manga_id}"
    values = cache.get_many([key, key + ":stale", card_key])
    for candidate in [values.get(key), values.get(key + ":stale")]:
        if url := _valid_cover_url(manga_id, candidate):
            return url
    try:
        card = json.loads(values.get(card_key) or "{}")
    except (ValueError, TypeError):
        card = {}
    if isinstance(card, dict) and (url := _valid_cover_url(manga_id, card.get("cover_url"))):
        return url

    revision = _live_revision(manga_id)
    bases = [f"mangadex:metadata:{manga_id}:rev={revision}",
             f"mangadex:lookup:{manga_id}:rev={revision}"]
    keys = [base + suffix for base in bases for suffix in ("", ":stale")]
    snapshots = cache.get_many(keys)
    for key in keys:
        try:
            payload = json.loads(snapshots.get(key) or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        manga = payload.get("manga") or payload.get("data") or {}
        if not isinstance(manga, dict):
            continue
        candidate = manga.get("cover_url") or _extract_cover_url(manga_id, manga.get("relationships") or [])
        if url := _valid_cover_url(manga_id, candidate):
            return url
    catalog = _get_cached_vi_catalog_manga(manga_id) or {}
    return _valid_cover_url(manga_id, catalog.get("cover_url"))


@coalesce_reads
async def get_cover_url(manga_id: str) -> str:
    # Redis/catalog reads must not block all the other images on the event loop.
    cached = await asyncio.to_thread(_cached_cover_url, manga_id)
    if cached:
        return cached
    cover_url = await _fetch_cover_url_by_manga_id(manga_id)
    if cover_url:
        await asyncio.to_thread(cache.set, f"mangadex:cover-url:v2:{manga_id}", cover_url, ttl=3600)
        await asyncio.to_thread(_cache_stale_cover_urls, {manga_id: cover_url})
    return cover_url


async def _fetch_cover_urls_for_manga_ids(manga_ids: list[str]) -> dict[str, str]:
    valid_ids = [str(mid or "").strip() for mid in manga_ids]
    valid_ids = [mid for mid in dict.fromkeys(valid_ids) if mid]
    if not valid_ids:
        return {}

    cached = await asyncio.to_thread(cache.get_many, [f"mangadex:cover-url:v2:{manga_id}" for manga_id in valid_ids])
    mapping: dict[str, str] = {
        manga_id: cached[f"mangadex:cover-url:v2:{manga_id}"] for manga_id in valid_ids
        if isinstance(cached.get(f"mangadex:cover-url:v2:{manga_id}"), str)
        and cached[f"mangadex:cover-url:v2:{manga_id}"].startswith("https://uploads.mangadex.org/covers/")
    }
    warm_ids = set(mapping)
    valid_ids = [manga_id for manga_id in valid_ids if manga_id not in mapping]
    step = 100
    for start in range(0, len(valid_ids), step):
        batch = valid_ids[start : start + step]
        try:
            # One current cover per title. /cover lists historical volumes and
            # can require several pages, overwrite the current cover with an
            # older one, and trigger many individual metadata lookups.
            payload = await _request_json("/manga", {
                "ids[]": batch, "includes[]": ["cover_art"], "limit": len(batch),
                "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
            })
        except RuntimeError:
            stale = await asyncio.to_thread(cache.get_many,
                [f"mangadex:cover-url:v2:{mid}:stale" for mid in batch])
            for mid in batch:
                url = _valid_cover_url(mid, stale.get(f"mangadex:cover-url:v2:{mid}:stale"))
                if url:
                    mapping[mid] = url
                    warm_ids.add(mid)
            continue
        for manga in payload.get("data") or []:
            mid = str(manga.get("id") or "")
            if mid not in batch:
                continue
            relations = manga.get("relationships") or []
            url = _extract_cover_url(mid, relations)
            if url:
                mapping[mid] = url
                for relation in relations:
                    if relation.get("type") == "cover_art" and relation.get("id"):
                        mapping[f"cover:{relation['id']}"] = url

    await asyncio.to_thread(cache.set_many,
        {f"mangadex:cover-url:v2:{manga_id}": url for manga_id, url in mapping.items()
         if manga_id not in warm_ids and not manga_id.startswith("cover:")}, ttl=3600)
    await asyncio.to_thread(_cache_stale_cover_urls,
        {manga_id: url for manga_id, url in mapping.items()
         if manga_id not in warm_ids and not manga_id.startswith("cover:")})
    return mapping


async def _enrich_missing_cover_urls(mangas: dict[str, dict[str, Any]]) -> None:
    missing_ids = [
        manga_id
        for manga_id, manga in mangas.items()
        if not str((manga or {}).get("cover_url") or "").strip()
    ]
    if not missing_ids:
        return
    resolved = await _fetch_cover_urls_for_manga_ids(missing_ids)
    for manga_id in missing_ids:
        url = str(resolved.get(manga_id) or "")
        if url and manga_id in mangas:
            mangas[manga_id]["cover_url"] = url


def _extract_people_from_relationships(
    relationships: list[dict[str, Any]], relation_type: str
) -> list[dict[str, str]]:
    people: list[dict[str, str]] = []
    for relation in relationships:
        if str(relation.get("type") or "") != relation_type:
            continue
        person_id = str(relation.get("id") or "")
        if not person_id:
            continue
        attributes = relation.get("attributes") or {}
        people.append(
            {
                "id": person_id,
                "name": str(attributes.get("name") or ""),
            }
        )
    return people


async def _get_person_by_id(person_id: str, cache: dict[str, dict[str, str]]) -> dict[str, str]:
    if person_id in cache:
        return cache[person_id]
    payload = await _request_json(f"/author/{person_id}")
    data = payload.get("data") or {}
    attributes = data.get("attributes") or {}
    person = {
        "id": str(data.get("id") or person_id),
        "name": str(attributes.get("name") or ""),
    }
    cache[person_id] = person
    return person


async def _safe_get_person_by_id(person_id: str, cache: dict[str, dict[str, str]]) -> dict[str, str]:
    try:
        return await _get_person_by_id(person_id, cache)
    except RuntimeError:
        person = {"id": person_id, "name": ""}
        cache[person_id] = person
        return person


def _parse_manga(
    attributes: dict[str, Any],
    manga_id: str,
    authors: list[dict[str, str]],
    artists: list[dict[str, str]],
    cover_url: str,
) -> dict[str, Any]:
    author_names = [str(author.get("name") or "").strip() for author in authors if author.get("name")]
    author_names = [name for name in author_names if name]
    authors_text = ", ".join(author_names)
    if authors_text:
        authors_text = f"{authors_text}, MangaDex"
    else:
        authors_text = "MangaDex"
    return {
        "id": manga_id,
        "url": f"https://mangadex.org/title/{manga_id}",
        "title": _pick_title(attributes),
        "description": _pick_description(attributes),
        "cover_url": cover_url,
        "authors": authors,
        "authors_text": authors_text,
        "artists": artists,
        "genres": _extract_genres(attributes),
        "status": str(attributes.get("status") or ""),
        "content_rating": str(attributes.get("contentRating") or ""),
        "publication_demographic": str(attributes.get("publicationDemographic") or ""),
        "original_language": str(attributes.get("originalLanguage") or ""),
        "available_translated_languages": [
            str(language or "").strip().lower()
            for language in (attributes.get("availableTranslatedLanguages") or [])
            if str(language or "").strip()
        ],
        "year": attributes.get("year"),
        "last_volume": str(attributes.get("lastVolume") or ""),
        "last_chapter": str(attributes.get("lastChapter") or ""),
        "updated_at": str(attributes.get("updatedAt") or ""),
        "mangadex_popularity_rank": 0,
        "mangadex_popularity_score": 0,
    }


def _parse_scanlation_groups(relations: list[dict[str, Any]]) -> list[dict[str, str]]:
    groups: list[dict[str, str]] = []
    for relation in relations:
        attributes = relation.get("attributes") or {}
        groups.append(
            {
                "id": str(relation.get("id") or ""),
                "name": str(attributes.get("name") or ""),
                "website": str(attributes.get("website") or ""),
                "discord": str(attributes.get("discord") or ""),
            }
        )
    return groups


def _parse_uploader(relations: list[dict[str, Any]]) -> dict[str, str]:
    if not relations:
        return {"id": "", "username": ""}
    relation = relations[0]
    attributes = relation.get("attributes") or {}
    return {
        "id": str(relation.get("id") or ""),
        "username": str(attributes.get("username") or ""),
    }


def _build_chapter_with_groups(chapter_value: str, groups: list[dict[str, str]]) -> str:
    chapter_text = chapter_value.strip() or "?"
    group_names = [str(group.get("name") or "").strip() for group in groups]
    group_names = [name for name in group_names if name]
    if group_names:
        return f"Chương {chapter_text} - {', '.join(group_names)}"
    return f"Chương {chapter_text}"


def _pick_chapter_time(chapter: dict[str, Any], manga_updated_at: str = "") -> str:
    now = datetime.now(timezone.utc)
    max_future = now + timedelta(days=2)

    def _safe_iso(value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        normalized = raw.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except Exception:
            return ""
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed > max_future:
            return ""
        return raw

    for key in ("publish_at", "readable_at", "created_at", "updated_at"):
        value = _safe_iso(str(chapter.get(key) or ""))
        if value:
            return value
    return _safe_iso(str(manga_updated_at or ""))


def _chapter_number_value(raw: Any) -> float:
    text = str(raw or "").replace(",", ".").strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except Exception:
        return 0.0


def _chapter_number_from_entry(chapter: dict[str, Any]) -> float:
    direct = _chapter_number_value(chapter.get("chapter"))
    if direct >= 0 and str(chapter.get("chapter") or "").strip():
        return direct

    fallback_text = str(
        chapter.get("chapter_with_groups")
        or chapter.get("chapter_title")
        or ""
    ).strip()
    if not fallback_text:
        return 0.0

    matched = _CHAPTER_NUMBER_RE.search(fallback_text)
    if not matched:
        return 0.0

    return _chapter_number_value(matched.group(1))


def _is_preferred_latest_chapter(
    candidate: dict[str, Any],
    current: dict[str, Any],
    *,
    manga_updated_at: str = "",
) -> bool:
    candidate_num = _chapter_number_from_entry(candidate)
    current_num = _chapter_number_from_entry(current)
    if candidate_num != current_num:
        return candidate_num > current_num

    candidate_time = _pick_chapter_time(candidate, manga_updated_at)
    current_time = _pick_chapter_time(current, manga_updated_at)
    if candidate_time != current_time:
        return candidate_time > current_time

    candidate_id = str(candidate.get("id") or "")
    current_id = str(current.get("id") or "")
    return candidate_id > current_id


def _latest_chapter_info_from_cached_catalog(manga_id: str) -> dict[str, str] | None:
    manga = _get_cached_vi_catalog_manga(manga_id)
    if not isinstance(manga, dict):
        return None

    manga_updated_at = str(manga.get("updated_at") or manga.get("local_last_published_at") or "")
    best_entry: dict[str, Any] | None = None
    best_info: dict[str, str] | None = None

    chapters = manga.get("chapters") or manga.get("chaptersLatest") or manga.get("chapters_latest") or []
    if isinstance(chapters, list):
        for chapter in chapters:
            if not isinstance(chapter, dict):
                continue
            chapter_name = str(chapter.get("chapter") or chapter.get("chapter_name") or "").strip()
            chapter_title = str(
                chapter.get("chapter_with_groups")
                or chapter.get("chapter_title")
                or chapter.get("title")
                or ""
            ).strip()
            publish_at = str(
                chapter.get("publish_at")
                or chapter.get("publishAt")
                or chapter.get("readable_at")
                or chapter.get("readableAt")
                or chapter.get("created_at")
                or chapter.get("updated_at")
                or manga_updated_at
                or ""
            ).strip()
            candidate_entry = {
                "id": str(chapter.get("id") or "").strip(),
                "chapter": chapter_name or "0",
                "chapter_with_groups": chapter_title,
                "publish_at": publish_at,
            }
            if best_entry is None or _is_preferred_latest_chapter(
                candidate_entry,
                best_entry,
                manga_updated_at=manga_updated_at,
            ):
                best_entry = candidate_entry
                best_info = {
                    "id": candidate_entry["id"],
                    "chapter_name": chapter_name or "0",
                    "chapter_title": chapter_title,
                    "publish_at": publish_at,
                }

    if best_info and str(best_info.get("chapter_name") or "").strip():
        return best_info

    return None


def _normalize_latest_chapter_language(value: str) -> str:
    language = str(value or "vi").strip().lower()
    if language in {"", "all", "any", "*", "non_vi"}:
        return "vi"
    return language


def _latest_chapter_cache_key(manga_id: str, translated_language: str, *, revision: str | None = None) -> str:
    language = _normalize_latest_chapter_language(translated_language)
    if revision is None:
        revision = _live_revision(manga_id)
    suffix = f":rev={revision}" if revision else ""
    # Keep the established Vietnamese key warm while separating every other
    # translation so a VI chapter is never shown for a Japanese result.
    if language == "vi":
        return f"mangadex:latest-chapter:v{LATEST_CHAPTER_CACHE_VERSION}:{manga_id}{suffix}"
    return f"mangadex:latest-chapter:v{LATEST_CHAPTER_CACHE_VERSION}:lang={language}:{manga_id}{suffix}"


@coalesce_reads(revision=lambda: _live_revision())
async def _get_latest_vi_chapter_for_manga(
    manga_id: str,
    *,
    translated_language: str = "vi",
    ignore_cache: bool = False,
    raise_on_error: bool = False,
) -> dict[str, str]:
    language = _normalize_latest_chapter_language(translated_language)
    cache_key = _latest_chapter_cache_key(manga_id, language)
    if not ignore_cache:
        cached = cache.get(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                cache.delete(cache_key)

    chapter_info = {"id": "", "chapter_name": "", "chapter_title": "", "publish_at": ""}
    best_entry: dict[str, Any] | None = None

    def _ingest_payload(payload: dict[str, Any]) -> None:
        nonlocal best_entry, chapter_info
        data = payload.get("data") or []
        for chapter in data:
            attributes = (chapter or {}).get("attributes") or {}
            raw_chapter = attributes.get("chapter")
            chapter_name = str(raw_chapter if raw_chapter is not None else "").strip()
            candidate_info = {
                "id": str((chapter or {}).get("id") or "").strip(),
                "chapter_name": chapter_name,
                "chapter_title": str(attributes.get("title") or ""),
                "publish_at": str(attributes.get("publishAt") or ""),
            }
            candidate_entry = {
                "id": str((chapter or {}).get("id") or ""),
                "chapter": candidate_info["chapter_name"],
                "chapter_with_groups": candidate_info["chapter_title"],
                "publish_at": candidate_info["publish_at"],
            }

            if best_entry is None or _is_preferred_latest_chapter(candidate_entry, best_entry):
                best_entry = candidate_entry
                chapter_info = candidate_info

    try:
        # First pass: prefer highest chapter number (not newest publish timestamp).
        payload_by_chapter = await _request_json(
            "/chapter",
            {
                "manga": manga_id,
                "translatedLanguage[]": language,
                "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
                "order[chapter]": "desc",
                "order[publishAt]": "desc",
                "limit": 1,
                "offset": 0,
            },
        )
        _ingest_payload(payload_by_chapter)

    except RuntimeError:
        if raise_on_error:
            raise

    # Only cache if we got a real result — don't lock in empty data
    if chapter_info.get("id"):
        chapter_info["verified_head"] = True
        cache.set(cache_key, json.dumps(chapter_info, ensure_ascii=False), ttl=VI_CATALOG_TTL)
    return chapter_info


def _extract_manga_id_from_chapter(chapter: dict[str, Any]) -> str:
    relations = _relation_bucket(chapter).get("manga", [])
    if not relations:
        return ""
    return str((relations[0] or {}).get("id") or "")


@coalesce_reads(revision=lambda: _live_revision())
async def _get_latest_vi_chapter_for_manga_ids(
    manga_ids: list[str], *, translated_language: str = "vi", allow_individual_fallback: bool = True,
) -> dict[str, dict[str, str]]:
    language = _normalize_latest_chapter_language(translated_language)
    ids = list(dict.fromkeys(str(value).strip().lower() for value in manga_ids
                            if _MANGADEX_UUID_RE.fullmatch(str(value).strip())))[:100]
    result = {}
    missing = []
    revisions = await asyncio.to_thread(cache.get_many, [f"catalog:book-version:mangadex:{manga_id}" for manga_id in ids])
    keys = {manga_id: _latest_chapter_cache_key(manga_id, language, revision=revisions.get(f"catalog:book-version:mangadex:{manga_id}") or "") for manga_id in ids}
    values = await asyncio.to_thread(cache.get_many, keys.values())
    def cached_infos():
        found = {}
        for manga_id in ids:
            raw = values.get(keys[manga_id])
            try:
                info = json.loads(raw) if isinstance(raw, str) else None
            except ValueError:
                info = None
            if not info and language == "vi":
                info = _latest_chapter_info_from_cached_catalog(manga_id)
            found[manga_id] = info
        return found
    infos = await asyncio.to_thread(cached_infos)
    for manga_id in ids:
        info = infos[manga_id]
        if info:
            result[manga_id] = info
        else:
            missing.append(manga_id)
    # /chapter accepts one manga UUID, not manga[]. A failed array query used
    # to trigger up to two additional requests for every visible card.
    # Fast card hydration is cache-only; opening a title fetches its real feed.
    if allow_individual_fallback:
        semaphore = asyncio.Semaphore(2)
        async def fetch(manga_id):
            async with semaphore:
                info = await _get_latest_vi_chapter_for_manga(manga_id, translated_language=language)
                if info.get("id"):
                    result[manga_id] = info
        await asyncio.gather(*(fetch(manga_id) for manga_id in missing))
    return result


def _to_legacy_item(manga: dict[str, Any], latest_chapter: dict[str, str] | None = None) -> dict[str, Any]:
    category = [{"name": genre, "slug": genre.lower().replace(" ", "-")} for genre in manga.get("genres", [])]
    chapter_id = str((latest_chapter or {}).get("id") or "").strip()
    chapter_name = str((latest_chapter or {}).get("chapter_name") or "")
    chapter_title = str((latest_chapter or {}).get("chapter_title") or "")
    publish_at = str((latest_chapter or {}).get("publish_at") or manga.get("updated_at") or "")
    chapters_latest: list[dict[str, Any]] = []
    if chapter_name:
        chapters_latest.append(
            {
                "chapter_name": chapter_name,
                "chapter_title": chapter_title,
                "chapter_api_data": chapter_id,
            }
        )
    author_names = [str(author.get("name") or "").strip() for author in manga.get("authors", []) if author.get("name")]
    author_names = [name for name in author_names if name]
    if not author_names:
        author_names = ["MangaDex"]
    return {
        "name": manga.get("title") or "Untitled",
        "slug": str(manga.get("id") or ""),
        "origin_name": [manga.get("title") or "Untitled"],
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
        "view_count": 0,
        "content_rating": str(manga.get("content_rating") or "").strip().lower(),
        "source": "mangadex",
    }


def _target_vi_catalog_manga_count(max_chapters: int | None) -> int:
    if max_chapters is None:
        bounded_all = max(VI_CATALOG_TARGET_MANGA_MIN, VI_CATALOG_TARGET_MANGA_ALL)
        return min(VI_CATALOG_TARGET_MANGA_MAX, bounded_all)
    estimated = int(max_chapters * 0.9)
    bounded = max(VI_CATALOG_TARGET_MANGA_MIN, estimated)
    return min(VI_CATALOG_TARGET_MANGA_MAX, bounded)


async def _top_up_vi_catalog_from_manga_feed(
    mangas: dict[str, dict[str, Any]],
    target_count: int,
    *,
    order_fields: tuple[str, ...] | None = None,
    max_seconds: float | None = None,
) -> None:
    if target_count <= 0 or len(mangas) >= target_count:
        return

    now = time.monotonic()
    effective_max_seconds = (
        VI_CATALOG_MANGA_FEED_TOP_UP_MAX_SECONDS
        if max_seconds is None
        else max(0.2, max_seconds)
    )
    top_up_deadline = now + effective_max_seconds

    page_size = max(20, min(100, VI_CATALOG_MANGA_FEED_PAGE_SIZE))
    effective_order_fields = order_fields or (
        "followedCount",
        "latestUploadedChapter",
        "updatedAt",
        "createdAt",
    )

    for order_field in effective_order_fields:
        if time.monotonic() >= top_up_deadline:
            break
        if len(mangas) >= target_count:
            break

        order_key = f"{order_field}:desc"
        max_safe_offset = _vi_catalog_manga_feed_safe_offsets.get(
            order_key,
            VI_CATALOG_MANGA_FEED_MAX_OFFSET,
        )
        if max_safe_offset < 0:
            continue

        offset = 0
        pages = 0
        total = 0
        stagnant_rounds = 0

        while len(mangas) < target_count and pages < VI_CATALOG_MANGA_FEED_MAX_PAGES:
            if time.monotonic() >= top_up_deadline:
                break
            if offset > max_safe_offset:
                break

            remaining = target_count - len(mangas)
            if remaining <= 0:
                break
            limit = page_size if remaining >= page_size else max(20, remaining)
            before_count = len(mangas)

            try:
                payload = await _request_json(
                    "/manga",
                    {
                        "availableTranslatedLanguage[]": "vi",
                        "includes[]": ["author", "artist", "cover_art"],
                        "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
                        f"order[{order_field}]": "desc",
                        "limit": limit,
                        "offset": offset,
                    },
                )
            except RuntimeError as exc:
                error_text = str(exc)
                is_http_400 = "HTTP 400" in error_text

                if is_http_400:
                    logger.warning(
                        "MangaDex vi-catalog manga-feed top-up skipping order after HTTP 400 (order=%s, offset=%s)",
                        order_field,
                        offset,
                    )
                else:
                    logger.warning(
                        "MangaDex vi-catalog manga-feed top-up failed (order=%s, offset=%s): %s",
                        order_field,
                        offset,
                        exc,
                    )

                if offset <= 0:
                    _vi_catalog_manga_feed_safe_offsets[order_key] = -1
                else:
                    prev_safe_offset = _vi_catalog_manga_feed_safe_offsets.get(
                        order_key,
                        VI_CATALOG_MANGA_FEED_MAX_OFFSET,
                    )
                    _vi_catalog_manga_feed_safe_offsets[order_key] = min(
                        prev_safe_offset,
                        max(0, offset - page_size),
                    )

                break

            data = payload.get("data") or []
            try:
                total = int(payload.get("total", 0))
            except Exception:
                total = 0
            if not data:
                break

            pages += 1
            for manga_index, manga_item in enumerate(data):
                manga_id = str(manga_item.get("id") or "")
                if not manga_id:
                    continue

                if order_field == "followedCount" and manga_id in mangas:
                    _apply_mangadex_popularity_rank(mangas[manga_id], offset + manga_index + 1)
                    continue

                if manga_id in mangas:
                    continue

                attributes = manga_item.get("attributes") or {}
                relationships = manga_item.get("relationships") or []
                author_ids = _extract_related_ids(relationships, "author")
                artist_ids = _extract_related_ids(relationships, "artist")
                cover_url = _extract_cover_url(manga_id, relationships)
                authors = _extract_people_from_relationships(relationships, "author")
                artists = _extract_people_from_relationships(relationships, "artist")

                if not authors:
                    authors = [{"id": author_id, "name": ""} for author_id in author_ids]
                if not artists:
                    artists = [{"id": artist_id, "name": ""} for artist_id in artist_ids]

                parsed = _parse_manga(
                    attributes,
                    manga_id,
                    authors=authors,
                    artists=artists,
                    cover_url=cover_url,
                )
                parsed["chapters"] = []
                if order_field == "followedCount":
                    _apply_mangadex_popularity_rank(parsed, offset + manga_index + 1)
                mangas[manga_id] = parsed
                if len(mangas) >= target_count:
                    break

            added = len(mangas) - before_count
            if added <= 0:
                if order_field == "followedCount":
                    stagnant_rounds = 0
                else:
                    stagnant_rounds += 1
            else:
                stagnant_rounds = 0

            offset += len(data)
            if len(data) < limit:
                break
            if total > 0 and offset >= total:
                break
            if stagnant_rounds >= 2:
                break


async def get_popular_first_catalog(max_chapters: int | None = 2000) -> dict[str, Any]:
    """Build a small catalog ordered by MangaDex popularity, then expand it in background."""
    cache_key = f"mangadex:vi-catalog:{'all' if max_chapters is None else max_chapters}"
    target_manga_count = _target_vi_catalog_manga_count(max_chapters)
    seed_target = min(
        target_manga_count,
        max(VI_CATALOG_POPULAR_FIRST_COUNT, VI_CATALOG_TARGET_MANGA_MIN),
    )
    mangas: dict[str, dict[str, Any]] = {}

    await _top_up_vi_catalog_from_manga_feed(
        mangas,
        target_count=seed_target,
        order_fields=("followedCount",),
        max_seconds=VI_CATALOG_POPULAR_FIRST_MAX_SECONDS,
    )

    if not mangas:
        raise RuntimeError("MangaDex popular catalog tạm thời không khả dụng")

    result = {
        "meta": {
            "language": "vi",
            "total_chapters_api": None,
            "fetched_chapters": 0,
            "total_manga": len(mangas),
            "target_manga": target_manga_count,
            "popular_first": True,
        },
        "mangas": list(mangas.values()),
    }

    _cache_payload(cache_key, result, ttl=VI_CATALOG_TTL)

    if len(mangas) < target_manga_count:
        _schedule_vi_catalog_top_up(
            cache_key,
            result,
            target_count=target_manga_count,
            reason="popular-first-depth",
        )

    if VI_CATALOG_COVER_ENRICH_TIMEOUT_SECONDS > 0:
        _schedule_vi_catalog_cover_enrich(
            cache_key,
            result,
            reason="popular-first-missing",
        )

    return result


def _payload_has_latest_sort_signal(payload: Any) -> bool:
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
            if _pick_chapter_time(chapter, str(manga.get("updated_at") or "")):
                return True
    return False


@coalesce_reads(revision=lambda: _live_revision())
async def get_vi_catalog(
    max_chapters: int | None = 2000,
    *,
    prefer_latest: bool = False,
) -> dict[str, Any]:
    cache_key = f"mangadex:vi-catalog:{'all' if max_chapters is None else max_chapters}"
    should_optimize_for_depth = (
        max_chapters is None or int(max_chapters) >= VI_CATALOG_TOP_UP_MIN_CHAPTERS
    )
    target_manga_count = (
        _target_vi_catalog_manga_count(max_chapters)
        if should_optimize_for_depth
        else 0
    )
    sync_target_manga_count = target_manga_count
    if max_chapters is None and target_manga_count > 0:
        sync_target_manga_count = min(
            target_manga_count,
            max(VI_CATALOG_TARGET_MANGA_MIN, VI_CATALOG_ALL_SYNC_TARGET_MANGA),
        )

    cached_payload = _load_json_cache_payload(cache_key)
    cached_is_usable_for_latest = (
        not prefer_latest or _payload_has_latest_sort_signal(cached_payload)
    )
    if _payload_has_mangas(cached_payload) and cached_is_usable_for_latest:
        mangas_map = _manga_map_from_payload(cached_payload)

        if target_manga_count > 0 and len(mangas_map) < target_manga_count:
            _schedule_vi_catalog_top_up(
                cache_key,
                cached_payload,
                target_count=target_manga_count,
                reason="cache-hit-depth",
            )

        elif target_manga_count > 0 and mangas_map:
            cached_meta = cached_payload.get("meta") if isinstance(cached_payload, dict) else {}
            if not isinstance(cached_meta, dict):
                cached_meta = {}
            if cached_meta.get("target_manga") is None:
                cached_payload = {
                    **(cached_payload or {}),
                    "meta": {
                        **cached_meta,
                        "total_manga": len(mangas_map),
                        "target_manga": target_manga_count,
                    },
                    "mangas": list(mangas_map.values()),
                }
                _cache_payload(cache_key, cached_payload, ttl=VI_CATALOG_TTL)

        if mangas_map:
            missing_popularity = _count_missing_popularity_scores(mangas_map)
            if target_manga_count > 0 and missing_popularity > 0:
                _schedule_vi_catalog_top_up(
                    cache_key,
                    cached_payload,
                    target_count=max(target_manga_count, len(mangas_map) + 1),
                    reason="cache-hit-popularity",
                )

            before_missing = _count_missing_cover_urls(mangas_map)
            if before_missing > 0:
                fallback_payload = None
                if before_missing >= len(mangas_map):
                    # Avoid serving fully-missing covers when we already have healthier stale caches.
                    fallback_payload = _load_non_empty_vi_catalog_fallback(max_chapters=max_chapters)
                _schedule_vi_catalog_cover_enrich(
                    cache_key,
                    cached_payload,
                    reason="cache-hit-missing",
                )
                if _payload_has_mangas(fallback_payload):
                    return fallback_payload

        return cached_payload
    if cached_payload is not None and not _payload_has_mangas(cached_payload):
        cache.delete(cache_key)

    stale_payload = _load_json_cache_payload(f"{cache_key}:stale")
    if (
        stale_payload is not None and
        (
            not _payload_has_mangas(stale_payload) or
            (prefer_latest and not _payload_has_latest_sort_signal(stale_payload))
        )
    ):
        cache.delete(f"{cache_key}:stale")
        stale_payload = None

    # "all" mode can be very large. Bootstrap with a bounded first pass,
    # then let background top-up expand depth toward the target.
    chapter_budget: int | None = max_chapters
    if max_chapters is None:
        chapter_budget = VI_CATALOG_ALL_INITIAL_CHAPTERS
    elif target_manga_count > 0:
        chapter_budget = min(max_chapters, VI_CATALOG_POPULAR_FIRST_CHAPTER_BUDGET)

    mangas: dict[str, dict[str, Any]] = {}
    fetched_chapters = 0
    offset = 0
    step = 100
    total = None

    # Seed the first browse pages from MangaDex's popularity feed. The chapter
    # crawl below still fills latest metadata, but users should see popular
    # MangaDex titles first instead of waiting for the large catalog pass.
    popular_seed_target = 0
    if target_manga_count > 0 and not prefer_latest:
        popular_seed_target = min(target_manga_count, VI_CATALOG_POPULAR_FIRST_COUNT)
        try:
            await _top_up_vi_catalog_from_manga_feed(
                mangas,
                target_count=popular_seed_target,
                order_fields=("followedCount",),
                max_seconds=VI_CATALOG_POPULAR_FIRST_MAX_SECONDS,
            )
        except Exception as exc:
            logger.warning("MangaDex popular-first seed failed: %s", exc)

    while True:
        remaining = None if chapter_budget is None else chapter_budget - fetched_chapters
        if remaining is not None and remaining <= 0:
            break

        limit = step if remaining is None else min(step, remaining)
        try:
            payload = await _request_json(
                "/chapter",
                {
                    "translatedLanguage[]": "vi",
                    "includes[]": ["manga", "scanlation_group"],
                    "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
                    "order[publishAt]": "desc",
                    "limit": limit,
                    "offset": offset,
                },
            )
        except RuntimeError as exc:
            logger.warning("MangaDex vi-catalog chapter fetch failed (offset=%s): %s", offset, exc)
            break
        data = payload.get("data", [])
        total = int(payload.get("total", 0))
        if not data:
            break

        for chapter in data:
            chapter_attributes = chapter.get("attributes") or {}
            translated_language = str(chapter_attributes.get("translatedLanguage") or "")
            if translated_language != "vi":
                continue
            relations = _relation_bucket(chapter)
            manga_relations = relations.get("manga", [])
            if not manga_relations:
                continue

            manga_relation = manga_relations[0]
            manga_id = str(manga_relation.get("id") or "")
            manga_attributes = manga_relation.get("attributes") or {}
            if not manga_id:
                continue

            if manga_id not in mangas:
                manga_relationships = manga_relation.get("relationships") or []
                author_ids = _extract_related_ids(manga_relationships, "author")
                artist_ids = _extract_related_ids(manga_relationships, "artist")
                cover_url = _extract_cover_url(manga_id, manga_relationships)
                authors = _extract_people_from_relationships(manga_relationships, "author")
                artists = _extract_people_from_relationships(manga_relationships, "artist")

                if not authors:
                    authors = [{"id": author_id, "name": ""} for author_id in author_ids]
                if not artists:
                    artists = [{"id": artist_id, "name": ""} for artist_id in artist_ids]
                mangas[manga_id] = _parse_manga(
                    manga_attributes,
                    manga_id,
                    authors=authors,
                    artists=artists,
                    cover_url=cover_url,
                )
                mangas[manga_id]["chapters"] = []

            fetched_chapters += 1
            scanlation_groups = _parse_scanlation_groups(relations.get("scanlation_group", []))
            chapter_value = str(chapter_attributes.get("chapter") or "")
            chapter_entry = {
                "id": str(chapter.get("id") or ""),
                "chapter": chapter_value,
                "publish_at": str(chapter_attributes.get("publishAt") or ""),
                "readable_at": str(chapter_attributes.get("readableAt") or ""),
                "created_at": str(chapter_attributes.get("createdAt") or ""),
                "updated_at": str(chapter_attributes.get("updatedAt") or ""),
                "translation_source": "mangadex",
                "translation_source_label": "MangaDex",
                "chapter_with_groups": _build_chapter_with_groups(chapter_value, scanlation_groups),
            }
            chapter_time = _pick_chapter_time(
                chapter_entry,
                manga_updated_at=str(mangas[manga_id].get("updated_at") or ""),
            )
            current_latest_time = str(mangas[manga_id].get("local_last_published_at") or "")
            if chapter_time and (not current_latest_time or chapter_time > current_latest_time):
                mangas[manga_id]["local_last_published_at"] = chapter_time

            existing_chapters = mangas[manga_id]["chapters"]
            if existing_chapters and isinstance(existing_chapters[0], dict):
                current_entry = existing_chapters[0]
                if _is_preferred_latest_chapter(
                    chapter_entry,
                    current_entry,
                    manga_updated_at=str(mangas[manga_id].get("updated_at") or ""),
                ):
                    existing_chapters[0] = chapter_entry
            elif existing_chapters:
                existing_chapters[0] = chapter_entry
            else:
                existing_chapters.append(chapter_entry)

            if chapter_budget is not None and fetched_chapters >= chapter_budget:
                break

        offset += len(data)
        if len(data) < step:
            break
        if total is not None and offset >= total:
            break
        if (
            target_manga_count > 0
            and len(mangas) >= target_manga_count
            and fetched_chapters
            >= min(
                VI_CATALOG_FAST_BREAK_MIN_CHAPTERS,
                chapter_budget
                if chapter_budget is not None
                else VI_CATALOG_FAST_BREAK_MIN_CHAPTERS,
            )
        ):
            break

    # For all-mode, avoid "few pages first then grow later" UX by
    # filling quickly to a practical sync target before returning the first payload.
    if max_chapters is None and sync_target_manga_count > 0 and len(mangas) < sync_target_manga_count:
        try:
            await _top_up_vi_catalog_from_manga_feed(mangas, target_count=sync_target_manga_count)
        except Exception as exc:
            logger.warning("MangaDex vi-catalog all bootstrap top-up failed: %s", exc)

    result = {
        "meta": {
            "language": "vi",
            "total_chapters_api": total,
            "fetched_chapters": fetched_chapters,
            "total_manga": len(mangas),
            "target_manga": target_manga_count,
        },
        "mangas": list(mangas.values()),
    }

    if target_manga_count > 0 and len(mangas) < target_manga_count:
        _schedule_vi_catalog_top_up(
            cache_key,
            result,
            target_count=target_manga_count,
            reason="fresh-depth",
        )
    elif target_manga_count > 0 and _count_missing_popularity_scores(mangas) > 0:
        _schedule_vi_catalog_top_up(
            cache_key,
            result,
            target_count=len(mangas) + 1,
            reason="fresh-popularity",
        )

    if mangas and VI_CATALOG_COVER_ENRICH_TIMEOUT_SECONDS > 0:
        # Keep request path non-blocking: enrich covers in background to avoid response delays/timeouts.
        _schedule_vi_catalog_cover_enrich(
            cache_key,
            result,
            reason="fresh-missing",
        )
    result["mangas"] = list(mangas.values())
    missing_cover_count = sum(
        1
        for manga in result["mangas"]
        if not str((manga or {}).get("cover_url") or "").strip()
    )
    if result["mangas"]:
        if missing_cover_count >= len(result["mangas"]):
            # Do not poison the main cache, but store briefly so repeated requests
            # don't re-fetch while background enrichment resolves covers.
            if _payload_has_mangas(stale_payload):
                _schedule_vi_catalog_cover_enrich(
                    cache_key,
                    result,
                    reason="fresh-all-missing",
                )
                return stale_payload

            fallback_payload = _load_non_empty_vi_catalog_fallback(max_chapters=max_chapters)
            if _payload_has_mangas(fallback_payload):
                _schedule_vi_catalog_cover_enrich(
                    cache_key,
                    result,
                    reason="fresh-all-missing",
                )
                return fallback_payload

            logger.warning(
                "MangaDex vi-catalog returning all-missing-cover payload (limit=%s, mangas=%s)",
                max_chapters,
                len(result["mangas"]),
            )
            # Cache briefly so background enrichment can update it
            _cache_payload(cache_key, result, ttl=30)
            _schedule_vi_catalog_cover_enrich(
                cache_key,
                result,
                reason="fresh-all-missing",
            )
            return result

        _cache_payload(cache_key, result, ttl=VI_CATALOG_TTL)
        return result

    if _payload_has_mangas(stale_payload):
        stale_mangas = _manga_map_from_payload(stale_payload)
        if target_manga_count > 0 and len(stale_mangas) < target_manga_count:
            _schedule_vi_catalog_top_up(
                cache_key,
                stale_payload,
                target_count=target_manga_count,
                reason="stale-fallback-depth",
            )
        return stale_payload

    fallback_payload = _load_non_empty_vi_catalog_fallback(max_chapters=max_chapters)
    if _payload_has_mangas(fallback_payload):
        fallback_mangas = _manga_map_from_payload(fallback_payload)
        if target_manga_count > 0 and len(fallback_mangas) < target_manga_count:
            _schedule_vi_catalog_top_up(
                cache_key,
                fallback_payload,
                target_count=target_manga_count,
                reason="limit-fallback-depth",
            )
        return fallback_payload

    raise RuntimeError("MangaDex vi-catalog tạm thời không khả dụng")


async def get_latest_chapters_for_manga_ids(
    manga_ids: list[str],
    *,
    translated_language: str = "vi",
    allow_individual_fallback: bool = True,
) -> dict[str, dict[str, str]]:
    normalized_ids = [str(manga_id or "").strip().lower() for manga_id in manga_ids]
    normalized_ids = [manga_id for manga_id in dict.fromkeys(normalized_ids) if manga_id]
    if not normalized_ids:
        return {}
    return await _get_latest_vi_chapter_for_manga_ids(
        normalized_ids,
        translated_language=translated_language,
        allow_individual_fallback=allow_individual_fallback,
    )


async def get_latest_vi_chapters_for_manga_ids(
    manga_ids: list[str],
    *,
    allow_individual_fallback: bool = True,
) -> dict[str, dict[str, str]]:
    return await get_latest_chapters_for_manga_ids(
        manga_ids,
        translated_language="vi",
        allow_individual_fallback=allow_individual_fallback,
    )


@coalesce_reads
async def _release_feed_chunk(
    offset: int, size: int, language: str, ratings: tuple[str, ...], feed_snapshot: str,
) -> dict[str, Any]:
    key = "mangadex:release-chunks:v1:" + hashlib.sha256(json.dumps(
        [offset, size, language, ratings, feed_snapshot], sort_keys=True).encode()).hexdigest()
    cached = await asyncio.to_thread(_load_json_cache_payload, key)
    if cached is not None:
        return cached
    params = {"includes[]": ["user", "scanlation_group", "manga"],
              "contentRating[]": list(ratings), "order[readableAt]": "desc",
              "limit": size, "offset": offset, "includeFuturePublishAt": 0}
    if language not in {"all", "non_vi"}:
        params["translatedLanguage[]"] = language
    value = await _request_json("/chapter", params)
    # Immutable source chunks keep page boundaries stable while the user
    # browses. All genre/status queries can reuse the same source window.
    stored = await asyncio.to_thread(cache.add, key, json.dumps(value), ttl=1800)
    return value if stored else (await asyncio.to_thread(_load_json_cache_payload, key) or value)


@coalesce_reads
async def get_latest_vi_chapter_feed(
    page: int = 1, limit: int = 24, *,
    content_ratings: list[str] | None = None,
    excluded_manga_ids: list[str] | None = None,
    snapshot: bool = False, translated_language: str = "vi",
    included_tag_slugs: list[str] | None = None,
    statuses: list[str] | None = None, keyword: str = "", feed_snapshot: str = "",
) -> dict[str, Any]:
    options = dict(page=page, limit=limit, content_ratings=content_ratings,
                   excluded_manga_ids=excluded_manga_ids, snapshot=snapshot,
                   translated_language=translated_language, included_tag_slugs=included_tag_slugs,
                   statuses=statuses, keyword=keyword, feed_snapshot=feed_snapshot)
    load = _get_indexed_vi_feed if translated_language == "vi" else _get_latest_vi_chapter_feed_live
    if not snapshot:
        return await load(**options)
    # A home snapshot survives minute/revision changes. Keep filters (including
    # hidden IDs) in the key; never borrow another reader's content selection.
    key = "mangadex:home-last-good:v1:" + hashlib.sha256(json.dumps([
        page, limit, sorted(content_ratings or ["safe", "suggestive"]),
        sorted(excluded_manga_ids or []), translated_language,
        sorted(included_tag_slugs or []), sorted(statuses or []), keyword,
    ]).encode()).hexdigest()
    try:
        result = await load(**options)
    except RuntimeError:
        previous = await asyncio.to_thread(_load_json_cache_payload, key)
        if previous and (previous.get("data") or {}).get("items"):
            previous["data"]["source_unavailable"] = True
            return previous
        raise
    if (result.get("data") or {}).get("items"):
        await asyncio.to_thread(cache.set, key, json.dumps(result, ensure_ascii=False), ttl=3600)
    return result


async def _get_indexed_vi_feed(**options):
    from fastapi_app.services import mangadex_release_index as index
    page = max(1, int(options.get("page") or 1))
    limit = max(1, min(24, int(options.get("limit") or 24)))
    tags = await _resolve_mangadex_tag_ids(options.get("included_tag_slugs"))
    if tags is None:
        return {"data": {"items": [], "params": {"pagination": {"totalItems": 0,
            "totalItemsPerPage": limit, "currentPage": page}}}}
    ratings = options.get("content_ratings") or ["safe", "suggestive"]
    excluded = {str(mid).removeprefix("mdx-").lower() for mid in options.get("excluded_manga_ids") or []}
    rows, total, page, version = await index.page_rows(page=page, limit=limit,
        ratings=ratings, excluded=excluded, tags=tags, statuses=options.get("statuses") or [],
        keyword=options.get("keyword") or "", snapshot=options.get("feed_snapshot") or "")
    cover_map = await _fetch_cover_urls_for_manga_ids([index.manga_relation(row)["id"] for row in rows])
    items = []
    for row in rows:
        relation = index.manga_relation(row)
        mid, attrs = relation["id"], row.get("attributes") or {}
        manga = _parse_manga(relation.get("attributes") or {}, mid, authors=[], artists=[], cover_url=cover_map.get(mid, ""))
        groups = _parse_scanlation_groups(_relation_bucket(row).get("scanlation_group", []))
        number = str(attrs.get("chapter") or "").strip()
        title = _build_chapter_with_groups(number, groups) if number else str(attrs.get("title") or "Chương đặc biệt")
        stamp = str(attrs.get("readableAt") or attrs.get("publishAt") or attrs.get("createdAt") or "")
        manga["local_last_published_at"] = stamp
        item = _to_legacy_item(manga, latest_chapter={"chapter_name": number, "chapter_title": title, "publish_at": stamp})
        item["chaptersLatest"] = [{"chapter_name": number, "chapter_title": title,
            "chapter_api_data": row["id"], "publish_at": stamp, "updated_at": stamp, "translated_language": "vi"}]
        items.append(item)
    return {"data": {"items": items, "feed_snapshot": version, "order": "readableAt:desc",
        "params": {"pagination": {"totalItems": total, "totalItemsPerPage": limit,
            "currentPage": page, "unit": "manga"}}}}


async def _get_latest_vi_chapter_feed_live(
    page: int = 1,
    limit: int = 24,
    *,
    content_ratings: list[str] | None = None,
    excluded_manga_ids: list[str] | None = None,
    snapshot: bool = False,
    translated_language: str = "vi",
    included_tag_slugs: list[str] | None = None,
    statuses: list[str] | None = None,
    keyword: str = "",
    feed_snapshot: str = "",
) -> dict[str, Any]:
    """Page releases directly for native Latest Updates.

    Explicit legacy genre/status/title feed requests retain their filtered
    unique-title window; Browse sends those selections to source title search.
    """
    page = max(1, int(page or 1))
    limit = max(1, min(24, int(limit or 24)))
    target_unique = page * limit
    language = str(translated_language or "vi").strip().lower()
    if language in {"any", "*"}:
        language = "all"
    tag_ids = await _resolve_mangadex_tag_ids(included_tag_slugs)
    if tag_ids is None:
        return {"data": {"items": [], "params": {"pagination": {
            "totalItems": 0, "totalItemsPerPage": limit, "currentPage": page, "totalPages": 1}}}}
    status_values = sorted(set(value for value in (statuses or [])
                               if value in {"ongoing", "completed", "hiatus", "cancelled"}))
    query_title = _slugify_tag(keyword)
    # Match MangaDex's Latest Updates: page chapter releases and group titles
    # within that page, without scanning every preceding chapter on deep links.
    chapter_paging = not snapshot and not (tag_ids or status_values or query_title)
    if chapter_paging:
        page = min(page, math.ceil(10000 / limit))
    current_window = int(time.time() // 60)
    window = int(feed_snapshot) if str(feed_snapshot).isdigit() and len(str(feed_snapshot)) < 12 else current_window
    if not current_window - 29 <= window <= current_window:
        window = current_window
    feed_snapshot = str(window)
    normalized_content_ratings = [
        rating
        for rating in (
            str(value or "").strip().lower()
            for value in (content_ratings or ["safe", "suggestive"])
        )
        if rating in {"safe", "suggestive", "erotica", "pornographic"}
    ] or ["safe", "suggestive"]
    normalized_excluded_ids: set[str] = set()
    for raw in excluded_manga_ids or []:
        value = str(raw or "").strip().lower()
        if value.startswith("mdx-"):
            value = value[4:]
        if _MANGADEX_UUID_RE.fullmatch(value):
            normalized_excluded_ids.add(value)
    excluded_cache_token = "none"
    if normalized_excluded_ids:
        excluded_cache_token = hashlib.sha1(
            ",".join(sorted(normalized_excluded_ids)).encode("utf-8")
        ).hexdigest()[:12]

    revision = await asyncio.to_thread(_live_revision) if snapshot else ""
    cache_key = (
        f"mangadex:latest-vi-feed:v6:{page}:{limit}:snapshot={int(snapshot)}:"
        f"rating={','.join(normalized_content_ratings)}:"
        f"excluded={excluded_cache_token}:lang={language}:tags={','.join(sorted(tag_ids))}:"
        f"status={','.join(status_values)}:title={query_title}:window={feed_snapshot}:rev={revision if snapshot else ''}"
    )
    cached = await asyncio.to_thread(cache.get, cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)

    manga_total = None if snapshot or chapter_paging else await get_total_vi_manga_count(
        content_ratings=normalized_content_ratings, translated_language=language,
        tag_ids=tag_ids, statuses=status_values, keyword=keyword)
    mangas: dict[str, dict[str, Any]] = {}
    latest_by_manga: dict[str, dict[str, Any]] = {}
    total = 0
    offset = (page - 1) * limit if chapter_paging else 0
    release_cutoff = ""
    exhausted = manga_total == 0
    window_key = "mangadex:release-window:v1:" + hashlib.sha256(json.dumps([
        normalized_content_ratings, sorted(normalized_excluded_ids), language,
        sorted(tag_ids), status_values, query_title, feed_snapshot,
    ]).encode()).hexdigest()
    if not snapshot and not chapter_paging:
        progress = await asyncio.to_thread(_load_json_cache_payload, window_key)
        if progress:
            mangas = progress["mangas"]
            latest_by_manga = progress["latest"]
            offset = progress["offset"]
            total = progress["total"]
            release_cutoff = progress["cutoff"]
            exhausted = progress["exhausted"]
    request_limit = min(100, max(24, int(LATEST_FEED_CHAPTER_PAGE_SIZE or 100)))
    if chapter_paging:
        request_limit = min(limit, 10000 - offset)
    advanced = False
    while not exhausted and len(mangas) < target_unique:
        if offset + request_limit > 10000:
            raise RuntimeError("MangaDex chapter feed reached its upstream pagination limit")
        payload = await asyncio.to_thread(_load_json_cache_payload, "catalog:probe:mangadex") if snapshot and page == 1 else None
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            payload = await _request_json(
                "/chapter",
                {
                    "translatedLanguage[]": "vi",
                    "includes[]": ["user", "scanlation_group", "manga"],
                    "contentRating[]": normalized_content_ratings,
                    "order[readableAt]": "desc",
                    "limit": request_limit,
                    "offset": offset,
                },
            ) if snapshot else await _release_feed_chunk(offset, request_limit, language,
                                                        tuple(normalized_content_ratings), feed_snapshot)
        total = max(total, int(payload.get("total") or 0))
        chapters = payload.get("data") or []
        advanced = True
        if not chapters:
            exhausted = True
            break
        if not release_cutoff:
            release_cutoff = max((str((row.get("attributes") or {}).get("readableAt") or "")
                                  for row in chapters), default="")

        for chapter in chapters:
            attributes = (chapter or {}).get("attributes") or {}
            # Newly inserted head releases must not leak into a later page of
            # an existing window when upstream offsets move during browsing.
            if release_cutoff and str(attributes.get("readableAt") or "") > release_cutoff:
                continue
            chapter_language = str(attributes.get("translatedLanguage") or "").strip().lower()
            if ((language not in {"all", "non_vi"} and chapter_language != language)
                    or (language == "non_vi" and chapter_language == "vi")):
                continue
            relations = _relation_bucket(chapter or {})
            manga_relations = relations.get("manga") or []
            if not manga_relations:
                continue
            manga_relation = manga_relations[0]
            manga_id = str(manga_relation.get("id") or "").strip()
            manga_attributes = manga_relation.get("attributes") or {}
            if manga_attributes.get("contentRating", "safe") not in normalized_content_ratings:
                continue
            if not manga_id or not isinstance(manga_attributes, dict):
                continue
            if manga_id.lower() in normalized_excluded_ids:
                continue
            manga_tags = {tag.get("id") for tag in manga_attributes.get("tags", []) if isinstance(tag, dict)}
            if not set(tag_ids).issubset(manga_tags):
                continue
            if status_values and manga_attributes.get("status") not in status_values:
                continue
            names = [*(manga_attributes.get("title") or {}).values(),
                     *(name for entry in manga_attributes.get("altTitles", []) for name in entry.values())]
            if query_title and not any(query_title in _slugify_tag(name) for name in names):
                continue

            if manga_id not in mangas:
                mangas[manga_id] = _parse_manga(
                    manga_attributes,
                    manga_id,
                    authors=[],
                    artists=[],
                    cover_url="",
                )

            scanlation_groups = _parse_scanlation_groups(relations.get("scanlation_group", []))
            chapter_value = str(attributes.get("chapter") or "").strip()
            chapter_entry = {
                "id": str((chapter or {}).get("id") or "").strip(),
                "chapter": chapter_value,
                "chapter_with_groups": (_build_chapter_with_groups(chapter_value, scanlation_groups)
                                        if chapter_value else str(attributes.get("title") or "Chương đặc biệt")),
                "publish_at": str(attributes.get("publishAt") or ""),
                "readable_at": str(attributes.get("readableAt") or ""),
                "created_at": str(attributes.get("createdAt") or ""),
                "updated_at": str(attributes.get("updatedAt") or ""),
                "translation_source": "mangadex",
                "translation_source_label": "MangaDex",
                "translated_language": chapter_language,
            }
            current = latest_by_manga.get(manga_id)
            if current is None:
                latest_by_manga[manga_id] = chapter_entry
                chapter_time = _pick_chapter_time(
                    {**chapter_entry, "publish_at": chapter_entry["readable_at"] or chapter_entry["publish_at"]},
                    manga_updated_at=str(mangas[manga_id].get("updated_at") or ""),
                )
                if chapter_time:
                    mangas[manga_id]["local_last_published_at"] = chapter_time

        offset += len(chapters)
        exhausted = len(chapters) < request_limit or bool(total and offset >= total)
        if snapshot or chapter_paging:
            break

    if not snapshot and not chapter_paging and advanced:
        # Continue the same filtered title index on subsequent pages instead
        # of rescanning and re-filtering all earlier chapter pages each time.
        await asyncio.to_thread(cache.set, window_key, json.dumps({
            "mangas": mangas, "latest": latest_by_manga, "offset": offset,
            "total": total, "cutoff": release_cutoff, "exhausted": exhausted,
        }), ttl=1800)

    ordered_manga_ids = list(mangas.keys())
    page_manga_ids = ordered_manga_ids if chapter_paging else ordered_manga_ids[(page - 1) * limit : page * limit]

    missing_cover_ids = [
        manga_id
        for manga_id in page_manga_ids
        for manga in [mangas.get(manga_id) or {}]
        if not str(manga.get("cover_url") or "").strip()
    ]
    if missing_cover_ids:
        cover_map = await _fetch_cover_urls_for_manga_ids(missing_cover_ids)
        for manga_id, cover_url in cover_map.items():
            if manga_id in mangas and cover_url:
                mangas[manga_id]["cover_url"] = cover_url

    items: list[dict[str, Any]] = []
    for manga_id in page_manga_ids:
        manga = mangas[manga_id]
        latest = latest_by_manga.get(manga_id) or {}
        latest_time = _pick_chapter_time(
            {**latest, "publish_at": latest.get("readable_at") or latest.get("publish_at", "")},
            manga_updated_at=str(manga.get("updated_at") or ""),
        )
        item = _to_legacy_item(
            manga,
            latest_chapter={
                "chapter_name": str(latest.get("chapter") or ""),
                "chapter_title": str(latest.get("chapter_with_groups") or ""),
                "publish_at": latest_time,
            },
        )
        if latest.get("id"):
            item["chaptersLatest"] = [{
                "chapter_name": str(latest.get("chapter") or ""),
                "chapter_title": str(latest.get("chapter_with_groups") or ""),
                "chapter_api_data": str(latest["id"]),
                "publish_at": latest_time, "updated_at": latest_time,
                "translated_language": latest.get("translated_language", "vi"),
            }]
        items.append(item)

    # A newly released/backfilled chapter can have a LOWER chapter number.
    # Keep release cards separate from the highest-number chapter lookup cache.

    # Native release pages count chapter entries; advanced filtered title
    # windows still count matching manga. The API exposes at most 10k entries.
    if chapter_paging:
        manga_total = min(total, 10000)
    elif snapshot:
        manga_total = len(ordered_manga_ids)
    result = {
        "data": {
            "feed_snapshot": feed_snapshot,
            "order": "readableAt:desc",
            "items": items,
            "params": {
                "pagination": {
                    "totalItems": manga_total,
                    "totalItemsPerPage": limit,
                    "currentPage": page,
                    "uniqueItemsInWindow": len(ordered_manga_ids),
                    "unit": "chapter" if chapter_paging else "manga",
                }
            },
        }
    }
    _cache_payload(cache_key, result, ttl=60)
    return result


@coalesce_reads
async def get_total_vi_manga_count(
    *, content_ratings: list[str] | None = None, translated_language: str = "vi",
    tag_ids: list[str] | None = None, statuses: list[str] | None = None, keyword: str = "",
) -> int:
    ratings = sorted(set(content_ratings or ["safe", "suggestive", "erotica", "pornographic"]))
    cache_key = "mangadex:total-vi-manga:v3:" + json.dumps([ratings, translated_language, tag_ids or [], statuses or [], keyword])
    cached = await asyncio.to_thread(cache.get, cache_key)
    if cached:
        try:
            return int(cached)
        except Exception:
            cache.delete(cache_key)
    params = {
        "limit": 1,
        "offset": 0,
        "contentRating[]": ratings,
    }
    if translated_language not in {"all", "non_vi"}:
        params["availableTranslatedLanguage[]"] = translated_language
    if tag_ids:
        params.update({"includedTags[]": tag_ids, "includedTagsMode": "AND"})
    if statuses:
        params["status[]"] = statuses
    if keyword:
        params["title"] = keyword
    payload = await _request_json("/manga", params)
    total = int(payload.get("total", 0))
    await asyncio.to_thread(cache.set, cache_key, str(total), ttl=TOTAL_COUNT_TTL)
    return total


@coalesce_reads(revision=lambda: _live_revision())
async def search_manga(
    keyword: str,
    page: int = 1,
    limit: int = 24,
    translated_language: str = "vi",
    attach_latest: bool = True,
    included_tag_slugs: list[str] | None = None,
    included_tags_mode: str = "AND",
    original_languages: list[str] | None = None,
    statuses: list[str] | None = None,
    sort: str = "relevance",
    content_ratings: list[str] | None = None,
    offset_override: int | None = None,
    manga_ids: list[str] | None = None,
) -> dict[str, Any]:
    normalized_keyword = str(keyword or "").strip()
    page = max(1, int(page))
    limit = max(1, min(100, int(limit)))
    page = min(page, math.ceil(10000 / limit))
    normalized_language = str(translated_language or "vi").strip().lower()
    if normalized_language in {"", "all", "any"}:
        normalized_language = "all"
    should_attach_latest = bool(attach_latest) and normalized_language not in {"all", "non_vi"}
    offset = max(0, int(offset_override)) if offset_override is not None else (page - 1) * limit
    if offset >= 10000:
        return {"data": {"items": [], "params": {"pagination": {
            "totalItems": 10000, "totalItemsPerPage": limit, "currentPage": page}}}}
    normalized_sort = str(sort or "relevance").strip().lower()
    if normalized_sort not in {"relevance", "latest", "popular", "updated", "title"}:
        normalized_sort = "relevance"
    tag_ids = await _resolve_mangadex_tag_ids(included_tag_slugs)
    if tag_ids is None:
        return {"data": {"items": [], "params": {"pagination": {
            "totalItems": 0, "totalItemsPerPage": limit, "currentPage": page, "totalPages": 1}}}}
    normalized_tags_mode = str(included_tags_mode or "AND").strip().upper()
    if normalized_tags_mode not in {"AND", "OR"}:
        normalized_tags_mode = "AND"
    normalized_original_languages = [
        language
        for language in (
            str(value or "").strip().lower()
            for value in (original_languages or [])
        )
        if language and language not in {"all", "any", "*"}
    ]
    normalized_original_languages = list(dict.fromkeys(normalized_original_languages))
    normalized_statuses = [
        status
        for status in (
            str(value or "").strip().lower()
            for value in (statuses or [])
        )
        if status in {"ongoing", "completed", "hiatus", "cancelled"}
    ]
    normalized_manga_ids = [
        manga_id
        for manga_id in (
            str(value or "").strip().lower()
            for value in (manga_ids or [])
        )
        if _MANGADEX_UUID_RE.match(manga_id)
    ]
    normalized_manga_ids = list(dict.fromkeys(normalized_manga_ids))[:100]
    allow_empty_catalog_query = normalized_sort in {"latest", "popular", "updated", "title"}
    if (
        not normalized_keyword
        and not tag_ids
        and not normalized_statuses
        and not normalized_manga_ids
        and not allow_empty_catalog_query
    ):
        return {
            "data": {
                "items": [],
                "params": {
                    "pagination": {
                        "totalItems": 0,
                        "totalItemsPerPage": limit,
                        "currentPage": page,
                    }
                },
            }
        }
    normalized_content_ratings = [
        rating
        for rating in (
            str(value or "").strip().lower()
            for value in (content_ratings or ["safe", "suggestive", "erotica", "pornographic"])
        )
        if rating in {"safe", "suggestive", "erotica", "pornographic"}
    ] or ["safe", "suggestive"]
    manga_ids_key = hashlib.sha1(",".join(normalized_manga_ids).encode("utf-8")).hexdigest() if normalized_manga_ids else ""
    cache_key = (
        f"mangadex:search:v5:{normalized_keyword.lower()}:{page}:{limit}:offset={offset}:"
        f"lang={normalized_language}:latest={1 if should_attach_latest else 0}:"
        f"tags={','.join(tag_ids)}:tag_mode={normalized_tags_mode}:status={','.join(normalized_statuses)}:"
        f"orig_lang={','.join(normalized_original_languages)}:"
        f"sort={normalized_sort}:rating={','.join(normalized_content_ratings)}:ids={manga_ids_key}:rev={_live_revision()}"
    )
    # Keep an exact query snapshot outside the short-lived invalidation namespace.
    snapshot_key = "mangadex:search-fallback:v1:" + hashlib.sha256(
        cache_key.rsplit(":rev=", 1)[0].encode("utf-8")
    ).hexdigest()
    cached = cache.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)
    stale = cache.get(f"{cache_key}:stale")
    stale_payload: dict[str, Any] | None = None
    if stale:
        try:
            stale_payload = json.loads(stale)
        except Exception:
            cache.delete(f"{cache_key}:stale")

    normalized_lc = normalized_keyword.lower()
    is_mangadex_tag = normalized_lc in {
        "mangadex",
        "#mangadex",
        "tag:mangadex",
        "source:mangadex",
    }

    params: dict[str, Any] = {
        "includes[]": ["author", "artist", "cover_art"],
        "limit": min(limit, 10000 - offset),
        "offset": offset,
        "contentRating[]": normalized_content_ratings,
    }
    if normalized_manga_ids:
        params["ids[]"] = normalized_manga_ids
    if normalized_language not in {"all", "non_vi"}:
        params["availableTranslatedLanguage[]"] = normalized_language
    if normalized_original_languages:
        params["originalLanguage[]"] = normalized_original_languages
    if tag_ids:
        params["includedTags[]"] = tag_ids
        params["includedTagsMode"] = normalized_tags_mode
        params["excludedTagsMode"] = "OR"
    if normalized_statuses:
        params["status[]"] = normalized_statuses
    # The title filter applies to every ordering, including latest/popular.
    if normalized_keyword and not is_mangadex_tag:
        params["title"] = normalized_keyword
    if is_mangadex_tag:
        params["order[latestUploadedChapter]"] = "desc"
    elif normalized_sort == "latest":
        params["order[latestUploadedChapter]"] = "desc"
    elif normalized_sort == "updated":
        params["order[updatedAt]"] = "desc"
    elif normalized_sort == "popular":
        params["order[followedCount]"] = "desc"
    elif normalized_sort == "title":
        params["order[title]"] = "asc"
    else:
        if normalized_keyword:
            params["order[relevance]"] = "desc"
        else:
            params["order[latestUploadedChapter]"] = "desc"

    try:
        payload = await _request_json("/manga", params)
    except RuntimeError as error:
        if stale_payload is None:
            stale_payload = await asyncio.to_thread(_load_json_cache_payload, snapshot_key)
        if stale_payload is not None:
            logger.warning(
                "MangaDex search using stale cache for '%s' (page=%s, limit=%s): %s",
                normalized_keyword,
                page,
                limit,
                error,
            )
            return stale_payload
        raise
    data = payload.get("data") or []
    total = min(int(payload.get("total", 0)), 10000)
    if not data and total > 0 and offset >= total:
        last_page = max(1, math.ceil(total / limit))
        last_offset = (last_page - 1) * limit
        if last_offset != offset:
            params["offset"] = last_offset
            params["limit"] = min(limit, 10000 - last_offset)
            payload = await _request_json("/manga", params)
            data = payload.get("data") or []
            total = min(int(payload.get("total", total)), 10000)
            page = last_page
    parsed_items: list[dict[str, Any]] = []
    for manga_item in data:
        manga_id = str(manga_item.get("id") or "")
        if not manga_id:
            continue
        attributes = manga_item.get("attributes") or {}
        relationships = manga_item.get("relationships") or []
        authors = _extract_people_from_relationships(relationships, "author")
        artists = _extract_people_from_relationships(relationships, "artist")
        parsed = _parse_manga(
            attributes=attributes,
            manga_id=manga_id,
            authors=authors,
            artists=artists,
            cover_url=_extract_cover_url(manga_id, relationships),
        )
        parsed_items.append(parsed)

    latest_map: dict[str, dict[str, str]] = {}
    if should_attach_latest:
        latest_map = await _get_latest_vi_chapter_for_manga_ids(
            [str(parsed.get("id") or "") for parsed in parsed_items],
            translated_language=normalized_language,
            allow_individual_fallback=False,
        )
    items: list[dict[str, Any]] = []
    for parsed in parsed_items:
        manga_id = str(parsed.get("id") or "")
        default_latest = {
            "chapter_name": "",
            "chapter_title": "",
            "publish_at": str(parsed.get("updated_at") or ""),
        }
        latest_chapter = latest_map.get(manga_id) or default_latest
        if not str(latest_chapter.get("chapter_name") or "").strip():
            latest_chapter = default_latest
        items.append(_to_legacy_item(parsed, latest_chapter=latest_chapter))

    result = {
        "data": {
            "items": items,
            "params": {
                "pagination": {
                    "totalItems": total,
                    "totalItemsPerPage": limit,
                    "currentPage": page,
                }
            },
        }
    }
    _cache_payload(cache_key, result, ttl=VI_CATALOG_TTL)
    if items:
        await asyncio.to_thread(cache.set, snapshot_key, json.dumps(result, ensure_ascii=False), ttl=SEARCH_SNAPSHOT_TTL)
        await asyncio.to_thread(_cache_stale_cover_urls,
            {item["id"]: item["cover_url"] for item in parsed_items if item.get("cover_url")})
    return result


@coalesce_reads(revision=lambda: _live_revision())
async def _get_manga_metadata(manga_id: str) -> dict[str, Any]:
    key = f"mangadex:metadata:{manga_id}:rev={_live_revision(manga_id)}"
    cached = _load_json_cache_payload(key)
    if cached is not None:
        return cached
    payload = await _request_json(f"/manga/{manga_id}", {"includes[]": ["author", "artist", "cover_art"]})
    if payload.get("data"):
        _cache_payload(key, payload, ttl=MANGA_DETAIL_TTL)
        cover_url = _extract_cover_url(manga_id, payload["data"].get("relationships") or [])
        if cover_url:
            await asyncio.to_thread(_cache_stale_cover_urls, {manga_id: cover_url})
    return payload


@coalesce_reads(revision=lambda: _live_revision())
async def _get_manga_chapter_page(params: dict[str, Any]) -> dict[str, Any]:
    # The quick detail and the full chapter list request the same first page.
    # Keep it briefly so progressive loading does not download it twice.
    digest = hashlib.sha256(_request_fingerprint("/chapter", params).encode()).hexdigest()
    key = f"mangadex:detail-chapter-page:{params.get('manga', '')}:{digest}:rev={_live_revision(params.get('manga', ''))}"
    cached = _load_json_cache_payload(key)
    if cached is not None:
        return cached
    payload = await _request_json("/chapter", params)
    if isinstance(payload.get("data"), list):
        cache.set(key, json.dumps(payload, ensure_ascii=False), ttl=30)
    return payload


@coalesce_reads(revision=lambda: _live_revision())
async def get_manga_lookup(manga_id: str) -> dict[str, Any]:
    normalized_manga_id = str(manga_id or "").strip().lower()
    if not normalized_manga_id:
        return {"manga": None}

    cache_key = f"mangadex:lookup:{normalized_manga_id}:rev={_live_revision(normalized_manga_id)}"
    cached = cache.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)

    stale_payload = _load_json_cache_payload(f"{cache_key}:stale")

    try:
        manga_payload = await _get_manga_metadata(normalized_manga_id)
    except RuntimeError as error:
        if stale_payload is not None:
            logger.warning(
                "MangaDex lookup using stale cache for %s: %s",
                normalized_manga_id,
                error,
            )
            return stale_payload
        raise

    manga_data = manga_payload.get("data") or {}
    if not manga_data:
        return {"manga": None}

    attributes = manga_data.get("attributes") or {}
    relationships = manga_data.get("relationships") or []
    authors = _extract_people_from_relationships(relationships, "author")
    artists = _extract_people_from_relationships(relationships, "artist")
    parsed = _parse_manga(
        attributes=attributes,
        manga_id=normalized_manga_id,
        authors=authors,
        artists=artists,
        cover_url=_extract_cover_url(normalized_manga_id, relationships),
    )

    result = {
        "meta": {
            "manga_id": normalized_manga_id,
            "lookup": True,
        },
        "manga": {
            **parsed,
            "chapters": [],
        },
    }
    _cache_payload(cache_key, result, ttl=MANGA_DETAIL_TTL)
    return result


@coalesce_reads(revision=lambda: _live_revision())
async def get_manga_detail(
    manga_id: str,
    max_chapters: int | None = 200,
    translated_language: str = "vi",
    scanlation_group_id: str | None = None,
) -> dict[str, Any]:
    # v2: include explicit contentRating[] filter in chapter query (see below),
    # so we version the key to avoid reusing stale zero-chapter payloads.
    normalized_language = str(translated_language or "vi").strip().lower()
    if normalized_language in {"", "all", "any"}:
        normalized_language = "all"
    normalized_group_id = str(scanlation_group_id or "").strip().lower()

    cache_key = (
        f"mangadex:detail:v{MANGA_DETAIL_CACHE_VERSION}:{manga_id}:"
        f"{'all' if max_chapters is None else max_chapters}:"
        f"lang={normalized_language}:group={normalized_group_id or 'all'}:rev={_live_revision(manga_id)}"
    )
    cached = cache.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)

    stale_payload = _load_json_cache_payload(f"{cache_key}:stale")
    if stale_payload is None and max_chapters is not None and int(max_chapters) <= 1:
        for fallback_cap in (120, 200, 500, None):
            fallback_key = (
                f"mangadex:detail:v{MANGA_DETAIL_CACHE_VERSION}:{manga_id}:"
                f"{'all' if fallback_cap is None else fallback_cap}:"
                f"lang={normalized_language}:group={normalized_group_id or 'all'}:rev={_live_revision(manga_id)}:stale"
            )
            fallback_payload = _load_json_cache_payload(fallback_key)
            if isinstance(fallback_payload, dict) and isinstance(fallback_payload.get("manga"), dict):
                stale_payload = fallback_payload
                break

    if (
        not normalized_group_id
        and not _live_revision(manga_id)
        and normalized_language == "vi"
        and max_chapters is not None
        and int(max_chapters) <= 1
    ):
        cached_manga = _get_cached_vi_catalog_manga(manga_id)
        if isinstance(cached_manga, dict):
            cached_chapters = cached_manga.get("chapters")
            if not isinstance(cached_chapters, list):
                cached_chapters = []
            cached_manga["chapters"] = cached_chapters[:1]
            if not cached_manga.get("available_translated_languages"):
                cached_manga["available_translated_languages"] = sorted(
                    {
                        str(chapter.get("translated_language") or chapter.get("translatedLanguage") or "").strip().lower()
                        for chapter in cached_chapters
                        if str(chapter.get("translated_language") or chapter.get("translatedLanguage") or "").strip()
                    }
                )

            quick_result = {
                "meta": {
                    "manga_id": manga_id,
                    "fetched_chapters": len(cached_manga["chapters"]),
                    "total_chapters_api": None,
                    "translated_language_filter": normalized_language,
                    "scanlation_group_filter": normalized_group_id,
                    "source": "vi-catalog-cache",
                },
                "manga": cached_manga,
            }
            _cache_payload(cache_key, quick_result, ttl=60)
            return quick_result

    chapters: list[dict[str, Any]] = []
    fetched_chapters = 0
    step = 100
    total = 0

    def _chapter_params(limit: int, offset: int) -> dict[str, Any]:
        params: dict[str, Any] = {
            "manga": manga_id,
            # Detail page only needs scanlation group label for chapter titles.
            "includes[]": ["scanlation_group"],
            "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
            "order[publishAt]": "desc",
            "limit": limit,
            "offset": offset,
        }
        if normalized_language not in {"all", "non_vi"}:
            params["translatedLanguage[]"] = normalized_language
        if normalized_group_id:
            params["groups[]"] = normalized_group_id
        return params

    def _append_chapters(rows: list[dict[str, Any]]) -> None:
        nonlocal fetched_chapters
        for chapter in rows:
            chapter_attributes = chapter.get("attributes") or {}
            translated_language = str(chapter_attributes.get("translatedLanguage") or "")
            if normalized_language == "non_vi":
                if not translated_language or translated_language == "vi":
                    continue
            elif normalized_language != "all" and translated_language != normalized_language:
                continue

            relations = _relation_bucket(chapter)
            scanlation_groups = _parse_scanlation_groups(relations.get("scanlation_group", []))
            chapter_value = str(chapter_attributes.get("chapter") or "")
            chapters.append(
                {
                    "id": str(chapter.get("id") or ""),
                    "volume": str(chapter_attributes.get("volume") or ""),
                    "chapter": chapter_value,
                    "title": str(chapter_attributes.get("title") or ""),
                    "translated_language": translated_language,
                    "pages": chapter_attributes.get("pages"),
                    "publish_at": str(chapter_attributes.get("publishAt") or ""),
                    "readable_at": str(chapter_attributes.get("readableAt") or ""),
                    "created_at": str(chapter_attributes.get("createdAt") or ""),
                    "updated_at": str(chapter_attributes.get("updatedAt") or ""),
                    "external_url": str(chapter_attributes.get("externalUrl") or ""),
                    "translation_source": "mangadex",
                    "translation_source_label": "MangaDex",
                    "scanlation_groups": scanlation_groups,
                    "chapter_with_groups": _build_chapter_with_groups(chapter_value, scanlation_groups),
                }
            )
            fetched_chapters += 1
            if max_chapters is not None and fetched_chapters >= max_chapters:
                break

    person_cache: dict[str, dict[str, str]] = {}
    try:
        first_limit = step if max_chapters is None else min(step, max_chapters)
        manga_payload, first_payload = await asyncio.gather(
            _get_manga_metadata(manga_id),
            _get_manga_chapter_page(_chapter_params(limit=first_limit, offset=0)),
        )
    except RuntimeError as error:
        if stale_payload is not None:
            logger.warning(
                "MangaDex detail using stale cache for %s: %s",
                manga_id,
                error,
            )
            return stale_payload
        raise

    manga_data = manga_payload.get("data") or {}
    if not manga_data:
        return {"manga": None}

    attributes = manga_data.get("attributes") or {}
    relationships = manga_data.get("relationships") or []
    author_ids = _extract_related_ids(relationships, "author")
    artist_ids = _extract_related_ids(relationships, "artist")
    cover_url = _extract_cover_url(manga_id, relationships)
    authors = _extract_people_from_relationships(relationships, "author")
    artists = _extract_people_from_relationships(relationships, "artist")

    if not authors or not artists:
        missing_ids = list(dict.fromkeys((author_ids if not authors else []) + (artist_ids if not artists else [])))
        people = await asyncio.gather(*[_safe_get_person_by_id(person_id, person_cache) for person_id in missing_ids])
        people_by_id = dict(zip(missing_ids, people))
        if not authors:
            authors = [people_by_id[person_id] for person_id in author_ids]
        if not artists:
            artists = [people_by_id[person_id] for person_id in artist_ids]
    manga = _parse_manga(
        attributes=attributes,
        manga_id=manga_id,
        authors=authors,
        artists=artists,
        cover_url=cover_url,
    )

    first_data = first_payload.get("data") or []
    total = int(first_payload.get("total", 0))
    chapters_complete = True

    if first_data:
        _append_chapters(first_data)

    desired_total = total if max_chapters is None else min(total, max_chapters)
    if desired_total > len(first_data):
        offset_plan: list[tuple[int, int]] = []
        cursor = len(first_data)
        while cursor < desired_total:
            limit = min(step, desired_total - cursor)
            offset_plan.append((cursor, limit))
            cursor += limit

        batch_size = max(1, DETAIL_CHAPTER_PAGE_CONCURRENCY)
        for batch_start in range(0, len(offset_plan), batch_size):
            plan_batch = offset_plan[batch_start : batch_start + batch_size]
            tasks = [
                _get_manga_chapter_page(_chapter_params(limit=limit, offset=offset))
                for offset, limit in plan_batch
            ]
            payloads = await asyncio.gather(*tasks, return_exceptions=True)

            ordered = sorted(
                zip(plan_batch, payloads),
                key=lambda pair: pair[0][0],
            )
            for (offset, _limit), payload in ordered:
                if isinstance(payload, Exception):
                    chapters_complete = False
                    logger.warning(
                        "MangaDex detail chapter page failed for %s at offset=%s: %s",
                        manga_id,
                        offset,
                        payload,
                    )
                    continue
                _append_chapters((payload or {}).get("data") or [])
                if max_chapters is not None and fetched_chapters >= max_chapters:
                    break
            if max_chapters is not None and fetched_chapters >= max_chapters:
                break

    if fetched_chapters == 0 and stale_payload is not None:
        logger.warning(
            "MangaDex detail produced 0 chapters for %s; serving stale payload",
            manga_id,
        )
        return stale_payload

    manga_updated = str(manga.get("updated_at") or "")
    chapters.sort(
        key=lambda ch: (
            _pick_chapter_time(ch, manga_updated),
            _chapter_number_value(ch.get("chapter")),
        ),
        reverse=True,
    )
    if not manga.get("available_translated_languages"):
        manga["available_translated_languages"] = sorted(
            {
                str(chapter.get("translated_language") or "").strip().lower()
                for chapter in chapters
                if str(chapter.get("translated_language") or "").strip()
            }
        )
    manga["chapters"] = chapters
    result = {
        "meta": {
            "manga_id": manga_id,
            "fetched_chapters": fetched_chapters,
            "total_chapters_api": total,
            "translated_language_filter": normalized_language,
            "scanlation_group_filter": normalized_group_id,
        },
        "manga": manga,
    }
    result["meta"]["chapters_complete"] = chapters_complete
    if chapters_complete:
        _cache_payload(cache_key, result, ttl=MANGA_DETAIL_TTL)
    return result


@coalesce_reads(revision=lambda: _live_revision())
async def get_chapter_pages(chapter_id: str, mode: str = "data", refresh: bool = False) -> dict[str, Any]:
    chapter_id = str(chapter_id or "").strip()
    normalized_mode = "data-saver" if str(mode or "").lower() in {"saver", "data-saver"} else "data"
    if not _MANGADEX_UUID_RE.fullmatch(chapter_id):
        return {
            "chapter_id": chapter_id,
            "mode": normalized_mode,
            "total_images": 0,
            "image_urls": [],
            "error": "Chapter MangaDex không hợp lệ.",
        }
    cache_key = f"mangadex:chapter-pages:{chapter_id}:{normalized_mode}"
    if not refresh:
        cached = cache.get(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                cache.delete(cache_key)
    try:
        payload = await _request_json(f"/at-home/server/{chapter_id}")
    except RuntimeError as first_error:
        if normalized_mode == "data-saver":
            fallback_cache_key = f"mangadex:chapter-pages:{chapter_id}:data"
            fallback_cached = cache.get(fallback_cache_key)
            if fallback_cached:
                try:
                    fallback = json.loads(fallback_cached)
                    fallback["mode"] = "data"
                    return fallback
                except Exception:
                    cache.delete(fallback_cache_key)
        try:
            chapter_payload = await _request_json(f"/chapter/{chapter_id}")
            chapter_data = chapter_payload.get("data") or {}
            chapter_attributes = chapter_data.get("attributes") or {}
            result = {
                "chapter_id": chapter_id,
                "mode": normalized_mode,
                "total_images": 0,
                "image_urls": [],
                "external_url": str(chapter_attributes.get("externalUrl") or ""),
                "error": str(first_error),
            }
            cache.set(cache_key, json.dumps(result, ensure_ascii=False), ttl=30)
            return result
        except RuntimeError:
            result = {
                "chapter_id": chapter_id,
                "mode": normalized_mode,
                "total_images": 0,
                "image_urls": [],
                "error": str(first_error),
            }
            cache.set(cache_key, json.dumps(result, ensure_ascii=False), ttl=15)
            return result

    chapter = payload.get("chapter") or {}
    image_names = chapter.get("dataSaver" if normalized_mode == "data-saver" else "data") or []
    used_mode = normalized_mode
    if not image_names and normalized_mode == "data-saver":
        image_names = chapter.get("data") or []
        used_mode = "data"
    base_url = str(payload.get("baseUrl") or "")
    chapter_hash = str(chapter.get("hash") or "")
    image_urls = [f"{base_url}/{used_mode}/{chapter_hash}/{name}" for name in image_names]
    fallback_image_urls: list[str] = []
    if used_mode == "data-saver":
        fallback_image_urls = [
            f"{base_url}/data/{chapter_hash}/{name}"
            for name in (chapter.get("data") or [])
        ]
    result = {
        "chapter_id": chapter_id,
        "mode": used_mode,
        "total_images": len(image_urls),
        "image_urls": image_urls,
        "fallback_image_urls": fallback_image_urls,
    }
    cache.set(cache_key, json.dumps(result, ensure_ascii=False), ttl=CHAPTER_PAGES_TTL)
    if used_mode == "data":
        cache.set(
            f"mangadex:chapter-pages:{chapter_id}:data",
            json.dumps(result, ensure_ascii=False),
            ttl=CHAPTER_PAGES_TTL,
        )
    return result


async def get_chapter_metadata(chapter_id: str) -> dict[str, Any]:
    chapter_id = str(chapter_id or "").strip()
    if not _MANGADEX_UUID_RE.fullmatch(chapter_id):
        raise RuntimeError("Chapter MangaDex không hợp lệ.")
    return await _request_json(
        f"/chapter/{chapter_id}",
        {
            "includes[]": ["manga"],
        },
    )
