import asyncio
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import cloudflare_access as access

ISSUER = "https://access-tests.cloudflareaccess.com"
AUD = "private-application"


@pytest.fixture
def signing(monkeypatch):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setenv("CF_ACCESS_REQUIRED", "true")
    monkeypatch.setenv("CF_ACCESS_TEAM_DOMAIN", ISSUER)
    monkeypatch.setenv("CF_ACCESS_AUD", AUD)
    keys = jwt.PyJWKClient(ISSUER + "/cdn-cgi/access/certs")
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    jwk.update(kid="test-key", alg="RS256", use="sig")
    monkeypatch.setattr(keys, "fetch_data", lambda: {"keys": [jwk]})
    monkeypatch.setattr(access, "_key_client", lambda issuer: keys)

    def sign(changes=None, key=None, algorithm="RS256"):
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": [AUD], "iat": now - 1, "exp": now + 120,
                  "email": "member@example.test", **(changes or {})}
        return jwt.encode({k: v for k, v in claims.items() if v is not None},
                          key or private, algorithm=algorithm, headers={"kid": "test-key"})
    return sign


@pytest.fixture
def application():
    app = FastAPI()
    reached = []

    @app.api_route("/{path:path}", methods=["GET", "POST", "HEAD", "OPTIONS"])
    def private_route(path):
        reached.append(path)
        return JSONResponse({"private": "manga data"}, headers={"Cache-Control": "public, max-age=600"})

    app.add_middleware(access.CloudflareAccessMiddleware)
    return TestClient(app), reached


def test_disabled_without_config_preserves_existing_routes(monkeypatch, application):
    monkeypatch.delenv("CF_ACCESS_REQUIRED", raising=False)
    client, reached = application
    response = client.get("/api/site-access")
    assert response.status_code == 200
    assert response.json() == {"private": "manga data"}
    assert response.headers["Cache-Control"] == "public, max-age=600"
    assert reached == ["api/site-access"]


@pytest.mark.parametrize("path", ["/", "/health", "/auth/login", "/auth/health", "/api/site-access",
                                  "/api/images/img", "/api/manga/detail/test", "/robots.txt", "/internal/maintenance-tasks"])
def test_all_routes_require_access_even_with_spoofed_headers(signing, application, path):
    client, reached = application
    response = client.get(path, headers={"CF-Ray": "pretend", "Cf-Access-Authenticated-User-Email": "member@example.test",
                                         "Authorization": "Bearer app-token", "X-Forwarded-Host": "mangahub.art"})
    assert response.status_code == 403
    assert response.text == "Unavailable"
    assert "no-store" in response.headers["Cache-Control"]
    assert response.headers["Vercel-CDN-Cache-Control"] == "no-store"
    assert "noindex" in response.headers["X-Robots-Tag"]
    assert reached == []


def test_valid_signature_admits_requests_without_leaking_private_cache(signing, application):
    client, reached = application
    response = client.get("/auth/health", headers={"Cf-Access-Jwt-Assertion": signing()})
    assert response.status_code == 200
    assert response.json() == {"private": "manga data"}
    assert "private" in response.headers["Cache-Control"]
    assert "public" not in response.headers["Cache-Control"]
    assert response.headers["Cloudflare-CDN-Cache-Control"] == "no-store"
    assert reached == ["auth/health"]


@pytest.mark.parametrize("changes", [
    {"iss": "https://other.cloudflareaccess.com"}, {"aud": "other-app"}, {"exp": 100},
    {"iat": 9999999999}, {"nbf": 9999999999}, {"exp": None}, {"iat": None}, {"iss": None}, {"aud": None},
])
def test_invalid_claims_fail_closed(signing, application, changes):
    client, reached = application
    response = client.get("/health", headers={"Cf-Access-Jwt-Assertion": signing(changes)})
    assert response.status_code == 403
    assert response.text == "Unavailable"
    assert reached == []


def test_forged_signatures_and_algorithm_confusion_fail_closed(signing, application):
    client, reached = application
    fake_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    for token in [signing(key=fake_key), signing(key="untrusted", algorithm="HS256"), "e30.e30.", "malformed", "a" * 16385]:
        assert client.get("/health", headers={"Cf-Access-Jwt-Assertion": token}).status_code == 403
    assert reached == []


def test_preflight_head_and_duplicate_assertions_cannot_bypass_gate(signing, application):
    client, reached = application
    assert client.options("/auth/login", headers={"Origin": "https://mangahub.art"}).status_code == 403
    response = client.head("/health")
    assert response.status_code == 403
    assert response.content == b""
    token = signing()
    assert client.get("/health", headers=[("Cf-Access-Jwt-Assertion", token), ("Cf-Access-Jwt-Assertion", token)]).status_code == 403
    assert reached == []


@pytest.mark.parametrize("key,value", [
    ("CF_ACCESS_REQUIRED", "typo"), ("CF_ACCESS_AUD", ""),
    ("CF_ACCESS_TEAM_DOMAIN", "http://access-tests.cloudflareaccess.com"),
    ("CF_ACCESS_TEAM_DOMAIN", "access-tests.cloudflareaccess.com.evil.test"),
    ("CF_ACCESS_TEAM_DOMAIN", "access-tests.cloudflareaccess.com/private"),
    ("CF_ACCESS_TEAM_DOMAIN", "user@access-tests.cloudflareaccess.com"),
])
def test_incomplete_or_invalid_configuration_never_opens_site(signing, application, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    client, reached = application
    response = client.get("/health")
    assert response.status_code == 503
    assert response.text == "Unavailable"
    assert reached == []


def test_key_outage_never_exposes_content_or_provider_details(signing, application, monkeypatch):
    def unavailable(issuer):
        raise RuntimeError("private provider failure")
    monkeypatch.setattr(access, "_key_client", unavailable)
    client, reached = application
    response = client.get("/health", headers={"Cf-Access-Jwt-Assertion": signing()})
    assert response.status_code == 403
    assert response.text == "Unavailable"
    assert reached == []


def test_websocket_and_lifespan_are_handled_without_exposing_data(signing):
    called, events = [], []

    async def inner(scope, receive, send):
        called.append(scope["type"])

    async def send(event):
        events.append(event)

    gate = access.CloudflareAccessMiddleware(inner)
    asyncio.run(gate({"type": "websocket", "headers": []}, None, send))
    assert events == [{"type": "websocket.close", "code": 1008}]
    asyncio.run(gate({"type": "lifespan"}, None, send))
    assert called == ["lifespan"]


def test_combined_entrypoint_protects_fastapi_flask_and_cron(signing, monkeypatch):
    import importlib
    from config import config
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", False)
    monkeypatch.setattr(config, "IS_VERCEL", False)
    monkeypatch.delenv("CRON_SECRET", raising=False)
    deployment = importlib.import_module("app")
    deployment.auth_app.config["RATELIMIT_ENABLED"] = False
    client = TestClient(deployment.app)
    for path in ["/health", "/auth/health", "/internal/maintenance-tasks"]:
        denied = client.get(path)
        assert denied.status_code == 403
        assert denied.text == "Unavailable"
    headers = {"Cf-Access-Jwt-Assertion": signing()}
    assert client.get("/health", headers=headers).json()["service"] == "fastapi-api"
    assert client.get("/auth/health", headers=headers).json()["service"] == "flask-gateway"
    # Access approval does not replace the endpoint's own machine authorization.
    assert client.get("/internal/maintenance-tasks", headers=headers).status_code == 401


def test_jwks_cache_coalesces_reads_and_throttles_unknown_kids(monkeypatch):
    from unittest.mock import Mock
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="known", alg="RS256", use="sig")
    fetch = Mock(return_value={"keys": [public]})
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: fetch())
    clock = [1000.0]
    monkeypatch.setattr(access.time, "monotonic", lambda: clock[0])
    cache = access._AccessKeys(ISSUER)
    def token(kid):
        return jwt.encode({"sub": "test"}, key, algorithm="RS256", headers={"kid": kid})
    assert cache.get_signing_key_from_jwt(token("known")).key_id == "known"
    assert cache.get_signing_key_from_jwt(token("known")).key_id == "known"
    for i in range(10):
        with pytest.raises(jwt.InvalidTokenError):
            cache.get_signing_key_from_jwt(token("unknown" + str(i)))
    assert fetch.call_count == 1
    clock[0] += 31
    rotated = {**public, "kid": "rotated"}
    fetch.return_value = {"keys": [rotated]}
    assert cache.get_signing_key_from_jwt(token("rotated")).key_id == "rotated"
    assert fetch.call_count == 2
    clock[0] += 301
    fetch.side_effect = RuntimeError("provider offline")
    with pytest.raises(RuntimeError):
        cache.get_signing_key_from_jwt(token("rotated"))
    with pytest.raises(jwt.InvalidTokenError):
        cache.get_signing_key_from_jwt(token("rotated"))
    assert fetch.call_count == 3
