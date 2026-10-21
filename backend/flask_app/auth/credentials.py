"""JWE credential envelopes with short-lived, single-use, operation-bound nonces.

TLS is still required. Supabase remains the password verifier; JWE prevents
reusable password derivatives from appearing in request bodies or proxy logs.
"""
import hashlib
import base64
import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from threading import Lock

from jwcrypto import jwk, jwe
from config import config

PURPOSES = {"login", "register", "change-password", "reset-password"}
TTL_SECONDS = 120
_private_key = None
_key_lock = Lock()
_nonce_lock = Lock()
_nonces = {}


class CredentialError(ValueError):
    pass


def get_private_key():
    global _private_key
    with _key_lock:
        if _private_key is not None:
            return _private_key
        shared_key = os.getenv("AUTH_CREDENTIAL_PRIVATE_JWK", "").strip()
        if shared_key:
            key = jwk.JWK.from_json(shared_key)
            modulus = str(key.get("n") or "")
            bits = int.from_bytes(base64.urlsafe_b64decode(modulus + "=" * (-len(modulus) % 4)), "big").bit_length()
            if key.get("kty") != "RSA" or not key.has_private or bits < 3072:
                raise RuntimeError("Invalid authentication encryption key")
            _private_key = key
            return key
        if config.IS_VERCEL:
            raise RuntimeError("AUTH_CREDENTIAL_PRIVATE_JWK is required on Vercel")
        path = Path(os.getenv("AUTH_CREDENTIAL_KEY_FILE") or
                    Path(__file__).resolve().parents[2] / ".auth-credential-key.json")
        if not path.exists():
            # Publish a complete file atomically, including across Flask workers.
            key = jwk.JWK.generate(kty="RSA", size=3072)
            fd, temporary = tempfile.mkstemp(prefix=".auth-credential-", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(key.export_private())
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                os.unlink(temporary)
        _private_key = jwk.JWK.from_json(path.read_text(encoding="utf-8"))
        modulus = str(_private_key.get("n") or "")
        bits = int.from_bytes(base64.urlsafe_b64decode(modulus + "=" * (-len(modulus) % 4)), "big").bit_length()
        if _private_key.get("kty") != "RSA" or not _private_key.has_private or bits < 3072:
            _private_key = None
            raise RuntimeError("Invalid authentication encryption key")
        return _private_key


def _nonce_key(nonce):
    return "auth:credential:" + hashlib.sha256(nonce.encode()).hexdigest()


def _redis():
    # Reuse the configured shared, health-checked security Redis connection.
    from flask_app.auth.routes import _get_refresh_redis_client
    client = _get_refresh_redis_client()
    if client is None and config.SECURITY_REQUIRE_REDIS:
        raise RuntimeError("Credential replay protection requires Redis")
    return client


def _save_nonce(nonce, purpose):
    client = _redis()
    if client is not None:
        try:
            client.set(_nonce_key(nonce), purpose, ex=TTL_SECONDS, nx=True)
            return
        except Exception:
            if config.SECURITY_REQUIRE_REDIS:
                raise RuntimeError("Credential replay protection requires Redis") from None
    with _nonce_lock:
        now = time.monotonic()
        for key in list(_nonces):
            if _nonces[key][1] <= now:
                _nonces.pop(key, None)
        if len(_nonces) >= 1024:
            raise CredentialError("Có quá nhiều yêu cầu đăng nhập, vui lòng thử lại sau.")
        _nonces[_nonce_key(nonce)] = (purpose, now + TTL_SECONDS)


def _consume_nonce(nonce, purpose):
    client = _redis()
    if client is not None:
        try:
            # GETDEL semantics supported on Redis versions before GETDEL existed.
            value = client.eval("local v=redis.call('GET',KEYS[1]); redis.call('DEL',KEYS[1]); return v", 1, _nonce_key(nonce))
            return value == purpose
        except Exception:
            if config.SECURITY_REQUIRE_REDIS:
                raise RuntimeError("Credential replay protection requires Redis") from None
    with _nonce_lock:
        value = _nonces.pop(_nonce_key(nonce), None)
        return bool(value and value[0] == purpose and value[1] > time.monotonic())


def issue_challenge(purpose):
    if purpose not in PURPOSES:
        raise CredentialError("Thao tác xác thực không hợp lệ.")
    key = get_private_key()
    public_key = json.loads(key.export_public())
    public_key["kid"] = key.thumbprint()
    nonce = secrets.token_urlsafe(32)
    _save_nonce(nonce, purpose)
    return {"nonce": nonce, "public_key": public_key, "expires_in": TTL_SECONDS}


def open_credentials(body, purpose):
    if not isinstance(body, dict):
        raise CredentialError("Dữ liệu xác thực không hợp lệ.")
    token = body.get("credential")
    if not isinstance(token, str) or not 100 <= len(token) <= 16_384:
        raise CredentialError("Vui lòng tải lại trang để cập nhật bảo mật đăng nhập.")
    try:
        key = get_private_key()
        protected = token.split(".", 1)[0]
        header = json.loads(base64.urlsafe_b64decode(protected + "=" * (-len(protected) % 4)))
        if header != {"alg": "RSA-OAEP-256", "enc": "A256GCM", "kid": key.thumbprint()}:
            raise ValueError("Unexpected JWE headers")
        envelope = jwe.JWE(algs=["RSA-OAEP-256", "A256GCM"])
        envelope.deserialize(token, key=key)
        payload = json.loads(envelope.payload)
        nonce = payload.get("nonce")
        fields = payload.get("fields")
        if (payload.get("purpose") != purpose or not isinstance(nonce, str)
                or len(nonce) != 43 or not isinstance(fields, dict)):
            raise ValueError("Invalid envelope")
        if not _consume_nonce(nonce, purpose):
            raise ValueError("Expired or already used")
        if any(not isinstance(value, str) or len(value) > 4096 for value in fields.values()):
            raise ValueError("Invalid credential fields")
        for field in ("password", "current_password"):
            if field in fields and (not isinstance(fields[field], str) or len(fields[field]) > 1024):
                raise ValueError("Invalid password length/type")
        if not fields.get("password"):
            raise ValueError("Missing password")
        return fields
    except RuntimeError:
        raise
    except Exception:
        raise CredentialError("Phiên xác thực không hợp lệ hoặc đã dùng. Vui lòng thử lại.") from None


def derive_password(password, email):
    salt = f"MangaHub_v4_password_pbkdf2:{email.strip().lower()}".encode()
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600_000).hex()


def legacy_passwords(password):
    # Only the backend derives these during migration, never the browser payload.
    return [hashlib.pbkdf2_hmac("sha256", password.encode(), b"MangaHub_v3_password_pbkdf2", 310_000).hex(),
            hashlib.sha256(("MangaHub_v2_" + password).encode()).hexdigest()]


def password_strength_error(password):
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return "Mật khẩu mới phải từ 8 đến 128 ký tự."
    return None
