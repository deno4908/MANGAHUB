"""
Small in-process anti-spam helpers.

This is not a replacement for Cloudflare/Nginx/Redis rate limiting. It is a
backend safety layer that blocks obvious tool spam before expensive DB writes.
"""

from __future__ import annotations

import hashlib
import time
from collections import defaultdict, deque
from threading import Lock
from typing import Deque

from fastapi import HTTPException, Request

try:
    import redis  # type: ignore
except Exception:  # pragma: no cover - Redis is optional for local dev.
    redis = None

try:
    from config import config
except Exception:  # pragma: no cover
    config = None

_counter_lock = Lock()
_window_counters: dict[str, Deque[float]] = defaultdict(deque)
_counter_cleanup_every = 500
_counter_calls = 0
_recent_lock = Lock()
_recent_seen: dict[str, float] = {}
_redis_lock = Lock()
_redis_client = None
_redis_disabled_until = 0.0
_redis_error_count = 0
_REDIS_DISABLE_SECONDS = 30.0


def _clean_header_ip(value: str) -> str:
    return str(value or "").split(",", 1)[0].strip()


def get_client_ip(request: Request) -> str:
    headers = request.headers
    for header in ("cf-connecting-ip", "x-real-ip", "x-forwarded-for"):
        value = _clean_header_ip(headers.get(header, ""))
        if value:
            return value
    return request.client.host if request.client else "unknown"


def request_fingerprint(request: Request, user_id: str | None = None) -> str:
    if user_id:
        return f"user:{user_id}"
    ip = get_client_ip(request)
    ua = request.headers.get("user-agent", "")
    digest = hashlib.sha256(f"{ip}|{ua}".encode("utf-8")).hexdigest()[:24]
    return f"anon:{digest}"


def hash_value(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _rate_key(key: str) -> str:
    digest = hashlib.sha256(str(key or "").encode("utf-8")).hexdigest()
    return f"mb:rate:{digest}"


def _get_redis_client():
    global _redis_client, _redis_disabled_until
    if redis is None:
        return None
    if time.monotonic() < _redis_disabled_until:
        return None

    redis_url = str(getattr(config, "REDIS_URL", "") or "").strip()
    if not redis_url or redis_url.startswith("memory://"):
        return None

    if _redis_client is not None:
        return _redis_client

    with _redis_lock:
        if _redis_client is not None:
            return _redis_client
        try:
            _redis_client = redis.Redis.from_url(
                redis_url,
                socket_connect_timeout=0.2,
                socket_timeout=0.2,
                decode_responses=True,
            )
            _redis_client.ping()
        except Exception:
            _redis_client = None
            _redis_disabled_until = time.monotonic() + _REDIS_DISABLE_SECONDS
            return None
        return _redis_client


def _redis_fixed_window(key: str, limit: int, window_seconds: int) -> tuple[bool, int, int] | None:
    global _redis_disabled_until, _redis_error_count
    client = _get_redis_client()
    if client is None:
        return None

    redis_key = _rate_key(key)
    window = max(1, int(window_seconds))
    try:
        count = int(client.incr(redis_key))
        if count == 1:
            client.expire(redis_key, window)
            ttl = window
        else:
            ttl = int(client.ttl(redis_key))
            if ttl <= 0:
                client.expire(redis_key, window)
                ttl = window
        _redis_error_count = 0
        return count <= limit, count, max(1, ttl)
    except Exception:
        _redis_error_count += 1
        if _redis_error_count >= 3:
            _redis_disabled_until = time.monotonic() + _REDIS_DISABLE_SECONDS
        return None


def _cleanup_counters_locked(now: float) -> None:
    for key in list(_window_counters.keys()):
        bucket = _window_counters.get(key)
        if not bucket:
            _window_counters.pop(key, None)
            continue
        # Each bucket stores monotonic timestamps. Keep a generous max horizon so
        # arbitrary one-off spam keys cannot live forever.
        cutoff = now - 60 * 60
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if not bucket:
            _window_counters.pop(key, None)


def check_fixed_window(key: str, limit: int, window_seconds: int) -> tuple[bool, int, int]:
    redis_result = _redis_fixed_window(key, max(1, int(limit)), max(1, int(window_seconds)))
    if redis_result is not None:
        return redis_result

    global _counter_calls
    now = time.monotonic()
    cutoff = now - max(1, window_seconds)
    with _counter_lock:
        _counter_calls += 1
        if _counter_calls >= _counter_cleanup_every or len(_window_counters) > 10000:
            _counter_calls = 0
            _cleanup_counters_locked(now)

        bucket = _window_counters[key]
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            reset_after = max(1, int(bucket[0] + window_seconds - now))
            return False, len(bucket), reset_after
        bucket.append(now)
        return True, len(bucket), window_seconds


def check_recent_once(key: str, ttl_seconds: int, *, mark: bool = True) -> tuple[bool, int]:
    now = time.monotonic()
    ttl = max(1, ttl_seconds)
    with _recent_lock:
        if len(_recent_seen) > 10000:
            expired = [k for k, expiry in _recent_seen.items() if expiry <= now]
            for expired_key in expired:
                _recent_seen.pop(expired_key, None)

        expiry = _recent_seen.get(key, 0)
        if expiry > now:
            return False, max(1, int(expiry - now))
        if mark:
            _recent_seen[key] = now + ttl
        return True, ttl


def enforce_fixed_window(
    key: str,
    limit: int,
    window_seconds: int,
    *,
    detail: str,
) -> None:
    allowed, _, reset_after = check_fixed_window(key, limit, window_seconds)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"{detail}, thử lại sau {reset_after}s",
        )


def enforce_user_action_limit(
    action: str,
    user_id: str,
    *,
    limit: int,
    window_seconds: int,
    detail: str,
) -> None:
    enforce_fixed_window(
        f"{action}:user:{user_id}",
        limit,
        window_seconds,
        detail=detail,
    )
