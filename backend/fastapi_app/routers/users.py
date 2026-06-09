"""
Users router — profile, settings, stats.
"""

import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from PIL import Image, ImageSequence

from fastapi_app.dependencies import (
    get_current_user,
    get_optional_user,
    get_supabase,
    get_supabase_public,
)
from fastapi_app.models.schemas import ProfileResponse, ProfileUpdate, SettingsUpdate
from fastapi_app.utils.upload_security import IMAGE_EXT_BY_CONTENT_TYPE, read_upload_limited

router = APIRouter()

AVATAR_BUCKET = "manga-pages"
AVATAR_FOLDER = "avatars"
AVATAR_MAX_SIZE = 5 * 1024 * 1024  # 5MB
ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Short-lived in-process cache to keep user profile widgets responsive.
USER_STATS_CACHE_TTL_SECONDS = 45
USER_STATS_STALE_TTL_SECONDS = 10 * 60
USER_STATS_WEEKLY_HISTORY_LIMIT = 2000
USER_STATS_STREAK_HISTORY_LIMIT = 1200
_USER_STATS_CACHE: dict[str, tuple[dict, float]] = {}
PUBLIC_PROFILE_CACHE_TTL_SECONDS = 20
PUBLIC_PROFILE_ACTIVITY_LIMIT = 12
PUBLIC_PROFILE_SELECT = (
    "id, username, display_name, avatar, bio, role, is_vip, "
    "name_color, name_font, name_effect, chapters_read, total_reading_time, "
    "comments_posted, reading_streak, created_at"
)

DEFAULT_USER_SETTINGS: dict[str, object] = {
    "reading_mode": "vertical",
    "page_direction": "ltr",
    "image_fit": "width",
    "image_loading": "preload",
    "auto_hide_toolbar": True,
    "show_page_number": True,
    "show_progress_bar": True,
    "auto_bookmark": True,
    "auto_follow": False,
    "notify_new_chapter": True,
    "notify_comment_reply": True,
    "notify_system": True,
    "notify_email": False,
    "profile_visibility": "public",
    "show_reading_history": True,
    "show_followed_manga": True,
    "show_comments": True,
    "show_mature_content": False,
}

ALLOWED_NAME_COLORS = {
    "",
    "#ef4444",
    "#e62e2e",
    "#dc2626",
    "#f87171",
    "#e11d48",
    "#f97316",
    "#fb923c",
    "#f59e0b",
    "#facc15",
    "#eab308",
    "#fbbf24",
    "#10b981",
    "#4ade80",
    "#84cc16",
    "#22c55e",
    "#16a34a",
    "#3b82f6",
    "#0ea5e9",
    "#06b6d4",
    "#14b8a6",
    "#2563eb",
    "#60a5fa",
    "#8b5cf6",
    "#a855f7",
    "#7c3aed",
    "#c084fc",
    "#d946ef",
    "#ec4899",
    "#f472b6",
    "#ffffff",
    "#94a3b8",
    "#1e293b",
    "#78716c",
    "#b45309",
}
FREE_NAME_COLORS = {
    "",
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#94a3b8",
}
PREMIUM_NAME_COLORS = ALLOWED_NAME_COLORS - FREE_NAME_COLORS

ALLOWED_NAME_FONTS = {
    "default",
    "serif",
    "mono",
    "cursive",
    "fantasy",
    "rounded",
    "bold",
    "thin",
    "condensed",
    "wide",
    "uppercase",
    "lowercase",
    "capitalize",
    "smallcaps",
    "heavy",
    "elegant",
    "tech",
    "handwrite",
    "gothic",
    "retro-font",
    "pixel",
    "newspaper",
    "whisper",
    "military",
    "manga-style",
    "minimal",
    "typewriter",
    "display",
    "sketch",
    "royal",
    "cinematic",
    "luxe",
    "stencil",
    "hacker",
    "titan",
    "airy",
    "comic-pop",
    "bookish",
    "razor",
    "rune",
    "zen",
    "noble",
}
FREE_NAME_FONTS = {
    "default",
    "serif",
    "mono",
    "cursive",
    "rounded",
    "bold",
    "uppercase",
    "lowercase",
    "capitalize",
}
PREMIUM_NAME_FONTS = ALLOWED_NAME_FONTS - FREE_NAME_FONTS
PREMIUM_NAME_STYLE_ROLES = {"admin", "moderator"}

ALLOWED_NAME_EFFECTS = {
    "none",
    "glow",
    "shadow",
    "gradient",
    "underline",
    "italic",
    "retro",
    "outline",
    "double-shadow",
    "emboss",
    "wave-underline",
    "strikethrough",
    "frost",
    "metallic",
    "blood",
    "gold",
    "silver",
    "copper",
    "electric",
    "sunset",
    "ocean",
    "toxic",
    "hologram",
    "galaxy",
    "cherry",
    "matrix",
    "prism",
    "rose-gold",
    "midnight",
    "mint-glow",
    "comic-shadow",
    "crystal",
    "ember",
    "starlight",
    "neon-glow",
    "fire-text",
    "rainbow",
    "glitch",
    "blur-glow",
    "color-cycle",
    "flicker",
    "glow-pulse",
    "rainbow-shift",
    "aurora",
    "lava",
    "ice-shimmer",
    "neon-pulse",
    "galaxy-shift",
    "prism-flow",
    "cyber-scan",
    "comet-trail",
    "storm-flicker",
    "blossom-breeze",
}
FREE_NAME_EFFECTS = {"none"}
PREMIUM_NAME_EFFECTS = ALLOWED_NAME_EFFECTS - FREE_NAME_EFFECTS


def _user_stats_cache_get(key: str) -> dict | None:
    entry = _USER_STATS_CACHE.get(key)
    if entry and time.monotonic() < entry[1]:
        return entry[0]
    _USER_STATS_CACHE.pop(key, None)
    return None


def _user_stats_cache_set(key: str, payload: dict, ttl: float) -> None:
    _USER_STATS_CACHE[key] = (payload, time.monotonic() + ttl)


def _user_stats_cache_set_with_stale(key: str, payload: dict, ttl: float, stale_ttl: float) -> None:
    _user_stats_cache_set(key, payload, ttl)
    _user_stats_cache_set(f"{key}:stale", payload, stale_ttl)


def _public_profile_cache_key(user_id: str) -> str:
    return f"public-profile:{str(user_id or '').strip()}"


def _clear_public_profile_cache(user_id: str) -> None:
    _USER_STATS_CACHE.pop(_public_profile_cache_key(user_id), None)


def _build_default_user_settings(user_id: str) -> dict[str, object]:
    payload = dict(DEFAULT_USER_SETTINGS)
    payload["user_id"] = str(user_id or "").strip()
    return payload


def _safe_get_user_settings(db, user_id: str):
    return (
        db.table("user_settings")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )


def _normalize_profile_visibility(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"public", "private"}:
        return normalized
    return "public"


def _normalize_search_pattern(value: str) -> str:
    text = " ".join(str(value or "").split()).strip()
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _normalize_name_effect(value: object) -> str:
    effect = str(value or "").strip()
    return effect or "none"


def _normalize_name_color(value: object) -> str:
    return str(value or "").strip().lower()


def _normalize_name_font(value: object) -> str:
    font = str(value or "").strip()
    return font or "default"


def _has_premium_name_style_access(profile_data: dict | None) -> bool:
    data = profile_data or {}
    role = str(data.get("role") or "").strip().lower()
    return bool(data.get("is_vip")) or role in PREMIUM_NAME_STYLE_ROLES


def _fetch_name_style_access_profile(db, user_id: str) -> dict:
    result = (
        db.table("profiles")
        .select("role, is_vip")
        .eq("id", user_id)
        .single()
        .execute()
    )
    return result.data or {}


def _public_settings_from_row(user_id: str, row: dict | None) -> dict[str, object]:
    settings = _build_default_user_settings(user_id)
    if isinstance(row, dict):
        settings.update({k: v for k, v in row.items() if v is not None})
    settings["profile_visibility"] = _normalize_profile_visibility(
        settings.get("profile_visibility")
    )
    return settings


def _get_public_profile_settings(db, user_id: str) -> dict[str, object]:
    try:
        result = _safe_get_user_settings(db, user_id)
        if result and result.data:
            return _public_settings_from_row(user_id, result.data)
    except Exception:
        pass
    return _public_settings_from_row(user_id, None)


def _can_view_public_profile(
    profile: dict,
    settings: dict[str, object],
    viewer: dict | None,
) -> tuple[bool, str, bool]:
    viewer_id = str((viewer or {}).get("id") or "").strip()
    owner_id = str((profile or {}).get("id") or "").strip()
    is_self = bool(viewer_id and owner_id and viewer_id == owner_id)
    visibility = _normalize_profile_visibility(settings.get("profile_visibility"))

    if is_self:
        return True, visibility, True
    if visibility == "private":
        return False, visibility, False
    return True, visibility, False


def _fallback_manga_thumb(slug: object, thumb: object = "") -> str:
    thumb_text = str(thumb or "").strip()
    if thumb_text:
        return thumb_text
    slug_text = str(slug or "").strip()
    if not slug_text or len(slug_text) >= 32:
        return ""
    return f"https://img.otruyenapi.com/uploads/comics/{slug_text}-thumb.jpg"


def _fetch_public_manga_rows(
    db,
    table: str,
    user_id: str,
    select_fields: str,
    order_field: str,
    limit: int = PUBLIC_PROFILE_ACTIVITY_LIMIT,
) -> list[dict]:
    try:
        result = (
            db.table(table)
            .select(select_fields)
            .eq("user_id", user_id)
            .order(order_field, desc=True)
            .limit(limit)
            .execute()
        )
    except Exception:
        return []

    rows = result.data or []
    for row in rows:
        if not isinstance(row, dict):
            continue
        row["manga_thumb"] = _fallback_manga_thumb(
            row.get("manga_slug"),
            row.get("manga_thumb") or row.get("thumb"),
        )
    return rows


def _fetch_public_comments(
    db,
    user_id: str,
    limit: int = PUBLIC_PROFILE_ACTIVITY_LIMIT,
) -> list[dict]:
    try:
        result = (
            db.table("comments")
            .select("id, manga_slug, chapter_id, content, image_url, likes, reactions, created_at")
            .eq("user_id", user_id)
            .eq("is_deleted", False)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception:
        return []
    return result.data or []


def _clean_public_text(value: object) -> str:
    return str(value or "").strip()


def _merge_public_manga_title_rows(
    title_by_slug: dict[str, str],
    rows: list[dict],
    *,
    slug_key: str = "manga_slug",
    title_keys: tuple[str, ...] = ("manga_title", "title"),
) -> None:
    for row in rows or []:
        slug = _clean_public_text((row or {}).get(slug_key))
        if not slug or slug in title_by_slug:
            continue
        for title_key in title_keys:
            title = _clean_public_text((row or {}).get(title_key))
            if title and title != slug:
                title_by_slug[slug] = title
                break


def _enrich_public_comment_manga_titles(db, user_id: str, comments: list[dict]) -> None:
    slugs: list[str] = []
    for comment in comments or []:
        slug = _clean_public_text((comment or {}).get("manga_slug"))
        if slug and slug not in slugs:
            slugs.append(slug)
    if not slugs:
        return

    title_by_slug: dict[str, str] = {}

    def fetch_titles(table: str, select_expr: str, *, user_scoped: bool) -> None:
        try:
            query = db.table(table).select(select_expr).in_("manga_slug", slugs)
            if user_scoped:
                query = query.eq("user_id", user_id)
            result = query.execute()
            _merge_public_manga_title_rows(title_by_slug, result.data or [])
        except Exception:
            pass

    fetch_titles("reading_history", "manga_slug,manga_title", user_scoped=True)
    fetch_titles("bookmarks", "manga_slug,manga_title", user_scoped=True)
    fetch_titles("follows", "manga_slug,manga_title", user_scoped=True)
    fetch_titles("manga_uploads", "manga_slug,title", user_scoped=False)
    fetch_titles("chapter_uploads", "manga_slug,manga_title", user_scoped=False)

    for comment in comments:
        slug = _clean_public_text((comment or {}).get("manga_slug"))
        title = title_by_slug.get(slug)
        if title:
            comment["manga_title"] = title


def _fetch_public_profile_by_identifier(db, identifier: str) -> dict | None:
    lookup = str(identifier or "").strip()
    if not lookup:
        return None

    for column, value in (("id", lookup), ("username", lookup)):
        try:
            result = (
                db.table("profiles")
                .select(PUBLIC_PROFILE_SELECT)
                .eq(column, value)
                .eq("is_banned", False)
                .maybe_single()
                .execute()
            )
            if result and result.data:
                return result.data
        except Exception:
            continue

    return None


def _storage_path_from_public_url(url: str, bucket: str) -> str:
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        markers = [
            f"/storage/v1/object/public/{bucket}/",
            f"/storage/v1/object/sign/{bucket}/",
        ]
        for marker in markers:
            idx = parsed.path.find(marker)
            if idx >= 0:
                raw_path = parsed.path[idx + len(marker) :]
                return unquote(raw_path).lstrip("/")
    except Exception:
        return ""
    return ""


def _remove_avatar_if_owned(db, user_id: str, avatar_url: str | None):
    if not avatar_url:
        return
    path = _storage_path_from_public_url(avatar_url, AVATAR_BUCKET)
    if not path:
        return
    # Only allow deleting avatars that belong to current user.
    expected_prefix = f"{AVATAR_FOLDER}/{user_id}/"
    if not path.startswith(expected_prefix):
        return
    try:
        db.storage.from_(AVATAR_BUCKET).remove([path])
    except Exception:
        # Ignore deletion failure because profile update should still succeed.
        pass


def _crop_avatar_bytes(
    content: bytes,
    content_type: str,
    crop_x: int | None,
    crop_y: int | None,
    crop_width: int | None,
    crop_height: int | None,
) -> tuple[bytes, str]:
    if None in (crop_x, crop_y, crop_width, crop_height):
        return content, content_type

    if crop_width is None or crop_height is None or crop_width <= 0 or crop_height <= 0:
        return content, content_type

    src = BytesIO(content)
    try:
        image = Image.open(src)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không đọc được ảnh: {str(e)}")

    x = max(0, int(crop_x))
    y = max(0, int(crop_y))
    w = int(crop_width)
    h = int(crop_height)
    right = min(image.width, x + w)
    bottom = min(image.height, y + h)
    if right <= x or bottom <= y:
        raise HTTPException(status_code=400, detail="Vùng cắt ảnh không hợp lệ")

    box = (x, y, right, bottom)

    try:
        if content_type == "image/gif":
            try:
                if getattr(image, "is_animated", False):
                    rgba_frames = []
                    durations = []
                    for frame in ImageSequence.Iterator(image):
                        rgba_frames.append(frame.convert("RGBA").crop(box))
                        durations.append(
                            frame.info.get("duration", image.info.get("duration", 100))
                        )

                    if not rgba_frames:
                        return content, content_type

                    paletted_frames = [
                        fr.quantize(colors=255, method=Image.Quantize.FASTOCTREE)
                        for fr in rgba_frames
                    ]
                    out = BytesIO()
                    paletted_frames[0].save(
                        out,
                        format="GIF",
                        save_all=True,
                        append_images=paletted_frames[1:],
                        duration=durations,
                        loop=image.info.get("loop", 0),
                        disposal=2,
                        optimize=False,
                    )
                    return out.getvalue(), "image/gif"

                # Static GIF path: normalize palette as well.
                gif_frame = (
                    image.convert("RGBA")
                    .crop(box)
                    .quantize(
                        colors=255,
                        method=Image.Quantize.FASTOCTREE,
                    )
                )
                out = BytesIO()
                gif_frame.save(out, format="GIF", optimize=False)
                return out.getvalue(), "image/gif"
            except Exception:
                # Keep original GIF if crop fails due to invalid/broken palette metadata.
                return content, "image/gif"

        cropped = image.crop(box)
        out = BytesIO()
        if content_type == "image/jpeg":
            if cropped.mode in ("RGBA", "P"):
                cropped = cropped.convert("RGB")
            cropped.save(out, format="JPEG", quality=95)
        elif content_type == "image/png":
            cropped.save(out, format="PNG")
        elif content_type == "image/webp":
            cropped.save(out, format="WEBP", quality=95)
        else:
            cropped.save(out, format=image.format or "PNG")
        return out.getvalue(), content_type
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Không thể cắt ảnh: {str(e)}")


@router.get("/search")
async def search_users(
    q: str = Query(..., min_length=1, max_length=50),
    limit: int = Query(10, ge=1, le=30),
    db=Depends(get_supabase_public),
):
    """Tìm kiếm user theo username hoặc display_name."""
    pattern = f"%{_normalize_search_pattern(q)}%"
    select_fields = (
        "id, username, display_name, avatar, role, is_vip, "
        "name_color, name_font, name_effect"
    )
    rows_by_id: dict[str, dict] = {}

    for column in ("username", "display_name"):
        try:
            result = (
                db.table("profiles")
                .select(select_fields)
                .ilike(column, pattern)
                .eq("is_banned", False)
                .limit(limit)
                .execute()
            )
        except Exception:
            continue
        for row in result.data or []:
            user_id = str(row.get("id") or "")
            if user_id and user_id not in rows_by_id:
                rows_by_id[user_id] = row
            if len(rows_by_id) >= limit:
                break
        if len(rows_by_id) >= limit:
            break

    return {"users": list(rows_by_id.values())[:limit]}


@router.get("/profile")
async def get_profile(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Lấy profile người dùng hiện tại."""
    result = db.table("profiles").select("*").eq("id", user["id"]).single().execute()
    profile = result.data
    if not profile:
        raise HTTPException(status_code=404, detail="Profile không tồn tại")
    return {"profile": profile}


@router.get("/profile/{user_id}")
async def get_user_profile(
    user_id: str,
    viewer=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Lấy profile user khác (public)."""
    profile = await asyncio.to_thread(_fetch_public_profile_by_identifier, db, user_id)

    if not profile:
        raise HTTPException(status_code=404, detail="Người dùng không tồn tại")
    owner_id = str(profile.get("id") or "").strip()

    cached_payload = _user_stats_cache_get(_public_profile_cache_key(owner_id))
    if isinstance(cached_payload, dict):
        cached_settings = cached_payload.get("settings") or {}
        can_view, visibility, is_self = _can_view_public_profile(profile, cached_settings, viewer)
        if not can_view:
            raise HTTPException(
                status_code=403,
                detail="Hồ sơ này đang ở chế độ riêng tư",
            )
        return {
            **cached_payload,
            "profile": cached_payload.get("profile") or profile,
            "settings": {
                **cached_settings,
                "profile_visibility": visibility,
            },
            "viewer": {"is_self": is_self},
            "cached": True,
        }

    settings = await asyncio.to_thread(_get_public_profile_settings, db, owner_id)
    can_view, visibility, is_self = _can_view_public_profile(profile, settings, viewer)
    if not can_view:
        raise HTTPException(
            status_code=403,
            detail="Hồ sơ này đang ở chế độ riêng tư",
        )

    show_reading_history = bool(settings.get("show_reading_history"))
    show_followed_manga = bool(settings.get("show_followed_manga"))
    show_comments = bool(settings.get("show_comments"))

    async def _empty_rows() -> list[dict]:
        return []

    following_task = (
        asyncio.to_thread(
            _fetch_public_manga_rows,
            db,
            "follows",
            owner_id,
            "manga_slug, manga_title, manga_thumb, created_at",
            "created_at",
        )
        if show_followed_manga
        else _empty_rows()
    )
    history_task = (
        asyncio.to_thread(
            _fetch_public_manga_rows,
            db,
            "reading_history",
            owner_id,
            "id, manga_slug, manga_title, manga_thumb, chapter_id, chapter_name, page, progress, read_at",
            "read_at",
        )
        if show_reading_history
        else _empty_rows()
    )
    comments_task = (
        asyncio.to_thread(_fetch_public_comments, db, owner_id)
        if show_comments
        else _empty_rows()
    )

    following_rows, history_rows, public_comments = await asyncio.gather(
        following_task,
        history_task,
        comments_task,
    )
    if public_comments:
        await asyncio.to_thread(_enrich_public_comment_manga_titles, db, owner_id, public_comments)

    activity = {
        "following": following_rows,
        "history": history_rows,
        "comments": public_comments,
    }

    payload = {
        "profile": profile,
        "settings": {
            "profile_visibility": visibility,
            "show_reading_history": show_reading_history,
            "show_followed_manga": show_followed_manga,
            "show_comments": show_comments,
        },
        "activity": activity,
    }
    _user_stats_cache_set(
        _public_profile_cache_key(owner_id),
        payload,
        PUBLIC_PROFILE_CACHE_TTL_SECONDS,
    )
    return {**payload, "viewer": {"is_self": is_self}, "cached": False}


@router.put("/profile")
async def update_profile(
    data: ProfileUpdate,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Cập nhật profile."""
    update_data = data.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="Không có dữ liệu cập nhật")

    current_style_data: dict | None = None

    def current_name_style_profile() -> dict:
        nonlocal current_style_data
        if current_style_data is None:
            current_style_data = _fetch_name_style_access_profile(db, user["id"])
        return current_style_data

    if "name_color" in update_data:
        color = _normalize_name_color(update_data.get("name_color"))
        if color not in ALLOWED_NAME_COLORS:
            raise HTTPException(status_code=400, detail="Màu tên không hợp lệ")
        update_data["name_color"] = color
        if color in PREMIUM_NAME_COLORS and not _has_premium_name_style_access(
            current_name_style_profile()
        ):
            raise HTTPException(
                status_code=403,
                detail="Màu tên này chỉ dành cho VIP, Mod hoặc Admin",
            )

    if "name_font" in update_data:
        font = _normalize_name_font(update_data.get("name_font"))
        if font not in ALLOWED_NAME_FONTS:
            raise HTTPException(status_code=400, detail="Font tên không hợp lệ")
        update_data["name_font"] = font
        if font in PREMIUM_NAME_FONTS and not _has_premium_name_style_access(
            current_name_style_profile()
        ):
            raise HTTPException(
                status_code=403,
                detail="Font tên này chỉ dành cho VIP, Mod hoặc Admin",
            )

    if "name_effect" in update_data:
        effect = _normalize_name_effect(update_data.get("name_effect"))
        if effect not in ALLOWED_NAME_EFFECTS:
            raise HTTPException(status_code=400, detail="Hiệu ứng tên không hợp lệ")
        update_data["name_effect"] = effect
        if effect in PREMIUM_NAME_EFFECTS and not _has_premium_name_style_access(
            current_name_style_profile()
        ):
            raise HTTPException(
                status_code=403,
                detail="Hiệu ứng tên này chỉ dành cho VIP, Mod hoặc Admin",
            )

    old_avatar = None
    if "avatar" in update_data:
        current = (
            db.table("profiles")
            .select("avatar")
            .eq("id", user["id"])
            .single()
            .execute()
        )
        old_avatar = (current.data or {}).get("avatar")

    result = db.table("profiles").update(update_data).eq("id", user["id"]).execute()

    if "avatar" in update_data:
        new_avatar = update_data.get("avatar")
        if old_avatar and old_avatar != new_avatar:
            _remove_avatar_if_owned(db, user["id"], old_avatar)

    _clear_public_profile_cache(user["id"])
    return {
        "message": "Cập nhật thành công",
        "profile": result.data[0] if result.data else None,
    }


@router.post("/profile/avatar")
async def upload_avatar(
    avatar: UploadFile = File(...),
    crop_x: int | None = Form(None),
    crop_y: int | None = Form(None),
    crop_width: int | None = Form(None),
    crop_height: int | None = Form(None),
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Upload avatar lên Supabase Storage và lưu public URL vào profile."""
    content, avatar_content_type = await read_upload_limited(
        avatar,
        max_size=AVATAR_MAX_SIZE,
        allowed_types=ALLOWED_AVATAR_TYPES,
        label="Avatar",
    )

    content, output_content_type = _crop_avatar_bytes(
        content,
        avatar_content_type,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
    )

    ext = IMAGE_EXT_BY_CONTENT_TYPE.get(output_content_type, "jpg")
    path = f"{AVATAR_FOLDER}/{user['id']}/{uuid.uuid4().hex}.{ext}"

    try:
        db.storage.from_(AVATAR_BUCKET).upload(
            path,
            content,
            file_options={"content-type": output_content_type},
        )
        avatar_url = db.storage.from_(AVATAR_BUCKET).get_public_url(path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload avatar thất bại: {str(e)}")

    current = (
        db.table("profiles").select("avatar").eq("id", user["id"]).single().execute()
    )
    old_avatar = (current.data or {}).get("avatar")

    updated = (
        db.table("profiles")
        .update({"avatar": avatar_url})
        .eq("id", user["id"])
        .execute()
    )

    if old_avatar and old_avatar != avatar_url:
        _remove_avatar_if_owned(db, user["id"], old_avatar)

    _clear_public_profile_cache(user["id"])
    return {
        "message": "Upload avatar thành công",
        "avatar_url": avatar_url,
        "profile": updated.data[0] if updated.data else None,
    }


@router.get("/settings")
async def get_settings(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Lấy cài đặt người dùng."""
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Không xác định được người dùng")

    try:
        result = await asyncio.to_thread(_safe_get_user_settings, db, user_id)
        if result and result.data:
            return {"settings": result.data}
    except Exception:
        # Fall through to self-heal + default fallback when Supabase has transient issues.
        pass

    # Best effort: create missing settings row so next read can hit DB defaults.
    try:
        await asyncio.to_thread(
            lambda: db.table("user_settings").insert({"user_id": user_id}).execute()
        )
    except Exception:
        pass

    try:
        result = await asyncio.to_thread(_safe_get_user_settings, db, user_id)
        if result and result.data:
            return {"settings": result.data}
    except Exception:
        pass

    return {"settings": _build_default_user_settings(user_id)}


@router.put("/settings")
async def update_settings(
    data: SettingsUpdate,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Cập nhật cài đặt."""
    update_data = data.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="Không có dữ liệu cập nhật")

    if "profile_visibility" in update_data:
        update_data["profile_visibility"] = _normalize_profile_visibility(update_data.get("profile_visibility"))

    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Không xác định được người dùng")

    try:
        result = await asyncio.to_thread(
            lambda: db.table("user_settings")
            .update(update_data)
            .eq("user_id", user_id)
            .execute()
        )
        if result.data:
            _clear_public_profile_cache(user_id)
            return {
                "message": "Cập nhật thành công",
                "settings": result.data[0],
            }
    except Exception:
        # Continue to self-heal path.
        pass

    try:
        await asyncio.to_thread(
            lambda: db.table("user_settings").insert({"user_id": user_id}).execute()
        )
    except Exception:
        pass

    try:
        result = await asyncio.to_thread(
            lambda: db.table("user_settings")
            .update(update_data)
            .eq("user_id", user_id)
            .execute()
        )
        _clear_public_profile_cache(user_id)
        return {
            "message": "Cập nhật thành công",
            "settings": result.data[0] if result.data else _build_default_user_settings(user_id),
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Không thể cập nhật cài đặt lúc này: {exc}")


@router.get("/stats")
async def get_stats(user=Depends(get_current_user), db=Depends(get_supabase)):
    """Lấy thống kê đọc truyện."""
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Không xác định được người dùng")

    cache_key = f"user_stats:{user_id}"
    cached = _user_stats_cache_get(cache_key)
    if isinstance(cached, dict):
        return cached

    stale_cached = _user_stats_cache_get(f"{cache_key}:stale")

    tz = ZoneInfo("Asia/Ho_Chi_Minh")
    now_local = datetime.now(timezone.utc).astimezone(tz)

    # Build 7-day window (oldest -> newest)
    dates = [(now_local.date() - timedelta(days=i)) for i in range(6, -1, -1)]
    counts_by_day = {d.isoformat(): 0 for d in dates}

    start_local = datetime.combine(dates[0], datetime.min.time(), tzinfo=tz)
    start_utc_iso = start_local.astimezone(timezone.utc).isoformat()

    try:
        profile, history_rows, streak_rows = await asyncio.gather(
            asyncio.to_thread(
                lambda: db.table("profiles")
                .select("chapters_read, total_reading_time, comments_posted, reading_streak")
                .eq("id", user_id)
                .single()
                .execute()
            ),
            asyncio.to_thread(
                lambda: db.table("reading_history")
                .select("read_at")
                .eq("user_id", user_id)
                .gte("read_at", start_utc_iso)
                .order("read_at", desc=False)
                .limit(USER_STATS_WEEKLY_HISTORY_LIMIT)
                .execute()
            ),
            asyncio.to_thread(
                lambda: db.table("reading_history")
                .select("read_at")
                .eq("user_id", user_id)
                .order("read_at", desc=True)
                .limit(USER_STATS_STREAK_HISTORY_LIMIT)
                .execute()
            ),
        )
    except Exception:
        if isinstance(stale_cached, dict):
            return stale_cached
        raise

    for row in history_rows.data or []:
        read_at = row.get("read_at")
        if not read_at:
            continue
        try:
            dt = datetime.fromisoformat(read_at.replace("Z", "+00:00"))
            day_key = dt.astimezone(tz).date().isoformat()
            if day_key in counts_by_day:
                counts_by_day[day_key] += 1
        except Exception:
            continue

    weekly = [counts_by_day[d.isoformat()] for d in dates]

    # Reading streak (consecutive active days up to today in local timezone)
    active_days = set()
    for row in streak_rows.data or []:
        read_at = row.get("read_at")
        if not read_at:
            continue
        try:
            dt = datetime.fromisoformat(read_at.replace("Z", "+00:00"))
            active_days.add(dt.astimezone(tz).date())
        except Exception:
            continue

    streak = 0
    cursor = now_local.date()
    while cursor in active_days:
        streak += 1
        cursor -= timedelta(days=1)

    stats = profile.data if profile.data else {}
    stats["weekly_activity"] = weekly
    stats["reading_streak"] = streak

    payload = {"stats": stats}
    _user_stats_cache_set_with_stale(
        cache_key,
        payload,
        USER_STATS_CACHE_TTL_SECONDS,
        USER_STATS_STALE_TTL_SECONDS,
    )
    return payload
