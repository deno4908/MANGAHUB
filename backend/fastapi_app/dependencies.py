"""
FastAPI dependencies — Supabase client, auth, RBAC.
"""

import base64
import json
import logging
from datetime import datetime, timezone
from time import time

from config import config
from fastapi import Depends, Header, HTTPException
from supabase import Client, create_client

# Lazy-initialized Supabase clients
_supabase_admin: Client | None = None
_supabase_anon: Client | None = None
logger = logging.getLogger(__name__)
_AUTH_CACHE_TTL = 3.0
_auth_cache: dict[str, tuple[float, dict]] = {}
_profile_cache: dict[str, tuple[float, dict]] = {}
_cleanup_counter = 0


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
        payload_part = token.split(".")[1]
        padded = payload_part + "=" * (-len(payload_part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
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


def _fetch_auth_profile(user_id: str) -> dict:
    try:
        profile = (
            _supabase_admin.table("profiles")
            .select("role, is_banned, session_revoked_at, password_changed_at")
            .eq("id", user_id)
            .single()
            .execute()
        )
        return profile.data or {}
    except Exception:
        profile = (
            _supabase_admin.table("profiles")
            .select("role, is_banned")
            .eq("id", user_id)
            .single()
            .execute()
        )
        return profile.data or {}


def _cleanup_expired_caches():
    """Remove expired entries from caches to prevent unbounded memory growth."""
    now = time()
    expired_auth = [k for k, (exp, _) in _auth_cache.items() if exp <= now]
    for k in expired_auth:
        _auth_cache.pop(k, None)
    expired_profile = [k for k, (exp, _) in _profile_cache.items() if exp <= now]
    for k in expired_profile:
        _profile_cache.pop(k, None)


def _init_clients():
    global _supabase_admin, _supabase_anon
    if not config.SUPABASE_URL or not config.SUPABASE_KEY:
        raise HTTPException(
            status_code=503,
            detail="Supabase chưa được cấu hình. Vui lòng cập nhật file .env",
        )
    if _supabase_admin is None:
        _supabase_admin = create_client(
            config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY
        )
    if _supabase_anon is None:
        _supabase_anon = create_client(config.SUPABASE_URL, config.SUPABASE_KEY)


def get_supabase() -> Client:
    """Get Supabase admin client (service role) — FastAPI dependency."""
    _init_clients()
    return _supabase_admin


def get_supabase_admin() -> Client:
    """Get Supabase admin client — standalone (for background tasks)."""
    _init_clients()
    return _supabase_admin


def get_supabase_anon() -> Client:
    """Get Supabase anon client."""
    _init_clients()
    return _supabase_anon


def get_supabase_public() -> Client:
    """Get Supabase anon client for public/read-only routes that should respect RLS."""
    return get_supabase_anon()


# ─── Role hierarchy ───
ROLE_HIERARCHY = {
    "reader": 0,
    "uploader": 1,
    "moderator": 2,
    "admin": 3,
}


async def get_current_user(authorization: str = Header(None)):
    """
    Extract and verify current user from Bearer token.
    Always fetches role from profiles table.
    Returns dict with 'id', 'email', 'role'.
    """
    global _cleanup_counter
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token không được cung cấp")

    token = authorization[7:]
    _init_clients()
    now = time()

    _cleanup_counter += 1
    if _cleanup_counter >= 100:
        _cleanup_counter = 0
        _cleanup_expired_caches()

    cached_auth = _auth_cache.get(token)
    if cached_auth and cached_auth[0] > now:
        cached_user = cached_auth[1]
        if cached_user.get("is_banned"):
            raise HTTPException(status_code=403, detail="Tài khoản đã bị cấm")
        if cached_user.get("is_revoked"):
            raise HTTPException(status_code=401, detail="Phiên đăng nhập đã hết hạn")
        return {
            "id": cached_user["id"],
            "email": cached_user.get("email"),
            "role": cached_user.get("role", "reader"),
        }

    try:
        user_response = _supabase_admin.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Token không hợp lệ")

        user_id = str(user_response.user.id)

        cached_profile = _profile_cache.get(user_id)
        if cached_profile and cached_profile[0] > now:
            profile_data = cached_profile[1]
        else:
            profile_data = _fetch_auth_profile(user_id)
            _profile_cache[user_id] = (now + _AUTH_CACHE_TTL, profile_data)

        role = profile_data.get("role", "reader")
        is_banned = bool(profile_data.get("is_banned"))
        is_revoked = _is_token_revoked(token, profile_data)
        cache_payload = {
            "id": user_id,
            "email": user_response.user.email,
            "role": role,
            "is_banned": is_banned,
            "is_revoked": is_revoked,
        }
        if not is_banned and not is_revoked:
            _auth_cache[token] = (now + _AUTH_CACHE_TTL, cache_payload)
        else:
            _auth_cache.pop(token, None)
            _profile_cache.pop(user_id, None)

        if is_banned:
            raise HTTPException(status_code=403, detail="Tài khoản đã bị cấm")

        if is_revoked:
            raise HTTPException(status_code=401, detail="Phiên đăng nhập đã hết hạn")

        return {
            "id": user_id,
            "email": user_response.user.email,
            "role": role,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("FastAPI authentication failed")
        raise HTTPException(status_code=401, detail="Xác thực thất bại") from e


async def get_optional_user(authorization: str = Header(None)):
    """
    Like get_current_user but returns None instead of raising if no token.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return await get_current_user(authorization)
    except HTTPException:
        return None


def require_role(*allowed_roles: str):
    """
    Dependency factory: require user to have one of the allowed roles.
    Respects role hierarchy: admin can access moderator routes, etc.
    Usage: Depends(require_role("moderator", "admin"))
    """

    async def _check(user=Depends(get_current_user)):
        user_role = user.get("role", "reader")
        user_level = ROLE_HIERARCHY.get(user_role, 0)

        # Check if user role is in allowed roles OR higher
        min_required = min(ROLE_HIERARCHY.get(r, 0) for r in allowed_roles)
        if user_level < min_required:
            raise HTTPException(
                status_code=403,
                detail=f"Yêu cầu quyền {'/'.join(allowed_roles)}. Bạn là {user_role}.",
            )
        return user

    return _check


# Convenience shortcuts
require_uploader = require_role("uploader", "moderator", "admin")
require_moderator = require_role("moderator", "admin")
require_admin = require_role("admin")
