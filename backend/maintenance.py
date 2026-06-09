"""Shared maintenance-mode helpers for Flask and FastAPI services."""

import base64
import json
import time
from datetime import datetime, timezone
from typing import Any

from config import config
from supabase import create_client

SETTING_KEY = "maintenance_mode"
DEFAULT_TITLE = "Website \u0111ang b\u1ea3o tr\u00ec"
DEFAULT_MESSAGE = "MangaHub \u0111ang b\u1ea3o tr\u00ec h\u1ec7 th\u1ed1ng. Vui l\u00f2ng quay l\u1ea1i sau \u00edt ph\u00fat."
CACHE_TTL_SECONDS = 3.0

_supabase_admin = None
_state_cache: tuple[float, dict[str, Any]] | None = None


def _clean_text(value: Any, fallback: str, limit: int) -> str:
    text = str(value or fallback).strip()[:limit] or fallback
    mojibake_markers = (
        "\u00c3",
        "\u00c2",
        "\u00c4",
        "\u00c5",
        "\u00c6",
        "\u00d0",
        "\u00e1\u00ba",
        "\u00e1\u00bb",
    )
    if any(marker in text for marker in mojibake_markers):
        return fallback
    return text


def _clean_optional_text(value: Any, limit: int) -> str | None:
    text = str(value or "").strip()[:limit]
    return text or None


def _clean_url(value: Any) -> str | None:
    text = _clean_optional_text(value, 1000)
    if not text:
        return None
    lowered = text.lower()
    if lowered.startswith(("https://", "http://", "/")):
        return text
    return None


def _get_supabase_admin():
    global _supabase_admin
    if _supabase_admin is None:
        if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
            raise RuntimeError("Supabase service key is not configured")
        _supabase_admin = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    return _supabase_admin


def _default_state() -> dict[str, Any]:
    return {
        "enabled": False,
        "title": DEFAULT_TITLE,
        "message": DEFAULT_MESSAGE,
        "image_url": None,
        "starts_at": None,
        "ends_at": None,
        "updated_at": None,
        "updated_by": None,
    }


def _normalize_state(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return _default_state()
    value = row.get("value") if isinstance(row, dict) else {}
    if not isinstance(value, dict):
        value = {}
    title = _clean_text(value.get("title"), DEFAULT_TITLE, 120)
    message = _clean_text(value.get("message"), DEFAULT_MESSAGE, 1000)
    return {
        "enabled": bool(value.get("enabled")),
        "title": title,
        "message": message,
        "image_url": _clean_url(value.get("image_url")),
        "starts_at": _clean_optional_text(value.get("starts_at"), 80),
        "ends_at": _clean_optional_text(value.get("ends_at"), 80),
        "updated_at": row.get("updated_at"),
        "updated_by": row.get("updated_by"),
    }


def get_maintenance_state(*, force: bool = False) -> dict[str, Any]:
    """Return current maintenance state. Missing table/config means disabled."""
    global _state_cache
    now = time.monotonic()
    if not force and _state_cache and _state_cache[0] > now:
        return dict(_state_cache[1])

    try:
        result = (
            _get_supabase_admin()
            .table("system_settings")
            .select("key, value, updated_at, updated_by")
            .eq("key", SETTING_KEY)
            .maybe_single()
            .execute()
        )
        state = _normalize_state(getattr(result, "data", None))
    except Exception:
        state = _default_state()

    _state_cache = (now + CACHE_TTL_SECONDS, state)
    return dict(state)


def set_maintenance_state(
    *,
    enabled: bool,
    title: str | None = None,
    message: str | None = None,
    image_url: str | None = None,
    starts_at: str | None = None,
    ends_at: str | None = None,
    updated_by: str | None = None,
) -> dict[str, Any]:
    global _state_cache
    next_state = {
        "enabled": bool(enabled),
        "title": _clean_text(title, DEFAULT_TITLE, 120),
        "message": _clean_text(message, DEFAULT_MESSAGE, 1000),
        "image_url": _clean_url(image_url),
        "starts_at": _clean_optional_text(starts_at, 80),
        "ends_at": _clean_optional_text(ends_at, 80),
    }
    payload = {
        "key": SETTING_KEY,
        "value": next_state,
        "updated_by": updated_by,
    }
    result = (
        _get_supabase_admin()
        .table("system_settings")
        .upsert(payload, on_conflict="key")
        .execute()
    )
    row = (getattr(result, "data", None) or [payload])[0]
    state = _normalize_state(row)
    _state_cache = (time.monotonic() + CACHE_TTL_SECONDS, state)
    return dict(state)


def maintenance_payload(state: dict[str, Any] | None = None) -> dict[str, Any]:
    current = state or get_maintenance_state()
    return {
        "error": current.get("message") or DEFAULT_MESSAGE,
        "detail": current.get("message") or DEFAULT_MESSAGE,
        "code": "MAINTENANCE_MODE",
        "maintenance": current,
    }


def _decode_token_payload(token: str) -> dict[str, Any]:
    try:
        payload_part = str(token or "").split(".")[1]
        padded = payload_part + "=" * (-len(payload_part) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("utf-8"))
        payload = json.loads(decoded.decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _as_utc_datetime(value: Any):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _is_token_revoked(token: str, profile: dict[str, Any]) -> bool:
    payload = _decode_token_payload(token)
    iat = payload.get("iat")
    if not iat:
        return False
    try:
        issued_at = datetime.fromtimestamp(float(iat), tz=timezone.utc)
    except Exception:
        return False
    cutoffs = [
        _as_utc_datetime(profile.get("session_revoked_at")),
        _as_utc_datetime(profile.get("password_changed_at")),
    ]
    latest_cutoff = max((dt for dt in cutoffs if dt is not None), default=None)
    return bool(latest_cutoff and issued_at <= latest_cutoff)


def is_admin_authorized(authorization: str | None) -> bool:
    """True only for a valid, non-revoked admin bearer token."""
    header = str(authorization or "").strip()
    if not header.startswith("Bearer "):
        return False
    token = header[7:].strip()
    if not token:
        return False
    try:
        sb = _get_supabase_admin()
        user_response = sb.auth.get_user(token)
        user = getattr(user_response, "user", None)
        if not user:
            return False
        user_id = str(getattr(user, "id", "") or "").strip()
        if not user_id:
            return False
        profile = (
            sb.table("profiles")
            .select("role, is_banned, session_revoked_at, password_changed_at")
            .eq("id", user_id)
            .single()
            .execute()
        )
        data = getattr(profile, "data", None) or {}
        return (
            str(data.get("role") or "").lower() == "admin"
            and not bool(data.get("is_banned"))
            and not _is_token_revoked(token, data)
        )
    except Exception:
        return False
