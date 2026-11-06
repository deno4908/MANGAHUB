"""
Reading history router.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from fastapi_app.dependencies import get_current_user, get_supabase
from fastapi_app.models.schemas import HistoryEntry
from fastapi_app.routers.users import clear_user_stats_cache
from fastapi_app.utils.anti_spam import enforce_user_action_limit

router = APIRouter()
logger = logging.getLogger(__name__)

HISTORY_UPDATE_LIMIT_PER_MINUTE = 90
HISTORY_UPDATE_LIMIT_PER_10_MINUTES = 600
READING_ACTIVITY_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


@router.get("/manga/{manga_slug}")
async def get_manga_history(
    manga_slug: str,
    aliases: str = Query("", max_length=2048),
    user=Depends(get_current_user), db=Depends(get_supabase),
):
    """Read one manga's checkpoint even beyond the 100-item library window."""
    from fastapi_app.routers.ratings import _normalize_manga_slug, _slug_candidates
    from fastapi_app.services.qq_statistics import cached_aliases

    requested = list(dict.fromkeys(_normalize_manga_slug(value)
        for value in [manga_slug, *aliases.split(",")[:12]] if value.strip()))
    if not requested:
        return {"history": None}
    verified = await asyncio.to_thread(cached_aliases, requested)
    candidates = list(dict.fromkeys(candidate for value in requested for candidate in _slug_candidates(value, verified)))
    result = await asyncio.to_thread(lambda: db.table("reading_history").select("*")
        .eq("user_id", user["id"]).in_("manga_slug", candidates).order("read_at", desc=True).limit(1).execute())
    return {"history": (result.data or [None])[0]}


def _parse_client_read_at(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if parsed > now + timedelta(minutes=5):
            return now
        return parsed
    except Exception:
        return None


def _activity_date_for(read_at: datetime) -> str:
    return read_at.astimezone(READING_ACTIVITY_TZ).date().isoformat()


def _record_reading_activity_event(db, user_id: str, data: HistoryEntry, read_at: datetime) -> None:
    manga_slug = str(data.manga_slug or "").strip()
    if not user_id or not manga_slug:
        return
    try:
        db.rpc(
            "record_reading_activity_event",
            {
                "p_user_id": user_id,
                "p_manga_slug": manga_slug,
                "p_chapter_id": str(data.chapter_id or "").strip(),
                "p_activity_date": _activity_date_for(read_at),
                "p_read_at": read_at.isoformat(),
            },
        ).execute()
    except Exception:
        # The migration may not be applied yet; history should still work.
        pass


@router.get("/")
async def get_history(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Get reading history, newest first."""
    result = (
        db.table("reading_history")
        .select("*")
        .eq("user_id", user["id"])
        .order("read_at", desc=True)
        .limit(100)
        .execute()
    )

    seen = set()
    deduped = []
    for row in result.data or []:
        slug = row.get("manga_slug")
        if slug in seen:
            continue
        seen.add(slug)
        deduped.append(row)

    return {"history": deduped}


@router.post("/")
async def add_or_update_history(
    request: Request,
    data: HistoryEntry,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Add/update reading history, keeping one row per manga."""
    _ = request
    enforce_user_action_limit(
        "history:min",
        user["id"],
        limit=HISTORY_UPDATE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Cập nhật lịch sử đọc quá nhanh",
    )
    enforce_user_action_limit(
        "history:10m",
        user["id"],
        limit=HISTORY_UPDATE_LIMIT_PER_10_MINUTES,
        window_seconds=10 * 60,
        detail="Cập nhật lịch sử đọc quá nhiều",
    )

    return await asyncio.to_thread(_persist_history, data, user, db)


def _persist_history(data: HistoryEntry, user: dict, db):
    """Keep blocking database work off the API event loop while reading."""
    try:
        now_dt = datetime.now(timezone.utc)
        client_read_at = _parse_client_read_at(data.client_read_at)
        read_at_dt = client_read_at or now_dt
        now_iso = read_at_dt.isoformat()
        existing = (
            db.table("reading_history")
            .select("id,manga_title,manga_thumb,read_at")
            .eq("user_id", user["id"])
            .eq("manga_slug", data.manga_slug)
            .order("read_at", desc=True)
            .execute()
        )
        rows = existing.data or []

        existing_row = rows[0] if rows else {}
        existing_title = str(existing_row.get("manga_title") or "").strip()
        existing_thumb = str(existing_row.get("manga_thumb") or "").strip()
        incoming_title = str(data.manga_title or "").strip()
        incoming_thumb = str(data.manga_thumb or "").strip()
        existing_read_at = _parse_client_read_at(str(existing_row.get("read_at") or ""))
        if existing_read_at and read_at_dt < existing_read_at:
            return {"message": "Bỏ qua cập nhật lịch sử cũ", "stale": True}

        payload = {
            "user_id": user["id"],
            "manga_slug": data.manga_slug,
            "manga_title": incoming_title or existing_title,
            "manga_thumb": incoming_thumb or existing_thumb,
            "chapter_id": data.chapter_id,
            "chapter_name": data.chapter_name,
            "page": data.page,
            "progress": data.progress,
            "read_at": now_iso,
        }

        _record_reading_activity_event(db, user["id"], data, read_at_dt)

        if rows:
            keep_id = rows[0]["id"]
            updated = (db.table("reading_history").update(payload).eq("id", keep_id)
                .or_(f"read_at.is.null,read_at.lte.{now_iso}").execute())
            if not updated.data:
                return {"message": "Bỏ qua cập nhật lịch sử cũ", "stale": True}

            dup_ids = [r["id"] for r in rows[1:]]
            if dup_ids:
                db.table("reading_history").delete().in_("id", dup_ids).execute()
                try:
                    count_result = (
                        db.table("reading_history")
                        .select("id", count="exact")
                        .eq("user_id", user["id"])
                        .execute()
                    )
                    db.table("profiles").update({"chapters_read": count_result.count or 0}).eq(
                        "id", user["id"]
                    ).execute()
                except Exception:
                    pass
        else:
            db.table("reading_history").insert(payload).execute()
            try:
                current = (
                    db.table("profiles")
                    .select("chapters_read")
                    .eq("id", user["id"])
                    .maybe_single()
                    .execute()
                )
                chapters_read = int(((current.data or {}).get("chapters_read") or 0)) + 1
                db.table("profiles").update({"chapters_read": chapters_read}).eq(
                    "id", user["id"]
                ).execute()
            except Exception:
                pass

        clear_user_stats_cache(user["id"])
        return {"message": "Đã cập nhật lịch sử"}
    except Exception as e:
        logger.exception("Reading history update failed")
        raise HTTPException(status_code=500, detail="Không thể cập nhật lịch sử đọc lúc này") from e


@router.delete("/{manga_slug}")
async def remove_history(
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Remove one manga from reading history."""
    await asyncio.to_thread(
        lambda: db.table("reading_history").delete().eq("user_id", user["id"]).eq(
            "manga_slug", manga_slug
        ).execute()
    )
    return {"message": "Đã xóa lịch sử"}


@router.delete("/")
async def clear_history(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Clear all reading history."""
    await asyncio.to_thread(
        lambda: db.table("reading_history").delete().eq("user_id", user["id"]).execute()
    )
    return {"message": "Đã xóa toàn bộ lịch sử"}
