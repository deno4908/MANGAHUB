from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest

from config import config
import flask_app
from flask_app.auth import routes


@pytest.fixture
def oauth_client(monkeypatch):
    monkeypatch.setattr(flask_app, "ensure_security_redis_available", lambda: None)
    monkeypatch.setattr(flask_app, "get_maintenance_state", lambda: {"enabled": False})
    monkeypatch.setattr(config, "FRONTEND_URL", "https://mangahub.art")
    monkeypatch.setattr(config, "SUPABASE_URL", "https://test.example")
    monkeypatch.setattr(config, "SUPABASE_KEY", jwt.encode(
        {"role": "anon", "iss": "supabase", "exp": 4102444800},
        "diagnostic-only-key-not-a-real-secret", algorithm="HS256",
    ))
    app = flask_app.create_app()
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    return app.test_client()


def start(client, provider="google"):
    return client.post(f"/auth/{provider}", headers={
        "Origin": "https://mangahub.art", "X-MangaHub-CSRF": "1",
    })


@pytest.mark.parametrize("provider", ["google", "discord"])
def test_real_sdk_builds_pkce_url_and_protected_cookie_without_network(oauth_client, monkeypatch, provider):
    def network_forbidden(*args, **kwargs):
        raise AssertionError("Starting OAuth must not contact the provider")

    monkeypatch.setattr("httpx.Client.send", network_forbidden)
    first = start(oauth_client, provider)
    assert first.status_code == 200
    first_url = first.json["url"]
    query = parse_qs(urlsplit(first_url).query)
    assert query["provider"] == [provider]
    assert query["redirect_to"] == ["https://mangahub.art/auth/callback"]
    assert query["code_challenge_method"] == ["s256"]
    assert query["code_challenge"]
    cookie = oauth_client.get_cookie("mh_oauth_code_verifier", path="/auth")
    assert cookie and cookie.http_only and cookie.secure and cookie.same_site == "Lax"
    assert cookie.value not in first.get_data(as_text=True)
    second = start(oauth_client, provider)
    assert second.status_code == 200
    assert parse_qs(urlsplit(second.json["url"]).query)["code_challenge"] != query["code_challenge"]
    assert "no-store" in first.headers["Cache-Control"]


@pytest.mark.parametrize("name", ["SUPABASE_KEY", "SUPABASE_URL"])
def test_missing_configuration_has_a_safe_code(oauth_client, monkeypatch, name):
    monkeypatch.setattr(config, name, "")
    response = start(oauth_client)
    assert response.status_code == 500
    assert response.json["code"] == "AUTH_PROVIDER_CONFIG_MISSING"
    assert "url" not in response.json


def test_actual_sdk_invalid_key_is_classified_without_exposing_it(oauth_client, monkeypatch):
    private_value = "private-invalid-api-key"
    monkeypatch.setattr(config, "SUPABASE_KEY", private_value)
    response = start(oauth_client)
    assert response.status_code == 500
    assert response.json["code"] == "AUTH_OAUTH_CLIENT_UNAVAILABLE"
    assert response.json["category"] == "SupabaseException"
    assert private_value not in response.get_data(as_text=True)


def test_provider_exception_is_redacted_after_the_response_filter(oauth_client, monkeypatch):
    def fail(*args, **kwargs):
        raise TypeError("private token=not-for-browser")

    monkeypatch.setattr(routes, "_get_sb", lambda: SimpleNamespace(
        auth=SimpleNamespace(sign_in_with_oauth=fail)))
    response = start(oauth_client)
    assert response.status_code == 500
    assert response.json["code"] == "AUTH_OAUTH_LINK_UNAVAILABLE"
    assert response.json["category"] == "TypeError"
    assert "not-for-browser" not in response.get_data(as_text=True)


def test_missing_verifier_never_returns_an_unprotected_login_link(oauth_client, monkeypatch):
    monkeypatch.setattr(routes, "_get_sb", lambda: SimpleNamespace(auth=SimpleNamespace(
        sign_in_with_oauth=lambda value: SimpleNamespace(url="https://test.example/auth/v1/authorize"))))
    response = start(oauth_client)
    assert response.status_code == 500
    assert response.json["code"] == "AUTH_OAUTH_VERIFIER_UNAVAILABLE"
    assert "url" not in response.json
    assert "mh_oauth_code_verifier" not in response.headers.get("Set-Cookie", "")
