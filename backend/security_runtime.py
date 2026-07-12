"""Production security dependencies that must fail closed."""

from __future__ import annotations

from config import config


def ensure_security_redis_available() -> None:
    if not bool(getattr(config, "SECURITY_REQUIRE_REDIS", False)):
        return

    redis_url = str(getattr(config, "REDIS_URL", "") or "").strip()
    if not redis_url or redis_url.startswith("memory://"):
        raise RuntimeError("Redis is required for production security rate limits")

    try:
        import redis

        client = redis.Redis.from_url(
            redis_url,
            socket_connect_timeout=1.0,
            socket_timeout=1.0,
            decode_responses=True,
        )
        client.ping()
        client.close()
    except Exception as exc:
        raise RuntimeError("Redis is required but unavailable") from exc
