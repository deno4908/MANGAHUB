"""
OTruyenAPI Service — wraps external API calls with caching.
Uses curl_cffi (sync in thread pool) with browser impersonation to bypass Cloudflare.
"""
import json
import hashlib
import asyncio
import logging
import threading
import time
import re
from concurrent.futures import ThreadPoolExecutor
from curl_cffi.requests import Session
from fastapi_app.services.cache_service import cache

logger = logging.getLogger(__name__)

# ─── Multiple API endpoints for failover ───
API_ENDPOINTS = [
    "https://otruyenapi.com/v1/api",
    "https://sv1.otruyencdn.com/v1/api",
]

CDN_ENDPOINTS = [
    "https://sv1.otruyencdn.com/v1/api",
    "https://otruyenapi.com/v1/api",
]

IMG_CDN = "https://img.otruyenapi.com"

# Cache TTLs (seconds)
TTL_HOME = 180           # 3 min
TTL_LIST = 180           # 3 min
TTL_CATEGORIES = 7200    # 2 hours
TTL_DETAIL = 600         # 10 min
TTL_SEARCH = 180         # 3 min
TTL_CHAPTER = 7200       # 2 hours
TTL_STALE = 86400        # 24 hours — stale fallback
STALE_REVALIDATE_DEADLINE_SECONDS = 10

# Thread pool for sync HTTP requests
_executor = ThreadPoolExecutor(max_workers=16)
REQUEST_TIMEOUT_SECONDS = 5
ENDPOINT_RETRIES = 2
COLD_FETCH_RETRIES = 3
COLD_FETCH_DEADLINE_SECONDS = 14

# Shared persistent session — keeps cookies + TLS state to avoid Cloudflare blocks
_session: Session | None = None
_session_lock = threading.Lock()
_inflight_refresh_tasks: dict[str, asyncio.Task] = {}
_inflight_refresh_lock = threading.Lock()
_inflight_remote_fetch_tasks: dict[str, asyncio.Task] = {}
_inflight_remote_fetch_lock = threading.Lock()

_MOJIBAKE_RE = re.compile(r"[ÃÂÄÅÆÐ]")
_MOJIBAKE_RE = re.compile(
    r"(?:\u00c3.|\u00c4.|\u00c6.|\u00e1[\u00ba\u00bb].)"
)
_BAD_DECODE_RE = re.compile(r"[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\u009f]")
_OTRUYEN_OBJECT_ID_RE = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)


def _mojibake_score(value: str) -> int:
    text = str(value or "")
    if not text:
        return 0
    return len(_MOJIBAKE_RE.findall(text))


def _decode_issue_score(value: str) -> int:
    text = str(value or "")
    if not text:
        return 0
    return _mojibake_score(text) + (len(_BAD_DECODE_RE.findall(text)) * 4)


def _repair_mojibake_text(value: str) -> str:
    text = str(value or "")
    if not text or _decode_issue_score(text) == 0:
        return text

    candidates = [text]
    for source_encoding in ("latin1", "cp1252"):
        try:
            fixed = text.encode(source_encoding).decode("utf-8")
            if fixed:
                candidates.append(fixed)
        except Exception:
            continue

    best = text
    best_score = _decode_issue_score(text)
    for candidate in candidates[1:]:
        score = _decode_issue_score(candidate)
        if score < best_score:
            best = candidate
            best_score = score

    return best


def _repair_payload_encoding(value):
    if isinstance(value, str):
        return _repair_mojibake_text(value)
    if isinstance(value, list):
        return [_repair_payload_encoding(item) for item in value]
    if isinstance(value, dict):
        return {key: _repair_payload_encoding(item) for key, item in value.items()}
    return value


def _payload_decode_issue_score(value) -> int:
    if isinstance(value, str):
        return _decode_issue_score(value)
    if isinstance(value, list):
        return sum(_payload_decode_issue_score(item) for item in value)
    if isinstance(value, dict):
        return sum(_payload_decode_issue_score(item) for item in value.values())
    return 0


def _parse_json_response(response) -> dict | None:
    raw = getattr(response, "content", b"") or b""
    payload = None

    if raw:
        for encoding in ("utf-8-sig", "utf-8"):
            try:
                payload = json.loads(raw.decode(encoding))
                break
            except Exception:
                payload = None

    if payload is None:
        try:
            payload = response.json()
        except Exception:
            return None

    repaired = _repair_payload_encoding(payload)
    if _payload_decode_issue_score(repaired) > 0:
        logger.debug("Discarding OTruyen payload with broken text encoding")
        return None
    return repaired


def _get_session() -> Session:
    """Get or create the shared curl_cffi session."""
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                _session = Session(impersonate="chrome131", verify=False)
    return _session


def _reset_session():
    """Force recreate session (e.g. after failures)."""
    global _session
    with _session_lock:
        if _session:
            try:
                _session.close()
            except Exception:
                pass
        _session = None


def _sync_fetch_url(url: str) -> dict | None:
    """Sync fetch using curl_cffi with Chrome impersonation (shared session)."""
    try:
        s = _get_session()
        response = s.get(
            url,
            headers={"accept": "application/json"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if response.status_code == 200:
            return _parse_json_response(response)
        logger.debug(f"Non-200: {url} — {response.status_code}")
        # If Cloudflare-blocked (403/503), reset session for next attempt
        if response.status_code in (403, 503):
            _reset_session()
        return None
    except Exception as e:
        logger.debug(f"Failed: {url} — {type(e).__name__}: {e}")
        _reset_session()
        return None


def _sync_fetch_with_failover(path: str, endpoints: list[str], retries: int) -> dict | None:
    for base in endpoints:
        url = f"{base}/{path}"
        for attempt in range(max(1, retries)):
            result = _sync_fetch_url(url)
            if result and result.get("status") != "error":
                return result
            _reset_session()
            if attempt < retries - 1:
                time.sleep(0.35 * (attempt + 1))
    return None


def _cache_payload(cache_key: str, data: dict, ttl: int):
    json_str = json.dumps(data, ensure_ascii=False)
    cache.set(cache_key, json_str, ttl)
    cache.set(f"{cache_key}:stale", json_str, TTL_STALE)
    if cache_key.startswith("otruyen:"):
        _cache_otruyen_id_aliases(data)


def _iter_otruyen_id_slug_pairs(value):
    if isinstance(value, dict):
        manga_id = str(value.get("_id") or "").strip().lower()
        slug = str(value.get("slug") or "").strip()
        if _OTRUYEN_OBJECT_ID_RE.fullmatch(manga_id) and slug:
            yield manga_id, slug
        for item in value.values():
            yield from _iter_otruyen_id_slug_pairs(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_otruyen_id_slug_pairs(item)


def _cache_otruyen_id_aliases(payload):
    try:
        seen: set[str] = set()
        for manga_id, slug in _iter_otruyen_id_slug_pairs(payload):
            if manga_id in seen:
                continue
            seen.add(manga_id)
            cache.set(f"otruyen:id:{manga_id}", slug, TTL_STALE)
    except Exception:
        pass


def _find_slug_for_otruyen_id(payload, manga_id: str) -> str | None:
    target = str(manga_id or "").strip().lower()
    if not _OTRUYEN_OBJECT_ID_RE.fullmatch(target):
        return None
    for found_id, slug in _iter_otruyen_id_slug_pairs(payload):
        if found_id == target:
            return slug
    return None


async def _fetch_from_remote(path: str, use_cdn: bool, retries: int, deadline: int) -> dict | None:
    endpoints = CDN_ENDPOINTS if use_cdn else API_ENDPOINTS
    loop = asyncio.get_running_loop()
    tasks = [
        loop.run_in_executor(_executor, _sync_fetch_with_failover, path, [base], retries)
        for base in endpoints
    ]
    try:
        for task in asyncio.as_completed(tasks, timeout=deadline):
            result = await task
            if result:
                return result
    except asyncio.TimeoutError:
        return None
    return None


async def _refresh_cache_in_background(path: str, cache_key: str, ttl: int, use_cdn: bool):
    data = await _fetch_singleflight_remote(
        cache_key=cache_key,
        path=path,
        use_cdn=use_cdn,
        retries=ENDPOINT_RETRIES,
        deadline=COLD_FETCH_DEADLINE_SECONDS,
    )
    if data:
        _cache_payload(cache_key, data, ttl)


def _schedule_background_refresh(path: str, cache_key: str, ttl: int, use_cdn: bool):
    with _inflight_refresh_lock:
        existing = _inflight_refresh_tasks.get(cache_key)
        if existing and not existing.done():
            return
        task = asyncio.create_task(_refresh_cache_in_background(path, cache_key, ttl, use_cdn))
        _inflight_refresh_tasks[cache_key] = task

        def _cleanup(done_task: asyncio.Task):
            with _inflight_refresh_lock:
                current = _inflight_refresh_tasks.get(cache_key)
                if current is done_task:
                    _inflight_refresh_tasks.pop(cache_key, None)

        task.add_done_callback(_cleanup)


async def _fetch_singleflight_remote(
    cache_key: str,
    path: str,
    use_cdn: bool,
    retries: int,
    deadline: int,
) -> dict | None:
    with _inflight_remote_fetch_lock:
        task = _inflight_remote_fetch_tasks.get(cache_key)
        if task is None or task.done():
            task = asyncio.create_task(
                _fetch_from_remote(
                    path=path,
                    use_cdn=use_cdn,
                    retries=retries,
                    deadline=deadline,
                )
            )
            _inflight_remote_fetch_tasks[cache_key] = task

            def _cleanup(done_task: asyncio.Task):
                with _inflight_remote_fetch_lock:
                    current = _inflight_remote_fetch_tasks.get(cache_key)
                    if current is done_task:
                        _inflight_remote_fetch_tasks.pop(cache_key, None)

            task.add_done_callback(_cleanup)

    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        logger.debug("Singleflight remote fetch cancelled for %s", cache_key)
        return None


async def _fetch(path: str, cache_key: str, ttl: int, use_cdn: bool = False):
    """
    Fetch from OTruyenAPI with:
    1. Cache check (fresh)
    2. Sync HTTP in thread pool (curl_cffi bypasses Cloudflare)
    3. Stale cache fallback if all endpoints fail
    """
    # 1. Try fresh cache
    cached = cache.get(cache_key)
    if cached:
        try:
            payload = json.loads(cached)
            repaired = _repair_payload_encoding(payload)
            if _payload_decode_issue_score(repaired) > 0:
                cache.delete(cache_key)
            elif repaired != payload:
                _cache_payload(cache_key, repaired, ttl)
                return repaired
            else:
                if cache_key.startswith("otruyen:"):
                    _cache_otruyen_id_aliases(payload)
                return payload
        except (json.JSONDecodeError, TypeError):
            cache.delete(cache_key)

    stale_data = None
    stale = cache.get(f"{cache_key}:stale")
    if stale:
        try:
            stale_payload = json.loads(stale)
            stale_data = _repair_payload_encoding(stale_payload)
            if _payload_decode_issue_score(stale_data) > 0:
                cache.delete(f"{cache_key}:stale")
                stale_data = None
            elif stale_data != stale_payload:
                cache.set(
                    f"{cache_key}:stale",
                    json.dumps(stale_data, ensure_ascii=False),
                    TTL_STALE,
                )
        except (json.JSONDecodeError, TypeError):
            cache.delete(f"{cache_key}:stale")
            stale_data = None

    if stale_data is not None:
        # Prefer fresh OTruyen data when upstream is merely slow; stale cache is
        # only the fallback after the fresh attempt has had enough time to finish.
        refreshed = await _fetch_singleflight_remote(
            cache_key=cache_key,
            path=path,
            use_cdn=use_cdn,
            retries=ENDPOINT_RETRIES,
            deadline=STALE_REVALIDATE_DEADLINE_SECONDS,
        )
        if refreshed:
            _cache_payload(cache_key, refreshed, ttl)
            return refreshed

        _schedule_background_refresh(path, cache_key, ttl, use_cdn)
        if cache_key.startswith("otruyen:"):
            _cache_otruyen_id_aliases(stale_data)
        return stale_data

    data = await _fetch_singleflight_remote(
        cache_key=cache_key,
        path=path,
        use_cdn=use_cdn,
        retries=COLD_FETCH_RETRIES,
        deadline=COLD_FETCH_DEADLINE_SECONDS,
    )

    if data:
        _cache_payload(cache_key, data, ttl)
        return data

    if stale_data is not None:
        logger.warning(f"Using stale cache for {cache_key}")
        if cache_key.startswith("otruyen:"):
            _cache_otruyen_id_aliases(stale_data)
        return stale_data

    logger.error(f"OTruyenAPI completely unavailable for path: {path}")
    return {
        "status": "error",
        "message": "OTruyenAPI đang bảo trì, vui lòng thử lại sau.",
    }


async def get_home():
    """Get homepage manga list."""
    return await _fetch("home", "otruyen:home", TTL_HOME)


async def get_list(list_type: str = "truyen-moi", page: int = 1):
    """Get manga list by type."""
    return await _fetch(
        f"danh-sach/{list_type}?page={page}",
        f"otruyen:list:{list_type}:{page}",
        TTL_LIST,
    )


async def get_categories():
    """Get all categories."""
    return await _fetch("the-loai", "otruyen:categories", TTL_CATEGORIES)


async def get_category_manga(slug: str, page: int = 1):
    """Get manga by category slug."""
    return await _fetch(
        f"the-loai/{slug}?page={page}",
        f"otruyen:category:{slug}:{page}",
        TTL_LIST,
    )


async def resolve_slug_from_id(manga_id: str) -> str | None:
    """Resolve an OTruyen Mongo ObjectId to its slug using aliases and hot lists."""
    normalized_id = str(manga_id or "").strip().lower()
    if not _OTRUYEN_OBJECT_ID_RE.fullmatch(normalized_id):
        return None

    cached_slug = cache.get(f"otruyen:id:{normalized_id}")
    if cached_slug:
        return str(cached_slug).strip() or None

    payloads = []
    try:
        payloads.append(await get_home())
    except Exception:
        pass

    list_jobs = []
    for list_type in ("truyen-moi", "dang-phat-hanh", "hoan-thanh"):
        for page in (1, 2, 3):
            list_jobs.append(get_list(list_type, page))
    if list_jobs:
        results = await asyncio.gather(*list_jobs, return_exceptions=True)
        payloads.extend([result for result in results if isinstance(result, dict)])

    for payload in payloads:
        slug = _find_slug_for_otruyen_id(payload, normalized_id)
        if slug:
            cache.set(f"otruyen:id:{normalized_id}", slug, TTL_STALE)
            return slug

    try:
        search_payload = await search_manga(normalized_id, page=1)
        slug = _find_slug_for_otruyen_id(search_payload, normalized_id)
        if slug:
            cache.set(f"otruyen:id:{normalized_id}", slug, TTL_STALE)
            return slug
    except Exception:
        pass

    return None


async def get_manga_detail(slug: str):
    """Get manga detail by slug."""
    return await _fetch(
        f"truyen-tranh/{slug}",
        f"otruyen:detail:{slug}",
        TTL_DETAIL,
    )


async def search_manga(keyword: str, page: int = 1):
    """Search manga by keyword."""
    page = max(1, int(page))
    key_hash = hashlib.md5(f"{keyword}:{page}".encode()).hexdigest()[:12]
    return await _fetch(
        f"tim-kiem?keyword={keyword}&page={page}",
        f"otruyen:search:{key_hash}",
        TTL_SEARCH,
    )


async def get_chapter(chapter_id: str):
    """Get chapter detail with pages (prefer CDN)."""
    return await _fetch(
        f"chapter/{chapter_id}",
        f"otruyen:chapter:{chapter_id}",
        TTL_CHAPTER,
        use_cdn=True,
    )


def get_image_url(path: str) -> str:
    """Build full CDN image URL from relative path."""
    if path.startswith("http"):
        return path
    return f"{IMG_CDN}/uploads/comics/{path}"


# ─── In-memory random pool (populated during warmup/refresh) ───
import random as _random

_random_pool: list[dict] = []


async def refresh_random_pool():
    """Refresh the in-memory pool of manga items for instant random picks."""
    global _random_pool
    import asyncio
    latest, ongoing = await asyncio.gather(
        get_list("truyen-moi", 1),
        get_list("dang-phat-hanh", 1),
    )
    items = []
    for src in [latest, ongoing]:
        if isinstance(src, dict) and src.get("status") != "error":
            items.extend(src.get("data", {}).get("items") or [])
    # Deduplicate by slug
    seen = set()
    unique = []
    for item in items:
        slug = (item or {}).get("slug")
        if slug and slug not in seen:
            seen.add(slug)
            unique.append(item)
    if unique:
        _random_pool = unique
        logger.info(f"Random pool refreshed: {len(unique)} manga")


def get_random_item() -> dict | None:
    """Pick a random manga from the in-memory pool — instant, no I/O."""
    if not _random_pool:
        return None
    return _random.choice(_random_pool)
