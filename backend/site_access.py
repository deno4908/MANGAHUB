"""Account whitelist stored in the existing, service-role-only settings table."""
import threading
import time
from uuid import UUID
from contextvars import ContextVar
from itertools import count

from itsdangerous import BadData, URLSafeTimedSerializer
from config import config

SETTING_KEY = "site_access"
MEMBER_PREFIX = "site_access:user:"
COOKIE_NAME = "mh_site_access"
COOKIE_SECONDS = 300
CACHE_SECONDS = 3
DEFAULT_MESSAGE = "Bạn không nằm trong whitelist của website. Vui lòng liên hệ admin để được cấp quyền truy cập."
_cache = {}
_lock = threading.RLock()
source_authorization = ContextVar("site_access_source_authorization", default=None)


class AccessUnavailable(RuntimeError):
    pass


def _db():
    from fastapi_app.dependencies import get_supabase_admin
    return get_supabase_admin()


def _read(key, *, force=False):
    with _lock:
        cached = _cache.get(key)
        if not force and cached and cached[0] > time.monotonic():
            return cached[1]
        try:
            rows = _db().table("system_settings").select("value").eq("key", key).limit(1).execute().data
            value = rows[0]["value"] if rows else {}
            if not isinstance(value, dict):
                raise ValueError("Invalid site access setting")
        except Exception as error:
            # Never turn an unavailable policy store into anonymous access.
            raise AccessUnavailable("Không thể kiểm tra quyền truy cập. Vui lòng thử lại.") from error
        if len(_cache) >= 2048:
            _cache.clear()
        _cache[key] = (time.monotonic() + CACHE_SECONDS, value)
        return value


def get_state(*, force=False):
    value = _read(SETTING_KEY, force=force)
    if "enabled" in value and type(value["enabled"]) is not bool:
        raise AccessUnavailable("Không thể kiểm tra quyền truy cập. Vui lòng thử lại.")
    return {"enabled": value.get("enabled") is True,
            "message": str(value.get("message") or DEFAULT_MESSAGE)[:1000]}


def is_allowed(state, user):
    if not state["enabled"]:
        return True
    if not user:
        return False
    if user.get("role") == "admin":
        return True
    return _read(MEMBER_PREFIX + str(UUID(user["id"]))).get("allowed") is True


def set_state(enabled, message, actor):
    value = {"enabled": enabled, "message": (message or DEFAULT_MESSAGE).strip() or DEFAULT_MESSAGE}
    _db().table("system_settings").upsert({"key": SETTING_KEY, "value": value, "updated_by": actor}, on_conflict="key").execute()
    with _lock:
        _cache.pop(SETTING_KEY, None)
    return value


def set_member(user_id, allowed, actor):
    user_id = str(UUID(str(user_id)))
    key = MEMBER_PREFIX + user_id
    if allowed:
        profiles = _db().table("profiles").select("id").eq("id", user_id).limit(1).execute().data
        if not profiles:
            raise LookupError("Không tìm thấy tài khoản.")
        _db().table("system_settings").upsert({"key": key, "value": {"allowed": True}, "updated_by": actor}, on_conflict="key").execute()
    else:
        _db().table("system_settings").delete().eq("key", key).execute()
    with _lock:
        _cache.pop(key, None)


def list_members():
    ids = []
    # Page explicitly: Supabase otherwise silently truncates at its row limit.
    for offset in count(0, 500):
        rows = _db().table("system_settings").select("key,value").like("key", MEMBER_PREFIX + "%").order("key").range(offset, offset + 499).execute().data or []
        ids.extend(row["key"][len(MEMBER_PREFIX):] for row in rows if row.get("value", {}).get("allowed") is True)
        if len(rows) < 500:
            break
    members = []
    for offset in range(0, len(ids), 100):
        rows = _db().table("profiles").select("id,username,display_name,email,role,is_banned").in_("id", ids[offset:offset + 100]).execute().data or []
        members.extend(rows)
    return members


def _signer():
    return URLSafeTimedSerializer(config.FLASK_SECRET_KEY, salt="mangahub-site-access-v1")


def asset_token(cookie):
    if not cookie:
        return None
    try:
        value = _signer().loads(cookie, max_age=COOKIE_SECONDS)
        token = value.get("token") if isinstance(value, dict) else None
        return token if isinstance(token, str) and token else None
    except (BadData, ValueError, TypeError):
        return None


def set_asset_cookie(response, token):
    secure = config.FRONTEND_URL.startswith("https://")
    if token:
        response.set_cookie(COOKIE_NAME, _signer().dumps({"token": token}),
                            max_age=COOKIE_SECONDS, httponly=True, secure=secure, samesite="lax", path="/")
    else:
        response.delete_cookie(COOKIE_NAME, httponly=True, secure=secure, samesite="lax", path="/")
