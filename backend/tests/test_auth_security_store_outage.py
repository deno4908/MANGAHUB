from unittest.mock import Mock

import pytest
from redis.exceptions import ConnectionError, ResponseError

from config import config
import flask_app
from flask_app.auth import routes


@pytest.mark.parametrize("failure,code", [
    (ResponseError("max requests limit exceeded. Limit: 500000, Usage: 500000. private-redis-detail"),
     "AUTH_REDIS_QUOTA_EXCEEDED"),
    (ConnectionError("private-redis-detail"), "AUTH_SECURITY_STORE_UNAVAILABLE"),
    (ResponseError("private-redis-detail"), "AUTH_SECURITY_STORE_UNAVAILABLE"),
])
def test_real_rate_limit_store_failure_rejects_before_oauth_without_leaking_details(monkeypatch, failure, code):
    monkeypatch.setattr(flask_app, "ensure_security_redis_available", lambda: None)
    monkeypatch.setattr(flask_app, "get_maintenance_state", lambda: {"enabled": False})
    monkeypatch.setattr(config, "FRONTEND_URL", "https://mangahub.art")
    monkeypatch.setattr(flask_app.limiter, "enabled", True)
    app = flask_app.create_app()
    app.config.update(TESTING=True, RATELIMIT_ENABLED=True)
    monkeypatch.setattr(flask_app.limiter, "_in_memory_fallback_enabled", False)
    monkeypatch.setattr(flask_app.limiter, "_storage_dead", False)
    start_oauth = Mock(side_effect=AssertionError("OAuth must not run without its rate limit"))
    monkeypatch.setattr(routes, "_start_oauth", start_oauth)
    storage_write = Mock(side_effect=failure)
    monkeypatch.setattr(flask_app.limiter.storage, "incr", storage_write)
    response = app.test_client().post("/auth/google", headers={
        "Origin": "https://mangahub.art", "X-MangaHub-CSRF": "1",
    })
    assert response.status_code == 503
    assert response.json["code"] == code
    assert "private-redis-detail" not in response.get_data(as_text=True)
    assert "no-store" in response.headers["Cache-Control"]
    assert response.headers["Access-Control-Allow-Origin"] == "https://mangahub.art"
    start_oauth.assert_not_called()
    assert storage_write.call_count == 1
    if code == "AUTH_REDIS_QUOTA_EXCEEDED":
        assert "Retry-After" not in response.headers
