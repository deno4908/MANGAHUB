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
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from functools import partial
from pathlib import Path
from urllib.parse import urljoin, urlparse
from typing import Any
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse
from serverless_runtime import writable_path, create_task, IS_VERCEL

try:
    from PIL import Image, ImageStat
except Exception:  # pragma: no cover - Pillow is optional for proxy safety.
    Image = None
    ImageStat = None

try:
    from curl_cffi.requests import Session as CurlSession
except Exception:  # pragma: no cover - keep proxy usable without curl_cffi
    CurlSession = None

logger = logging.getLogger(__name__)

router = APIRouter()

CACHE_DIR = writable_path(".image_cache")
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
_checked_cache_files = OrderedDict()
_checked_cache_files_lock = threading.Lock()

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
_preferred_mangadex_transports: dict[str, tuple[str, float]] = {}


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
    "MANGADEX_IMAGE_UPSTREAM_CONCURRENCY", 3, minimum=1
)
MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS = _env_float(
    "MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS", 1.0, minimum=0.1
)
MAX_CACHE_SIZE = _env_int("IMAGE_CACHE_MAX_MB", 128, minimum=64) * 1024 * 1024
IMAGE_CACHE_TARGET_SIZE = int(MAX_CACHE_SIZE * 0.85)
IMAGE_CACHE_PRUNE_COOLDOWN_SECONDS = _env_float(
    "IMAGE_CACHE_PRUNE_COOLDOWN_SECONDS", 30.0, minimum=1.0
)
MAX_IMAGE_BYTES = _env_int("IMAGE_PROXY_MAX_MB", 16, minimum=1) * 1024 * 1024
IMAGE_PROXY_CURL_WORKERS = _env_int("IMAGE_PROXY_CURL_WORKERS", 8, minimum=1, maximum=32)
MANGADEX_IMAGE_CACHE_VERSION = (
    str(os.getenv("MANGADEX_IMAGE_CACHE_VERSION", "3") or "3").strip() or "3"
)
_mangadex_image_semaphore = asyncio.Semaphore(MANGADEX_IMAGE_UPSTREAM_CONCURRENCY)
_curl_executor = ThreadPoolExecutor(max_workers=IMAGE_PROXY_CURL_WORKERS)
_image_dns_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="image-dns")
_image_cache_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="image-cache")


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
                "User-Agent": "MangaHub/1.0 (MangaDex API client)",
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


def _cached_file_is_mangadex_placeholder(path: Path) -> bool:
    try:
        if path.suffix.lower() not in EXT_CONTENT_TYPE:
            return False
        stat = path.stat()
        size = stat.st_size
        if size <= 0 or size > 768 * 1024:
            return False
        key = (str(path), stat.st_mtime_ns, size)
        with _checked_cache_files_lock:
            if key in _checked_cache_files:
                return _checked_cache_files[key]
        result = _looks_like_mangadex_hotlink_placeholder(path.read_bytes())
        with _checked_cache_files_lock:
            _checked_cache_files[key] = result
            while len(_checked_cache_files) > 512:
                _checked_cache_files.popitem(last=False)
        return result
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


def _looks_like_mangadex_hotlink_placeholder(data: bytes) -> bool:
    if Image is None or ImageStat is None or not data:
        return False
    try:
        with Image.open(BytesIO(data)) as image:
            width, height = image.size
            if width < 120 or height < 120:
                return False

            sample = image.convert("RGB").resize((64, 64))
            stat = ImageStat.Stat(sample)
            mean = stat.mean
            extrema = stat.extrema

            pixels = list(sample.getdata())
            total = max(1, len(pixels))
            whiteish = sum(1 for r, g, b in pixels if r >= 235 and g >= 235 and b >= 235) / total
            very_dark = sum(1 for r, g, b in pixels if r <= 45 and g <= 45 and b <= 45) / total
            orange = sum(1 for r, g, b in pixels if r >= 180 and 70 <= g <= 170 and b <= 90) / total
            blue_gray = sum(1 for r, g, b in pixels if 35 <= r <= 120 and 45 <= g <= 130 and 65 <= b <= 160) / total
            channel_spread = max(mean) - min(mean)
            dynamic_range = max(high - low for low, high in extrema)

            # MangaDex's anti-hotlink placeholder is a mostly-white page with
            # small dark text plus the orange/blue MangaDex logo. Real covers
            # can be bright too, so require several signals together.
            return (
                whiteish >= 0.62
                and very_dark >= 0.015
                and orange >= 0.002
                and blue_gray >= 0.002
                and channel_spread <= 28
                and dynamic_range >= 120
            )
    except Exception:
        return False


def _validate_mangadex_image_payload(data: bytes, source_url: str) -> str:
    host = _normalized_hostname(urlparse(source_url).hostname)
    if not _is_mangadex_host(host):
        return ""
    if _looks_like_mangadex_hotlink_placeholder(data):
        return "MangaDex returned hotlink placeholder"
    return ""


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

    if IS_VERCEL:
        create_task(asyncio.to_thread(_prune_image_cache_sync))
    else:
        thread = threading.Thread(target=_prune_image_cache_sync, daemon=True)
        thread.start()


def _etag_for_file(path: Path) -> str:
    stat = path.stat()
    return f'"{hashlib.md5(f"{stat.st_size}-{stat.st_mtime_ns}".encode()).hexdigest()}"'


COMMON_HEADERS = {
    "Cache-Control": "public, max-age=2592000, immutable",
    "Vercel-CDN-Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
    "Access-Control-Allow-Origin": "*",
    "Vary": "Accept-Encoding",
}


def _is_usable_cached_image(cached_path: Path) -> bool:
    if not cached_path.exists():
        return False
    if not _is_usable_cache_file(cached_path):
        _remove_broken_cache_file(cached_path)
        return False
    if _cached_file_is_mangadex_placeholder(cached_path):
        try:
            cached_path.unlink()
        except OSError:
            pass
        return False
    return True


def _cached_image_response(
    cached_path: Path,
    request: Request,
    *,
    cache_status: str = "HIT",
) -> Response | None:
    if not _is_usable_cached_image(cached_path):
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


async def _read_cached_image_response(
    cached_path: Path, request: Request, *, cache_status: str = "HIT",
) -> Response | None:
    # Disk reads and Pillow decoding can take time on a small VPS. Reuse the
    # bounded image pool so they cannot pause authentication, OPTIONS or pages.
    return await asyncio.get_running_loop().run_in_executor(
        _image_cache_executor,
        partial(_cached_image_response, cached_path, request, cache_status=cache_status),
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


def _image_url_host(url: str) -> tuple[str, str | None]:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme.lower() != "https":
        return "", "Only HTTPS image URLs are allowed"
    host = _normalized_hostname(parsed.hostname)
    if not host:
        return "", "Missing image host"
    if parsed.username or parsed.password:
        return "", "Userinfo is not allowed in image URLs"
    if parsed.port not in (None, 443):
        return "", "Custom image ports are not allowed"
    if not parsed.path or parsed.path == "/":
        return "", "Image URL path is required"
    if not _is_allowed_image_host(host):
        return "", "Image host is not allowed"
    return host, None


def _validate_image_url_sync(url: str) -> str | None:
    host, error = _image_url_host(url)
    if error:
        return error
    return _validate_host_dns_sync(host)


async def _validate_image_url(url: str) -> str | None:
    host, error = _image_url_host(url)
    if error:
        return error
    # A new cover URL usually uses a host already checked by earlier covers.
    # Reuse exactly the existing DNS TTL, including negative results, without
    # queuing every image behind unrelated blocking catalog/database work.
    with _host_validation_lock:
        cached = _host_validation_cache.get(host)
    if cached and cached[0] > time.time():
        return cached[1]
    # Cold DNS remains off the event loop, bounded independently of catalogs.
    # URL, host allowlist and public-address checks still run for every read.
    return await asyncio.get_running_loop().run_in_executor(
        _image_dns_executor, _validate_host_dns_sync, host
    )


def _is_mangadex_host(host: str) -> bool:
    value = _normalized_hostname(host)
    return value.endswith(".mangadex.network") or value == "uploads.mangadex.org"


def _request_headers_for_url(url: str) -> dict[str, str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    base_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if _is_mangadex_host(host):
        # The CDN, like the API, can redirect browser-looking requests to an
        # interactive challenge. Both HTTPX and curl use this per-request identity.
        headers = {
            **base_headers,
            "User-Agent": "MangaHub/1.0 (MangaDex API client)",
            "Referer": "https://mangadex.org/",
        }
        match = re.search(r"/covers/([0-9a-f-]{36})/", parsed.path, flags=re.IGNORECASE)
        if match:
            headers["Referer"] = f"https://mangadex.org/title/{match.group(1)}"
        return headers
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
            preferred = _preferred_mangadex_transports.get(host)
            if preferred and preferred[0] == "httpx" and preferred[1] > time.monotonic():
                return ["httpx", "curl_cffi"]
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
                timeout=httpx.Timeout(5 if "/covers/" in current_url else 12, connect=3),
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
                    mangadex_payload_error = await asyncio.get_running_loop().run_in_executor(
                        _image_cache_executor, _validate_mangadex_image_payload, data or b"", current_url
                    )
                    if mangadex_payload_error:
                        await _reset_client(mangadex=is_mangadex)
                        return None, None, mangadex_payload_error, True
                    return data, content_type, "", False

                retryable = response.status_code in {403, 404, 408, 425, 429, 500, 502, 503, 504}
                # An HTTP error is a completed request, not a broken pool.
                # Closing the shared client here cancels unrelated page images
                # that are still downloading and makes the reader retry them.
                return None, None, f"HTTP {response.status_code}", retryable
        except httpx.HTTPError as error:
            # HTTPX discards the failed connection/request itself. Closing the
            # shared client also interrupts unrelated pages and turns one
            # timeout (including a pool wait) into a chapter-wide retry storm.
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
                timeout=5 if "/covers/" in current_url else 12,
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
                mangadex_payload_error = _validate_mangadex_image_payload(data or b"", current_url)
                if mangadex_payload_error:
                    _reset_curl_session()
                    return None, None, mangadex_payload_error, True
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


async def _fetch_mangadex_candidate(url):
    transports = _transport_order(url)
    async def fetch(transport):
        result = await (_fetch_once_curl(url) if transport == "curl_cffi" else _fetch_once_httpx(url))
        return (*result, transport)
    def successful(result):
        if result[0] is not None:
            host = (urlparse(url).hostname or "").lower()
            if len(_preferred_mangadex_transports) >= 32:
                _preferred_mangadex_transports.clear()
            _preferred_mangadex_transports[host] = (result[4], time.monotonic() + 300)
        return result
    tasks = [create_task(fetch(transports[0]))]
    try:
        done, _ = await asyncio.wait(tasks, timeout=0.35)
        if done:
            first = next(iter(done)).result()
            if first[0] is not None or _is_throttle_error(first[2]) or len(transports) == 1:
                return successful(first)
        if len(transports) > 1:
            tasks.append(create_task(fetch(transports[1])))
        remaining = set(tasks)
        last = (None, None, "CDN unavailable", False, transports[0])
        while remaining:
            done, remaining = await asyncio.wait(remaining, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                last = task.result()
                if last[0] is not None:
                    return successful(last)
        return last
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _fetch_image(url: str, retry_hint: int = 0) -> tuple[bytes | None, str | None, str | None, str | None]:
    last_error = "CDN unavailable"
    attempts = 1 if "/covers/" in url else 2
    candidates = _candidate_urls(url)
    for candidate in candidates:
        candidate_host = (urlparse(candidate).hostname or "").lower()
        candidate_is_mangadex = _is_mangadex_host(candidate_host)
        for attempt in range(attempts):
            if candidate_is_mangadex:
                async with _mangadex_image_semaphore:
                    data, content_type, error_text, retryable, transport = await _fetch_mangadex_candidate(candidate)
                if data is not None:
                    return data, candidate, content_type, transport
                last_error = f"{transport}: {error_text}"
                if not retryable:
                    break
                if _is_throttle_error(error_text):
                    await asyncio.sleep(MANGADEX_IMAGE_THROTTLE_BACKOFF_SECONDS)
                continue
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


def _log_slow_image(request, key, cache, started, *, lock_ms=0, fetch_ms=0, write_ms=0):
    access_ms = getattr(request.state, "api_access_ms", 0)
    maintenance_ms = getattr(request.state, "api_maintenance_ms", 0)
    endpoint_ms = (time.perf_counter() - started) * 1000
    if endpoint_ms + access_ms + maintenance_ms < 750:
        return
    # Private server log only: no reader identity, source URL, credentials or
    # origin routing markers. Passive measurements make no upstream requests.
    logger.warning("Image stage timing key=%s cache=%s access_ms=%.1f maintenance_ms=%.1f "
                   "endpoint_ms=%.1f lock_ms=%.1f fetch_ms=%.1f write_ms=%.1f",
                   key[:32], cache, access_ms, maintenance_ms, endpoint_ms, lock_ms, fetch_ms, write_ms)


@router.get("/img")
async def proxy_image(url: str, request: Request, retry: int = 0):
    """Proxy + cache an image from OTruyen CDN with ETag support."""
    started = time.perf_counter()
    lock_ms = fetch_ms = write_ms = 0
    validation_error = await _validate_image_url(url)
    if validation_error:
        return Response(status_code=400, content=validation_error)

    key = _cache_key(url)
    cached_path = CACHE_DIR / key

    # A frontend retry may arrive while another request has just finished
    # warming this cache entry. Always reuse a valid cached image instead of
    # forcing another slow upstream download merely because `retry` is set.
    cached = await _read_cached_image_response(cached_path, request)
    if cached is not None:
        _log_slow_image(request, key, "HIT", started)
        return cached

    lock = _cache_lock_for_key(key)
    stage_started = time.perf_counter()
    async with lock:
        lock_ms = (time.perf_counter() - stage_started) * 1000
        cached = await _read_cached_image_response(cached_path, request)
        if cached is not None:
            _log_slow_image(request, key, "HIT", started, lock_ms=lock_ms)
            return cached
        stage_started = time.perf_counter()
        data, fetch_info, content_type, transport = await _fetch_image(url, retry_hint=retry)
        fetch_ms = (time.perf_counter() - stage_started) * 1000
        if data is not None:
            stage_started = time.perf_counter()
            try:
                # CDN bytes are ready. Catalog work in the default executor
                # must not hold the reader's response behind unrelated jobs.
                await asyncio.get_running_loop().run_in_executor(
                    _image_cache_executor, _write_cache_atomic, cached_path, data
                )
                schedule_image_cache_prune()
            except OSError as error:
                logger.debug("Image cache write unavailable: %s", type(error).__name__)
            write_ms = (time.perf_counter() - stage_started) * 1000
    _log_slow_image(request, key, "MISS" if data is not None else "FAIL", started,
                    lock_ms=lock_ms, fetch_ms=fetch_ms, write_ms=write_ms)
    if data is None:
        stale = await _read_cached_image_response(cached_path, request, cache_status="STALE")
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

    etag = _etag_for_file(cached_path) if cached_path.exists() else f'"{hashlib.md5(data).hexdigest()}"'
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
        async with _cache_lock_for_key(key):
            if await asyncio.get_running_loop().run_in_executor(
                _image_cache_executor, _is_usable_cached_image, path
            ):
                cached += 1
                return
            data, _, _, _ = await _fetch_image(url)
            if data is None:
                return
            try:
                await asyncio.get_running_loop().run_in_executor(
                    _image_cache_executor, _write_cache_atomic, path, data
                )
                cached += 1
            except OSError:
                pass

    await asyncio.gather(*[fetch_one(u) for u in url_list])
    if cached:
        schedule_image_cache_prune()
    return {"cached": cached, "total": len(url_list)}
