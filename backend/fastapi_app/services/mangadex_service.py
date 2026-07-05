import asyncio
import hashlib
import json
import logging
import os
import re
import time
import threading
import httpx
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any
from fastapi_app.services.cache_service import cache

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
    "User-Agent": "manga-bliss-backend/1.0",
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


MANGADEX_TRANSPORT = str(os.getenv("MANGADEX_TRANSPORT", TRANSPORT_CURL_CFFI) or TRANSPORT_CURL_CFFI).strip().lower()
REQUEST_RETRIES = _env_int("MANGADEX_RETRIES", 3, minimum=1)
REQUEST_TIMEOUT_SECONDS = _env_float("MANGADEX_TIMEOUT_SECONDS", 25.0, minimum=5.0)
REQUEST_CONNECT_TIMEOUT_SECONDS = _env_float("MANGADEX_CONNECT_TIMEOUT_SECONDS", 10.0, minimum=1.0)
REQUEST_CONNECT_TIMEOUT_SECONDS = min(REQUEST_CONNECT_TIMEOUT_SECONDS, REQUEST_TIMEOUT_SECONDS)
REQUEST_RETRY_BACKOFF_SECONDS = _env_float("MANGADEX_RETRY_BACKOFF_SECONDS", 0.35, minimum=0.05)
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

_http_client: httpx.AsyncClient | None = None
_curl_executor = ThreadPoolExecutor(max_workers=CURL_WORKERS)
_curl_session: Any = None
_curl_session_lock = threading.Lock()
_request_semaphore = asyncio.Semaphore(UPSTREAM_REQUEST_CONCURRENCY)
_throttle_until_ts: float = 0.0
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
VI_CATALOG_LOOKUP_INDEX_TTL = 90
LATEST_CHAPTER_CACHE_VERSION = 3
LATEST_CHAPTER_LOW_CONFIDENCE_FALLBACK_MAX = _env_int(
    "MANGADEX_LATEST_LOW_CONFIDENCE_FALLBACK_MAX", 16, minimum=1
)
LATEST_CHAPTER_FALLBACK_CONCURRENCY = _env_int(
    "MANGADEX_LATEST_FALLBACK_CONCURRENCY", 6, minimum=1
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
LATEST_FEED_MAX_BATCHES = _env_int(
    "MANGADEX_LATEST_FEED_MAX_BATCHES", 30, minimum=2
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
        return data
    cache.delete(cache_key)
    return None


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

    seen: set[str] = set()
    for base_key in preferred_keys:
        for suffix in ("", ":stale"):
            key = f"{base_key}{suffix}"
            if key in seen:
                continue
            seen.add(key)
            payload = _load_json_cache_payload(key)
            if not _payload_has_mangas(payload):
                continue

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
        not _vi_catalog_lookup_index
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

    _vi_catalog_cover_enrich_tasks[cache_key] = asyncio.create_task(_job())


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

    _vi_catalog_top_up_tasks[cache_key] = asyncio.create_task(_job())


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
        _vi_catalog_refresh_tasks[task_key] = asyncio.create_task(_job())
    except RuntimeError:
        logger.debug("MangaDex vi-catalog refresh skipped; no running event loop")


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=REQUEST_CONNECT_TIMEOUT_SECONDS),
            headers=REQUEST_HEADERS,
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
        )
    except _MangaDexNetworkError:
        raise
    except Exception as error:
        _reset_curl_session()
        raise _MangaDexNetworkError(_format_exception(error)) from error

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
        return response.json()
    except Exception as error:
        raise _MangaDexNetworkError(f"Invalid JSON response: {_format_exception(error)}") from error


async def _request_json_via_curl(url: str, params: dict[str, Any]) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_curl_executor, _request_json_via_curl_sync, url, params)


async def _request_json_via_httpx(url: str, params: dict[str, Any]) -> dict[str, Any]:
    client = await _get_client()
    try:
        response = await client.get(url, params=params)
    except httpx.HTTPError as error:
        await _reset_client()
        raise _MangaDexNetworkError(_format_exception(error)) from error

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
        return response.json()
    except Exception as error:
        raise _MangaDexNetworkError(f"Invalid JSON response: {_format_exception(error)}") from error


async def _request_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
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
        await asyncio.sleep(_throttle_until_ts - now)

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


async def _resolve_mangadex_tag_ids(slugs: list[str] | None) -> list[str]:
    normalized = [_slugify_tag(slug) for slug in (slugs or [])]
    normalized = [slug for slug in dict.fromkeys(normalized) if slug]
    if not normalized:
        return []
    try:
        tag_map = await _get_mangadex_tag_id_by_slug()
    except Exception:
        return []
    if any(slug in {"all", "any", "*"} for slug in normalized):
        return list(dict.fromkeys(str(tag_id) for tag_id in tag_map.values() if tag_id))
    return [tag_map[slug] for slug in normalized if slug in tag_map]


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
    try:
        payload = await _request_json(
            f"/manga/{manga_id}",
            {"includes[]": "cover_art"},
        )
    except RuntimeError:
        return ""
    data = payload.get("data") or {}
    relationships = data.get("relationships") or []
    return _extract_cover_url(manga_id, relationships)


async def _fetch_cover_urls_for_manga_ids(manga_ids: list[str]) -> dict[str, str]:
    valid_ids = [str(mid or "").strip() for mid in manga_ids]
    valid_ids = [mid for mid in dict.fromkeys(valid_ids) if mid]
    if not valid_ids:
        return {}

    mapping: dict[str, str] = {}
    step = 100
    for start in range(0, len(valid_ids), step):
        batch = valid_ids[start : start + step]
        unresolved = set(batch)
        limit = 100
        offset = 0

        while unresolved:
            try:
                payload = await _request_json(
                    "/cover",
                    {
                        "manga[]": list(unresolved),
                        "limit": limit,
                        "offset": offset,
                        "order[updatedAt]": "desc",
                    },
                )
            except RuntimeError:
                break

            covers = payload.get("data") or []
            total = int(payload.get("total", 0))
            if not covers:
                break

            for cover in covers:
                cover_id = str(cover.get("id") or "")
                attributes = cover.get("attributes") or {}
                file_name = str(attributes.get("fileName") or "").strip()
                relationships = cover.get("relationships") or []
                manga_id = _extract_manga_id_from_cover_relationships(relationships)
                if not manga_id or not file_name:
                    continue
                mapping[manga_id] = f"https://uploads.mangadex.org/covers/{manga_id}/{file_name}.512.jpg"
                unresolved.discard(manga_id)
                if cover_id:
                    mapping.setdefault(f"cover:{cover_id}", mapping[manga_id])

            offset += len(covers)
            if len(covers) < limit or (total > 0 and offset >= total):
                break

        if unresolved:
            fallback_tasks = [_fetch_cover_url_by_manga_id(manga_id) for manga_id in unresolved]
            fallback_results = await asyncio.gather(*fallback_tasks, return_exceptions=True)
            for manga_id, cover_url in zip(unresolved, fallback_results):
                if isinstance(cover_url, str) and cover_url:
                    mapping[manga_id] = cover_url

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
                    "chapter_name": chapter_name or "0",
                    "chapter_title": chapter_title,
                    "publish_at": publish_at,
                }

    if best_info and str(best_info.get("chapter_name") or "").strip():
        return best_info

    last_chapter = str(
        manga.get("latest_chapter")
        or manga.get("last_chapter")
        or manga.get("chapter_newest")
        or ""
    ).strip()
    if not last_chapter:
        return None
    if _chapter_number_value(last_chapter) <= 0 and last_chapter.replace(",", ".") not in {"0", "0.0"}:
        matched = _CHAPTER_NUMBER_RE.search(last_chapter)
        if not matched:
            return None

    return {
        "chapter_name": last_chapter,
        "chapter_title": "",
        "publish_at": manga_updated_at,
    }


async def _get_latest_vi_chapter_for_manga(
    manga_id: str,
    *,
    ignore_cache: bool = False,
) -> dict[str, str]:
    cache_key = f"mangadex:latest-chapter:v{LATEST_CHAPTER_CACHE_VERSION}:{manga_id}"
    if not ignore_cache:
        cached = cache.get(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                cache.delete(cache_key)

    chapter_info = {"chapter_name": "", "chapter_title": "", "publish_at": ""}
    best_entry: dict[str, Any] | None = None

    def _ingest_payload(payload: dict[str, Any]) -> None:
        nonlocal best_entry, chapter_info
        data = payload.get("data") or []
        for chapter in data:
            attributes = (chapter or {}).get("attributes") or {}
            chapter_name = str(attributes.get("chapter") or "").strip()
            candidate_info = {
                "chapter_name": chapter_name or "0",
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
                "translatedLanguage[]": "vi",
                "order[chapter]": "desc",
                "order[publishAt]": "desc",
                "limit": 80,
                "offset": 0,
            },
        )
        _ingest_payload(payload_by_chapter)

        # Second pass: add recent chapters as fallback/tie-break.
        needs_publish_probe = best_entry is None or _chapter_number_from_entry(best_entry) <= 1
        if needs_publish_probe:
            payload_by_publish = await _request_json(
                "/chapter",
                {
                    "manga": manga_id,
                    "translatedLanguage[]": "vi",
                    "order[publishAt]": "desc",
                    "limit": 120,
                    "offset": 0,
                },
            )
            _ingest_payload(payload_by_publish)
    except RuntimeError:
        pass

    # Only cache if we got a real result — don't lock in empty data
    if str(chapter_info.get("chapter_name") or "").strip():
        cache.set(cache_key, json.dumps(chapter_info, ensure_ascii=False), ttl=VI_CATALOG_TTL)
    return chapter_info


def _extract_manga_id_from_chapter(chapter: dict[str, Any]) -> str:
    relations = _relation_bucket(chapter).get("manga", [])
    if not relations:
        return ""
    return str((relations[0] or {}).get("id") or "")


async def _get_latest_vi_chapter_for_manga_ids(
    manga_ids: list[str],
    *,
    allow_individual_fallback: bool = True,
) -> dict[str, dict[str, str]]:
    normalized_ids = [str(manga_id or "").strip() for manga_id in manga_ids]
    normalized_ids = [manga_id for manga_id in dict.fromkeys(normalized_ids) if manga_id]
    result: dict[str, dict[str, str]] = {}
    missing_ids: list[str] = []

    for manga_id in normalized_ids:
        cache_key = f"mangadex:latest-chapter:v{LATEST_CHAPTER_CACHE_VERSION}:{manga_id}"
        cached = cache.get(cache_key)
        if cached:
            try:
                result[manga_id] = json.loads(cached)
                continue
            except Exception:
                cache.delete(cache_key)
        missing_ids.append(manga_id)

    if missing_ids:
        found: dict[str, dict[str, str]] = {}
        found_entries: dict[str, dict[str, Any]] = {}
        # Batch request — use a generous limit so we don't miss manga
        batch_limit = 500 if not allow_individual_fallback else min(500, max(50, len(missing_ids) * 10))

        async def _fetch_batch_payload(order_params: dict[str, str]) -> dict[str, Any] | None:
            request = _request_json(
                "/chapter",
                {
                    "manga[]": missing_ids,
                    "translatedLanguage[]": "vi",
                    "includes[]": "manga",
                    **order_params,
                    "limit": batch_limit,
                    "offset": 0,
                },
            )
            if allow_individual_fallback:
                return await request
            return await asyncio.wait_for(
                request,
                timeout=LATEST_CHAPTER_BATCH_TIMEOUT_SECONDS,
            )

        def _ingest_batch_payload(payload: dict[str, Any] | None) -> None:
            if not isinstance(payload, dict):
                return
            for chapter in payload.get("data") or []:
                manga_id = _extract_manga_id_from_chapter(chapter)
                if not manga_id:
                    continue
                attributes = chapter.get("attributes") or {}
                chapter_name = str(attributes.get("chapter") or "").strip()
                candidate_info = {
                    "chapter_name": chapter_name or "0",
                    "chapter_title": str(attributes.get("title") or ""),
                    "publish_at": str(attributes.get("publishAt") or ""),
                }
                candidate_entry = {
                    "id": str(chapter.get("id") or ""),
                    "chapter": candidate_info["chapter_name"],
                    "chapter_with_groups": candidate_info["chapter_title"],
                    "publish_at": candidate_info["publish_at"],
                }

                current_entry = found_entries.get(manga_id)
                if current_entry is None or _is_preferred_latest_chapter(candidate_entry, current_entry):
                    found_entries[manga_id] = candidate_entry
                    found[manga_id] = candidate_info

        try:
            if allow_individual_fallback:
                payload = await _fetch_batch_payload({"order[publishAt]": "desc"})
                _ingest_batch_payload(payload)
            else:
                batch_results = await asyncio.gather(
                    _fetch_batch_payload({"order[publishAt]": "desc"}),
                    _fetch_batch_payload({"order[chapter]": "desc", "order[publishAt]": "desc"}),
                    return_exceptions=True,
                )
                for payload in batch_results:
                    if isinstance(payload, Exception):
                        continue
                    _ingest_batch_payload(payload)
        except (RuntimeError, asyncio.TimeoutError):
            pass

        # Individual fallback for manga not found in batch, or low-confidence chapter picks.
        still_missing = [mid for mid in missing_ids if mid not in found]
        low_confidence_ids = [
            mid
            for mid in missing_ids
            if mid in found_entries and _chapter_number_from_entry(found_entries[mid]) <= 1
        ]
        fallback_requests: list[tuple[str, bool]] = []
        seen_fallback: set[str] = set()

        for manga_id in still_missing:
            if manga_id in seen_fallback:
                continue
            seen_fallback.add(manga_id)
            fallback_requests.append((manga_id, False))

        low_confidence_count = 0
        for manga_id in low_confidence_ids:
            if manga_id in seen_fallback:
                continue
            if low_confidence_count >= LATEST_CHAPTER_LOW_CONFIDENCE_FALLBACK_MAX:
                break
            seen_fallback.add(manga_id)
            fallback_requests.append((manga_id, True))
            low_confidence_count += 1

        if fallback_requests and allow_individual_fallback:
            semaphore = asyncio.Semaphore(max(1, LATEST_CHAPTER_FALLBACK_CONCURRENCY))

            async def _resolve_fallback(
                fallback_manga_id: str,
                fallback_ignore_cache: bool,
            ) -> tuple[str, dict[str, str] | None]:
                async with semaphore:
                    try:
                        response = await _get_latest_vi_chapter_for_manga(
                            fallback_manga_id,
                            ignore_cache=fallback_ignore_cache,
                        )
                    except Exception:
                        return fallback_manga_id, None

                if not (isinstance(response, dict) and str(response.get("chapter_name") or "").strip()):
                    return fallback_manga_id, None
                return fallback_manga_id, response

            individual_results = await asyncio.gather(
                *[
                    _resolve_fallback(mid, ignore_cache)
                    for mid, ignore_cache in fallback_requests
                ],
                return_exceptions=False,
            )

            for mid, res in individual_results:
                if not res:
                    continue

                candidate_entry = {
                    "id": "",
                    "chapter": str(res.get("chapter_name") or ""),
                    "chapter_with_groups": str(res.get("chapter_title") or ""),
                    "publish_at": str(res.get("publish_at") or ""),
                }
                current_entry = found_entries.get(mid)
                if current_entry is None or _is_preferred_latest_chapter(candidate_entry, current_entry):
                    found_entries[mid] = candidate_entry
                    found[mid] = res

        for manga_id in missing_ids:
            catalog_fallback = None if allow_individual_fallback else _latest_chapter_info_from_cached_catalog(manga_id)
            chapter_info = (
                found.get(manga_id)
                or catalog_fallback
                or {"chapter_name": "", "chapter_title": "", "publish_at": ""}
            )
            result[manga_id] = chapter_info
            # Only cache successful lookups — don't cache empty results so next request retries
            if str(chapter_info.get("chapter_name") or "").strip():
                cache.set(
                    f"mangadex:latest-chapter:v{LATEST_CHAPTER_CACHE_VERSION}:{manga_id}",
                    json.dumps(chapter_info, ensure_ascii=False),
                    ttl=VI_CATALOG_TTL,
                )

    return result


def _to_legacy_item(manga: dict[str, Any], latest_chapter: dict[str, str] | None = None) -> dict[str, Any]:
    category = [{"name": genre, "slug": genre.lower().replace(" ", "-")} for genre in manga.get("genres", [])]
    chapter_name = str((latest_chapter or {}).get("chapter_name") or manga.get("last_chapter") or "")
    chapter_title = str((latest_chapter or {}).get("chapter_title") or "")
    publish_at = str((latest_chapter or {}).get("publish_at") or manga.get("updated_at") or "")
    chapters_latest: list[dict[str, Any]] = []
    if chapter_name:
        chapters_latest.append(
            {
                "chapter_name": chapter_name,
                "chapter_title": chapter_title,
                "chapter_api_data": "",
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
        "last_chapter": str(manga.get("last_chapter") or ""),
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


async def get_latest_vi_chapters_for_manga_ids(
    manga_ids: list[str],
    *,
    allow_individual_fallback: bool = True,
) -> dict[str, dict[str, str]]:
    normalized_ids = [str(manga_id or "").strip().lower() for manga_id in manga_ids]
    normalized_ids = [manga_id for manga_id in dict.fromkeys(normalized_ids) if manga_id]
    if not normalized_ids:
        return {}
    return await _get_latest_vi_chapter_for_manga_ids(
        normalized_ids,
        allow_individual_fallback=allow_individual_fallback,
    )


async def get_latest_vi_chapter_feed(
    page: int = 1,
    limit: int = 24,
    *,
    content_ratings: list[str] | None = None,
    excluded_manga_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Return latest MangaDex VI updates as unique manga pages.

    MangaDex /chapter is chapter-paginated. A single title can publish several
    chapters at once, so slicing the raw chapter offset creates short pages and
    repeated manga across page boundaries. Build a unique manga window from the
    top of the feed first, then slice by manga page.
    """
    page = max(1, int(page or 1))
    limit = max(1, min(24, int(limit or 24)))
    target_unique = page * limit
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

    cache_key = (
        f"mangadex:latest-vi-feed:v2:{page}:{limit}:"
        f"rating={','.join(normalized_content_ratings)}:"
        f"excluded={excluded_cache_token}"
    )
    cached = cache.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)

    mangas: dict[str, dict[str, Any]] = {}
    latest_by_manga: dict[str, dict[str, Any]] = {}
    total = 0
    offset = 0
    request_limit = min(100, max(24, int(LATEST_FEED_CHAPTER_PAGE_SIZE or 100)))
    max_batches = max(2, min(LATEST_FEED_MAX_BATCHES, page * 4 + 4))

    for _ in range(max_batches):
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
        )
        total = max(total, int(payload.get("total") or 0))
        chapters = payload.get("data") or []
        if not chapters:
            break

        for chapter in chapters:
            attributes = (chapter or {}).get("attributes") or {}
            if str(attributes.get("translatedLanguage") or "").strip().lower() != "vi":
                continue
            relations = _relation_bucket(chapter or {})
            manga_relations = relations.get("manga") or []
            if not manga_relations:
                continue
            manga_relation = manga_relations[0]
            manga_id = str(manga_relation.get("id") or "").strip()
            manga_attributes = manga_relation.get("attributes") or {}
            if not manga_id or not isinstance(manga_attributes, dict):
                continue
            if manga_id.lower() in normalized_excluded_ids:
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
                "chapter_with_groups": _build_chapter_with_groups(chapter_value, scanlation_groups),
                "publish_at": str(attributes.get("publishAt") or ""),
                "readable_at": str(attributes.get("readableAt") or ""),
                "created_at": str(attributes.get("createdAt") or ""),
                "updated_at": str(attributes.get("updatedAt") or ""),
                "translation_source": "mangadex",
                "translation_source_label": "MangaDex",
            }
            current = latest_by_manga.get(manga_id)
            if current is None or _is_preferred_latest_chapter(
                chapter_entry,
                current,
                manga_updated_at=str(mangas[manga_id].get("updated_at") or ""),
            ):
                latest_by_manga[manga_id] = chapter_entry
                chapter_time = _pick_chapter_time(
                    chapter_entry,
                    manga_updated_at=str(mangas[manga_id].get("updated_at") or ""),
                )
                if chapter_time:
                    mangas[manga_id]["local_last_published_at"] = chapter_time

        if len(mangas) >= target_unique:
            break
        offset += len(chapters)
        if len(chapters) < request_limit or (total and offset >= total):
            break

    ordered_manga_ids = list(mangas.keys())
    page_manga_ids = ordered_manga_ids[(page - 1) * limit : page * limit]

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
            latest,
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
        if latest.get("id") and item.get("chaptersLatest"):
            item["chaptersLatest"][0]["chapter_api_data"] = str(latest.get("id") or "")
            item["chaptersLatest"][0]["publish_at"] = str(latest.get("readable_at") or latest.get("publish_at") or latest_time)
            item["chaptersLatest"][0]["updated_at"] = str(latest.get("updated_at") or latest.get("readable_at") or latest.get("publish_at") or latest_time)
        items.append(item)

    result = {
        "data": {
            "items": items,
            "params": {
                "pagination": {
                    "totalItems": total,
                    "totalItemsPerPage": limit,
                    "currentPage": page,
                    "uniqueItemsInWindow": len(ordered_manga_ids),
                }
            },
        }
    }
    _cache_payload(cache_key, result, ttl=60)
    return result


async def get_total_vi_manga_count() -> int:
    cache_key = "mangadex:total-vi-manga"
    cached = cache.get(cache_key)
    if cached:
        try:
            return int(cached)
        except Exception:
            cache.delete(cache_key)
    payload = await _request_json(
        "/manga",
        {
            "availableTranslatedLanguage[]": "vi",
            "limit": 1,
            "offset": 0,
            "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
        },
    )
    total = int(payload.get("total", 0))
    cache.set(cache_key, str(total), ttl=TOTAL_COUNT_TTL)
    return total


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
) -> dict[str, Any]:
    normalized_keyword = str(keyword or "").strip()
    page = max(1, int(page))
    limit = max(1, min(100, int(limit)))
    normalized_language = str(translated_language or "vi").strip().lower()
    if normalized_language in {"", "all", "any"}:
        normalized_language = "all"
    should_attach_latest = bool(attach_latest) and normalized_language == "vi"
    offset = (page - 1) * limit
    normalized_sort = str(sort or "relevance").strip().lower()
    if normalized_sort not in {"relevance", "latest", "popular", "updated", "title"}:
        normalized_sort = "relevance"
    tag_ids = await _resolve_mangadex_tag_ids(included_tag_slugs)
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
    allow_empty_catalog_query = normalized_sort in {"latest", "popular", "updated", "title"}
    if not normalized_keyword and not tag_ids and not normalized_statuses and not allow_empty_catalog_query:
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
    cache_key = (
        f"mangadex:search:v2:{normalized_keyword.lower()}:{page}:{limit}:"
        f"lang={normalized_language}:latest={1 if should_attach_latest else 0}:"
        f"tags={','.join(tag_ids)}:tag_mode={normalized_tags_mode}:status={','.join(normalized_statuses)}:"
        f"orig_lang={','.join(normalized_original_languages)}:"
        f"sort={normalized_sort}:rating={','.join(normalized_content_ratings)}"
    )
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
        "limit": limit,
        "offset": offset,
        "contentRating[]": normalized_content_ratings,
    }
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
    if is_mangadex_tag:
        params["order[latestUploadedChapter]"] = "desc"
    elif normalized_sort == "latest":
        params["order[latestUploadedChapter]"] = "desc"
    elif normalized_sort == "updated":
        params["order[updatedAt]"] = "desc"
    elif normalized_sort == "popular":
        params["order[latestUploadedChapter]"] = "desc"
    elif normalized_sort == "title":
        params["order[title]"] = "asc"
    else:
        if normalized_keyword:
            params["title"] = normalized_keyword
            params["order[relevance]"] = "desc"
        else:
            params["order[latestUploadedChapter]"] = "desc"

    try:
        payload = await _request_json("/manga", params)
    except RuntimeError as error:
        if stale_payload is not None:
            logger.warning(
                "MangaDex search using stale cache for '%s' (page=%s, limit=%s): %s",
                normalized_keyword,
                page,
                limit,
                error,
            )
            return stale_payload
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
            },
            "error": str(error),
        }
    data = payload.get("data") or []
    total = int(payload.get("total", 0))
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
            [str(parsed.get("id") or "") for parsed in parsed_items]
        )
    items: list[dict[str, Any]] = []
    for parsed in parsed_items:
        manga_id = str(parsed.get("id") or "")
        default_latest = {
            "chapter_name": str(parsed.get("last_chapter") or ""),
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
    return result


async def get_manga_lookup(manga_id: str) -> dict[str, Any]:
    normalized_manga_id = str(manga_id or "").strip().lower()
    if not normalized_manga_id:
        return {"manga": None}

    cache_key = f"mangadex:lookup:{normalized_manga_id}"
    cached = cache.get(cache_key)
    if cached:
        try:
            return json.loads(cached)
        except Exception:
            cache.delete(cache_key)

    stale_payload = _load_json_cache_payload(f"{cache_key}:stale")

    try:
        manga_payload = await _request_json(
            f"/manga/{normalized_manga_id}",
            {"includes[]": ["author", "artist", "cover_art"]},
        )
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
        f"lang={normalized_language}:group={normalized_group_id or 'all'}"
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
                f"lang={normalized_language}:group={normalized_group_id or 'all'}:stale"
            )
            fallback_payload = _load_json_cache_payload(fallback_key)
            if isinstance(fallback_payload, dict) and isinstance(fallback_payload.get("manga"), dict):
                stale_payload = fallback_payload
                break

    if (
        not normalized_group_id
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

    person_cache: dict[str, dict[str, str]] = {}
    try:
        manga_payload = await _request_json(
            f"/manga/{manga_id}",
            {"includes[]": ["author", "artist", "cover_art"]},
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

    if not authors:
        authors = [await _safe_get_person_by_id(author_id, person_cache) for author_id in author_ids]
    if not artists:
        artists = [await _safe_get_person_by_id(artist_id, person_cache) for artist_id in artist_ids]
    manga = _parse_manga(
        attributes=attributes,
        manga_id=manga_id,
        authors=authors,
        artists=artists,
        cover_url=cover_url,
    )

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

    first_limit = step if max_chapters is None else min(step, max_chapters)
    first_data: list[dict[str, Any]] = []
    try:
        first_payload = await _request_json("/chapter", _chapter_params(limit=first_limit, offset=0))
        first_data = first_payload.get("data") or []
        total = int(first_payload.get("total", 0))
    except RuntimeError as error:
        if stale_payload is not None:
            logger.warning(
                "MangaDex detail chapters using stale cache for %s: %s",
                manga_id,
                error,
            )
            return stale_payload
        logger.warning("MangaDex detail chapters unavailable for %s: %s", manga_id, error)

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
                _request_json("/chapter", _chapter_params(limit=limit, offset=offset))
                for offset, limit in plan_batch
            ]
            payloads = await asyncio.gather(*tasks, return_exceptions=True)

            ordered = sorted(
                zip(plan_batch, payloads),
                key=lambda pair: pair[0][0],
            )
            for (offset, _limit), payload in ordered:
                if isinstance(payload, Exception):
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
    _cache_payload(cache_key, result, ttl=MANGA_DETAIL_TTL)
    return result


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
