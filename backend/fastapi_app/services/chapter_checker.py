"""
Background job: Check followed manga for new chapters and create notifications.
Runs periodically via FastAPI lifespan.
"""
import asyncio
import logging
from datetime import datetime, timezone
from fastapi_app.services import otruyen_service
from fastapi_app.dependencies import get_supabase_admin

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 600  # Check every 10 minutes


async def _check_new_chapters():
    """
    For each unique manga_slug in follows table:
    1. Fetch latest chapter info from OTruyen API
    2. Compare with last known chapter stored in manga_chapter_cache
    3. If new chapter found, create notifications for all followers
    """
    try:
        db = get_supabase_admin()

        # Get all unique followed manga slugs
        follows_result = db.table("follows").select("manga_slug, manga_title").execute()
        if not follows_result.data:
            return

        # Deduplicate slugs
        seen = set()
        manga_list = []
        for f in follows_result.data:
            slug = f["manga_slug"]
            if slug not in seen:
                seen.add(slug)
                manga_list.append({"slug": slug, "title": f.get("manga_title", slug)})

        logger.info(f"[ChapterCheck] Checking {len(manga_list)} followed manga...")

        for manga in manga_list:
            try:
                await _check_single_manga(db, manga["slug"], manga["title"])
            except Exception as e:
                logger.debug(f"[ChapterCheck] Error checking {manga['slug']}: {e}")

            # Delay between API calls to be polite
            await asyncio.sleep(0.5)

    except Exception as e:
        logger.error(f"[ChapterCheck] Fatal error: {e}")


async def _check_single_manga(db, manga_slug: str, manga_title: str):
    """Check a single manga for new chapters."""
    # Get manga detail from OTruyen
    detail = await otruyen_service.get_manga_detail(manga_slug)
    if not detail or detail.get("status") == "error":
        return

    # Extract latest chapter info
    item = detail.get("data", {}).get("item", {})
    if not item:
        return

    chapters = item.get("chapters", [])
    if not chapters or not chapters[0].get("server_data"):
        return

    server_data = chapters[0]["server_data"]
    if not server_data:
        return

    # Get the latest chapter
    latest = server_data[0]  # First item is usually the latest
    latest_chapter_name = latest.get("chapter_name", "")
    latest_chapter_api = latest.get("chapter_api_data", "")

    # Extract chapter_id from API URL
    chapter_id = latest_chapter_api.split("/")[-1] if latest_chapter_api else ""

    if not chapter_id or not latest_chapter_name:
        return

    # Check if we already notified about this chapter
    # Use a simple cache key to track last known chapter per manga
    cache_key = f"last_chapter:{manga_slug}"
    from fastapi_app.services.cache_service import cache
    last_known = cache.get(cache_key)

    if last_known == chapter_id:
        return  # Already notified

    # If this is the first time tracking, just store and skip notification
    if last_known is None:
        cache.set(cache_key, chapter_id, 86400 * 7)  # Store for 7 days
        return

    # New chapter found! Create notifications for all followers
    logger.info(f"[ChapterCheck] New chapter for {manga_slug}: Ch.{latest_chapter_name}")

    # Get all users following this manga
    followers = db.table("follows").select("user_id").eq(
        "manga_slug", manga_slug
    ).execute()

    if not followers.data:
        cache.set(cache_key, chapter_id, 86400 * 7)
        return

    # Create notification for each follower
    notifications = []
    for follower in followers.data:
        notifications.append({
            "user_id": follower["user_id"],
            "type": "new_chapter",
            "title": f"Chương mới: {manga_title}",
            "message": f"Chương {latest_chapter_name} đã được cập nhật!",
            "manga_slug": manga_slug,
            "chapter_id": chapter_id,
            "is_read": False,
        })

    # Batch insert notifications
    if notifications:
        try:
            db.table("notifications").insert(notifications).execute()
            logger.info(
                f"[ChapterCheck] Created {len(notifications)} notifications "
                f"for {manga_slug} Ch.{latest_chapter_name}"
            )
        except Exception as e:
            logger.error(f"[ChapterCheck] Failed to insert notifications: {e}")

    # Update last known chapter
    cache.set(cache_key, chapter_id, 86400 * 7)


async def chapter_check_loop():
    """Background loop that periodically checks for new chapters."""
    logger.info("[ChapterCheck] Starting background chapter check loop...")
    # Wait a bit before first check to let the server start
    await asyncio.sleep(30)

    while True:
        try:
            await _check_new_chapters()
        except Exception as e:
            logger.error(f"[ChapterCheck] Loop error: {e}")

        await asyncio.sleep(CHECK_INTERVAL)
