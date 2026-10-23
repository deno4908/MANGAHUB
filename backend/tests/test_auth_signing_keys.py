import asyncio
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import URLError

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from fastapi.testclient import TestClient

from config import config
from fastapi_app import dependencies as auth
from fastapi_app.services import auth_claims as verification

ISSUER = "https://auth-test.example/auth/v1"
USER = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def keys(monkeypatch):
    private = ec.generate_private_key(ec.SECP256R1())
    public = jwt.algorithms.ECAlgorithm.to_jwk(private.public_key(), as_dict=True)
    public.update(kid="test-key", alg="ES256", use="sig")
    fetch = Mock(side_effect=lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [public]}).encode()))
    monkeypatch.setattr(config, "SUPABASE_URL", "https://auth-test.example")
    monkeypatch.setattr(jwt.jwks_client.urllib.request, "urlopen", fetch)
    verification._key_client.cache_clear()
    yield private, fetch
    verification._key_client.cache_clear()


def signed(private, *, headers=None, remove=None, **changes):
    claims = {"sub": USER, "email": "reader@example.com", "role": "authenticated",
              "aud": "authenticated", "iss": ISSUER, "iat": int(time.time()) - 10,
              "exp": int(time.time()) + 300}
    claims.update(changes)
    if remove:
        claims.pop(remove)
    return jwt.encode(claims, private, algorithm="ES256", headers=headers or {"kid": "test-key"})


def test_cached_public_keys_verify_parallel_tokens_without_repeated_auth_calls(keys):
    private, fetch = keys
    tokens = [signed(private, email=f"reader{n}@example.com") for n in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(pool.map(verification.verified_access_claims, tokens))
    assert all(item["sub"] == USER for item in claims)
    fetch.assert_called_once()
    assert fetch.call_args.args[0].full_url == ISSUER + "/.well-known/jwks.json"
    assert fetch.call_args.kwargs["timeout"] == 5


@pytest.mark.parametrize("changes", [
    {"exp": 1}, {"iat": 9999999999}, {"aud": "service_role"},
    {"iss": "https://attacker.example/auth/v1"}, {"role": "service_role"},
    {"sub": "not-a-user-id"},
])
def test_invalid_claims_never_authorize_a_user(keys, changes):
    private, _ = keys
    with pytest.raises(HTTPException) as error:
        verification.verified_access_claims(signed(private, **changes))
    assert error.value.status_code == 401


@pytest.mark.parametrize("remove", ["sub", "exp", "iat", "aud", "iss", "role"])
def test_required_identity_and_lifetime_claims_cannot_be_omitted(keys, remove):
    with pytest.raises(HTTPException) as error:
        verification.verified_access_claims(signed(keys[0], remove=remove))
    assert error.value.status_code == 401


def test_signature_and_key_identifier_must_match_project_keys(keys):
    private, _ = keys
    foreign = ec.generate_private_key(ec.SECP256R1())
    for token in [signed(foreign), signed(private, headers={"kid": "unknown"})]:
        with pytest.raises(HTTPException) as error:
            verification.verified_access_claims(token)
        assert error.value.status_code == 401


def test_header_key_urls_are_never_followed(keys):
    token = signed(keys[0], headers={"kid": "test-key", "jku": "https://attacker.example/keys"})
    assert verification.verified_access_claims(token)["sub"] == USER
    assert keys[1].call_args.args[0].full_url.startswith(ISSUER)


def test_legacy_symmetric_tokens_still_require_online_auth_verification(keys):
    token = jwt.encode({"sub": USER}, "untrusted-secret", algorithm="HS256")
    assert verification.verified_access_claims(token) is None
    keys[1].assert_not_called()


def test_key_discovery_failure_does_not_accept_unverified_claims(keys):
    keys[1].side_effect = URLError("connection unavailable")
    with pytest.raises(HTTPException) as error:
        verification.verified_access_claims(signed(keys[0]))
    assert error.value.status_code == 503
    assert error.value.headers["X-MangaHub-Auth-Stage"] == "signing-keys"
    assert USER not in str(error.value.detail)


@pytest.mark.parametrize("body", [b"<html>temporarily unavailable</html>", b'{"keys": [{"kty": "invalid"}]}'])
def test_broken_key_endpoint_is_an_outage_not_an_invalid_user_session(keys, body):
    keys[1].side_effect = lambda *args, **kwargs: io.BytesIO(body)
    with pytest.raises(HTTPException) as error:
        verification.verified_access_claims(signed(keys[0]))
    assert error.value.status_code == 503
    assert error.value.headers["X-MangaHub-Auth-Stage"] == "signing-keys"


def test_rotated_signing_key_is_discovered_without_redeploying(keys):
    private, fetch = keys
    verification.verified_access_claims(signed(private))
    rotated = ec.generate_private_key(ec.SECP256R1())
    public = jwt.algorithms.ECAlgorithm.to_jwk(rotated.public_key(), as_dict=True)
    public.update(kid="rotated", alg="ES256", use="sig")
    fetch.side_effect = lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [public]}).encode())
    assert verification.verified_access_claims(signed(rotated, headers={"kid": "rotated"}))["sub"] == USER
    assert fetch.call_count == 2
    # Removed keys are not cached individually beyond the refreshed key set.
    with pytest.raises(HTTPException) as error:
        verification.verified_access_claims(signed(private))
    assert error.value.status_code == 401


@pytest.fixture
def user_backend(keys, monkeypatch):
    provider = Mock(side_effect=AssertionError("asymmetric verification must not call get_user"))
    monkeypatch.setattr(auth, "_init_clients", lambda: None)
    monkeypatch.setattr(auth, "_supabase_admin", SimpleNamespace(auth=SimpleNamespace(get_user=provider)))
    monkeypatch.setattr(auth, "_auth_cache", {})
    monkeypatch.setattr(auth, "_profile_cache", {})
    profile = Mock(return_value={"role": "reader"})
    monkeypatch.setattr(auth, "_fetch_auth_profile", profile)
    return provider, profile


def test_verified_claims_do_not_replace_current_database_role(keys, user_backend):
    token = signed(keys[0], app_metadata={"role": "admin"})
    assert asyncio.run(auth.get_current_user("Bearer " + token))["role"] == "reader"
    user_backend[1].assert_called_once_with(USER)
    user_backend[0].assert_not_called()


def test_auth_cache_cannot_extend_a_signed_tokens_expiry(keys, user_backend):
    expires = time.time() + 1
    token = signed(keys[0], exp=expires)
    asyncio.run(auth.get_current_user("Bearer " + token))
    assert auth._auth_cache[token][0] == expires


@pytest.mark.parametrize("profile,status", [
    ({"role": "admin", "is_banned": True}, 403),
    ({"role": "reader", "session_revoked_at": "2099-01-01T00:00:00Z"}, 401),
    ({"role": "reader", "password_changed_at": "2099-01-01T00:00:00Z"}, 401),
])
def test_signed_tokens_still_obey_bans_and_session_cutoffs(keys, user_backend, profile, status):
    user_backend[1].return_value = profile
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_current_user("Bearer " + signed(keys[0])))
    assert error.value.status_code == status
    assert not auth._auth_cache


def test_database_outage_still_fails_closed_with_a_distinct_stage(keys, user_backend):
    user_backend[1].side_effect = OSError("private provider detail")
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_current_user("Bearer " + signed(keys[0])))
    assert error.value.status_code == 503
    assert error.value.headers["X-MangaHub-Auth-Stage"] == "profile"
    assert "private" not in error.value.detail
    assert not auth._auth_cache


def test_gateway_preserves_safe_auth_diagnostics(monkeypatch):
    from fastapi_app import main
    async def unavailable(*args, **kwargs):
        raise HTTPException(503, "unavailable", headers={"X-MangaHub-Auth-Stage": "profile", "Retry-After": "2"})
    monkeypatch.setattr(main, "authorize_api_request", unavailable)
    response = TestClient(main.app).get("/api/site-access", headers={"Authorization": "Bearer test"})
    assert response.status_code == 503
    assert response.headers["X-MangaHub-Auth-Stage"] == "profile"
    assert response.headers["Retry-After"] == "2"
    assert response.json()["code"] == "AUTH_PROFILE_UNAVAILABLE"
