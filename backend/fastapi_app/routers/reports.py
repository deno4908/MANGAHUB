"""
Reports and support tickets router.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

from fastapi_app.dependencies import get_current_user, get_supabase
from fastapi_app.models.schemas import ReportCreate
from fastapi_app.utils.anti_spam import (
    check_fixed_window,
    enforce_fixed_window,
    enforce_user_action_limit,
    hash_value,
    request_fingerprint,
)
from fastapi_app.utils.email_delivery import send_support_ticket_email, support_email_configured

router = APIRouter()

REPORT_LIMIT_PER_MINUTE = 3
REPORT_LIMIT_PER_HOUR = 20
REPORT_IP_LIMIT_PER_MINUTE = 8
REPORT_IP_LIMIT_PER_HOUR = 60
REPORT_SAME_TARGET_WINDOW_SECONDS = 10 * 60

SUPPORT_EMAIL_LIMIT_PER_USER_10_MINUTES = 3
SUPPORT_EMAIL_LIMIT_PER_USER_HOUR = 8
SUPPORT_EMAIL_LIMIT_PER_IP_HOUR = 20


def _enforce_report_submit_limits(request: Request, user_id: str) -> None:
    fingerprint = request_fingerprint(request)
    enforce_fixed_window(
        f"report:ip:min:{fingerprint}",
        REPORT_IP_LIMIT_PER_MINUTE,
        60,
        detail="IP này đang gửi ticket quá nhanh",
    )
    enforce_fixed_window(
        f"report:ip:hour:{fingerprint}",
        REPORT_IP_LIMIT_PER_HOUR,
        60 * 60,
        detail="IP này đã gửi quá nhiều ticket",
    )
    enforce_user_action_limit(
        "report:min",
        user_id,
        limit=REPORT_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Gửi báo cáo quá nhanh",
    )
    enforce_user_action_limit(
        "report:hour",
        user_id,
        limit=REPORT_LIMIT_PER_HOUR,
        window_seconds=60 * 60,
        detail="Gửi báo cáo quá nhiều",
    )


def _allow_support_email_notification(request: Request, user_id: str) -> bool:
    fingerprint = request_fingerprint(request)
    checks = (
        (f"support-email:user:10m:{user_id}", SUPPORT_EMAIL_LIMIT_PER_USER_10_MINUTES, 10 * 60),
        (f"support-email:user:hour:{user_id}", SUPPORT_EMAIL_LIMIT_PER_USER_HOUR, 60 * 60),
        (f"support-email:ip:hour:{fingerprint}", SUPPORT_EMAIL_LIMIT_PER_IP_HOUR, 60 * 60),
    )
    for key, limit, window_seconds in checks:
        allowed, _, _ = check_fixed_window(key, limit, window_seconds)
        if not allowed:
            return False
    return True


@router.post("/")
async def create_report(
    request: Request,
    background_tasks: BackgroundTasks,
    data: ReportCreate,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Create a report/support ticket."""
    _enforce_report_submit_limits(request, user["id"])

    target_key = hash_value(
        f"{data.report_type.value}:{data.target_id or ''}:{data.title[:120]}"
    )
    enforce_fixed_window(
        f"report:same-target:{user['id']}:{target_key}",
        1,
        REPORT_SAME_TARGET_WINDOW_SECONDS,
        detail="Bạn vừa gửi báo cáo tương tự",
    )

    if data.report_type.value == "comment":
        target_id = str(data.target_id or "").strip()
        if not target_id:
            raise HTTPException(
                status_code=400,
                detail="Thiếu ID bình luận cần báo cáo",
            )
        comment_res = (
            db.table("comments")
            .select("id, user_id")
            .eq("id", target_id)
            .limit(1)
            .execute()
        )
        comment_rows = comment_res.data or []
        if not comment_rows:
            raise HTTPException(status_code=404, detail="Bình luận không tồn tại")
        comment_user_id = str(comment_rows[0].get("user_id") or "")
        if comment_user_id and comment_user_id == str(user["id"]):
            raise HTTPException(
                status_code=400,
                detail="Không thể tự báo cáo bình luận của chính bạn",
            )

    result = db.table("reports").insert({
        "reporter_id": user["id"],
        "report_type": data.report_type.value,
        "target_id": data.target_id,
        "title": data.title,
        "description": data.description,
    }).execute()

    report = result.data[0] if result.data else None
    email_status = "not_created"
    if not report:
        email_status = "not_created"
    elif not support_email_configured():
        email_status = "not_configured"
    elif not _allow_support_email_notification(request, user["id"]):
        email_status = "rate_limited"
    else:
        email_status = "queued"
        background_tasks.add_task(
            send_support_ticket_email,
            report=report,
            reporter=user,
        )

    return {
        "message": "Đã gửi báo cáo. Cảm ơn bạn!",
        "report": report,
        "support_email": {
            "to": "cskh.mangahub@gmail.com",
            "status": email_status,
        },
    }


@router.get("/")
async def get_my_reports(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Get current user's reports."""
    result = db.table("reports").select("*").eq(
        "reporter_id", user["id"]
    ).order("created_at", desc=True).execute()
    return {"reports": result.data}
