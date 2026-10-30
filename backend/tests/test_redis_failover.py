import asyncio
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import fakeredis
import pytest
from fastapi import HTTPException
from redis.exceptions import ConnectionError, ResponseError, TimeoutError

from config import config
import redis_runtime as runtime
from fastapi_app.services.cache_service import _RedisCache
from fastapi_app.services.redis_failover import FailoverCache, PREFIX, RedisRecoveryMiddleware


@pytest.fixture
def stores(monkeypatch):
    monkeypatch.setattr(config, "REDIS_URL", "rediss://main.invalid:6379/0")
    monkeypatch.setattr(config, "REDIS_FALLBACK_URL", "rediss://standby.invalid:6379/0")
    monkeypatch.setattr(config, "REDIS_SECURITY_URL", "")
    main = fakeredis.FakeRedis(decode_responses=True)
    standby = fakeredis.FakeRedis(decode_responses=True)
    local = fakeredis.FakeRedis(decode_responses=True)
    factory = Mock(side_effect=lambda: _RedisCache(local))
    cache = FailoverCache(_RedisCache, factory, primary=main, standby=standby)
    return cache, main, standby, factory


def test_healthy_reads_and_batch_writes_never_contact_standby(stores, monkeypatch):
    cache, main, standby, local = stores
    contact = Mock(side_effect=AssertionError("standby must stay idle"))
    monkeypatch.setattr(standby, "execute_command", contact)
    cache.set_many({"title": "Title", "chapter": "10"}, ttl=120)
    assert cache.get_many(["chapter", "title", "chapter", "absent"]) == {
        "chapter": "10", "title": "Title", "absent": None}
    assert main.ttl(PREFIX + "title") > 0
    contact.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("error", [ConnectionError("private-host"), TimeoutError("private-host"),
    ResponseError("max requests limit exceeded. Limit: 500000")])
def test_first_failure_retries_cache_in_standby_and_stops_hitting_main(stores, monkeypatch, error, caplog):
    cache, main, standby, local = stores
    attempts = Mock(side_effect=error)
    monkeypatch.setattr(main, "execute_command", attempts)
    cache.set("title", "Fallback title", ttl=120)
    for _ in range(20):
        assert cache.get("title") == "Fallback title"
    assert attempts.call_count == 1
    assert not cache.recovery_due()
    assert "private-host" not in caplog.text
    assert "500000" not in caplog.text
    local.assert_not_called()


def test_programming_errors_do_not_silently_switch_stores(stores, monkeypatch):
    cache, main, standby, local = stores
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=ResponseError("WRONGTYPE")))
    with pytest.raises(ResponseError, match="WRONGTYPE"):
        cache.get("wrong")
    assert not list(standby.scan_iter())


def test_instances_share_outage_and_only_one_checks_main_per_interval(stores, monkeypatch):
    cache, main, standby, _ = stores
    other = FailoverCache(_RedisCache, Mock(), primary=main, standby=standby)
    failure = Mock(side_effect=ConnectionError("offline"))
    monkeypatch.setattr(main, "execute_command", failure)
    cache.set("title", "same standby", ttl=120)
    assert other.get("title") == "same standby"
    assert other._outage == cache._outage
    # Simulate many Vercel functions checking a failed main at the same time.
    before = failure.call_count
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda c: c.check_primary(), [cache, other] * 8))
    assert failure.call_count == before + 1


def test_recovery_proves_reads_and_writes_then_warms_fallback_and_preserves_security(stores, monkeypatch):
    cache, main, standby, _ = stores
    cache.set("title", "outdated", ttl=300)
    main.set("auth:credential:test", "nonce", ex=120)
    original = main.execute_command
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=TimeoutError("offline")))
    cache.set("title", "current", ttl=120)
    cache.set("other", "keep warm", ttl=120)
    monkeypatch.setattr(main, "execute_command", original)
    cache.check_primary()
    assert cache._mode == "primary"
    assert cache.get("title") == "current"
    assert cache.get("other") == "keep warm"
    assert main.get("auth:credential:test") == "nonce"
    assert 0 < main.ttl(PREFIX + "title") <= 120


def test_ping_success_cannot_trigger_failback_when_writes_fail(stores, monkeypatch):
    cache, main, standby, _ = stores
    original = main.execute_command
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=ConnectionError("offline")))
    cache.set("title", "current", ttl=120)
    monkeypatch.setattr(main, "execute_command", original)
    monkeypatch.setattr(main, "set", Mock(side_effect=ResponseError("max requests limit exceeded")))
    cache.check_primary()
    assert cache._mode == "fallback"
    assert cache.get("title") == "current"


def test_new_outage_does_not_resurrect_prior_standby_cache(stores, monkeypatch):
    cache, main, standby, _ = stores
    original = main.execute_command
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=ConnectionError("offline")))
    cache.set("title", "first outage", ttl=300)
    first = cache._outage
    monkeypatch.setattr(main, "execute_command", original)
    cache.check_primary()
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=ConnectionError("offline again")))
    assert cache.get("title") is None
    assert first != cache._outage


def test_both_down_use_only_public_local_cache(stores, monkeypatch):
    cache, main, standby, local = stores
    for client in (main, standby):
        monkeypatch.setattr(client, "execute_command", Mock(side_effect=ConnectionError("offline")))
    cache.set("title", "local", ttl=30)
    assert cache.get("title") == "local"
    assert local.call_count == 1


def test_fallback_namespace_invalidation_never_deletes_security(stores, monkeypatch):
    cache, main, standby, _ = stores
    monkeypatch.setattr(main, "execute_command", Mock(side_effect=ConnectionError("offline")))
    monkeypatch.setattr(main, "pipeline", Mock(side_effect=ConnectionError("offline")))
    cache.set_many({"book:one": "one", "book:two": "two", "cover:one": "cover"})
    standby.set("auth:credential:test", "nonce")
    cache.flush_patterns(["book:o*", "book:t*"])
    assert cache.get_many(["book:one", "book:two", "cover:one"]) == {
        "book:one": None, "book:two": None, "cover:one": "cover"}
    assert standby.get("auth:credential:test") == "nonce"


def test_normalize_aiven_scheme_preserves_tls_and_rejects_unsafe_uri_overrides(monkeypatch):
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", True)
    assert runtime.normalize_url("valkeys://user:secret@host.invalid:123/0") == "rediss://user:secret@host.invalid:123/0"
    assert runtime.normalize_url("rediss://host.invalid/0?ssl_cert_reqs=required") == "rediss://host.invalid/0"
    for uri in ["redis://host.invalid/0", "https://host.invalid", "rediss://host.invalid?ssl_cert_reqs=none",
                "rediss://host.invalid?socket_timeout=30", "rediss://host.invalid?retry_on_timeout=true"]:
        with pytest.raises(ValueError) as raised:
            runtime.normalize_url(uri)
        assert uri not in str(raised.value)


def test_client_has_no_implicit_retries_and_bounded_timeouts(monkeypatch):
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", True)
    client = runtime.client_for("valkeys://user:secret@host.invalid:123/0")
    options = client.connection_pool.connection_kwargs
    assert options["ssl_cert_reqs"] == "required"
    assert options["ssl_check_hostname"] is True
    assert options["socket_connect_timeout"] == 0.35
    assert options["socket_timeout"] == 0.5
    assert options["retry"]._retries == 0


def test_real_stalled_connection_is_bounded_and_later_readers_skip_it(stores, monkeypatch):
    cache, _, _, _ = stores
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", False)
    monkeypatch.setattr(config, "REDIS_CONNECT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(config, "REDIS_SOCKET_TIMEOUT_SECONDS", 0.05)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(1)
    release = threading.Event()
    connections = []
    def silent_server():
        try:
            conn, _ = listener.accept()
            connections.append(conn)
            release.wait(3)
            conn.close()
        except OSError:
            pass
    server = threading.Thread(target=silent_server, daemon=True)
    server.start()
    client = runtime.client_for(f"redis://127.0.0.1:{listener.getsockname()[1]}/0")
    cache._primary = client
    try:
        started = time.monotonic()
        cache.set("chapter", "readable", ttl=120)
        assert time.monotonic() - started < 1
        started = time.monotonic()
        for _ in range(50):
            assert cache.get("chapter") == "readable"
        assert time.monotonic() - started < 1
        assert len(connections) == 1
    finally:
        release.set()
        listener.close()
        server.join(timeout=2)
        client.close()


def test_security_atomic_commands_are_not_replayed_during_a_circuit_outage(monkeypatch):
    import redis
    client = runtime.FastRedis()
    send = Mock(side_effect=TimeoutError("uncertain atomic nonce consumption"))
    monkeypatch.setattr(redis.Redis, "execute_command", send)
    with pytest.raises(TimeoutError):
        client.eval("return 1", 0)
    with pytest.raises(ConnectionError):
        client.eval("return 1", 0)
    assert send.call_count == 1


def test_cutover_is_initialized_atomically_once_across_workers(stores, monkeypatch):
    _, main, _, _ = stores
    monkeypatch.setattr(runtime, "client_for", lambda url: main)
    runtime._cutover.cache_clear()
    first = runtime._cutover("rediss://cutover-test.invalid/0")
    runtime._cutover.cache_clear()
    assert runtime._cutover("rediss://cutover-test.invalid/0") == first
    assert first > 0
    runtime._cutover.cache_clear()


def test_real_flask_limiter_uses_shared_security_pool_and_still_rejects_excess(stores, monkeypatch):
    from flask import Flask
    from flask_limiter import Limiter
    _, main, standby, _ = stores
    monkeypatch.setattr(runtime, "security_client", lambda: main)
    app = Flask(__name__)
    limiter = Limiter(key_func=lambda: "test-client", storage_uri="mhredis://",
                      in_memory_fallback_enabled=False, swallow_errors=False)
    limiter.init_app(app)
    @app.get("/limited")
    @limiter.limit("1 per minute")
    def limited():
        return {"ok": True}
    client = app.test_client()
    assert client.get("/limited").status_code == 200
    assert client.get("/limited").status_code == 429
    assert limiter.storage.get_connection() is main
    assert not list(standby.scan_iter())


def test_public_cold_start_with_standby_does_not_require_security_network(monkeypatch):
    from security_runtime import ensure_security_redis_available
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", True)
    monkeypatch.setattr(config, "REDIS_URL", "valkeys://aiven.invalid:123/0")
    monkeypatch.setattr(config, "REDIS_SECURITY_URL", "")
    monkeypatch.setattr(config, "REDIS_FALLBACK_URL", "rediss://standby.invalid:123/0")
    network = Mock(side_effect=AssertionError("no network before a public request"))
    monkeypatch.setattr(runtime, "security_client", network)
    ensure_security_redis_available()
    network.assert_not_called()


def test_security_never_moves_to_standby_and_old_refresh_cannot_cross_cutover(monkeypatch):
    import jwt
    monkeypatch.setattr(config, "REDIS_URL", "valkeys://aiven.invalid:123/0")
    monkeypatch.setattr(config, "REDIS_SECURITY_URL", "")
    monkeypatch.setattr(config, "REDIS_FALLBACK_URL", "rediss://upstash.invalid:123/0")
    assert runtime.security_url() == "rediss://aiven.invalid:123/0"
    monkeypatch.setattr(runtime, "security_cutover", lambda: 100)
    def token(start, issued=200):
        return jwt.encode({"iat": issued, "amr": [{"method": "password", "timestamp": start},
                                                 {"method": "token_refresh", "timestamp": issued}]},
                          "test-key-only-not-a-production-secret", algorithm="HS256")
    with pytest.raises(HTTPException) as rejected:
        runtime.enforce_security_cutover(token(90))
    assert rejected.value.status_code == 401
    runtime.enforce_security_cutover(token(101))


def test_recovery_runs_only_after_final_response_body(stores, monkeypatch):
    from fastapi_app.services import cache_service
    from serverless_runtime import _request_tasks
    cache, *_ = stores
    monkeypatch.setattr(cache_service, "cache", cache)
    monkeypatch.setattr(cache, "recovery_due", lambda: True)
    events = []
    monkeypatch.setattr(cache, "check_primary", lambda: events.append("probe"))
    async def exercise():
        pending = set()
        token = _request_tasks.set(pending)
        try:
            async def app(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"chapter"})
            async def send(message):
                events.append(message["type"])
            await RedisRecoveryMiddleware(app)({"type": "http"}, None, send)
            assert events[:2] == ["http.response.start", "http.response.body"]
            await asyncio.gather(*pending)
        finally:
            _request_tasks.reset(token)
    asyncio.run(exercise())
    assert events == ["http.response.start", "http.response.body", "probe"]
