"""Pooled Redis connections with bounded waits and no command replay.

Security state has one authority. A second Redis is a content-cache fallback,
never a second copy of nonces, revocations or authentication rate limits.
"""
from functools import lru_cache
from threading import Lock
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import redis
from redis.client import Pipeline
from redis.backoff import NoBackoff
from redis.retry import Retry
from config import config


def normalize_url(value):
    value = str(value or "").strip()
    try:
        parts = urlsplit(value)
        scheme = {"valkeys": "rediss", "valkey": "redis"}.get(parts.scheme, parts.scheme)
        if scheme not in {"redis", "rediss"} or not parts.hostname or parts.fragment:
            raise ValueError()
        # A connection URI must not silently override latency/retry policy.
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        for key, allowed in (("ssl_cert_reqs", {"required", "cert_required", "2"}),
                             ("ssl_check_hostname", {"true", "1"})):
            if key in query:
                if query.pop(key).lower() not in allowed:
                    raise ValueError()
        if any(key not in {"db", "ssl_ca_certs"} for key in query):
            raise ValueError()
        if config.SECURITY_REQUIRE_REDIS and scheme != "rediss":
            raise ValueError()
        return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), ""))
    except (ValueError, TypeError):
        raise ValueError("Invalid Redis connection configuration (TLS required in production)") from None


def security_url():
    # Default to the main Redis (Aiven). Never move security state on an outage.
    return normalize_url(getattr(config, "REDIS_SECURITY_URL", "") or config.REDIS_URL)


def availability_error(error):
    if isinstance(error, (redis.ConnectionError, redis.TimeoutError)):
        return True
    return isinstance(error, redis.ResponseError) and any(text in str(error).lower() for text in (
        "max requests limit exceeded", "maxmemory", "oom ", "readonly", "loading",
    ))


class FastRedis(redis.Redis):
    """Open a short local circuit after an outage; never replay an atomic write."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._failed_until = 0.0
        self._circuit_lock = Lock()

    def execute_command(self, *args, **kwargs):
        if time.monotonic() < self._failed_until:
            raise redis.ConnectionError("Redis temporarily unavailable")
        try:
            return super().execute_command(*args, **kwargs)
        except redis.RedisError as error:
            if availability_error(error):
                with self._circuit_lock:
                    self._failed_until = time.monotonic() + 2.0
            raise

    def pipeline(self, transaction=True, shard_hint=None):
        return FastPipeline(self, transaction, shard_hint)


class FastPipeline(Pipeline):
    def __init__(self, owner, transaction, shard_hint):
        super().__init__(owner.connection_pool, owner.response_callbacks, transaction, shard_hint)
        self.owner = owner

    def execute(self, raise_on_error=True):
        if time.monotonic() < self.owner._failed_until:
            raise redis.ConnectionError("Redis temporarily unavailable")
        try:
            return super().execute(raise_on_error=raise_on_error)
        except redis.RedisError as error:
            if availability_error(error):
                self.owner._failed_until = time.monotonic() + 2.0
            raise


@lru_cache(maxsize=6)
def _client(url, connect_timeout, socket_timeout):
    options = dict(decode_responses=True, socket_connect_timeout=connect_timeout,
                   socket_timeout=socket_timeout, socket_keepalive=True,
                   retry=Retry(NoBackoff(), 0), retry_on_timeout=False,
                   max_connections=32, health_check_interval=0)
    if url.startswith("rediss://"):
        options.update(ssl_cert_reqs="required", ssl_check_hostname=True)
    return FastRedis.from_url(url, **options)


def client_for(url):
    return _client(normalize_url(url), config.REDIS_CONNECT_TIMEOUT_SECONDS,
                   config.REDIS_SOCKET_TIMEOUT_SECONDS)


def security_client():
    return client_for(security_url())


# Register a limits backend so Flask-Limiter shares the same connection pool,
# timeout policy and circuit as API authentication. Lua scripts stay atomic.
from limits.storage import RedisStorage


class SecurityRedisStorage(RedisStorage):
    STORAGE_SCHEME = ["mhredis"]

    def __init__(self, uri, **options):
        super().__init__(security_url(), **options)
        self.storage.close()
        self.storage = security_client()
        self.initialize_storage(uri)


@lru_cache(maxsize=4)
def _cutover(url):
    # Changing stores loses the previous revocation ledger. Require a fresh
    # login once, rather than resurrecting any login revoked in the old store.
    return float(client_for(url).eval("""
        local t = redis.call('GET', KEYS[1])
        if not t then
            t = redis.call('TIME')[1]
            redis.call('SET', KEYS[1], t)
        end
        return t
    """, 1, "mh:security:store-cutover:v1"))


def security_cutover():
    return _cutover(security_url()) if config.REDIS_FALLBACK_URL else None


def enforce_security_cutover(token):
    if not config.REDIS_FALLBACK_URL:
        return
    from fastapi import HTTPException
    import jwt
    try:
        # Unverified claims can only reject here, never grant authentication.
        claims = jwt.decode(token, options={"verify_signature": False})
        starts = [float(item["timestamp"]) for item in claims.get("amr", [])
                  if isinstance(item, dict) and item.get("method") != "token_refresh"]
        import math
        started = min(starts) if starts else 0
        if not math.isfinite(started) or started <= security_cutover():
            raise ValueError()
    except (jwt.InvalidTokenError, TypeError, KeyError, ValueError):
        raise HTTPException(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.") from None
