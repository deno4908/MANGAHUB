"""
Reading history router.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from fastapi_app.dependencies import get_current_user, get_supabase
from fastapi_app.models.schemas import HistoryEntry
from fastapi_app.utils.anti_spam import enforce_user_action_limit

router = APIRouter()

HISTORY_UPDATE_LIMIT_PER_MINUTE = 90
HISTORY_UPDATE_LIMIT_PER_10_MINUTES = 600


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

        if rows:
            keep_id = rows[0]["id"]
            db.table("reading_history").update(payload).eq("id", keep_id).execute()

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

        return {"message": "Đã cập nhật lịch sử"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
