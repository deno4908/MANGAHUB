"""
Background tasks for Manga-Bliss.
"""
from workers.celery_app import celery_app
from supabase import create_client
from config import config

db = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)


@celery_app.task(name="send_chapter_notifications")
def send_chapter_notifications(manga_slug: str, manga_title: str, chapter_name: str):
    """
    Send notifications to all followers when a new chapter is available.
    Called asynchronously when we detect new chapters.
    """
    # Get all followers of this manga
    followers = db.table("follows").select("user_id").eq(
        "manga_slug", manga_slug
    ).execute()

    if not followers.data:
        return {"sent": 0}

    # Batch insert notifications
    notifications = []
    for f in followers.data:
        notifications.append({
            "user_id": f["user_id"],
            "type": "new_chapter",
            "title": "Chapter mới",
            "message": f"{manga_title} - Chương {chapter_name} đã được cập nhật!",
            "manga_slug": manga_slug,
        })

    if notifications:
        db.table("notifications").insert(notifications).execute()

    return {"sent": len(notifications)}


@celery_app.task(name="cleanup_old_notifications")
def cleanup_old_notifications(days: int = 30):
    """Remove notifications older than N days."""
    from datetime import datetime, timedelta
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()

    db.table("notifications").delete().lt("created_at", cutoff).eq(
        "is_read", True
    ).execute()

    return {"status": "cleaned"}


@celery_app.task(name="update_reading_streaks")
def update_reading_streaks():
    """
    Daily task to update reading streaks for all users.
    Run via: celery -A workers.celery_app beat
    """
    from datetime import datetime, timedelta

    yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    today = datetime.utcnow().strftime("%Y-%m-%d")

    # Get all users
    users = db.table("profiles").select("id, reading_streak").execute()

    for user in users.data or []:
        # Check if user read anything yesterday
        history = db.table("reading_history").select("id", count="exact").eq(
            "user_id", user["id"]
        ).gte("read_at", f"{yesterday}T00:00:00").lt(
            "read_at", f"{today}T00:00:00"
        ).execute()

        if history.count and history.count > 0:
            # Increment streak
            db.table("profiles").update({
                "reading_streak": (user.get("reading_streak", 0) or 0) + 1
            }).eq("id", user["id"]).execute()
        else:
            # Reset streak
            db.table("profiles").update({
                "reading_streak": 0
            }).eq("id", user["id"]).execute()

    return {"updated": len(users.data or [])}
