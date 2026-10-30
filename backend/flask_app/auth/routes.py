"""
Authentication routes â€” Register, Login, Logout, Forgot Password, OTP.
Uses Supabase Auth under the hood.
"""
import re
import base64
import hashlib
import json
import jwt
import logging
import time
import access_tickets
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from threading import Lock
from flask import Blueprint, request, jsonify, g, make_response
from supabase import create_client
from config import config
from flask_app.auth.credentials import (CredentialError, issue_challenge, open_credentials,
    derive_password, legacy_passwords, password_strength_error)
from flask_app.middleware import clear_auth_cache, require_auth, get_current_user_id
from flask_app import limiter
from proxy_trust import resolve_client_ip
from vip_access import normalize_vip_profile

try:
    import redis  # type: ignore
except Exception:  # pragma: no cover - Redis is optional for local dev.
    redis = None

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger(__name__)

_supabase = None
_supabase_admin = None
_refresh_redis_client = None
_refresh_redis_disabled_until = 0.0
_refresh_singleflight_guard = Lock()
_refresh_singleflight_locks: dict[str, Lock] = {}
_refresh_result_cache: dict[str, tuple[float, dict]] = {}
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_SIGN_OUT_SCOPES = {"local", "global", "others"}
_REFRESH_COOKIE_NAME = "mh_refresh_token"
_OAUTH_VERIFIER_COOKIE_NAME = "mh_oauth_code_verifier"
_AUTH_CSRF_HEADER_NAME = "X-MangaHub-CSRF"
_AUTH_CSRF_HEADER_VALUE = "1"
_AUTH_INTERNAL_ERROR_MESSAGE = "Dịch vụ xác thực tạm thời không khả dụng. Vui lòng thử lại sau."
_REFRESH_COOKIE_MAX_AGE_SECONDS = min(30 * 24 * 60 * 60, max(
    60 * 60 * 24,
    int(getattr(config, "REFRESH_COOKIE_MAX_AGE_SECONDS", 60 * 60 * 24 * 30)),
))
_OAUTH_VERIFIER_COOKIE_MAX_AGE_SECONDS = 10 * 60
_REFRESH_SINGLEFLIGHT_TTL_SECONDS = 20
_REFRESH_SINGLEFLIGHT_LOCK_SECONDS = 25
_REFRESH_SINGLEFLIGHT_WAIT_SECONDS = 25
_REFRESH_ROTATION_GRACE_SECONDS = max(
    _REFRESH_SINGLEFLIGHT_TTL_SECONDS,
    min(60, int(getattr(config, "REFRESH_ROTATION_GRACE_SECONDS", 30))),
)
_EMAIL_VERIFY_TIMEOUT_MINUTES = max(1, int(getattr(config, "EMAIL_VERIFY_TIMEOUT_MINUTES", 15)))
_DEFAULT_USER_SETTINGS = {
    "reading_mode": "vertical",
    "page_direction": "ltr",
    "image_fit": "width",
    "image_loading": "preload",
    "auto_hide_toolbar": True,
    "show_page_number": True,
    "show_progress_bar": True,
    "auto_bookmark": True,
    "auto_follow": False,
    "notify_new_chapter": True,
    "notify_comment_reply": True,
    "notify_system": True,
    "notify_email": False,
    "profile_visibility": "public",
    "show_reading_history": True,
    "show_followed_manga": True,
    "show_comments": True,
    "show_mature_content": False,
    "silent_view_tracking": False,
}


def _build_default_settings(user_id: str) -> dict:
    payload = dict(_DEFAULT_USER_SETTINGS)
    payload["user_id"] = str(user_id or "").strip()
    return payload


def _build_fallback_profile(user_id: str) -> dict:
    current_user = getattr(g, "current_user", None)
    email = str(getattr(current_user, "email", "") or "")
    return {
        "id": user_id,
        "email": email,
        "username": "",
        "display_name": "",
        "avatar": "",
        "bio": "",
        "role": str(getattr(g, "current_role", "reader") or "reader"),
        "is_vip": False,
        "vip_expiry": None,
        "name_color": None,
        "name_font": None,
        "name_effect": None,
        "chapters_read": 0,
        "total_reading_time": 0,
        "comments_posted": 0,
        "reading_streak": 0,
        "created_at": None,
    }


def _refresh_cookie_secure() -> bool:
    return str(config.FRONTEND_URL or "").lower().startswith("https://")


def _refresh_cookie_samesite() -> str:
    return "Lax"


def _normalize_origin(value: str | None) -> str:
    try:
        parsed = urllib.parse.urlparse(str(value or "").strip())
    except Exception:
        return ""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _trusted_auth_origins() -> set[str]:
    origins = {_normalize_origin(config.FRONTEND_URL), _normalize_origin(request.host_url)}
    if getattr(config, "CORS_ALLOW_LOCALHOST", False):
        origins.update(
            {
                "http://localhost:5173",
                "http://localhost:8080",
                "http://localhost:3000",
            }
        )
    return {origin for origin in origins if origin}


def _auth_csrf_error():
    if request.headers.get(_AUTH_CSRF_HEADER_NAME, "") != _AUTH_CSRF_HEADER_VALUE:
        return jsonify({"error": "Yêu cầu xác thực không hợp lệ"}), 403

    trusted_origins = _trusted_auth_origins()
    origin = _normalize_origin(request.headers.get("Origin"))
    referer = _normalize_origin(request.headers.get("Referer"))
    presented_origin = origin or referer
    if presented_origin and presented_origin not in trusted_origins:
        logger.warning("Blocked auth request from untrusted origin: %s", presented_origin)
        return jsonify({"error": "Nguồn yêu cầu không được phép"}), 403
    return None


@auth_bp.before_request
def enforce_auth_csrf():
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return None
    return _auth_csrf_error()


def _log_auth_exception(context: str, error: Exception) -> None:
    # Provider exceptions can embed request data. Never log credential material.
    logger.error("%s (%s)", context, type(error).__name__)


def _auth_internal_error(context: str, error: Exception):
    _log_auth_exception(context, error)
    return jsonify({"error": _AUTH_INTERNAL_ERROR_MESSAGE}), 500


def _set_refresh_cookie(response, refresh_token: str):
    token = str(refresh_token or "").strip()
    if not token:
        return response
    response.set_cookie(
        _REFRESH_COOKIE_NAME,
        token,
        max_age=_REFRESH_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=_refresh_cookie_secure(),
        samesite=_refresh_cookie_samesite(),
        path="/auth",
    )
    return response


def _clear_refresh_cookie(response):
    response.delete_cookie(
        _REFRESH_COOKIE_NAME,
        path="/auth",
        secure=_refresh_cookie_secure(),
        samesite=_refresh_cookie_samesite(),
    )
    return response


def _set_oauth_verifier_cookie(response, code_verifier: str):
    verifier = str(code_verifier or "").strip()
    if not verifier:
        return response
    response.set_cookie(
        _OAUTH_VERIFIER_COOKIE_NAME,
        verifier,
        max_age=_OAUTH_VERIFIER_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=_refresh_cookie_secure(),
        samesite=_refresh_cookie_samesite(),
        path="/auth",
    )
    return response


def _clear_oauth_verifier_cookie(response):
    response.delete_cookie(
        _OAUTH_VERIFIER_COOKIE_NAME,
        path="/auth",
        secure=_refresh_cookie_secure(),
        samesite=_refresh_cookie_samesite(),
    )
    return response


def _json(
    payload: dict,
    status: int = 200,
    *,
    refresh_token: str = "",
    clear_refresh: bool = False,
    oauth_code_verifier: str = "",
    clear_oauth_verifier: bool = False,
):
    response = make_response(jsonify(payload), status)
    if refresh_token:
        _set_refresh_cookie(response, refresh_token)
    if clear_refresh:
        _clear_refresh_cookie(response)
    if oauth_code_verifier:
        _set_oauth_verifier_cookie(response, oauth_code_verifier)
    if clear_oauth_verifier:
        _clear_oauth_verifier_cookie(response)
    return response


def _get_oauth_code_verifier(sb_client) -> str:
    try:
        auth = getattr(sb_client, "auth", None)
        storage = getattr(auth, "_storage", None)
        storage_key = str(getattr(auth, "_storage_key", "") or "")
        if storage and storage_key:
            return str(storage.get_item(f"{storage_key}-code-verifier") or "").strip()
    except Exception:
        return ""
    return ""


def _refresh_token_cache_key(refresh_token: str) -> str:
    return hashlib.sha256(str(refresh_token or "").encode("utf-8")).hexdigest()


def _get_refresh_redis_client():
    global _refresh_redis_client, _refresh_redis_disabled_until
    if redis is None:
        return None
    if time.monotonic() < _refresh_redis_disabled_until:
        return None
    redis_url = str(getattr(config, "REDIS_URL", "") or "").strip()
    if not redis_url or redis_url.startswith("memory://"):
        return None
    if _refresh_redis_client is not None:
        return _refresh_redis_client
    try:
        _refresh_redis_client = redis.Redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=0.25,
            socket_timeout=0.75,
            health_check_interval=30,
        )
        _refresh_redis_client.ping()
        return _refresh_redis_client
    except Exception:
        _refresh_redis_client = None
        _refresh_redis_disabled_until = time.monotonic() + 30
        return None


def _prune_refresh_result_cache(now: float | None = None):
    now = time.monotonic() if now is None else now
    if len(_refresh_result_cache) <= 512:
        expired = [key for key, (expires_at, _) in _refresh_result_cache.items() if expires_at <= now]
    else:
        expired = list(_refresh_result_cache.keys())[: max(1, len(_refresh_result_cache) - 256)]
    for key in expired:
        _refresh_result_cache.pop(key, None)
        _refresh_singleflight_locks.pop(key, None)


def _remember_refresh_result(cache_key: str, payload: dict, ttl_seconds: int | None = None):
    if not payload.get("access_token"):
        return
    ttl = max(
        _REFRESH_SINGLEFLIGHT_TTL_SECONDS,
        min(60, int(ttl_seconds or _REFRESH_ROTATION_GRACE_SECONDS)),
    )
    now = time.monotonic()
    with _refresh_singleflight_guard:
        _refresh_result_cache[cache_key] = (
            now + ttl,
            dict(payload),
        )
        _prune_refresh_result_cache(now)

    client = _get_refresh_redis_client()
    if not client:
        return
    try:
        client.setex(
            f"mh:auth:refresh-result:v2:{cache_key}",
            ttl,
            json.dumps(payload, separators=(",", ":")),
        )
    except Exception:
        pass


def _load_cached_refresh_result(cache_key: str) -> dict | None:
    now = time.monotonic()
    with _refresh_singleflight_guard:
        cached = _refresh_result_cache.get(cache_key)
        if cached and cached[0] > now:
            return dict(cached[1])
        if cached:
            _refresh_result_cache.pop(cache_key, None)

    client = _get_refresh_redis_client()
    if not client:
        return None
    try:
        raw = client.get(f"mh:auth:refresh-result:v2:{cache_key}")
        if not raw:
            return None
        payload = json.loads(raw)
        if isinstance(payload, dict) and payload.get("access_token"):
            with _refresh_singleflight_guard:
                _refresh_result_cache[cache_key] = (
                    now + _REFRESH_SINGLEFLIGHT_TTL_SECONDS,
                    dict(payload),
                )
            return payload
    except Exception:
        return None
    return None


def _refresh_payload_is_fresh(payload: dict, buffer_seconds: int = 60) -> bool:
    try:
        expires_at = int(float(payload.get("expires_at") or 0))
    except Exception:
        expires_at = 0
    if not expires_at:
        token_payload = _decode_access_token_payload(str(payload.get("access_token") or ""))
        try:
            expires_at = int(float(token_payload.get("exp") or 0))
        except Exception:
            expires_at = 0
    if not expires_at:
        return True
    return expires_at - int(time.time()) > buffer_seconds


def _refresh_supabase_session(refresh_token: str) -> dict:
    result = _get_sb().auth.refresh_session(refresh_token)
    session = getattr(result, "session", None)
    if not session:
        raise RuntimeError("Refresh thất bại")
    payload = {
        "access_token": str(getattr(session, "access_token", "") or ""),
        "refresh_token": str(getattr(session, "refresh_token", "") or ""),
        "expires_at": getattr(session, "expires_at", None),
    }
    if not payload["access_token"]:
        raise RuntimeError("Refresh thất bại")
    return payload


def _get_refresh_singleflight_lock(cache_key: str) -> Lock:
    with _refresh_singleflight_guard:
        lock = _refresh_singleflight_locks.get(cache_key)
        if lock is None:
            lock = Lock()
            _refresh_singleflight_locks[cache_key] = lock
        return lock


def _acquire_redis_refresh_lock(cache_key: str) -> tuple[object | None, str, str]:
    client = _get_refresh_redis_client()
    if not client:
        return None, "", ""
    lock_key = f"mh:auth:refresh-lock:{cache_key}"
    owner = f"{time.time()}:{id(request)}"
    try:
        acquired = client.set(
            lock_key,
            owner,
            nx=True,
            ex=_REFRESH_SINGLEFLIGHT_LOCK_SECONDS,
        )
        if acquired:
            return client, lock_key, owner
    except Exception:
        return None, "", ""
    return client, lock_key, ""


def _release_redis_refresh_lock(client, lock_key: str, owner: str):
    if not client or not lock_key or not owner:
        return
    try:
        if client.get(lock_key) == owner:
            client.delete(lock_key)
    except Exception:
        pass


def _wait_for_cached_refresh_result(cache_key: str) -> dict | None:
    deadline = time.monotonic() + _REFRESH_SINGLEFLIGHT_WAIT_SECONDS
    while time.monotonic() < deadline:
        cached = _load_cached_refresh_result(cache_key)
        if cached:
            return cached
        time.sleep(0.12)
    return None


def _refresh_session_singleflight(refresh_token: str) -> dict:
    cache_key = _refresh_token_cache_key(refresh_token)
    cached = _load_cached_refresh_result(cache_key)
    if cached and _refresh_payload_is_fresh(cached):
        return cached

    lock = _get_refresh_singleflight_lock(cache_key)
    with lock:
        cached = _load_cached_refresh_result(cache_key)
        if cached and _refresh_payload_is_fresh(cached):
            return cached
        effective_refresh_token = str((cached or {}).get("refresh_token") or refresh_token).strip()

        redis_client, redis_lock_key, redis_lock_owner = _acquire_redis_refresh_lock(cache_key)
        if redis_client and not redis_lock_owner:
            cached = _wait_for_cached_refresh_result(cache_key)
            if cached and _refresh_payload_is_fresh(cached):
                return cached
            raise RuntimeError("Refresh đang được xử lý, vui lòng thử lại")

        try:
            payload = _refresh_supabase_session(effective_refresh_token)
            _remember_refresh_result(cache_key, payload)
            if effective_refresh_token and effective_refresh_token != refresh_token:
                _remember_refresh_result(_refresh_token_cache_key(effective_refresh_token), payload)
            return payload
        finally:
            _release_redis_refresh_lock(redis_client, redis_lock_key, redis_lock_owner)


def _client_ip() -> str:
    return resolve_client_ip(request.remote_addr, request.headers)


def _verify_recaptcha_token(token: str) -> tuple[bool, str]:
    secret = str(getattr(config, "RECAPTCHA_SECRET_KEY", "") or "").strip()
    required = bool(getattr(config, "RECAPTCHA_REQUIRED", False))

    if not secret:
        if required:
            return False, "reCAPTCHA chưa được cấu hình trên máy chủ"
        return True, ""

    response_token = str(token or "").strip()
    if not response_token:
        return False, "Vui lòng xác minh reCAPTCHA"

    payload = {
        "secret": secret,
        "response": response_token,
    }
    remote_ip = _client_ip()
    if remote_ip:
        payload["remoteip"] = remote_ip

    try:
        encoded = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(
            str(getattr(config, "RECAPTCHA_VERIFY_URL", "") or "https://www.google.com/recaptcha/api/siteverify"),
            data=encoded,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        timeout = max(1, int(getattr(config, "RECAPTCHA_TIMEOUT_SECONDS", 5) or 5))
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise ValueError("Invalid reCAPTCHA verification response")
    except Exception:
        return False, "Không thể xác minh reCAPTCHA, vui lòng thử lại"

    if result.get("success") is True:
        return True, ""

    error_codes = result.get("error-codes") or []
    if "timeout-or-duplicate" in error_codes:
        return False, "reCAPTCHA đã hết hạn, vui lòng xác minh lại"
    return False, "Xác minh reCAPTCHA thất bại"


def _require_recaptcha(data: dict):
    return _verify_recaptcha_token(
        data.get("recaptcha_token")
        or data.get("captcha_token")
        or data.get("g-recaptcha-response")
        or ""
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_sign_out_scope(value: str | None, default: str = "local") -> str:
    scope = str(value or default).strip().lower()
    return scope if scope in _SIGN_OUT_SCOPES else default


def _revoke_supabase_sessions(scope: str = "global") -> tuple[bool, str]:
    access_token = str(getattr(g, "access_token", "") or "").strip()
    if not access_token:
        return False, "missing access token"
    try:
        _get_sb_admin().auth.admin.sign_out(access_token, scope)
        return True, ""
    except Exception as error:
        return False, str(error)


def _mark_session_security_event(user_id: str, *, password_changed: bool = False) -> tuple[bool, str]:
    payload = {"session_revoked_at": _now_iso()}
    if password_changed:
        payload["password_changed_at"] = payload["session_revoked_at"]
    try:
        _get_sb_admin().table("profiles").update(payload).eq("id", user_id).execute()
        return True, ""
    except Exception as error:
        return False, str(error)


def _revoke_access_sessions(user_id, scope="local", *, check_session=True):
    # g.access_token was verified by require_auth or the logout verifier.
    who = access_tickets.identity(_decode_access_token_payload(getattr(g, "access_token", "")))
    if who and who["uid"] == str(user_id):
        access_tickets.revoke_sessions(who, scope, check_session=check_session)


def _decode_access_token_payload(token: str) -> dict:
    try:
        payload_part = str(token or "").split(".")[1]
        padded = payload_part + "=" * (-len(payload_part) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("utf-8"))
        payload = json.loads(decoded.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _token_issued_at(token: str):
    payload = _decode_access_token_payload(token)
    iat = payload.get("iat")
    if not iat:
        return None
    try:
        return datetime.fromtimestamp(float(iat), tz=timezone.utc)
    except Exception:
        return None


def _latest_session_cutoff(profile_data: dict):
    cutoffs = [
        _as_utc_datetime(profile_data.get("session_revoked_at")),
        _as_utc_datetime(profile_data.get("password_changed_at")),
    ]
    return max((dt for dt in cutoffs if dt is not None), default=None)


def _is_access_token_revoked(token: str, profile_data: dict) -> bool:
    issued_at = _token_issued_at(token)
    latest_cutoff = _latest_session_cutoff(profile_data)
    return bool(issued_at and latest_cutoff and issued_at <= latest_cutoff)


def _fetch_session_profile(user_id: str) -> dict:
    try:
        result = (
            _get_sb_admin()
            .table("profiles")
            .select("role, is_banned, session_revoked_at, password_changed_at")
            .eq("id", user_id)
            .single()
            .execute()
        )
        return result.data or {}
    except Exception:
        return {}


def _fetch_profile_and_settings(user_id: str) -> tuple[dict, dict]:
    sb = _get_sb_admin()
    profile_data = None
    settings_data = None

    try:
        profile = (
            sb.table("profiles")
            .select("*")
            .eq("id", user_id)
            .single()
            .execute()
        )
        profile_data = profile.data if profile and profile.data else None
    except Exception:
        profile_data = None

    try:
        settings = (
            sb.table("user_settings")
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        settings_data = settings.data if settings and settings.data else None
    except Exception:
        settings_data = None

    if settings_data is None:
        try:
            sb.table("user_settings").insert({"user_id": user_id}).execute()
            settings = (
                sb.table("user_settings")
                .select("*")
                .eq("user_id", user_id)
                .maybe_single()
                .execute()
            )
            settings_data = settings.data if settings and settings.data else None
        except Exception:
            settings_data = None

    if profile_data is None:
        profile_data = _build_fallback_profile(user_id)
    else:
        profile_data = normalize_vip_profile(profile_data, sb)
    if settings_data is None:
        settings_data = _build_default_settings(user_id)

    return profile_data, settings_data


def _load_logout_auth_from_bearer() -> bool:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False

    token = auth_header[7:].strip()
    if not token:
        return False

    g.access_token = token
    try:
        user_response = _get_sb_admin().auth.get_user(token)
        if user_response and user_response.user:
            g.current_user = user_response.user
            return True
    except Exception:
        pass
    return False


def _verify_current_password(email: str, password_hash: str) -> tuple[bool, str]:
    try:
        result = _get_sb().auth.sign_in_with_password({
            "email": email,
            "password": password_hash,
        })
        session = getattr(result, "session", None)
        access_token = str(getattr(session, "access_token", "") or "")
        if access_token:
            try:
                _get_sb_admin().auth.admin.sign_out(access_token, "local")
            except Exception:
                pass
        if result and result.user and result.session:
            return True, ""
        return False, "Mật khẩu hiện tại không đúng"
    except Exception:
        return False, "Mật khẩu hiện tại không đúng"


def _verify_current_password_any(email: str, password_hashes: list[str]) -> tuple[bool, str, str]:
    last_error = "Mật khẩu hiện tại không đúng"
    for password_hash in password_hashes:
        verified, error = _verify_current_password(email, password_hash)
        if verified:
            return True, "", password_hash
        last_error = error or last_error
    return False, last_error, ""


def _normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def _is_valid_email(value: str) -> bool:
    return bool(_EMAIL_RE.fullmatch(str(value or "").strip()))


def _validate_username(username: str) -> str | None:
    value = str(username or "").strip()
    if not value:
        return "Username là bắt buộc"
    if len(value) > 50:
        return "Username tối đa 50 ký tự"
    return None


def _get_sb():
    # Supabase/Gotrue auth clients keep the last session in memory after
    # sign-in/refresh. Reusing one anon client across users can make refresh
    # tokens bleed between requests, so auth flows must get an isolated client.
    client = getattr(g, "_supabase_auth_client", None)
    if client is None:
        client = create_client(config.SUPABASE_URL, config.SUPABASE_KEY)
        g._supabase_auth_client = client
    return client


def _get_sb_admin():
    global _supabase_admin
    if _supabase_admin is None:
        _supabase_admin = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    return _supabase_admin


def _iter_admin_users() -> list:
    users = _get_sb_admin().auth.admin.list_users()
    if isinstance(users, list):
        return users
    nested_users = getattr(users, "users", None)
    return nested_users if isinstance(nested_users, list) else []


def _as_utc_datetime(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _is_email_verified_user(user) -> bool:
    return bool(
        getattr(user, "email_confirmed_at", None)
        or getattr(user, "confirmed_at", None)
    )


def _get_auth_users_by_email(email: str) -> list:
    normalized = _normalize_email(email)
    if not normalized:
        return []

    matched = []
    for user in _iter_admin_users():
        user_email = _normalize_email(getattr(user, "email", ""))
        if user_email and user_email == normalized:
            matched.append(user)
    return matched


def _purge_expired_unverified_users(users: list, grace_minutes: int) -> int:
    if not users:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max(1, grace_minutes))
    purged = 0

    for user in users:
        if _is_email_verified_user(user):
            continue

        created_at = _as_utc_datetime(getattr(user, "created_at", None))
        if created_at is None:
            created_at = _as_utc_datetime(getattr(user, "confirmation_sent_at", None))

        # If we cannot determine created time, keep the account and avoid accidental deletion.
        if created_at is None or created_at > cutoff:
            continue

        user_id = str(getattr(user, "id", "") or "").strip()
        if not user_id:
            continue

        try:
            _get_sb_admin().auth.admin.delete_user(user_id, should_soft_delete=False)
            purged += 1
        except Exception:
            continue

    return purged


def _has_active_unverified_user(users: list, grace_minutes: int) -> bool:
    if not users:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max(1, grace_minutes))

    for user in users:
        if _is_email_verified_user(user):
            continue

        created_at = _as_utc_datetime(getattr(user, "created_at", None))
        if created_at is None:
            created_at = _as_utc_datetime(getattr(user, "confirmation_sent_at", None))

        # If missing timestamp, treat as active unverified account for safety.
        if created_at is None or created_at > cutoff:
            return True

    return False


def _email_exists(email: str, matched_auth_users: list | None = None) -> bool:
    normalized = _normalize_email(email)
    if not normalized:
        return False

    # Fast path: profile rows are created from auth.users via trigger.
    try:
        existing_profile = (
            _get_sb_admin()
            .table("profiles")
            .select("id")
            .ilike("email", normalized)
            .limit(1)
            .execute()
        )
        if existing_profile.data:
            return True
    except Exception:
        pass

    # Fallback: check auth users directly in case profile row is missing/delayed.
    try:
        users = matched_auth_users if matched_auth_users is not None else _iter_admin_users()
        for user in users:
            user_email = _normalize_email(getattr(user, "email", ""))
            if user_email and user_email == normalized:
                return True
    except Exception:
        pass

    return False


@auth_bp.errorhandler(CredentialError)
def invalid_credential(error):
    return jsonify({"error": str(error)}), 400


@auth_bp.route("/credential-challenge", methods=["GET"])
@limiter.limit("20 per minute")
def credential_challenge():
    return jsonify(issue_challenge(request.args.get("purpose", "")))


@auth_bp.route("/register", methods=["POST"])
@limiter.limit("5 per minute")
def register():
    """Register a new user."""
    data = open_credentials(request.get_json(silent=True), "register")
    email = _normalize_email(data.get("email", ""))
    strength_error = password_strength_error(data.get("password"))
    if strength_error:
        return jsonify({"error": strength_error}), 400
    username = data.get("username", "").strip()
    display_name = data.get("displayName", username)
    captcha_ok, captcha_error = _require_recaptcha(data)
    if not captcha_ok:
        return jsonify({"error": captcha_error}), 400

    if not email or not data.get("password", "") or not username:
        return jsonify({"error": "Email, password và username là bắt buộc"}), 400

    if not _is_valid_email(email):
        return jsonify({"error": "Email không hợp lệ"}), 400

    username_error = _validate_username(username)
    if username_error:
        return jsonify({"error": username_error}), 400

    password = derive_password(data["password"], email)
    try:
        # Enforce verification window: unverified emails expire after N minutes.
        same_email_auth_users = _get_auth_users_by_email(email)
        _purge_expired_unverified_users(same_email_auth_users, _EMAIL_VERIFY_TIMEOUT_MINUTES)
        same_email_auth_users = _get_auth_users_by_email(email)
        if _has_active_unverified_user(same_email_auth_users, _EMAIL_VERIFY_TIMEOUT_MINUTES):
            return jsonify({
                "error": (
                    "Email này chưa xác thực. Vui lòng kiểm tra hộp thư để xác thực, "
                    f"hoặc đợi {_EMAIL_VERIFY_TIMEOUT_MINUTES} phút để đăng ký lại."
                )
            }), 409

        # Check if username is taken
        existing = _get_sb_admin().table("profiles").select("id").eq(
            "username", username
        ).execute()
        if existing.data:
            return jsonify({"error": "Username đã tồn tại"}), 409

        # Prevent duplicate registration for the same email (case-insensitive).
        if _email_exists(email, matched_auth_users=same_email_auth_users):
            return jsonify({"error": "Email đã được đăng ký"}), 409

        # Sign up via Supabase Auth (triggers handle_new_user function)
        result = _get_sb().auth.sign_up({
            "email": email,
            "password": password,
            "options": {
                "data": {
                    "username": username,
                    "display_name": display_name,
                }
            }
        })

        if result.user:
            # Supabase may return an obfuscated user for existing emails.
            identities = getattr(result.user, "identities", None)
            if isinstance(identities, list) and len(identities) == 0:
                return jsonify({"error": "Email đã được đăng ký"}), 409

            return jsonify({
                "message": "Đăng ký thành công! Vui lòng kiểm tra email để xác thực.",
                "user": {
                    "id": str(result.user.id),
                    "email": result.user.email,
                    "username": username,
                }
            }), 201
        else:
            return jsonify({"error": "Đăng ký thất bại"}), 400

    except Exception as e:
        error_msg = str(e)
        error_msg_lower = error_msg.lower()
        if (
            "already registered" in error_msg_lower
            or "already exists" in error_msg_lower
            or "duplicate" in error_msg_lower
        ):
            return jsonify({"error": "Email đã được đăng ký"}), 409
        return _auth_internal_error("Registration failed", e)


@auth_bp.route("/login", methods=["POST"])
@limiter.limit("10 per minute")
def login():
    """Login with email and password."""
    data = open_credentials(request.get_json(silent=True), "login")
    email = _normalize_email(data.get("email", ""))
    raw_password = data.get("password", "")
    captcha_ok, captcha_error = _require_recaptcha(data)
    if not captcha_ok:
        return jsonify({"error": captcha_error}), 400

    if not email or not raw_password:
        return jsonify({"error": "Email và password là bắt buộc"}), 400

    if not _is_valid_email(email):
        return jsonify({"error": "Email không hợp lệ"}), 400

    try:
        primary_password = derive_password(raw_password, email)
        def candidates():
            yield primary_password
            yield from legacy_passwords(raw_password)
        result = None
        used_password = ""
        last_auth_error = ""
        for candidate in candidates():
            try:
                candidate_result = _get_sb().auth.sign_in_with_password({
                    "email": email,
                    "password": candidate,
                })
                if candidate_result.user and candidate_result.session:
                    result = candidate_result
                    used_password = candidate
                    break
            except Exception as auth_error:
                code = str(getattr(auth_error, "code", "") or "")
                message = str(auth_error).lower()
                if code == "email_not_confirmed" or "email not confirmed" in message:
                    return jsonify({"error": "Email chưa được xác thực. Vui lòng kiểm tra hộp thư."}), 403
                if code == "invalid_credentials" or "invalid login credentials" in message:
                    last_auth_error = "invalid credentials"
                else:
                    # Provider timeouts/rate limits must not try two legacy KDFs
                    # and repeat the same failing upstream call.
                    raise

        if result and result.user and result.session:
            # Get profile data
            profile = _get_sb_admin().table("profiles").select("*").eq(
                "id", str(result.user.id)
            ).single().execute()
            profile_data = normalize_vip_profile(
                profile.data if profile.data else None,
                _get_sb_admin(),
            )

            if profile_data and profile_data.get("is_banned"):
                _get_sb_admin().auth.admin.sign_out(result.session.access_token, "local")
                return _json({"error": "BANNED", "reason": profile_data.get("ban_reason", "")},
                             403, clear_refresh=True)
            if primary_password and used_password and used_password != primary_password:
                try:
                    _get_sb_admin().auth.admin.update_user_by_id(
                        str(result.user.id),
                        {"password": primary_password},
                    )
                except Exception:
                    pass

            return _json({
                "message": "Đăng nhập thành công",
                "session": {
                    "access_token": result.session.access_token,
                    "expires_at": result.session.expires_at,
                },
                "user": {
                    "id": str(result.user.id),
                    "email": result.user.email,
                },
                "profile": profile_data or None,
            }, 200, refresh_token=result.session.refresh_token)
        else:
            if "invalid" in last_auth_error.lower():
                return jsonify({"error": "Email hoặc mật khẩu không đúng"}), 401
            if last_auth_error:
                raise RuntimeError(last_auth_error)
            return jsonify({"error": "Đăng nhập thất bại"}), 401

    except Exception as e:
        error_msg = str(e)
        if "invalid" in error_msg.lower():
            return jsonify({"error": "Email hoặc mật khẩu không đúng"}), 401
        return _auth_internal_error("Login failed", e)


@auth_bp.route("/logout", methods=["POST"])
def logout():
    """Logout current user and revoke the selected Supabase session scope."""
    data = request.get_json(silent=True) or {}
    scope = _normalize_sign_out_scope(data.get("scope"), default="local")
    has_auth = _load_logout_auth_from_bearer()

    if not has_auth and scope != "local":
        return _json({
            "error": "Token không được cung cấp",
            "message": "Đã xoá phiên cục bộ trên trình duyệt",
        }, 401, clear_refresh=True)

    user_id = get_current_user_id()
    if has_auth and user_id:
        try:
            _revoke_access_sessions(user_id, scope)
        except access_tickets.Unavailable:
            return _json({"error": "Không thể thu hồi phiên truy cập. Vui lòng thử lại."}, 503, clear_refresh=True)
    profile_marked = True
    profile_error = ""
    if has_auth and scope == "global" and user_id:
        profile_marked, profile_error = _mark_session_security_event(user_id)

    if has_auth:
        revoked, revoke_error = _revoke_supabase_sessions(scope)
    else:
        revoked, revoke_error = False, ""
    if profile_error:
        logger.error("Could not persist logout security event: %s", profile_error)
    if revoke_error:
        logger.error("Could not revoke Supabase session: %s", revoke_error)
    clear_auth_cache(user_id=user_id, token=str(getattr(g, "access_token", "") or ""))
    return _json({
        "message": "Đăng xuất thành công",
        "scope": scope,
        "revoked": revoked,
        "session_state_updated": profile_marked,
    }, 200, clear_refresh=True)

@auth_bp.route("/forgot-password", methods=["POST"])
@limiter.limit("5 per minute")
def forgot_password():
    """Send password reset email."""
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip()
    captcha_ok, captcha_error = _require_recaptcha(data)
    if not captcha_ok:
        return jsonify({"error": captcha_error}), 400

    if not email:
        return jsonify({"error": "Email là bắt buộc"}), 400

    try:
        _get_sb().auth.reset_password_email(email, {
            "redirect_to": f"{config.FRONTEND_URL}/auth/callback",
        })
        return jsonify({
            "message": "Email đặt lại mật khẩu đã được gửi. Vui lòng kiểm tra hộp thư."
        }), 200
    except Exception as e:
        return _auth_internal_error("Password reset email failed", e)


@auth_bp.route("/verify-otp", methods=["POST"])
@limiter.limit("10 per minute")
def verify_otp():
    """Verify OTP token from email."""
    data = request.get_json(silent=True) or {}
    token = data.get("token", "")
    otp_type = data.get("type", "email")  # email, recovery, signup

    if not token:
        return jsonify({"error": "Token là bắt buộc"}), 400

    try:
        result = _get_sb().auth.verify_otp({
            "token": token,
            "type": otp_type,
        })

        if result.user:
            return jsonify({
                "message": "Xác thực thành công",
                "user": {
                    "id": str(result.user.id),
                    "email": result.user.email,
                },
                "session": {
                    "access_token": result.session.access_token if result.session else None,
                } if result.session else None,
            }), 200
        else:
            return jsonify({"error": "OTP không hợp lệ"}), 400

    except Exception as e:
        _log_auth_exception("OTP verification failed", e)
        return jsonify({"error": "OTP không hợp lệ hoặc đã hết hạn"}), 400


@auth_bp.route("/reset-password", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def reset_password():
    """Reset password from a recovery session; revokes all sessions after update."""
    if not _is_recent_recovery_session(str(getattr(g, "access_token", "") or "")):
        return jsonify({"error": "Vui lòng mở liên kết đặt lại mật khẩu mới từ email."}), 403
    data = open_credentials(request.get_json(silent=True), "reset-password")
    strength_error = password_strength_error(data.get("password"))
    if strength_error:
        return jsonify({"error": strength_error}), 400
    user_email = _normalize_email(getattr(getattr(g, "current_user", None), "email", ""))
    if not user_email:
        return jsonify({"error": "Không xác thực được email tài khoản"}), 401
    new_password = derive_password(data["password"], user_email)

    try:
        user_id = get_current_user_id()
        if not user_id:
            return jsonify({"error": "Không xác thực được"}), 401

        with access_tickets.security_change(user_id):
            _revoke_access_sessions(user_id, "global", check_session=False)
            _get_sb_admin().auth.admin.update_user_by_id(user_id, {"password": new_password})
            profile_marked, profile_error = _mark_session_security_event(user_id, password_changed=True)
            _revoke_access_sessions(user_id, "global", check_session=False)
        revoked, revoke_error = _revoke_supabase_sessions("global")
        if profile_error:
            logger.error("Could not persist password reset security event: %s", profile_error)
        if revoke_error:
            logger.error("Could not revoke sessions after password reset: %s", revoke_error)
        clear_auth_cache(user_id=user_id, token=str(getattr(g, "access_token", "") or ""))
        return _json({
            "message": "Đổi mật khẩu thành công. Vui lòng đăng nhập lại.",
            "requires_relogin": True,
            "revoked": revoked,
            "session_state_updated": profile_marked,
        }, 200, clear_refresh=True)
    except Exception as e:
        return _auth_internal_error("Password reset failed", e)


def _is_recent_recovery_session(token: str) -> bool:
    # require_auth has already verified this exact token with Supabase. Inspect
    # its signed AMR claim; a normal password/OAuth login cannot bypass the
    # current-password check by changing a client-side URL type to "recovery".
    # Supabase's implicit email recovery flow issues AMR method "otp" (verify.go,
    # issueRefreshToken(...models.OTP...)), not the URL's "recovery" type. A
    # recent, email-only OTP proves inbox access just like a recovery email.
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        now = time.time()
        email_otp = bool(_is_valid_email(str(claims.get("email") or ""))) and not claims.get("phone")
        return any(isinstance(entry, dict)
                   and (entry.get("method") == "recovery" or (entry.get("method") == "otp" and email_otp))
                   and 0 <= now - float(entry.get("timestamp", 0)) <= 15 * 60
                   for entry in claims.get("amr", []))
    except Exception:
        return False


@auth_bp.route("/change-password", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def change_password():
    """Change password from settings; verifies current password first."""
    data = open_credentials(request.get_json(silent=True), "change-password")
    strength_error = password_strength_error(data.get("password"))
    if strength_error:
        return jsonify({"error": strength_error}), 400
    if not data.get("current_password"):
        return jsonify({"error": "Mật khẩu hiện tại là bắt buộc"}), 400
    if data["password"] == data["current_password"]:
        return jsonify({"error": "Mật khẩu mới phải khác mật khẩu hiện tại"}), 400

    try:
        user_id = get_current_user_id()
        user_email = _normalize_email(getattr(getattr(g, "current_user", None), "email", ""))
        if not user_id or not user_email:
            return jsonify({"error": "Không xác thực được tài khoản"}), 401

        current_password = derive_password(data["current_password"], user_email)
        verified, verify_error = _verify_current_password(user_email, current_password)
        if not verified:
            verified, verify_error, _ = _verify_current_password_any(user_email, legacy_passwords(data["current_password"]))
        if not verified:
            return jsonify({"error": verify_error}), 401
        new_password = derive_password(data["password"], user_email)

        with access_tickets.security_change(user_id):
            _revoke_access_sessions(user_id, "global", check_session=False)
            _get_sb_admin().auth.admin.update_user_by_id(user_id, {"password": new_password})
            profile_marked, profile_error = _mark_session_security_event(user_id, password_changed=True)
            _revoke_access_sessions(user_id, "global", check_session=False)
        revoked, revoke_error = _revoke_supabase_sessions("global")
        if profile_error:
            logger.error("Could not persist password change security event: %s", profile_error)
        if revoke_error:
            logger.error("Could not revoke sessions after password change: %s", revoke_error)
        clear_auth_cache(user_id=user_id, token=str(getattr(g, "access_token", "") or ""))
        return _json({
            "message": "Đổi mật khẩu thành công. Vui lòng đăng nhập lại.",
            "requires_relogin": True,
            "revoked": revoked,
            "session_state_updated": profile_marked,
        }, 200, clear_refresh=True)
    except Exception as e:
        return _auth_internal_error("Password change failed", e)

@auth_bp.route("/me", methods=["GET"])
@require_auth
def get_me():
    """Get current authenticated user's profile."""
    user_id = get_current_user_id()
    if not user_id:
        return jsonify({"error": "Không xác thực được"}), 401

    profile_data, settings_data = _fetch_profile_and_settings(user_id)

    return jsonify({
        "profile": profile_data,
        "settings": settings_data,
        "auth_email": str(getattr(getattr(g, "current_user", None), "email", "") or ""),
    }), 200


@auth_bp.route("/ping", methods=["GET"])
@require_auth
def ping():
    return jsonify({"ok": True}), 200


@auth_bp.route("/refresh", methods=["POST"])
@limiter.limit("30 per minute")
def refresh_token():
    """Refresh access token."""
    data = request.get_json(silent=True) or {}
    refresh_token = request.cookies.get(_REFRESH_COOKIE_NAME) or data.get("refresh_token", "")
    presented_access_token = str(data.get("access_token", "") or "").strip()

    if not refresh_token:
        return _json({
            "error": "Refresh token là bắt buộc",
            "requires_relogin": True,
        }, 401)

    try:
        presented_user_id = ""
        presented_profile: dict = {}
        if presented_access_token:
            token_payload = _decode_access_token_payload(presented_access_token)
            presented_user_id = str(token_payload.get("sub") or "").strip()
            if presented_user_id:
                presented_profile = _fetch_session_profile(presented_user_id)
                if presented_profile.get("is_banned"):
                    return jsonify({"error": "Tài khoản đã bị cấm"}), 403
                if _is_access_token_revoked(presented_access_token, presented_profile):
                    return jsonify({"error": "Phiên đăng nhập đã hết hạn"}), 401

        refreshed_session = _refresh_session_singleflight(refresh_token)

        if refreshed_session:
            refreshed_access_token = str(refreshed_session.get("access_token") or "")
            refreshed_payload = _decode_access_token_payload(refreshed_access_token)
            refreshed_user_id = str(
                refreshed_payload.get("sub") or ""
            ).strip()

            if presented_user_id and refreshed_user_id and presented_user_id != refreshed_user_id:
                return jsonify({"error": "Refresh token không khớp phiên đăng nhập"}), 401

            profile = presented_profile if presented_user_id == refreshed_user_id else {}
            if refreshed_user_id and not profile:
                profile = _fetch_session_profile(refreshed_user_id)
            if profile.get("is_banned"):
                return jsonify({"error": "Tài khoản đã bị cấm"}), 403
            if _is_access_token_revoked(refreshed_access_token, profile):
                return jsonify({"error": "Phiên đăng nhập cần xác thực lại"}), 401

            profile_payload, settings_payload = _fetch_profile_and_settings(refreshed_user_id)
            return _json({
                "session": {
                    "access_token": refreshed_access_token,
                    "expires_at": refreshed_session.get("expires_at"),
                },
                "profile": profile_payload,
                "settings": settings_payload,
                "auth_email": str(refreshed_payload.get("email") or profile_payload.get("email") or ""),
            }, 200, refresh_token=refreshed_session.get("refresh_token") or "")
        else:
            return jsonify({"error": "Refresh thất bại"}), 401

    except Exception as e:
        message = str(e)
        normalized = message.lower()
        if "already used" in normalized or "reuse" in normalized:
            try:
                cached_session = _wait_for_cached_refresh_result(_refresh_token_cache_key(refresh_token))
                if cached_session and _refresh_payload_is_fresh(cached_session):
                    cached_access_token = str(cached_session.get("access_token") or "")
                    cached_payload = _decode_access_token_payload(cached_access_token)
                    cached_user_id = str(cached_payload.get("sub") or "").strip()
                    if presented_user_id and cached_user_id and presented_user_id != cached_user_id:
                        return jsonify({"error": "Refresh token không khớp phiên đăng nhập"}), 401

                    cached_profile = presented_profile if presented_user_id == cached_user_id else {}
                    if cached_user_id and not cached_profile:
                        cached_profile = _fetch_session_profile(cached_user_id)
                    if cached_profile.get("is_banned"):
                        return jsonify({"error": "Tài khoản đã bị cấm"}), 403
                    if _is_access_token_revoked(cached_access_token, cached_profile):
                        return jsonify({"error": "Phiên đăng nhập cần xác thực lại"}), 401

                    profile_payload, settings_payload = _fetch_profile_and_settings(cached_user_id)
                    return _json({
                        "session": {
                            "access_token": cached_access_token,
                            "expires_at": cached_session.get("expires_at"),
                        },
                        "profile": profile_payload,
                        "settings": settings_payload,
                        "auth_email": str(cached_payload.get("email") or profile_payload.get("email") or ""),
                    }, 200, refresh_token=cached_session.get("refresh_token") or "")
            except Exception:
                pass
            return _json({
                "error": "Refresh đang được xử lý, vui lòng thử lại",
                "requires_retry": True,
            }, 503)
        if (
            "invalid refresh" in normalized
            or "refresh token not found" in normalized
            or "session not found" in normalized
        ):
            return _json({
                "error": "Refresh token không hợp lệ",
                "requires_relogin": True,
            }, 401, clear_refresh=True)
        return _auth_internal_error("Token refresh failed", e)


def _start_oauth(provider: str):
    stage = "AUTH_OAUTH_CLIENT_UNAVAILABLE"
    try:
        if not config.SUPABASE_URL or not config.SUPABASE_KEY:
            return jsonify({"error": _AUTH_INTERNAL_ERROR_MESSAGE,
                            "code": "AUTH_PROVIDER_CONFIG_MISSING"}), 500
        redirect_to = f"{config.FRONTEND_URL}/auth/callback"
        sb = _get_sb()
        stage = "AUTH_OAUTH_LINK_UNAVAILABLE"
        result = sb.auth.sign_in_with_oauth({
            "provider": provider,
            "options": {
                "redirect_to": redirect_to,
            }
        })
        if result and result.url:
            code_verifier = _get_oauth_code_verifier(sb)
            if not code_verifier:
                return jsonify({"error": _AUTH_INTERNAL_ERROR_MESSAGE,
                                "code": "AUTH_OAUTH_VERIFIER_UNAVAILABLE"}), 500
            stage = "AUTH_OAUTH_RESPONSE_UNAVAILABLE"
            return _json({"url": result.url}, 200, oauth_code_verifier=code_verifier)
        return jsonify({"error": _AUTH_INTERNAL_ERROR_MESSAGE, "code": stage}), 500
    except Exception as e:
        _log_auth_exception(f"{provider} OAuth failed at {stage}", e)
        payload = {"error": _AUTH_INTERNAL_ERROR_MESSAGE, "code": stage}
        # Only fixed exception categories are public. Never return provider
        # messages, URLs, credentials, or arbitrary exception class names.
        category = type(e).__name__
        if category in {"SupabaseException", "ValueError", "TypeError", "OSError",
                        "AuthApiError", "AuthRetryableError"}:
            payload["category"] = category
        return jsonify(payload), 500


@auth_bp.route("/google", methods=["POST"])
@limiter.limit("10 per minute")
def google_login():
    """Initiate Google OAuth with a request-isolated PKCE verifier."""
    return _start_oauth("google")



@auth_bp.route("/discord", methods=["POST"])
@limiter.limit("10 per minute")
def discord_login():
    """Initiate Discord OAuth with a request-isolated PKCE verifier."""
    return _start_oauth("discord")


@auth_bp.route("/oauth/callback", methods=["POST"])
@limiter.limit("20 per minute")
def oauth_callback():
    """Exchange OAuth access_token + refresh_token for a verified session and profile."""
    data = request.get_json(silent=True) or {}
    access_token = data.get("access_token", "")
    refresh_token_value = data.get("refresh_token", "")

    if not access_token:
        return jsonify({"error": "access_token là bắt buộc"}), 400

    try:
        # Get user from the access token
        user_response = _get_sb_admin().auth.get_user(access_token)
        user = user_response.user if user_response else None

        if not user:
            return jsonify({"error": "Token không hợp lệ"}), 401

        user_id = str(user.id)

        # Ensure profile exists (Supabase trigger should create it, but just in case)
        profile_result = _get_sb_admin().table("profiles").select("*").eq(
            "id", user_id
        ).execute()

        if not profile_result.data:
            # Create profile for OAuth user
            username = (
                (user.user_metadata or {}).get("name", "").replace(" ", "_").lower()
                or user.email.split("@")[0]
            )
            # Ensure unique username
            existing = _get_sb_admin().table("profiles").select("id").eq(
                "username", username
            ).execute()
            if existing.data:
                import uuid as _uuid
                username = f"{username}_{_uuid.uuid4().hex[:6]}"

            _get_sb_admin().table("profiles").insert({
                "id": user_id,
                "username": username,
                "display_name": (user.user_metadata or {}).get("full_name", username),
                "avatar": (user.user_metadata or {}).get("avatar_url", ""),
                "email": user.email,
                "role": "reader",
            }).execute()

            profile_result = _get_sb_admin().table("profiles").select("*").eq(
                "id", user_id
            ).execute()

        # Ensure user_settings exists
        settings_result = _get_sb_admin().table("user_settings").select("user_id").eq(
            "user_id", user_id
        ).execute()
        if not settings_result.data:
            try:
                _get_sb_admin().table("user_settings").insert(
                    {"user_id": user_id}
                ).execute()
            except Exception:
                pass

        profile = normalize_vip_profile(
            profile_result.data[0] if profile_result.data else None,
            _get_sb_admin(),
        ) or None

        # Check if banned
        if profile and profile.get("is_banned"):
            return jsonify({"error": "BANNED", "reason": profile.get("ban_reason", "")}), 403

        return _json({
            "message": "Đăng nhập thành công",
            "session": {
                "access_token": access_token,
            },
            "user": {
                "id": user_id,
                "email": user.email,
            },
            "profile": profile,
        }, 200, refresh_token=refresh_token_value)

    except Exception as e:
        return _auth_internal_error("OAuth callback failed", e)


@auth_bp.route("/oauth/code", methods=["POST"])
@limiter.limit("20 per minute")
def oauth_exchange_code():
    """Exchange PKCE authorization code for session (Supabase PKCE flow)."""
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "") or "").strip()
    code_verifier = str(
        data.get("code_verifier")
        or request.cookies.get(_OAUTH_VERIFIER_COOKIE_NAME)
        or ""
    ).strip()

    if not code:
        return _json({"error": "code là bắt buộc"}, 400, clear_oauth_verifier=True)
    if not code_verifier:
        return _json({
            "error": "Phiên OAuth đã hết hạn, vui lòng đăng nhập lại",
            "requires_relogin": True,
        }, 400, clear_oauth_verifier=True)

    try:
        # Exchange code for session
        result = _get_sb().auth.exchange_code_for_session({
            "auth_code": code,
            "code_verifier": code_verifier,
        })

        if not result.session or not result.user:
            return _json({"error": "Không thể exchange code"}, 401, clear_oauth_verifier=True)

        user = result.user
        session = result.session
        user_id = str(user.id)

        # Ensure profile exists
        profile_result = _get_sb_admin().table("profiles").select("*").eq(
            "id", user_id
        ).execute()

        if not profile_result.data:
            # Create profile for OAuth user
            username = (
                (user.user_metadata or {}).get("name", "").replace(" ", "_").lower()
                or user.email.split("@")[0]
            )
            existing = _get_sb_admin().table("profiles").select("id").eq(
                "username", username
            ).execute()
            if existing.data:
                import uuid as _uuid
                username = f"{username}_{_uuid.uuid4().hex[:6]}"

            _get_sb_admin().table("profiles").insert({
                "id": user_id,
                "username": username,
                "display_name": (user.user_metadata or {}).get("full_name", username),
                "avatar": (user.user_metadata or {}).get("avatar_url", ""),
                "email": user.email,
                "role": "reader",
            }).execute()

            profile_result = _get_sb_admin().table("profiles").select("*").eq(
                "id", user_id
            ).execute()

        # Ensure user_settings exists
        settings_result = _get_sb_admin().table("user_settings").select("user_id").eq(
            "user_id", user_id
        ).execute()
        if not settings_result.data:
            try:
                _get_sb_admin().table("user_settings").insert(
                    {"user_id": user_id}
                ).execute()
            except Exception:
                pass

        profile = normalize_vip_profile(
            profile_result.data[0] if profile_result.data else None,
            _get_sb_admin(),
        ) or None

        if profile and profile.get("is_banned"):
            return _json({
                "error": "BANNED",
                "reason": profile.get("ban_reason", ""),
            }, 403, clear_oauth_verifier=True)

        return _json({
            "message": "Đăng nhập thành công",
            "session": {
                "access_token": session.access_token,
                "expires_at": session.expires_at,
            },
            "user": {
                "id": user_id,
                "email": user.email,
            },
            "profile": profile,
        }, 200, refresh_token=session.refresh_token, clear_oauth_verifier=True)

    except Exception as e:
        _log_auth_exception("OAuth code exchange failed", e)
        return _json({
            "error": _AUTH_INTERNAL_ERROR_MESSAGE,
        }, 500, clear_oauth_verifier=True)


