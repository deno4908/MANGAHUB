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
from proxy_trust import resolve_client_ip

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


def get_client_ip(request: Request) -> str:
    peer_ip = request.client.host if request.client else ""
    return resolve_client_ip(peer_ip, request.headers)


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
    if redis is None:
        return None
    redis_url = str(getattr(config, "REDIS_SECURITY_URL", "") or config.REDIS_URL).strip()
    if not redis_url or redis_url.startswith("memory://"):
        return None
    from redis_runtime import security_client
    return security_client()


def _redis_fixed_window(key: str, limit: int, window_seconds: int) -> tuple[bool, int, int] | None:
    client = _get_redis_client()
    if client is None:
        return None

    redis_key = _rate_key(key)
    window = max(1, int(window_seconds))
    try:
        # One round trip and an atomic expiry, including after a connection loss.
        count, ttl = client.eval("""
            local n = redis.call('INCR', KEYS[1])
            local ttl = redis.call('TTL', KEYS[1])
            if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
            return {n, ttl}
        """, 1, redis_key, window)
        count, ttl = int(count), int(ttl)
        return count <= limit, count, max(1, ttl)
    except Exception:
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

    if bool(getattr(config, "SECURITY_REQUIRE_REDIS", False)):
        raise HTTPException(
            status_code=503,
            detail="Dịch vụ chống spam tạm thời không khả dụng",
        )

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
