"""Production security dependencies that must fail closed."""

from __future__ import annotations

from config import config


def ensure_security_redis_available() -> None:
    if not bool(getattr(config, "SECURITY_REQUIRE_REDIS", False)):
        return

    redis_url = str(getattr(config, "REDIS_SECURITY_URL", "") or config.REDIS_URL).strip()
    if not redis_url or redis_url.startswith("memory://"):
        raise RuntimeError("Redis is required for production security rate limits")

    try:
        from redis_runtime import security_client, security_cutover, security_url, normalize_url
        security_url()
        if config.REDIS_FALLBACK_URL:
            normalize_url(config.REDIS_URL)
            normalize_url(config.REDIS_FALLBACK_URL)
            # A main outage must not prevent a cold function serving public
            # content from standby. Security commands still fail closed at use.
            return
        # Keep the existing single-store startup connectivity check. Runtime
        # commands and recovery probes detect write/quota failures themselves.
        security_client().ping()
        security_cutover()
    except Exception as exc:
        raise RuntimeError("Redis is required but unavailable") from exc
