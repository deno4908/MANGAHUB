"""
JWT middleware for Flask routes — with role support.
"""
import logging
import jwt
from functools import wraps
from flask import request, jsonify, g
from config import config
from supabase import create_client
from time import time
from datetime import datetime, timezone
from types import SimpleNamespace
import access_tickets
from fastapi import HTTPException

_supabase = None
logger = logging.getLogger(__name__)
_AUTH_CACHE_TTL = 3.0
_auth_cache = {}
_profile_cache = {}


def clear_auth_cache(user_id: str | None = None, token: str | None = None):
    if token:
        _auth_cache.pop(token, None)
    if user_id:
        _profile_cache.pop(str(user_id), None)


def _as_utc_datetime(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _token_issued_at(token: str):
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        iat = payload.get("iat")
        if not iat:
            return None
        return datetime.fromtimestamp(float(iat), tz=timezone.utc)
    except Exception:
        return None


def _is_token_revoked(token: str, profile_data: dict) -> bool:
    issued_at = _token_issued_at(token)
    if issued_at is None:
        return False
    cutoffs = [
        _as_utc_datetime(profile_data.get("session_revoked_at")),
        _as_utc_datetime(profile_data.get("password_changed_at")),
    ]
    latest_cutoff = max((dt for dt in cutoffs if dt is not None), default=None)
    return bool(latest_cutoff and issued_at <= latest_cutoff)


def _fetch_auth_profile(sb, user_id: str) -> dict:
    try:
        profile = sb.table("profiles").select(
            "role, is_banned, session_revoked_at, password_changed_at"
        ).eq("id", user_id).single().execute()
        return profile.data or {}
    except Exception:
        profile = sb.table("profiles").select("role, is_banned").eq(
            "id", user_id
        ).single().execute()
        return profile.data or {}


def _get_supabase():
    global _supabase
    if _supabase is None and config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY:
        _supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    return _supabase


def require_auth(f):
    """Decorator to require valid JWT token. Fetches user role from profiles."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None

        # Get token from Authorization header
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]

        if not token:
            return jsonify({"error": "Token không được cung cấp"}), 401

        try:
            from fastapi_app.dependencies import _ticket_read
            record, changed = _ticket_read(auth_header)
            force_live = changed or request.method not in {"GET", "HEAD"}
            if not force_live:
                # Reuse only a registered, signed-in website session. Writes
                # continue through live Supabase authentication and RBAC below.
                if record:
                    g.current_user = SimpleNamespace(id=record["uid"], email=record.get("email"))
                    g.access_token = token
                    g.current_role = record["role"]
                    return f(*args, **kwargs)
            now = time()
            cached_auth = _auth_cache.get(token)
            if not force_live and cached_auth and cached_auth[0] > now:
                cached_user = cached_auth[1]
                g.current_user = cached_user["user_obj"]
                g.access_token = token
                g.current_role = cached_user.get("role", "reader")
                if cached_user.get("is_banned"):
                    return jsonify({"error": "Tài khoản đã bị cấm"}), 403
                if cached_user.get("is_revoked"):
                    return jsonify({"error": "Phiên đăng nhập đã hết hạn"}), 401
                return f(*args, **kwargs)

            # Verify with Supabase
            sb = _get_supabase()
            if not sb:
                return jsonify({"error": "Supabase chưa được cấu hình"}), 503
            user_response = sb.auth.get_user(token)
            if not user_response or not user_response.user:
                return jsonify({"error": "Token không hợp lệ"}), 401

            g.current_user = user_response.user
            g.access_token = token

            user_id = str(user_response.user.id)
            cached_profile = _profile_cache.get(user_id)
            if not force_live and cached_profile and cached_profile[0] > now:
                profile_data = cached_profile[1]
            else:
                profile_data = _fetch_auth_profile(sb, user_id)
                _profile_cache[user_id] = (now + _AUTH_CACHE_TTL, profile_data)

            role = profile_data.get("role", "reader")
            is_banned = bool(profile_data.get("is_banned"))
            is_revoked = _is_token_revoked(token, profile_data)
            g.current_role = role
            if not is_banned and not is_revoked:
                _auth_cache[token] = (now + _AUTH_CACHE_TTL, {
                    "user_obj": user_response.user,
                    "role": role,
                    "is_banned": is_banned,
                    "is_revoked": is_revoked,
                })
            else:
                _auth_cache.pop(token, None)
                _profile_cache.pop(user_id, None)
            if is_banned:
                return jsonify({"error": "Tài khoản đã bị cấm"}), 403

            if is_revoked:
                return jsonify({"error": "Phiên đăng nhập đã hết hạn"}), 401

        except HTTPException as e:
            return jsonify({"error": str(e.detail)}), e.status_code
        except Exception as e:
            logger.exception("Flask authentication failed")
            return jsonify({"error": "Xác thực thất bại"}), 401

        return f(*args, **kwargs)
    return decorated


ROLE_HIERARCHY = {"reader": 0, "uploader": 1, "moderator": 2, "admin": 3}


def require_role(*allowed_roles):
    """Decorator factory: require user to have one of the allowed roles."""
    def decorator(f):
        @wraps(f)
        @require_auth
        def decorated(*args, **kwargs):
            user_role = getattr(g, "current_role", "reader")
            user_level = ROLE_HIERARCHY.get(user_role, 0)
            min_required = min(ROLE_HIERARCHY.get(r, 0) for r in allowed_roles)
            if user_level < min_required:
                return jsonify({
                    "error": f"Yêu cầu quyền {'/'.join(allowed_roles)}. Bạn là {user_role}."
                }), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def get_current_user_id():
    """Get current authenticated user's ID."""
    if hasattr(g, 'current_user') and g.current_user:
        return str(g.current_user.id)
    return None


def get_current_user_role():
    """Get current authenticated user's role."""
    return getattr(g, 'current_role', 'reader')
