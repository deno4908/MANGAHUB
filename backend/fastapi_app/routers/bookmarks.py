"""
Bookmarks & Follows router.
"""
import logging
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi_app.dependencies import get_current_user, get_supabase
from fastapi_app.models.schemas import MangaAction
from fastapi_app.utils.anti_spam import enforce_user_action_limit

router = APIRouter()
logger = logging.getLogger(__name__)
LIBRARY_WRITE_LIMIT_PER_MINUTE = 40
LIBRARY_WRITE_LIMIT_PER_10_MINUTES = 180


def _thumb_from_slug(slug: str, thumb: str = "") -> str:
    if thumb:
        return thumb
    slug = str(slug or "").strip()
    if not slug:
        return ""
    manga_id = re.sub(r"^mangadex[-:]", "", slug, flags=re.I)
    if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", manga_id, re.I):
        return f"/api/manga/mangadex-cover/{manga_id}"
    return f"/api/manga/truyenqq/cover/{quote(slug, safe='')}"


def _enforce_library_write_limit(user_id: str) -> None:
    enforce_user_action_limit(
        "library-write:min",
        user_id,
        limit=LIBRARY_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác thư viện quá nhanh",
    )
    enforce_user_action_limit(
        "library-write:10m",
        user_id,
        limit=LIBRARY_WRITE_LIMIT_PER_10_MINUTES,
        window_seconds=10 * 60,
        detail="Thao tác thư viện quá nhiều",
    )


# ============================================================
# BOOKMARKS
# ============================================================
@router.get("/")
async def get_bookmarks(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Lấy danh sách bookmark."""
    result = db.table("bookmarks").select("*").eq(
        "user_id", user["id"]
    ).order("created_at", desc=True).execute()
    items = result.data or []
    for it in items:
        it["manga_thumb"] = _thumb_from_slug(it.get("manga_slug", ""), it.get("manga_thumb", ""))
    return {"bookmarks": items}


@router.post("/")
async def add_bookmark(
    request: Request,
    data: MangaAction,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Thêm bookmark."""
    _ = request
    _enforce_library_write_limit(user["id"])
    try:
        db.table("bookmarks").insert({
            "user_id": user["id"],
            "manga_slug": data.manga_slug,
            "manga_title": data.manga_title,
            "manga_thumb": _thumb_from_slug(data.manga_slug, data.manga_thumb),
        }).execute()
        return {"message": "Đã bookmark"}
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return {"message": "Đã bookmark trước đó"}
        logger.exception("Bookmark creation failed")
        raise HTTPException(status_code=500, detail="Không thể lưu truyện lúc này") from e


@router.delete("/{manga_slug}")
async def remove_bookmark(
    request: Request,
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Xóa bookmark."""
    _ = request
    _enforce_library_write_limit(user["id"])
    db.table("bookmarks").delete().eq(
        "user_id", user["id"]
    ).eq("manga_slug", manga_slug).execute()
    return {"message": "Đã xóa bookmark"}


@router.get("/check/{manga_slug}")
async def check_bookmark(
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Kiểm tra đã bookmark chưa."""
    result = db.table("bookmarks").select("manga_slug").eq(
        "user_id", user["id"]
    ).eq("manga_slug", manga_slug).execute()
    return {"is_bookmarked": len(result.data) > 0}


# ============================================================
# FOLLOWS
# ============================================================
@router.get("/follows")
async def get_follows(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Lấy danh sách theo dõi."""
    result = db.table("follows").select("*").eq(
        "user_id", user["id"]
    ).order("created_at", desc=True).execute()
    items = result.data or []
    for it in items:
        it["manga_thumb"] = _thumb_from_slug(it.get("manga_slug", ""), it.get("manga_thumb", ""))
    return {"follows": items}


@router.post("/follows")
async def add_follow(
    request: Request,
    data: MangaAction,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Theo dõi truyện."""
    _ = request
    _enforce_library_write_limit(user["id"])
    try:
        db.table("follows").insert({
            "user_id": user["id"],
            "manga_slug": data.manga_slug,
            "manga_title": data.manga_title,
            "manga_thumb": _thumb_from_slug(data.manga_slug, data.manga_thumb),
        }).execute()
        return {"message": "Đã theo dõi"}
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return {"message": "Đã theo dõi trước đó"}
        logger.exception("Follow creation failed")
        raise HTTPException(status_code=500, detail="Không thể theo dõi truyện lúc này") from e


@router.delete("/follows/{manga_slug}")
async def remove_follow(
    request: Request,
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Bỏ theo dõi."""
    _ = request
    _enforce_library_write_limit(user["id"])
    db.table("follows").delete().eq(
        "user_id", user["id"]
    ).eq("manga_slug", manga_slug).execute()
    return {"message": "Đã bỏ theo dõi"}


@router.get("/follows/check/{manga_slug}")
async def check_follow(
    manga_slug: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Kiểm tra đã theo dõi chưa."""
    result = db.table("follows").select("manga_slug").eq(
        "user_id", user["id"]
    ).eq("manga_slug", manga_slug).execute()
    return {"is_following": len(result.data) > 0}
