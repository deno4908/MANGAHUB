"""
Notifications router.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from fastapi_app.dependencies import get_current_user, get_supabase

router = APIRouter()
logger = logging.getLogger(__name__)


def _execute_safe(label: str, fn):
    try:
        return fn()
    except Exception as exc:
        logger.warning("notifications.%s failed: %s", label, exc)
        return None


@router.get("/")
async def get_notifications(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Lấy danh sách thông báo (có phân trang)."""
    offset = (page - 1) * limit
    result = await asyncio.to_thread(_execute_safe,
        "get_list",
        lambda: (
            db.table("notifications")
            .select("*")
            .eq("user_id", user["id"])
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        ),
    )

    unread = await asyncio.to_thread(_execute_safe,
        "get_unread_count",
        lambda: (
            db.table("notifications")
            .select("id", count="exact")
            .eq("user_id", user["id"])
            .eq("is_read", False)
            .execute()
        ),
    )

    notifications = (result.data or []) if result is not None else []
    unread_count = int(getattr(unread, "count", 0) or 0)

    return {
        "notifications": notifications,
        "unread_count": unread_count,
        "page": page,
        "limit": limit,
        "degraded": result is None or unread is None,
    }


@router.put("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Đánh dấu đã đọc."""
    updated = await asyncio.to_thread(_execute_safe,
        "mark_read",
        lambda: db.table("notifications")
        .update({"is_read": True})
        .eq("id", notification_id)
        .eq("user_id", user["id"])
        .execute(),
    )
    if updated is None:
        raise HTTPException(status_code=503, detail="Dịch vụ thông báo tạm thời không khả dụng")
    return {"message": "Đã đánh dấu đã đọc"}


@router.put("/read-all")
async def mark_all_read(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Đánh dấu tất cả đã đọc."""
    updated = await asyncio.to_thread(_execute_safe,
        "mark_all_read",
        lambda: db.table("notifications")
        .update({"is_read": True})
        .eq("user_id", user["id"])
        .eq("is_read", False)
        .execute(),
    )
    if updated is None:
        raise HTTPException(status_code=503, detail="Dịch vụ thông báo tạm thời không khả dụng")
    return {"message": "Đã đánh dấu tất cả đã đọc"}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Xóa thông báo."""
    deleted = await asyncio.to_thread(_execute_safe,
        "delete_one",
        lambda: db.table("notifications")
        .delete()
        .eq("id", notification_id)
        .eq("user_id", user["id"])
        .execute(),
    )
    if deleted is None:
        raise HTTPException(status_code=503, detail="Dịch vụ thông báo tạm thời không khả dụng")
    return {"message": "Đã xóa thông báo"}


@router.delete("/")
async def clear_notifications(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Xóa toàn bộ thông báo."""
    deleted = await asyncio.to_thread(_execute_safe,
        "delete_all",
        lambda: db.table("notifications").delete().eq("user_id", user["id"]).execute(),
    )
    if deleted is None:
        raise HTTPException(status_code=503, detail="Dịch vụ thông báo tạm thời không khả dụng")
    return {"message": "Đã xóa toàn bộ thông báo"}
