import concurrent.futures
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask
from jwcrypto import jwk, jwe

from config import config
from flask_app import limiter
from flask_app.auth import credentials as c, routes

PASSWORD = "a long private passphrase"
EMAIL = "reader@example.com"


@pytest.fixture
def secure(monkeypatch):
    key = jwk.JWK.generate(kty="RSA", size=2048)
    monkeypatch.setattr(c, "get_private_key", lambda: key)
    monkeypatch.setattr(c, "_redis", lambda: None)
    monkeypatch.setattr(c, "_nonces", {})
    return key


def seal(challenge, purpose="login", fields=None, **headers):
    public = jwk.JWK(**challenge["public_key"])
    payload = {"nonce": challenge["nonce"], "purpose": purpose,
               "fields": fields or {"email": EMAIL, "password": PASSWORD}}
    protected = {"alg": "RSA-OAEP-256", "enc": "A256GCM", "kid": public["kid"], **headers}
    token = jwe.JWE(json.dumps(payload).encode(), protected=json.dumps(protected))
    token.add_recipient(public)
    return {"credential": token.serialize(compact=True)}


def test_password_payload_is_random_encrypted_and_single_use(secure):
    challenge = c.issue_challenge("login")
    assert not any(field in challenge["public_key"] for field in ("d", "p", "q"))
    first = seal(challenge)
    second = seal(challenge)
    assert first != second
    assert PASSWORD not in json.dumps(first)
    assert c.open_credentials(first, "login")["password"] == PASSWORD
    with pytest.raises(c.CredentialError):
        c.open_credentials(first, "login")
    with pytest.raises(c.CredentialError):
        c.open_credentials(second, "login")  # a new encryption cannot reuse a nonce


def test_operation_binding_and_untrusted_headers_do_not_consume_nonce(secure):
    challenge = c.issue_challenge("login")
    with pytest.raises(c.CredentialError):
        c.open_credentials(seal(challenge), "reset-password")
    with pytest.raises(c.CredentialError):
        c.open_credentials(seal(challenge, zip="DEF"), "login")
    assert c.open_credentials(seal(challenge), "login")["email"] == EMAIL


def test_nonce_expiry_and_concurrent_replay(secure, monkeypatch):
    challenge = c.issue_challenge("login")
    token = seal(challenge)
    def attempt(_):
        try:
            c.open_credentials(token, "login")
            return True
        except c.CredentialError:
            return False
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        assert list(pool.map(attempt, range(2))).count(True) == 1
    challenge = c.issue_challenge("login")
    token = seal(challenge)
    monkeypatch.setattr(c.time, "monotonic", lambda: float("inf"))
    with pytest.raises(c.CredentialError):
        c.open_credentials(token, "login")


@pytest.mark.parametrize("body", [{"password": "a" * 64}, {"password": "mb4$pbkdf2-sha256$1$" + "a" * 64}, None, []])
def test_old_hash_payloads_cannot_bypass_encrypted_credentials(secure, body):
    with pytest.raises(c.CredentialError):
        c.open_credentials(body, "login")


def test_production_nonce_store_fails_closed(secure, monkeypatch):
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", True)
    broken = Mock()
    broken.set.side_effect = ConnectionError("offline")
    broken.eval.side_effect = ConnectionError("offline")
    monkeypatch.setattr(c, "_redis", lambda: broken)
    with pytest.raises(RuntimeError, match="requires Redis"):
        c.issue_challenge("login")
    with pytest.raises(RuntimeError, match="requires Redis"):
        c._consume_nonce("x" * 43, "login")
    assert not c._nonces


@pytest.fixture
def auth_client(secure, monkeypatch):
    app = Flask(__name__)
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    limiter.init_app(app)
    app.register_blueprint(routes.auth_bp, url_prefix="/auth")
    monkeypatch.setattr(routes, "_require_recaptcha", lambda data: (True, ""))
    admin = Mock()
    admin.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = SimpleNamespace(data={"id": "user", "is_banned": False})
    monkeypatch.setattr(routes, "_get_sb_admin", lambda: admin)
    monkeypatch.setattr(routes, "normalize_vip_profile", lambda value, db: value)
    return app.test_client(), admin


def post_login(client, fields=None):
    token = seal(c.issue_challenge("login"), fields=fields)
    return client.post("/auth/login", json=token, headers={"X-MangaHub-CSRF": "1"})


def session_result():
    return SimpleNamespace(user=SimpleNamespace(id="user", email=EMAIL), session=SimpleNamespace(
        access_token="access", refresh_token="refresh", expires_at=12345))


def test_current_login_uses_one_verifier_and_does_not_scan_auth_users(auth_client, monkeypatch):
    client, admin = auth_client
    provider = Mock()
    provider.auth.sign_in_with_password.return_value = session_result()
    monkeypatch.setattr(routes, "_get_sb", lambda: provider)
    old = Mock(side_effect=AssertionError("must not derive weak passwords"))
    monkeypatch.setattr(routes, "legacy_passwords", old)
    response = post_login(client)
    assert response.status_code == 200
    provider.auth.sign_in_with_password.assert_called_once_with({"email": EMAIL, "password": c.derive_password(PASSWORD, EMAIL)})
    admin.auth.admin.list_users.assert_not_called()
    assert "refresh_token" not in response.get_json()["session"]
    assert "HttpOnly" in response.headers["Set-Cookie"]


def test_existing_passwords_still_allow_login_after_new_password_policy_changes(auth_client, monkeypatch):
    client, _ = auth_client
    provider = Mock()
    provider.auth.sign_in_with_password.return_value = session_result()
    monkeypatch.setattr(routes, "_get_sb", lambda: provider)
    result = post_login(client, {"email": EMAIL, "password": "Password123!"})
    assert result.status_code == 200


def test_legacy_account_migrates_after_successful_verification(auth_client, monkeypatch):
    client, admin = auth_client
    provider = Mock()
    provider.auth.sign_in_with_password.side_effect = [ValueError("Invalid login credentials"), session_result()]
    monkeypatch.setattr(routes, "_get_sb", lambda: provider)
    assert post_login(client).status_code == 200
    assert provider.auth.sign_in_with_password.call_args_list[1].args[0]["password"] == c.legacy_passwords(PASSWORD)[0]
    admin.auth.admin.update_user_by_id.assert_called_once_with("user", {"password": c.derive_password(PASSWORD, EMAIL)})


def test_provider_outage_is_not_retried_with_weaker_passwords(auth_client, monkeypatch):
    client, _ = auth_client
    provider = Mock()
    provider.auth.sign_in_with_password.side_effect = TimeoutError("upstream timeout")
    monkeypatch.setattr(routes, "_get_sb", lambda: provider)
    response = post_login(client)
    assert response.status_code == 500
    assert "upstream timeout" not in response.get_data(as_text=True)
    assert provider.auth.sign_in_with_password.call_count == 1


def test_banned_login_revokes_new_session_without_returning_tokens(auth_client, monkeypatch):
    client, admin = auth_client
    admin.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {"is_banned": True}
    provider = Mock()
    provider.auth.sign_in_with_password.return_value = session_result()
    monkeypatch.setattr(routes, "_get_sb", lambda: provider)
    response = post_login(client)
    assert response.status_code == 403
    assert "session" not in response.get_json()
    admin.auth.admin.sign_out.assert_called_once_with("access", "local")


def test_new_password_policy_is_enforced_server_side():
    assert c.password_strength_error("weak")
    assert c.password_strength_error("x" * 7)
    assert c.password_strength_error("x" * 8)
    assert c.password_strength_error("x" * 14)
    assert c.password_strength_error("x" * 128)
    assert c.password_strength_error("😀" * 7)
    assert c.password_strength_error("😀" * 8)
    assert c.password_strength_error("x" * 129)
    assert c.password_strength_error(PASSWORD) is None


def test_password_policy_matches_shared_browser_fixtures():
    from pathlib import Path
    cases = json.loads((Path(__file__).resolve().parents[2] / "test-fixtures" / "password-policy.json").read_text(encoding="utf-8"))
    for case in cases:
        assert (c.password_strength_error(case["password"]) is None) == case["accepted"]


def test_password_reset_requires_recent_recovery_proof():
    import jwt
    import time
    def token(method, age, **claims):
        return jwt.encode({"email": EMAIL, "phone": "", "amr": [{"method": method, "timestamp": time.time() - age}], **claims}, "test-secret")
    assert routes._is_recent_recovery_session(token("recovery", 10))
    assert routes._is_recent_recovery_session(token("otp", 10))
    assert not routes._is_recent_recovery_session(token("password", 10))
    assert not routes._is_recent_recovery_session(token("oauth", 10))
    assert not routes._is_recent_recovery_session(token("token_refresh", 10))
    assert not routes._is_recent_recovery_session(token("totp", 10))
    assert not routes._is_recent_recovery_session(token("otp", 10, phone="+10000000000"))
    assert not routes._is_recent_recovery_session(token("otp", 10, email=""))
    assert not routes._is_recent_recovery_session(token("otp", 901))
    assert not routes._is_recent_recovery_session(token("otp", -60))
    assert not routes._is_recent_recovery_session(token("recovery", 901))
    assert not routes._is_recent_recovery_session("invalid")


def test_rotated_refresh_results_cannot_be_replayed_for_hours(monkeypatch):
    monkeypatch.setattr(routes, "_refresh_result_cache", {})
    redis = Mock()
    monkeypatch.setattr(routes, "_get_refresh_redis_client", lambda: redis)
    routes._remember_refresh_result("old-token-fingerprint", {"access_token": "secret"}, ttl_seconds=7200)
    key, ttl, _ = redis.setex.call_args.args
    assert ":v2:" in key  # do not reuse old two-hour entries after deployment
    assert 20 <= ttl <= 60
    assert routes._REFRESH_COOKIE_MAX_AGE_SECONDS <= 30 * 24 * 60 * 60
