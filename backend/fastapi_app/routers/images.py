"""
Image proxy - caches OTruyen CDN images locally for fast re-reads.
First request: fetches from CDN, saves to disk, returns with cache headers.
Subsequent requests: served directly from disk cache with ETag support (instant/304).
"""
import hashlib
import ipaddress
import os
import socket
import time
import httpx
import asyncio
import logging
import threading
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse
from typing import Any
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse

try:
    from curl_cffi.requests import Session as CurlSession
except Exception:  # pragma: no cover - keep proxy usable without curl_cffi
    CurlSession = None

logger = logging.getLogger(__name__)

router = APIRouter()

CACHE_DIR = Path(__file__).parent.parent.parent / ".image_cache"
CACHE_DIR.mkdir(exist_ok=True)

EXT_CONTENT_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_http_client: httpx.AsyncClient | None = None
_mangadex_http_client: httpx.AsyncClient | None = None
_curl_thread_local = threading.local()
_curl_session_lock = threading.RLock()
_image_cache_prune_lock = threading.Lock()
_image_cache_prune_running = False
_last_image_cache_prune_at = 0.0
_cache_fetch_locks: dict[str, asyncio.Lock] = {}
_cache_fetch_locks_guard = threading.Lock()

REQUEST_TIMEOUT_SECONDS = 25.0
REQUEST_CONNECT_TIMEOUT_SECONDS = 10.0
MAX_IMAGE_REDIRECTS = 3
HOST_VALIDATION_TTL_SECONDS = 300.0
IMAGE_FETCH_CHUNK_SIZE = 256 * 1024
ALLOWED_IMAGE_HOSTS = {
    "img.otruyenapi.com",
    "uploads.mangadex.org",
}
ALLOWED_IMAGE_HOST_SUFFIXES = (
    ".otruyencdn.com",
    ".mangadex.network",
)
_host_validation_cache: dict[str, tuple[float, str | None]] = {}
_host_validation_lock = threading.Lock()


def _env_int(name: str, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        value = max(minimum, int(raw))
        return min(value, maximum) if maximum is not None else value
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


MANGADEX_IMAGE_UPSTREAM_CONCURRENCY = _env_int(
    "MANGADEX_IMAGE_UPSTREAM_CONCURRENCY", 2, minimum=1
)
MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS = _env_float(
    "MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS", 1.0, minimum=0.1
)
MAX_CACHE_SIZE = _env_int("IMAGE_CACHE_MAX_MB", 350, minimum=64) * 1024 * 1024
IMAGE_CACHE_TARGET_SIZE = int(MAX_CACHE_SIZE * 0.85)
IMAGE_CACHE_PRUNE_COOLDOWN_SECONDS = _env_float(
    "IMAGE_CACHE_PRUNE_COOLDOWN_SECONDS", 30.0, minimum=1.0
)
MAX_IMAGE_BYTES = _env_int("IMAGE_PROXY_MAX_MB", 16, minimum=1) * 1024 * 1024
IMAGE_PROXY_CURL_WORKERS = _env_int("IMAGE_PROXY_CURL_WORKERS", 8, minimum=1, maximum=32)
MANGADEX_IMAGE_CACHE_VERSION = (
    str(os.getenv("MANGADEX_IMAGE_CACHE_VERSION", "2") or "2").strip() or "2"
)
_mangadex_image_semaphore = asyncio.Semaphore(MANGADEX_IMAGE_UPSTREAM_CONCURRENCY)
_curl_executor = ThreadPoolExecutor(max_workers=IMAGE_PROXY_CURL_WORKERS)


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=REQUEST_CONNECT_TIMEOUT_SECONDS),
            follow_redirects=False,
            http2=True,
            trust_env=False,
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "image/*,*/*;q=0.8",
                "Referer": "https://otruyenapi.com/",
            },
        )
    return _http_client


async def _get_mangadex_client() -> httpx.AsyncClient:
    global _mangadex_http_client
    if _mangadex_http_client is None or _mangadex_http_client.is_closed:
        _mangadex_http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=REQUEST_CONNECT_TIMEOUT_SECONDS),
            follow_redirects=False,
            # MangaDex cover CDN can reset HTTP/2 streams on unstable routes.
            # HTTP/1.1 is a bit less flashy, but much steadier for local proxying.
            http2=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "image/*,*/*;q=0.8",
                "Referer": "https://mangadex.org/",
                "Origin": "https://mangadex.org",
            },
        )
    return _mangadex_http_client


async def _reset_client(*, mangadex: bool = False) -> None:
    global _http_client, _mangadex_http_client
    client = _mangadex_http_client if mangadex else _http_client
    if client and not client.is_closed:
        try:
            await client.aclose()
        except Exception:
            pass
    if mangadex:
        _mangadex_http_client = None
    else:
        _http_client = None


def _get_curl_session() -> Any:
    if CurlSession is None:
        raise RuntimeError("curl_cffi not available")
    session = getattr(_curl_thread_local, "session", None)
    if session is None:
        session = CurlSession(
            impersonate="chrome131",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "image/*,*/*;q=0.8",
            },
        )
        _curl_thread_local.session = session
    return session


def _reset_curl_session() -> None:
    with _curl_session_lock:
        session = getattr(_curl_thread_local, "session", None)
        if session is not None:
            try:
                session.close()
            except Exception:
                pass
            try:
                delattr(_curl_thread_local, "session")
            except Exception:
                pass


def _cache_key(url: str) -> str:
    parsed = urlparse(url)
    host = _normalized_hostname(parsed.hostname)
    namespace = (
        f"mangadex-cover-v{MANGADEX_IMAGE_CACHE_VERSION}:"
        if host == "uploads.mangadex.org" or host.endswith(".mangadex.network")
        else ""
    )
    h = hashlib.md5(f"{namespace}{url}".encode()).hexdigest()
    ext = os.path.splitext(url.split("?")[0])[1] or ".jpg"
    return f"{h}{ext}"


def _cache_lock_for_key(key: str) -> asyncio.Lock:
    with _cache_fetch_locks_guard:
        lock = _cache_fetch_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _cache_fetch_locks[key] = lock
        return lock


def _is_usable_cache_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _remove_broken_cache_file(path: Path) -> None:
    try:
        if path.exists() and not _is_usable_cache_file(path):
            path.unlink()
    except OSError:
        pass


def _write_cache_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{time.time_ns()}.tmp"
    )
    try:
        with tmp_path.open("wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass


def _header_value(headers: Any, name: str) -> str:
    try:
        return str(headers.get(name) or "").strip()
    except Exception:
        return ""


def _content_length_exceeds_limit(headers: Any) -> bool:
    raw = _header_value(headers, "content-length")
    if not raw:
        return False
    try:
        return int(raw) > MAX_IMAGE_BYTES
    except Exception:
        return False


def _normalize_content_type(value: str | None) -> str:
    content_type = str(value or "").split(";", 1)[0].strip().lower()
    if content_type == "image/jpg":
        return "image/jpeg"
    return content_type


def _detect_image_content_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _validate_image_payload(data: bytes, declared_type: str | None) -> tuple[str | None, str]:
    if not data:
        return None, "Empty image response"

    detected_type = _detect_image_content_type(data)
    if not detected_type:
        return None, "Response is not a supported image"

    normalized_declared = _normalize_content_type(declared_type)
    if normalized_declared and not normalized_declared.startswith("image/"):
        return None, "Response Content-Type is not an image"
    if normalized_declared and normalized_declared != detected_type:
        return None, "Response Content-Type does not match image bytes"

    return detected_type, ""


async def _read_httpx_response_limited(response: httpx.Response) -> tuple[bytes | None, str | None, str]:
    if _content_length_exceeds_limit(response.headers):
        return None, None, f"Image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)}MB"

    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes(chunk_size=IMAGE_FETCH_CHUNK_SIZE):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_IMAGE_BYTES:
            return None, None, f"Image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)}MB"
        chunks.append(chunk)

    data = b"".join(chunks)
    detected_type, error = _validate_image_payload(data, response.headers.get("content-type"))
    if error:
        return None, None, error
    return data, detected_type, ""


def _read_curl_response_limited(response: Any) -> tuple[bytes | None, str | None, str]:
    if _content_length_exceeds_limit(getattr(response, "headers", None)):
        return None, None, f"Image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)}MB"

    chunks: list[bytes] = []
    total = 0
    iter_content = getattr(response, "iter_content", None)
    if not callable(iter_content):
        return None, None, "curl_cffi streaming is not available"

    try:
        try:
            iterator = iter_content(chunk_size=IMAGE_FETCH_CHUNK_SIZE)
        except TypeError:
            iterator = iter_content(IMAGE_FETCH_CHUNK_SIZE)

        for chunk in iterator:
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                return None, None, f"Image exceeds {MAX_IMAGE_BYTES // (1024 * 1024)}MB"
            chunks.append(chunk)
    except Exception as error:
        return None, None, f"curl_cffi read failed: {error}"

    data = b"".join(chunks)
    detected_type, error = _validate_image_payload(
        data,
        _header_value(getattr(response, "headers", None), "content-type"),
    )
    if error:
        return None, None, error
    return data, detected_type, ""


def _close_response(response: Any) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _prune_image_cache_sync() -> None:
    global _image_cache_prune_running
    try:
        cache_root = CACHE_DIR.resolve()
        files: list[tuple[int, int, Path]] = []
        total_size = 0

        for path in CACHE_DIR.iterdir():
            try:
                if not path.is_file():
                    continue
                resolved = path.resolve()
                if cache_root not in resolved.parents:
                    continue
                stat = path.stat()
            except OSError:
                continue
            size = int(stat.st_size)
            atime = int(getattr(stat, "st_atime_ns", 0) or stat.st_mtime_ns)
            total_size += size
            files.append((atime, size, path))

        if total_size <= MAX_CACHE_SIZE:
            return

        files.sort(key=lambda item: (item[0], item[2].name))
        deleted = 0
        target_size = max(0, IMAGE_CACHE_TARGET_SIZE)
        for _, size, path in files:
            if total_size <= target_size:
                break
            try:
                path.unlink()
                total_size -= size
                deleted += 1
            except OSError:
                continue

        if deleted:
            logger.info(
                "Image cache pruned %s files; cache is now %.1f MB",
                deleted,
                total_size / (1024 * 1024),
            )
    except Exception as exc:
        logger.debug("Image cache prune skipped: %s", exc)
    finally:
        with _image_cache_prune_lock:
            _image_cache_prune_running = False


def schedule_image_cache_prune(*, force: bool = False) -> None:
    global _image_cache_prune_running, _last_image_cache_prune_at
    now = time.time()
    with _image_cache_prune_lock:
        if _image_cache_prune_running:
            return
        if not force and now - _last_image_cache_prune_at < IMAGE_CACHE_PRUNE_COOLDOWN_SECONDS:
            return
        _image_cache_prune_running = True
        _last_image_cache_prune_at = now

    thread = threading.Thread(target=_prune_image_cache_sync, daemon=True)
    thread.start()


def _etag_for_file(path: Path) -> str:
    stat = path.stat()
    return f'"{hashlib.md5(f"{stat.st_size}-{stat.st_mtime_ns}".encode()).hexdigest()}"'


COMMON_HEADERS = {
    "Cache-Control": "public, max-age=2592000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Vary": "Accept-Encoding",
}


def _cached_image_response(
    cached_path: Path,
    request: Request,
    *,
    cache_status: str = "HIT",
) -> Response | None:
    if not cached_path.exists():
        return None
    if not _is_usable_cache_file(cached_path):
        _remove_broken_cache_file(cached_path)
        return None

    try:
        etag = _etag_for_file(cached_path)
    except OSError:
        return None

    if_none_match = request.headers.get("if-none-match")
    if if_none_match and if_none_match == etag:
        return Response(
            status_code=304,
            headers={**COMMON_HEADERS, "ETag": etag, "X-Cache": cache_status},
        )

    ext = cached_path.suffix
    ct = EXT_CONTENT_TYPE.get(ext, "image/jpeg")
    return FileResponse(
        cached_path,
        media_type=ct,
        headers={**COMMON_HEADERS, "ETag": etag, "X-Cache": cache_status},
    )


def _normalized_hostname(host: str | None) -> str:
    value = str(host or "").strip().strip(".").lower()
    if not value:
        return ""
    try:
        return value.encode("idna").decode("ascii")
    except Exception:
        return ""


def _is_allowed_image_host(host: str) -> bool:
    value = _normalized_hostname(host)
    return value in ALLOWED_IMAGE_HOSTS or any(
        value.endswith(suffix) for suffix in ALLOWED_IMAGE_HOST_SUFFIXES
    )


def _is_public_ip_address(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not any(
        (
            ip.is_private,
            ip.is_loopback,
            ip.is_link_local,
            ip.is_multicast,
            ip.is_reserved,
            ip.is_unspecified,
        )
    )


def _validate_host_dns_sync(host: str) -> str | None:
    value = _normalized_hostname(host)
    if not value:
        return "Missing image host"
    if not _is_allowed_image_host(value):
        return "Image host is not allowed"

    now = time.time()
    with _host_validation_lock:
        cached = _host_validation_cache.get(value)
        if cached and cached[0] > now:
            return cached[1]

    error: str | None = None
    try:
        addresses = socket.getaddrinfo(value, None, type=socket.SOCK_STREAM)
        resolved_ips = {row[4][0] for row in addresses if row and row[4]}
        if not resolved_ips:
            error = "Image host did not resolve"
        elif any(not _is_public_ip_address(ip) for ip in resolved_ips):
            error = "Image host resolved to a private address"
    except Exception:
        error = "Image host DNS validation failed"

    with _host_validation_lock:
        _host_validation_cache[value] = (now + HOST_VALIDATION_TTL_SECONDS, error)
    return error


def _validate_image_url_sync(url: str) -> str | None:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme.lower() != "https":
        return "Only HTTPS image URLs are allowed"
    host = _normalized_hostname(parsed.hostname)
    if not host:
        return "Missing image host"
    if parsed.username or parsed.password:
        return "Userinfo is not allowed in image URLs"
    if parsed.port not in (None, 443):
        return "Custom image ports are not allowed"
    if not parsed.path or parsed.path == "/":
        return "Image URL path is required"
    return _validate_host_dns_sync(host)


async def _validate_image_url(url: str) -> str | None:
    return await asyncio.to_thread(_validate_image_url_sync, url)


def _is_mangadex_host(host: str) -> bool:
    value = _normalized_hostname(host)
    return value.endswith(".mangadex.network") or value == "uploads.mangadex.org"


def _request_headers_for_url(url: str) -> dict[str, str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    base_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
    }
    if _is_mangadex_host(host):
        return {
            **base_headers,
            "Referer": "https://mangadex.org/",
            "Origin": "https://mangadex.org",
        }
    return {
        **base_headers,
        "Referer": "https://otruyenapi.com/",
    }


def _candidate_urls(url: str) -> list[str]:
    candidates = [url]
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    # MangaDex resized covers can intermittently return 404/502.
    # Fallback to original cover asset when size-variant URL fails.
    if _is_mangadex_host(host) and "/covers/" in url:
        match = re.search(r"\.(256|512)\.jpg$", url, flags=re.IGNORECASE)
        if match:
            original_url = url[: match.start()]
            if parsed.query:
                original_url = f"{original_url}?{parsed.query}"
            if original_url not in candidates:
                candidates.append(original_url)

            current_size = match.group(1)
            other_size = "256" if current_size == "512" else "512"
            other_resized = f"{url[:match.start()]}.{other_size}.jpg"
            if parsed.query:
                other_resized = f"{other_resized}?{parsed.query}"
            if other_resized not in candidates:
                candidates.append(other_resized)
    if _is_mangadex_host(host) and "/data-saver/" in url:
        candidates.append(url.replace("/data-saver/", "/data/", 1))
    return candidates


def _is_throttle_error(error_text: str) -> bool:
    text = str(error_text or "")
    return (
        "ENHANCE_YOUR_CALM" in text
        or "curl: (92)" in text
        or "HTTP 429" in text
        or " 429" in text
    )


def _transport_order(url: str) -> list[str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if _is_mangadex_host(host):
        if CurlSession is not None:
            return ["curl_cffi", "httpx"]
        return ["httpx"]
    if CurlSession is not None:
        return ["httpx", "curl_cffi"]
    return ["httpx"]


async def _fetch_once_httpx(url: str) -> tuple[bytes | None, str | None, str, bool]:
    current_url = url
    for redirect_count in range(MAX_IMAGE_REDIRECTS + 1):
        validation_error = await _validate_image_url(current_url)
        if validation_error:
            return None, None, validation_error, False

        parsed = urlparse(current_url)
        is_mangadex = _is_mangadex_host(parsed.hostname or "")
        client = await (_get_mangadex_client() if is_mangadex else _get_client())
        try:
            async with client.stream(
                "GET",
                current_url,
                headers=_request_headers_for_url(current_url),
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        return None, None, f"HTTP {response.status_code} without redirect target", False
                    if redirect_count >= MAX_IMAGE_REDIRECTS:
                        return None, None, "Too many image redirects", False
                    current_url = urljoin(current_url, location)
                    continue

                if response.status_code < 400:
                    data, content_type, read_error = await _read_httpx_response_limited(response)
                    if read_error:
                        return None, None, read_error, False
                    return data, content_type, "", False

                retryable = response.status_code in {403, 404, 408, 425, 429, 500, 502, 503, 504}
                if retryable:
                    await _reset_client(mangadex=is_mangadex)
                return None, None, f"HTTP {response.status_code}", retryable
        except httpx.HTTPError as error:
            await _reset_client(mangadex=is_mangadex)
            return None, None, f"{type(error).__name__}: {error}", True

    return None, None, "Too many image redirects", False


def _fetch_once_curl_sync(url: str) -> tuple[bytes | None, str | None, str, bool]:
    current_url = url
    for redirect_count in range(MAX_IMAGE_REDIRECTS + 1):
        validation_error = _validate_image_url_sync(current_url)
        if validation_error:
            return None, None, validation_error, False
        try:
            session = _get_curl_session()
            response = session.get(
                current_url,
                headers=_request_headers_for_url(current_url),
                timeout=REQUEST_TIMEOUT_SECONDS,
                allow_redirects=False,
                stream=True,
            )

            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    _close_response(response)
                    return None, None, f"HTTP {response.status_code} without redirect target", False
                if redirect_count >= MAX_IMAGE_REDIRECTS:
                    _close_response(response)
                    return None, None, "Too many image redirects", False
                current_url = urljoin(current_url, location)
                _close_response(response)
                continue

            if response.status_code < 400:
                data, content_type, read_error = _read_curl_response_limited(response)
                _close_response(response)
                if read_error:
                    return None, None, read_error, False
                return data, content_type, "", False

            retryable = response.status_code in {403, 404, 408, 425, 429, 500, 502, 503, 504}
            if retryable:
                _reset_curl_session()
            _close_response(response)
            return None, None, f"HTTP {response.status_code}", retryable
        except Exception as error:
            _reset_curl_session()
            return None, None, f"{type(error).__name__}: {error}", True

    return None, None, "Too many image redirects", False


async def _fetch_once_curl(url: str) -> tuple[bytes | None, str | None, str, bool]:
    if CurlSession is None:
        return None, None, "curl_cffi not available", False
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_curl_executor, _fetch_once_curl_sync, url)


async def _fetch_image(url: str, retry_hint: int = 0) -> tuple[bytes | None, str | None, str | None, str | None]:
    last_error = "CDN unavailable"
    attempts = 3 + max(0, min(retry_hint, 3))
    candidates = _candidate_urls(url)
    for candidate in candidates:
        candidate_host = (urlparse(candidate).hostname or "").lower()
        candidate_is_mangadex = _is_mangadex_host(candidate_host)
        for attempt in range(attempts):
            transports = _transport_order(candidate)
            retryable_failure = False
            saw_throttle_signal = False
            for transport in transports:
                if transport == "curl_cffi":
                    if candidate_is_mangadex:
                        async with _mangadex_image_semaphore:
                            data, content_type, error_text, retryable = await _fetch_once_curl(candidate)
                    else:
                        data, content_type, error_text, retryable = await _fetch_once_curl(candidate)
                else:
                    if candidate_is_mangadex:
                        async with _mangadex_image_semaphore:
                            data, content_type, error_text, retryable = await _fetch_once_httpx(candidate)
                    else:
                        data, content_type, error_text, retryable = await _fetch_once_httpx(candidate)

                if data is not None:
                    return data, candidate, content_type, transport

                retryable_failure = retryable_failure or retryable
                last_error = f"{transport}: {error_text}"
                if _is_throttle_error(error_text):
                    saw_throttle_signal = True

            if not retryable_failure:
                break
            if attempt < attempts - 1:
                retry_delay = 0.2 * (attempt + 1)
                if candidate_is_mangadex and saw_throttle_signal:
                    retry_delay = max(
                        retry_delay,
                        MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS * (attempt + 1),
                    )
                await asyncio.sleep(retry_delay)
    return None, last_error, None, None


@router.get("/img")
async def proxy_image(url: str, request: Request, retry: int = 0):
    """Proxy + cache an image from OTruyen CDN with ETag support."""
    validation_error = await _validate_image_url(url)
    if validation_error:
        return Response(status_code=400, content=validation_error)

    key = _cache_key(url)
    cached_path = CACHE_DIR / key

    force_refetch = retry > 0
    if not force_refetch:
        cached = _cached_image_response(cached_path, request)
        if cached is not None:
            return cached

    lock = _cache_lock_for_key(key)
    async with lock:
        if not force_refetch:
            cached = _cached_image_response(cached_path, request)
            if cached is not None:
                return cached
        data, fetch_info, content_type, transport = await _fetch_image(url, retry_hint=retry)
    if data is None:
        stale = _cached_image_response(cached_path, request, cache_status="STALE")
        if stale is not None:
            return stale
        logger.warning("Image fetch failed: %s - %s", url, fetch_info)
        parsed = urlparse(url)
        if _is_mangadex_host(parsed.hostname or ""):
            return Response(
                status_code=502,
                content="MangaDex image temporarily unavailable",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                    "X-Cache": "BYPASS",
                },
            )
        return Response(status_code=502, content="CDN unavailable")

    try:
        _write_cache_atomic(cached_path, data)
        schedule_image_cache_prune()
    except Exception as e:
        logger.warning(f"Cache write failed: {e}")

    etag = f'"{hashlib.md5(data).hexdigest()}"'
    ext = cached_path.suffix
    ct = content_type or EXT_CONTENT_TYPE.get(ext, "image/jpeg")
    return Response(
        content=data,
        media_type=ct,
        headers={
            **COMMON_HEADERS,
            "ETag": etag,
            "X-Cache": "MISS",
            "X-Upstream-Transport": transport or "unknown",
        },
    )


@router.get("/preload")
async def preload_images(urls: str):
    """Pre-warm cache for a batch of image URLs (comma-separated, max 10)."""
    url_list: list[str] = []
    for raw_url in [u.strip() for u in urls.split(",") if u.strip()][:10]:
        if await _validate_image_url(raw_url) is None:
            url_list.append(raw_url)
    if not url_list:
        return {"cached": 0}

    cached = 0

    async def fetch_one(url: str):
        nonlocal cached
        key = _cache_key(url)
        path = CACHE_DIR / key
        if path.exists():
            cached += 1
            return
        data, _, _, _ = await _fetch_image(url)
        if data is None:
            return
        try:
            _write_cache_atomic(path, data)
            cached += 1
        except Exception:
            pass

    await asyncio.gather(*[fetch_one(u) for u in url_list])
    if cached:
        schedule_image_cache_prune()
    return {"cached": cached, "total": len(url_list)}
