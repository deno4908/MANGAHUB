"""Shared VIP expiry enforcement for the Flask and FastAPI services."""

from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from time import monotonic
from typing import Any


_sweep_lock = Lock()
_last_sweep_at = 0.0


def parse_vip_expiry(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def has_active_vip(profile: dict[str, Any] | None, *, now: datetime | None = None) -> bool:
    data = profile or {}
    if not bool(data.get("is_vip")):
        return False

    raw_expiry = data.get("vip_expiry")
    if raw_expiry in (None, ""):
        return True

    expiry = parse_vip_expiry(raw_expiry)
    current = now or datetime.now(timezone.utc)
    current = current if current.tzinfo else current.replace(tzinfo=timezone.utc)
    return bool(expiry and expiry > current)


def normalize_vip_profile(
    profile: dict[str, Any] | None,
    db: Any | None = None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Remove expired VIP access immediately and persist it when possible."""
    if not isinstance(profile, dict):
        return {}
    if not bool(profile.get("is_vip")) or has_active_vip(profile, now=now):
        return profile

    raw_expiry = profile.get("vip_expiry")
    profile["is_vip"] = False
    profile["vip_expiry"] = None

    user_id = str(profile.get("id") or "").strip()
    if db is None or not user_id:
        return profile

    try:
        query = (
            db.table("profiles")
            .update({"is_vip": False, "vip_expiry": None})
            .eq("id", user_id)
            .eq("is_vip", True)
        )
        if raw_expiry not in (None, ""):
            query = query.eq("vip_expiry", raw_expiry)
        query.execute()
    except Exception:
        # Access is still denied in this response even if persistence is down.
        pass
    return profile


def revoke_expired_vips(
    db: Any,
    *,
    force: bool = False,
    min_interval_seconds: float = 30.0,
) -> int:
    """Atomically revoke every elapsed VIP row, with optional process throttling."""
    global _last_sweep_at

    current_tick = monotonic()
    with _sweep_lock:
        if not force and current_tick - _last_sweep_at < max(0.0, min_interval_seconds):
            return 0
        _last_sweep_at = current_tick

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        result = (
            db.table("profiles")
            .update({"is_vip": False, "vip_expiry": None})
            .eq("is_vip", True)
            .lte("vip_expiry", now_iso)
            .execute()
        )
        rows = getattr(result, "data", None)
        return len(rows) if isinstance(rows, list) else 0
    except Exception:
        return 0
