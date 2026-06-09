"""
Admin router — dashboard stats, user management, moderation, audit.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
import re
import time
import uuid
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from PIL import Image
from pydantic import BaseModel, Field

from fastapi_app.dependencies import get_supabase, require_admin, require_role
from fastapi_app.models.schemas import BanUser, ChangeRole, NotifyRequest, VipUpdate
from fastapi_app.services import mangadex_service, otruyen_service
from fastapi_app.utils.upload_security import IMAGE_EXT_BY_CONTENT_TYPE, read_upload_limited
from maintenance import get_maintenance_state, set_maintenance_state

router = APIRouter()
COMMENT_IMAGE_BUCKET = "comment-images"
ANNOUNCEMENT_IMAGE_BUCKET = "announcement-images"
MAINTENANCE_IMAGE_BUCKET = "maintenance-images"
MAINTENANCE_IMAGE_PREFIX = "maintenance"
ANNOUNCEMENT_IMAGE_MAX_SIZE = 8 * 1024 * 1024
ALLOWED_ANNOUNCEMENT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAINTENANCE_IMAGE_MAX_FRAME_SIDE = 2400

# ── Simple in-process TTL cache ─────────────────────────────────────────────
_CACHE: dict[str, tuple[Any, float]] = {}  # key → (payload, expires_at)

ADMIN_STATS_CACHE_TTL_SECONDS = 5 * 60
ADMIN_STATS_STALE_TTL_SECONDS = 30 * 60
ADMIN_ANALYTICS_CACHE_TTL_SECONDS = 15 * 60
# Keep stale analytics available longer so admin chart rarely blocks on cold recompute.
ADMIN_ANALYTICS_STALE_TTL_SECONDS = 6 * 60 * 60
ADMIN_ANALYTICS_REFRESH_LOCK_TTL_SECONDS = 90
ADMIN_ANALYTICS_PHASE1_TIMEOUT_SECONDS = 5.0
ADMIN_ANALYTICS_PHASE2_TIMEOUT_SECONDS = 3.0
ADMIN_ANALYTICS_MDX_TITLE_BATCH_TIMEOUT_SECONDS = 3.0
ADMIN_ANALYTICS_TOP_VIEWS_SCAN_LIMIT = 24
ADMIN_ANALYTICS_ENABLE_OTRUYEN_TITLE_ENRICH = True
ADMIN_ANALYTICS_OTRUYEN_TITLE_LIMIT = 8
ADMIN_ANALYTICS_OTRUYEN_TITLE_TIMEOUT_SECONDS = 2.5


def _cache_get(key: str) -> Any | None:
    entry = _CACHE.get(key)
    if entry and time.monotonic() < entry[1]:
        return entry[0]
    _CACHE.pop(key, None)
    return None


def _cache_set(key: str, value: Any, ttl: float) -> None:
    _CACHE[key] = (value, time.monotonic() + ttl)


def _cache_set_with_stale(key: str, value: Any, ttl: float, stale_ttl: float) -> None:
    _cache_set(key, value, ttl)
    _cache_set(f"{key}:stale", value, stale_ttl)


def _cache_invalidate_prefix(prefix: str) -> None:
    for k in list(_CACHE):
        if k.startswith(prefix):
            _CACHE.pop(k, None)


def _extract_storage_path(image_url: str, bucket: str) -> str:
    marker = f"/storage/v1/object/public/{bucket}/"
    if marker not in image_url:
        return ""
    return unquote(image_url.split(marker, 1)[1].split("?", 1)[0]).strip("/")


def _sanitize_postgrest_search(value: Any, max_len: int = 80) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    safe = "".join(ch for ch in text if ch.isalnum() or ch in " @._-")
    return re.sub(r"\s+", " ", safe).strip()[:max_len]


def _build_ilike_or_filter(columns: tuple[str, ...], search: Any) -> str:
    term = _sanitize_postgrest_search(search)
    if not term:
        return ""
    pattern = f"%{term}%"
    return ",".join(f"{column}.ilike.{pattern}" for column in columns)


def _remove_comment_image(db, image_url: str):
    if not image_url:
        return
    path = _extract_storage_path(image_url, COMMENT_IMAGE_BUCKET)
    if not path:
        return
    try:
        db.storage.from_(COMMENT_IMAGE_BUCKET).remove([path])
    except Exception:
        pass


def _build_month_labels(count: int = 12):
    now = datetime.now(timezone.utc)
    year = now.year
    month = now.month
    labels = []
    for i in range(count - 1, -1, -1):
        m = month - i
        y = year
        while m <= 0:
            m += 12
            y -= 1
        labels.append((y, m, f"T{m}"))
    return labels


def _build_week_labels(count: int = 7):
    day_names = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]
    now = datetime.now(timezone.utc).date()
    labels = []
    for i in range(count - 1, -1, -1):
        d = now - timedelta(days=i)
        labels.append((d.isoformat(), day_names[d.weekday()]))
    return labels


def _clean_slug(value: Any) -> str:
    return re.sub(r"[^a-z0-9-]", "", str(value or "").strip().lower().strip("/"))


def _is_invalid_manga_slug(value: Any) -> bool:
    slug = _clean_slug(value)
    if not slug or len(slug) < 3:
        return True
    if re.fullmatch(r"\d+", slug):
        return True
    if re.fullmatch(r"[0-9a-f]{20,}", slug):
        return True
    if re.fullmatch(r"chapter\d*", slug):
        return True
    return slug in {
        "uploads",
        "comics",
        "chapters",
        "chapter",
        "api",
        "img",
        "images",
        "v1",
        "data",
    }


def _normalize_title_key(value: Any) -> str:
    title = str(value or "").strip()
    if not title:
        return ""
    title = re.sub(r"\[[^\]]*(chap|chương)[^\]]*\]", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip().lower()
    return title


def _humanize_slug_title(value: Any) -> str:
    slug = _clean_slug(value)
    if not slug:
        return ""
    words = [part for part in slug.split("-") if part]
    if not words:
        return slug
    # Keep short tokens uppercase and title-case normal words for readability.
    return " ".join(part.upper() if len(part) <= 3 else part.capitalize() for part in words)


_MANGADEX_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _canonical_manga_override_slug(value: Any) -> str:
    normalized = str(value or "").strip().strip("/").lower()
    if not normalized:
        return ""
    if normalized.startswith("mdx-"):
        raw = normalized[4:]
        if _MANGADEX_ID_RE.fullmatch(raw):
            return raw
    if _MANGADEX_ID_RE.fullmatch(normalized):
        return normalized
    return normalized


def _legacy_mangadex_alias(slug: str) -> str | None:
    if _MANGADEX_ID_RE.fullmatch(str(slug or "")):
        return f"mdx-{slug}"
    return None


def _override_slug_candidates(value: Any) -> list[str]:
    normalized = str(value or "").strip().strip("/").lower()
    if not normalized:
        return []

    candidates: list[str] = []

    def _push(candidate: str) -> None:
        text = str(candidate or "").strip().strip("/").lower()
        if text and text not in candidates:
            candidates.append(text)

    _push(normalized)
    canonical = _canonical_manga_override_slug(normalized)
    if canonical:
        _push(canonical)

    if normalized.startswith("mdx-"):
        raw = normalized[4:]
        if _MANGADEX_ID_RE.fullmatch(raw):
            _push(raw)
    elif _MANGADEX_ID_RE.fullmatch(normalized):
        _push(f"mdx-{normalized}")

    legacy_alias = _legacy_mangadex_alias(canonical or normalized)
    if legacy_alias:
        _push(legacy_alias)

    return candidates


class MangaSettingsUpdate(BaseModel):
    is_featured: bool | None = None
    admin_notes: str | None = None


class SiteAnnouncementCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=2000)
    announcement_type: str = "system"
    target: str = "all"
    show_popup: bool = True
    is_active: bool = True
    image_url: str | None = Field(default=None, max_length=1000)
    cta_label: str | None = Field(default=None, max_length=80)
    cta_url: str | None = Field(default=None, max_length=1000)
    popup_size: str = "standard"
    popup_dismissible: bool = True
    priority: int = Field(default=0, ge=0, le=1000)
    popup_expires_hours: int = Field(default=24, ge=1, le=720)
    starts_at: str | None = None
    expires_at: str | None = None


class SiteAnnouncementUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    message: str | None = Field(default=None, min_length=1, max_length=2000)
    announcement_type: str | None = None
    target: str | None = None
    show_popup: bool | None = None
    is_active: bool | None = None
    image_url: str | None = Field(default=None, max_length=1000)
    cta_label: str | None = Field(default=None, max_length=80)
    cta_url: str | None = Field(default=None, max_length=1000)
    popup_size: str | None = None
    popup_dismissible: bool | None = None
    priority: int | None = Field(default=None, ge=0, le=1000)
    popup_expires_hours: int | None = Field(default=None, ge=1, le=720)
    starts_at: str | None = None
    expires_at: str | None = None


class MaintenanceModeUpdate(BaseModel):
    enabled: bool
    title: str | None = Field(default=None, max_length=120)
    message: str | None = Field(default=None, max_length=1000)
    image_url: str | None = Field(default=None, max_length=1000)
    starts_at: str | None = Field(default=None, max_length=80)
    ends_at: str | None = Field(default=None, max_length=80)


class MaintenanceImageDelete(BaseModel):
    image_url: str = Field(min_length=1, max_length=1000)


def _resize_if_oversized(image: Image.Image) -> Image.Image:
    max_side = MAINTENANCE_IMAGE_MAX_FRAME_SIDE
    if image.width <= max_side and image.height <= max_side:
        return image
    scale = min(max_side / max(1, image.width), max_side / max(1, image.height))
    width = max(1, int(round(image.width * scale)))
    height = max(1, int(round(image.height * scale)))
    return image.resize((width, height), Image.Resampling.LANCZOS)


def _save_gif_frames(
    frames: list[Image.Image],
    durations: list[int],
    loop: int,
) -> bytes:
    out = BytesIO()
    frames[0].save(
        out,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=loop,
        disposal=2,
        optimize=False,
    )
    return out.getvalue()


def _gif_background_rgba(image: Image.Image) -> tuple[int, int, int, int]:
    background = image.info.get("background")
    transparency = image.info.get("transparency")
    palette = image.getpalette() or []
    if isinstance(background, int) and background >= 0 and background * 3 + 2 < len(palette):
        alpha = 0 if background == transparency else 255
        return (
            int(palette[background * 3]),
            int(palette[background * 3 + 1]),
            int(palette[background * 3 + 2]),
            alpha,
        )
    return (0, 0, 0, 0)


def _flatten_rgba_for_gif(image: Image.Image, background: tuple[int, int, int, int]) -> Image.Image:
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    base = Image.new("RGBA", image.size, background)
    base.alpha_composite(image)
    return base.convert("RGB")


def _crop_gif_image(image: Image.Image, box: tuple[int, int, int, int]) -> bytes:
    background = _gif_background_rgba(image)
    canvas = Image.new("RGBA", image.size, background)
    frames: list[Image.Image] = []
    durations: list[int] = []
    loop = int(image.info.get("loop", 0) or 0)
    palette = image.getpalette()

    for index in range(getattr(image, "n_frames", 1)):
        image.seek(index)
        disposal = int(getattr(image, "disposal_method", 0) or 0)
        previous_canvas = canvas.copy()
        duration = int(image.info.get("duration", 100) or 100)
        tile_box = image.tile[0][1] if image.tile else (0, 0, image.width, image.height)

        frame = image.copy()
        if frame.mode == "P" and not frame.getpalette() and palette:
            frame.putpalette(palette)
        frame_rgba = frame.convert("RGBA")

        layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        if frame_rgba.size == image.size:
            layer.alpha_composite(frame_rgba)
        else:
            layer.alpha_composite(frame_rgba, dest=(int(tile_box[0]), int(tile_box[1])))

        canvas.alpha_composite(layer)
        cropped = _resize_if_oversized(canvas.crop(box))
        frames.append(_flatten_rgba_for_gif(cropped, background))
        durations.append(duration)

        if disposal == 2:
            clear = Image.new(
                "RGBA",
                (max(1, int(tile_box[2] - tile_box[0])), max(1, int(tile_box[3] - tile_box[1]))),
                background,
            )
            canvas.paste(clear, (int(tile_box[0]), int(tile_box[1])))
        elif disposal == 3:
            canvas = previous_canvas

    if not frames:
        raise HTTPException(status_code=400, detail="GIF khong co frame hop le")
    return _save_gif_frames(frames, durations, loop)


def _crop_image_bytes(
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

    try:
        image = Image.open(BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Không đọc được ảnh: {exc}") from exc

    x = max(0, int(crop_x or 0))
    y = max(0, int(crop_y or 0))
    right = min(image.width, x + int(crop_width))
    bottom = min(image.height, y + int(crop_height))
    if right <= x or bottom <= y:
        raise HTTPException(status_code=400, detail="Vùng cắt ảnh không hợp lệ")

    box = (x, y, right, bottom)

    try:
        if content_type == "image/gif":
            return _crop_gif_image(image, box), "image/gif"

        cropped = _resize_if_oversized(image.crop(box))
        out = BytesIO()
        if content_type == "image/jpeg":
            if cropped.mode in ("RGBA", "LA", "P"):
                cropped = cropped.convert("RGB")
            cropped.save(out, format="JPEG", quality=92, optimize=True)
        elif content_type == "image/png":
            cropped.save(out, format="PNG", optimize=True)
        elif content_type == "image/webp":
            cropped.save(out, format="WEBP", quality=92, method=6)
        else:
            cropped.save(out, format=image.format or "PNG")
        return out.getvalue(), content_type
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Không thể cắt ảnh: {exc}") from exc


ANNOUNCEMENT_TYPES = {"system", "maintenance", "event", "warning"}
ANNOUNCEMENT_POPUP_SIZES = {"compact", "standard", "wide"}
ANNOUNCEMENT_MAX_HOURS = 24 * 30
ANNOUNCEMENT_SELECT_COLUMNS = (
    "id, title, message, announcement_type, target, show_popup, is_active, "
    "image_url, cta_label, cta_url, popup_size, popup_dismissible, priority, "
    "created_by, starts_at, expires_at, created_at, updated_at"
)
ANNOUNCEMENT_LEGACY_SELECT_COLUMNS = (
    "id, title, message, announcement_type, target, show_popup, is_active, "
    "created_by, starts_at, expires_at, created_at, updated_at"
)


def _normalize_announcement_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in ANNOUNCEMENT_TYPES else "system"


def _normalize_announcement_target(value: Any) -> str:
    normalized = str(value or "all").strip().lower()
    return normalized if normalized in {"all", "reader", "uploader", "moderator", "admin"} else "all"


def _normalize_popup_size(value: Any) -> str:
    normalized = str(value or "standard").strip().lower()
    return normalized if normalized in ANNOUNCEMENT_POPUP_SIZES else "standard"


def _coerce_popup_hours(value: Any) -> int:
    try:
        hours = int(value or 24)
    except Exception:
        hours = 24
    return max(1, min(ANNOUNCEMENT_MAX_HOURS, hours))


def _clean_optional_text(value: Any, max_len: int) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return text[:max_len]


def _clean_announcement_url(value: Any) -> str | None:
    text = _clean_optional_text(value, 1000)
    if not text:
        return None
    lowered = text.lower()
    if lowered.startswith(("https://", "http://", "/")):
        return text
    return None


def _coerce_datetime_iso(value: Any, fallback: datetime) -> str:
    text = str(value or "").strip()
    if not text:
        return fallback.isoformat()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except Exception:
        return fallback.isoformat()


def _site_announcement_row(
    data: SiteAnnouncementCreate | SiteAnnouncementUpdate | NotifyRequest,
    *,
    admin: dict[str, Any] | None = None,
    partial: bool = False,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    row: dict[str, Any] = {}
    provided_fields = (
        getattr(data, "model_fields_set", None)
        or getattr(data, "__fields_set__", None)
        or set()
    )

    def has_value(name: str) -> bool:
        if not partial:
            return True
        return name in provided_fields

    if has_value("title"):
        row["title"] = str(getattr(data, "title", "") or "").strip()
    if has_value("message"):
        row["message"] = str(getattr(data, "message", "") or "").strip()
    if has_value("announcement_type"):
        row["announcement_type"] = _normalize_announcement_type(getattr(data, "announcement_type", None))
    if has_value("target"):
        row["target"] = _normalize_announcement_target(getattr(data, "target", "all"))
    if has_value("show_popup"):
        row["show_popup"] = bool(getattr(data, "show_popup", True))
    if has_value("is_active"):
        row["is_active"] = bool(getattr(data, "is_active", True))
    if has_value("image_url"):
        row["image_url"] = _clean_announcement_url(getattr(data, "image_url", None))
    if has_value("cta_label"):
        row["cta_label"] = _clean_optional_text(getattr(data, "cta_label", None), 80)
    if has_value("cta_url"):
        row["cta_url"] = _clean_announcement_url(getattr(data, "cta_url", None))
    if has_value("popup_size"):
        row["popup_size"] = _normalize_popup_size(getattr(data, "popup_size", None))
    if has_value("popup_dismissible"):
        row["popup_dismissible"] = bool(getattr(data, "popup_dismissible", True))
    if has_value("priority"):
        try:
            row["priority"] = max(0, min(1000, int(getattr(data, "priority", 0) or 0)))
        except Exception:
            row["priority"] = 0

    if not partial:
        row.setdefault("target", "all")
        row.setdefault("show_popup", True)
        row.setdefault("is_active", True)
        row.setdefault("popup_size", "standard")
        row.setdefault("popup_dismissible", True)
        row.setdefault("priority", 0)
        if admin:
            row["created_by"] = admin.get("id")

    if has_value("starts_at"):
        row["starts_at"] = _coerce_datetime_iso(getattr(data, "starts_at", None), now)

    expires_fallback = now + timedelta(hours=_coerce_popup_hours(getattr(data, "popup_expires_hours", None)))
    if has_value("expires_at"):
        row["expires_at"] = _coerce_datetime_iso(getattr(data, "expires_at", None), expires_fallback)
    elif not partial or getattr(data, "popup_expires_hours", None) is not None:
        row["expires_at"] = expires_fallback.isoformat()

    if not partial:
        row.setdefault("starts_at", now.isoformat())
        row.setdefault("expires_at", expires_fallback.isoformat())

    return row


def _create_site_announcement(db: Any, data: NotifyRequest, admin: dict[str, Any]) -> dict[str, Any] | None:
    if not data.show_popup:
        return None

    row = _site_announcement_row(data, admin=admin)
    row["target"] = "all"
    try:
        result = db.table("site_announcements").insert(row).execute()
        return (result.data or [None])[0]
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Không thể tạo popup home. Hãy chạy "
                "backend/database/migration_v11_site_announcements.sql và "
                "backend/database/migration_v12_announcement_options.sql rồi thử lại: "
                f"{exc}"
            ),
        )


def _extract_joined_profile_role(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("role") or "").strip().lower()
    if isinstance(value, list):
        for row in value:
            if not isinstance(row, dict):
                continue
            role = str(row.get("role") or "").strip().lower()
            if role:
                return role
    return ""


def _fetch_profile_role(db: Any, user_id: Any) -> str:
    uid = str(user_id or "").strip()
    if not uid:
        return ""
    try:
        res = (
            db.table("profiles")
            .select("role")
            .eq("id", uid)
            .limit(1)
            .execute()
        )
        row = (res.data or [None])[0]
        if isinstance(row, dict):
            return str(row.get("role") or "").strip().lower()
    except Exception:
        pass
    return ""


def _ensure_moderator_not_targeting_admin(actor: dict[str, Any], target_role: str, message: str) -> None:
    actor_role = str((actor or {}).get("role") or "").strip().lower()
    if actor_role == "admin":
        return
    if actor_role == "moderator" and str(target_role or "").strip().lower() == "admin":
        raise HTTPException(status_code=403, detail=message)


@router.get("/announcements/active")
async def active_site_announcements(
    limit: int = Query(3, ge=1, le=5),
    db=Depends(get_supabase),
):
    """Public active site announcements for home popup/banner."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        result = (
            db.table("site_announcements")
            .select(ANNOUNCEMENT_SELECT_COLUMNS)
            .eq("is_active", True)
            .eq("show_popup", True)
            .eq("target", "all")
            .lte("starts_at", now)
            .gt("expires_at", now)
            .order("priority", desc=True)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return {"announcements": result.data or []}
    except Exception:
        try:
            result = (
                db.table("site_announcements")
                .select(ANNOUNCEMENT_LEGACY_SELECT_COLUMNS)
                .eq("is_active", True)
                .eq("show_popup", True)
                .eq("target", "all")
                .lte("starts_at", now)
                .gt("expires_at", now)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            return {"announcements": result.data or []}
        except Exception:
            return {"announcements": []}


@router.get("/announcements")
async def list_site_announcements(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query("all"),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Admin-only site announcement manager."""
    _ = admin
    now = datetime.now(timezone.utc).isoformat()
    offset = (page - 1) * limit
    normalized_status = str(status or "all").strip().lower()

    def apply_status(query):
        if normalized_status == "active":
            return query.eq("is_active", True).lte("starts_at", now).gt("expires_at", now)
        if normalized_status == "inactive":
            return query.eq("is_active", False)
        if normalized_status == "expired":
            return query.lte("expires_at", now)
        if normalized_status == "scheduled":
            return query.eq("is_active", True).gt("starts_at", now)
        return query

    try:
        query = apply_status(db.table("site_announcements").select(ANNOUNCEMENT_SELECT_COLUMNS))
        count_query = apply_status(db.table("site_announcements").select("id", count="exact"))
        result = (
            query.order("priority", desc=True)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        total_result = count_query.execute()
        return {
            "announcements": result.data or [],
            "total": total_result.count or 0,
            "page": page,
            "limit": limit,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Không thể tải danh sách thông báo. Hãy chạy "
                "backend/database/migration_v11_site_announcements.sql và "
                f"backend/database/migration_v12_announcement_options.sql: {exc}"
            ),
        )


@router.post("/announcements")
async def create_site_announcement(
    data: SiteAnnouncementCreate,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    row = _site_announcement_row(data, admin=admin)
    try:
        result = db.table("site_announcements").insert(row).execute()
        announcement = (result.data or [None])[0]
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Không thể tạo thông báo. Hãy chạy migration V11/V12 rồi thử lại: "
                f"{exc}"
            ),
        )
    _log_action(db, admin, "Tạo thông báo home", row.get("title", ""))
    return {"announcement": announcement}


@router.post("/announcements/upload-image")
async def upload_site_announcement_image(
    image: UploadFile = File(...),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    content, content_type = await read_upload_limited(
        image,
        max_size=ANNOUNCEMENT_IMAGE_MAX_SIZE,
        allowed_types=ALLOWED_ANNOUNCEMENT_IMAGE_TYPES,
        label="Ảnh banner",
    )

    ext = IMAGE_EXT_BY_CONTENT_TYPE.get(content_type, "jpg")
    path = f"{admin.get('id') or 'admin'}/{uuid.uuid4().hex}.{ext}"

    try:
        db.storage.from_(ANNOUNCEMENT_IMAGE_BUCKET).upload(
            path,
            content,
            file_options={
                "content-type": content_type,
                "cache-control": "31536000",
            },
        )
        image_url = db.storage.from_(ANNOUNCEMENT_IMAGE_BUCKET).get_public_url(path)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Upload ảnh banner thất bại. Hãy chạy migration_v12_announcement_options.sql "
                f"để tạo bucket announcement-images: {exc}"
            ),
        )

    return {"message": "Upload ảnh banner thành công", "image_url": image_url}


@router.get("/maintenance/images")
async def list_maintenance_images(
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    _ = admin
    try:
        files = db.storage.from_(MAINTENANCE_IMAGE_BUCKET).list(MAINTENANCE_IMAGE_PREFIX) or []
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Không thể tải lịch sử ảnh bảo trì. Hãy tạo bucket maintenance-images "
                f"trong Supabase Storage rồi thử lại: {exc}"
            ),
        )

    images: list[dict[str, Any]] = []
    for file in files:
        name = str((file or {}).get("name") or "").strip()
        if not name or name.startswith("."):
            continue
        path = f"{MAINTENANCE_IMAGE_PREFIX}/{name}"
        metadata = (file or {}).get("metadata") or {}
        images.append(
            {
                "name": name,
                "path": path,
                "image_url": db.storage.from_(MAINTENANCE_IMAGE_BUCKET).get_public_url(path),
                "size": metadata.get("size") or (file or {}).get("size"),
                "created_at": (file or {}).get("created_at"),
                "updated_at": (file or {}).get("updated_at"),
            }
        )

    images.sort(
        key=lambda item: str(item.get("updated_at") or item.get("created_at") or item.get("name") or ""),
        reverse=True,
    )
    return {"images": images[:60]}


@router.post("/maintenance/upload-image")
async def upload_maintenance_image(
    image: UploadFile = File(...),
    crop_x: int | None = Form(None),
    crop_y: int | None = Form(None),
    crop_width: int | None = Form(None),
    crop_height: int | None = Form(None),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    content, content_type = await read_upload_limited(
        image,
        max_size=ANNOUNCEMENT_IMAGE_MAX_SIZE,
        allowed_types=ALLOWED_ANNOUNCEMENT_IMAGE_TYPES,
        label="Ảnh bảo trì",
    )

    content, content_type = _crop_image_bytes(
        content,
        content_type,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
    )

    ext = IMAGE_EXT_BY_CONTENT_TYPE.get(content_type, "jpg")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    path = f"{MAINTENANCE_IMAGE_PREFIX}/{timestamp}-{uuid.uuid4().hex}.{ext}"

    try:
        db.storage.from_(MAINTENANCE_IMAGE_BUCKET).upload(
            path,
            content,
            file_options={
                "content-type": content_type,
                "cache-control": "31536000",
            },
        )
        image_url = db.storage.from_(MAINTENANCE_IMAGE_BUCKET).get_public_url(path)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Upload ảnh bảo trì thất bại. Hãy chạy migration_v16_site_settings_maintenance.sql "
                f"để tạo bucket maintenance-images: {exc}"
            ),
        )

    _log_action(db, admin, "Upload ảnh bảo trì", path)
    return {"message": "Upload ảnh bảo trì thành công", "image_url": image_url, "path": path}


@router.delete("/maintenance/images")
async def delete_maintenance_image(
    data: MaintenanceImageDelete,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    image_url = str(data.image_url or "").strip()
    path = _extract_storage_path(image_url, MAINTENANCE_IMAGE_BUCKET)
    if not path or not path.startswith(f"{MAINTENANCE_IMAGE_PREFIX}/"):
        raise HTTPException(status_code=400, detail="Ảnh bảo trì không hợp lệ")

    try:
        db.storage.from_(MAINTENANCE_IMAGE_BUCKET).remove([path])
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Không thể xóa ảnh bảo trì: {exc}")

    current = await asyncio.to_thread(get_maintenance_state, force=True)
    if str(current.get("image_url") or "").strip() == image_url:
        await asyncio.to_thread(
            set_maintenance_state,
            enabled=bool(current.get("enabled")),
            title=str(current.get("title") or "").strip() or None,
            message=str(current.get("message") or "").strip() or None,
            image_url=None,
            starts_at=str(current.get("starts_at") or "").strip() or None,
            ends_at=str(current.get("ends_at") or "").strip() or None,
            updated_by=admin["id"],
        )

    _log_action(db, admin, "Xóa ảnh bảo trì", path)
    return {"message": "Đã xóa ảnh bảo trì", "path": path}


@router.put("/announcements/{announcement_id}")
async def update_site_announcement(
    announcement_id: str,
    data: SiteAnnouncementUpdate,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    row = _site_announcement_row(data, partial=True)
    if not row:
        raise HTTPException(status_code=400, detail="Không có dữ liệu cập nhật")
    try:
        result = db.table("site_announcements").update(row).eq("id", announcement_id).execute()
        announcement = (result.data or [None])[0]
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Không thể cập nhật thông báo: {exc}")
    if not announcement:
        raise HTTPException(status_code=404, detail="Không tìm thấy thông báo")
    _log_action(db, admin, "Cập nhật thông báo home", announcement_id)
    return {"announcement": announcement}


@router.delete("/announcements/{announcement_id}")
async def delete_site_announcement(
    announcement_id: str,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    try:
        existing = (
            db.table("site_announcements")
            .select("id, title")
            .eq("id", announcement_id)
            .limit(1)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="Không tìm thấy thông báo")
        db.table("site_announcements").delete().eq("id", announcement_id).execute()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Không thể xóa thông báo: {exc}")
    _log_action(db, admin, "Xóa thông báo home", announcement_id)
    return {"message": "Đã xóa thông báo"}


async def _refresh_external_counts() -> None:
    """Background task — fetches external manga counts and caches for 30 min.
    Never blocks the stats endpoint."""
    if _cache_get("admin_stats_ext") is not None:
        return  # still fresh
    try:
        otruyen_res, mdx_res = await asyncio.gather(
            otruyen_service.get_list("truyen-moi", 1),
            mangadex_service.get_total_vi_manga_count(),
            return_exceptions=True,
        )
        total_ot = 0
        if isinstance(otruyen_res, dict):
            total_ot = int(
                (otruyen_res.get("data", {}).get("params", {}).get("pagination", {}) or {}).get(
                    "totalItems"
                )
                or 0
            )
        total_mdx = int(mdx_res) if isinstance(mdx_res, int) else 0
        _cache_set("admin_stats_ext", (total_ot, total_mdx), 30 * 60)  # 30 min
    except Exception:
        pass


@router.get("/stats")
async def admin_stats(admin=Depends(require_role("moderator", "admin")), db=Depends(get_supabase)):
    """Dashboard stats — instant DB-only response, external counts refresh in background."""

    # Always kick off background refresh of external counts (idempotent if still fresh)
    asyncio.create_task(_refresh_external_counts())

    # External counts: latest available value (background-refreshed separately)
    ext_cached: tuple[int, int] = _cache_get("admin_stats_ext") or (0, 0)
    total_ot, total_mdx = ext_cached

    cached = _cache_get("admin_stats")
    if cached is not None:
        # Overlay freshest ext counts so total_manga never sticks at 0
        result = dict(cached)
        result["stats"] = {**cached["stats"], "total_manga": total_ot + total_mdx}
        return result

    stale_cached = _cache_get("admin_stats:stale")
    if isinstance(stale_cached, dict) and isinstance(stale_cached.get("stats"), dict):
        result = dict(stale_cached)
        result["stats"] = {
            **stale_cached["stats"],
            "total_manga": total_ot + total_mdx,
        }
        return result

    # ── Fast path: single DB RPC (no external HTTP) ───────────────────────
    try:
        rpc_result = await asyncio.to_thread(lambda: db.rpc("get_admin_stats", {}).execute())
        rpc_data = rpc_result.data
        if isinstance(rpc_data, dict):
            chapter_uploads_pending = int(rpc_data.get("pending_chapter_uploads") or 0)
            manga_uploads_pending = int(rpc_data.get("pending_manga_uploads") or 0)
            total_chapters = int(rpc_data.get("total_chapter_uploads") or 0)
            base_stats = {
                "total_users": int(rpc_data.get("total_users") or 0),
                "total_manga": 0,   # stored as 0; overridden via ext_cached at read time
                "total_chapters": total_chapters,
                "active_readers": int(rpc_data.get("active_readers") or 0),
                "pending_uploads": chapter_uploads_pending + manga_uploads_pending,
                "total_comments": int(rpc_data.get("total_comments") or 0),
                "pending_reports": int(rpc_data.get("pending_reports") or 0),
                "banned_users": int(rpc_data.get("banned_users") or 0),
            }
            _cache_set_with_stale(
                "admin_stats",
                {"stats": base_stats},
                ADMIN_STATS_CACHE_TTL_SECONDS,
                ADMIN_STATS_STALE_TTL_SECONDS,
            )
            # Return with real total_manga now
            return {"stats": {**base_stats, "total_manga": total_ot + total_mdx}}
    except Exception:
        pass

    # ── Legacy fallback: parallel DB queries (still no external HTTP) ─────
    (
        users_res,
        comments_res,
        reports_res,
        banned_res,
        active_res,
        ch_pending_res,
        ch_total_res,
        manga_pending_res,
    ) = await asyncio.gather(
        asyncio.to_thread(lambda: db.table("profiles").select("id", count="exact").execute()),
        asyncio.to_thread(
            lambda: db.table("comments").select("id", count="exact").eq("is_deleted", False).execute()
        ),
        asyncio.to_thread(
            lambda: db.table("reports").select("id", count="exact").eq("status", "pending").execute()
        ),
        asyncio.to_thread(
            lambda: db.table("profiles").select("id", count="exact").eq("is_banned", True).execute()
        ),
        asyncio.to_thread(
            lambda: db.table("profiles").select("id", count="exact").gt("chapters_read", 0).execute()
        ),
        asyncio.to_thread(
            lambda: db.table("chapter_uploads")
            .select("id", count="exact")
            .eq("status", "pending")
            .execute()
        ),
        asyncio.to_thread(
            lambda: db.table("chapter_uploads").select("id", count="exact").execute()
        ),
        asyncio.to_thread(
            lambda: db.table("manga_uploads")
            .select("id", count="exact")
            .eq("status", "pending")
            .execute()
        ),
        return_exceptions=True,
    )

    def _count(r: Any, default: int = 0) -> int:
        if isinstance(r, Exception):
            return default
        return int(getattr(r, "count", None) or default)

    chapter_uploads_pending = _count(ch_pending_res)
    manga_uploads_pending = _count(manga_pending_res)
    asyncio.create_task(_refresh_external_counts())

    result = {
        "stats": {
            "total_users": _count(users_res),
            "total_manga": total_ot + total_mdx,
            "total_chapters": _count(ch_total_res),
            "active_readers": _count(active_res),
            "pending_uploads": chapter_uploads_pending + manga_uploads_pending,
            "total_comments": _count(comments_res),
            "pending_reports": _count(reports_res),
            "banned_users": _count(banned_res),
        }
    }
    _cache_set_with_stale(
        "admin_stats",
        result,
        ADMIN_STATS_CACHE_TTL_SECONDS,
        ADMIN_STATS_STALE_TTL_SECONDS,
    )
    return result


@router.get("/analytics")
async def admin_analytics(admin=Depends(require_admin), db=Depends(get_supabase)):
    """Analytics — serve cached/stale instantly and refresh stale cache in background."""
    _ = admin

    cached = _cache_get("admin_analytics")
    if cached is not None:
        return cached

    stale_cached = _cache_get("admin_analytics:stale")
    if isinstance(stale_cached, dict):
        refresh_key = "admin_analytics:refreshing"
        if _cache_get(refresh_key) is None:
            _cache_set(refresh_key, True, ADMIN_ANALYTICS_REFRESH_LOCK_TTL_SECONDS)

            async def _refresh_stale_cache() -> None:
                try:
                    await _compute_admin_analytics_and_cache(db)
                except Exception:
                    pass
                finally:
                    _CACHE.pop(refresh_key, None)

            asyncio.create_task(_refresh_stale_cache())
        return stale_cached

    return await _compute_admin_analytics_and_cache(db)


async def _compute_admin_analytics_and_cache(db: Any) -> dict[str, Any]:
    """Compute analytics payload and refresh in-process cache."""
    month_buckets = _build_month_labels(12)
    month_index = {(y, m): idx for idx, (y, m, _) in enumerate(month_buckets)}
    month_labels = [label for _, _, label in month_buckets]
    monthly_views = [0] * len(month_buckets)
    monthly_new_users = [0] * len(month_buckets)
    week_buckets = _build_week_labels(7)
    week_index = {d: idx for idx, (d, _) in enumerate(week_buckets)}
    weekly_labels = [label for _, label in week_buckets]
    weekly_views = [0] * len(week_buckets)

    first_year, first_month, _ = month_buckets[0]
    from_date = datetime(first_year, first_month, 1, tzinfo=timezone.utc).isoformat()
    today_start = (
        datetime.now(timezone.utc)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .isoformat()
    )

    # ── Phase 1: DB queries only (no external HTTP) ─────────────────────
    try:
        (
            view_events_res,
            user_rows_res,
            today_events_res,
            views_rows_res,
        ) = await asyncio.wait_for(
            asyncio.gather(
                asyncio.to_thread(
                    lambda: db.table("manga_view_events")
                    .select("created_at")
                    .gte("created_at", from_date)
                    .execute()
                ),
                asyncio.to_thread(
                    lambda: db.table("profiles")
                    .select("created_at")
                    .gte("created_at", from_date)
                    .execute()
                ),
                asyncio.to_thread(
                    lambda: db.table("manga_view_events")
                    .select("id", count="exact")
                    .gte("created_at", today_start)
                    .execute()
                ),
                asyncio.to_thread(
                    lambda: db.table("manga_views")
                    .select("manga_slug, views")
                    .order("views", desc=True)
                    .limit(ADMIN_ANALYTICS_TOP_VIEWS_SCAN_LIMIT)
                    .execute()
                ),
                return_exceptions=True,
            ),
            timeout=ADMIN_ANALYTICS_PHASE1_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        timeout_error = RuntimeError("analytics phase-1 timeout")
        view_events_res = timeout_error
        user_rows_res = timeout_error
        today_events_res = timeout_error
        views_rows_res = timeout_error

    # Process view events
    try:
        for row in (view_events_res.data if not isinstance(view_events_res, Exception) else []):
            created_at = row.get("created_at")
            if not created_at:
                continue
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            idx = month_index.get((dt.year, dt.month))
            if idx is not None:
                monthly_views[idx] += 1
            day_idx = week_index.get(dt.date().isoformat())
            if day_idx is not None:
                weekly_views[day_idx] += 1
    except Exception:
        pass

    # Process user growth
    try:
        for row in (user_rows_res.data if not isinstance(user_rows_res, Exception) else []):
            created_at = row.get("created_at")
            if not created_at:
                continue
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            idx = month_index.get((dt.year, dt.month))
            if idx is not None:
                monthly_new_users[idx] += 1
    except Exception:
        pass

    views_today = 0
    try:
        if not isinstance(today_events_res, Exception):
            views_today = today_events_res.count or 0
    except Exception:
        pass

    # source_map is empty (OTruyen API calls removed for performance)
    # Titles resolved entirely from reading_history (title_map) below
    source_map: dict[str, str] = {}

    # Build valid rows from manga_views
    top_manga: list[dict[str, Any]] = []
    try:
        valid_rows: list[dict[str, Any]] = []
        for item in (views_rows_res.data if not isinstance(views_rows_res, Exception) else []):
            slug = _clean_slug(item.get("manga_slug"))
            if not _is_invalid_manga_slug(slug):
                valid_rows.append({"slug": slug, "views": int(item.get("views") or 0)})
        slugs = list(dict.fromkeys(item["slug"] for item in valid_rows))

        if slugs:
            # ── Phase 2: title + progress queries in parallel ─────────
            try:
                title_rows_res, progress_rows_res = await asyncio.wait_for(
                    asyncio.gather(
                        asyncio.to_thread(
                            lambda: db.table("reading_history")
                            .select("manga_slug, manga_title")
                            .in_("manga_slug", slugs)
                            .neq("manga_title", "")
                            .order("read_at", desc=True)
                            .limit(len(slugs) * 2)
                            .execute()
                        ),
                        asyncio.to_thread(
                            lambda: db.table("reading_history")
                            .select("manga_slug, progress")
                            .in_("manga_slug", slugs)
                            .gt("progress", 0)
                            .execute()
                        ),
                        return_exceptions=True,
                    ),
                    timeout=ADMIN_ANALYTICS_PHASE2_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                timeout_error = RuntimeError("analytics phase-2 timeout")
                title_rows_res = timeout_error
                progress_rows_res = timeout_error

            title_map: dict[str, str] = {}
            for r in (title_rows_res.data if not isinstance(title_rows_res, Exception) else []):
                s = _clean_slug(r.get("manga_slug", ""))
                if s and s not in title_map and r.get("manga_title"):
                    title_map[s] = r["manga_title"]

            progress_map: dict[str, list[float]] = {}
            for r in (progress_rows_res.data if not isinstance(progress_rows_res, Exception) else []):
                s = _clean_slug(r.get("manga_slug", ""))
                if s:
                    progress_map.setdefault(s, []).append(float(r.get("progress") or 0))

            # Phase 3: Batch-resolve MangaDex UUID slugs still missing titles.
            # A single /manga?ids[]=... call handles all UUIDs efficiently.
            _MDX_UUID_RE = re.compile(
                r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                re.IGNORECASE,
            )

            def _extract_mdx_uuid(value: str) -> str | None:
                normalized = str(value or "").strip().lower()
                if not normalized:
                    return None
                if normalized.startswith("mdx-"):
                    normalized = normalized[4:]
                return normalized if _MDX_UUID_RE.match(normalized) else None

            mdx_slug_to_uuid = {
                s: _extract_mdx_uuid(s)
                for s in slugs
                if s not in title_map and _extract_mdx_uuid(s)
            }
            uuid_slugs = list(dict.fromkeys([u for u in mdx_slug_to_uuid.values() if u]))
            detail_title_map: dict[str, str] = {}

            if uuid_slugs:
                try:
                    from fastapi_app.services.mangadex_service import _request_json  # type: ignore
                    batch_ids = uuid_slugs[:ADMIN_ANALYTICS_TOP_VIEWS_SCAN_LIMIT]
                    params: dict = {
                        "ids[]": batch_ids,
                        "includes[]": [],
                        "limit": len(batch_ids),
                    }
                    result = await asyncio.wait_for(
                        _request_json("/manga", params),
                        timeout=ADMIN_ANALYTICS_MDX_TITLE_BATCH_TIMEOUT_SECONDS,
                    )
                    for item in (result.get("data") or []):
                        manga_id = str(item.get("id") or "")
                        if not manga_id:
                            continue
                        attrs = item.get("attributes") or {}
                        title_obj = attrs.get("title") or {}
                        # Prefer VI title, then EN, then any available
                        title_str = (
                            title_obj.get("vi")
                            or title_obj.get("en")
                            or next(iter(title_obj.values()), "")
                        )
                        if not title_str:
                            # Try altTitles
                            for alt in (attrs.get("altTitles") or []):
                                if isinstance(alt, dict):
                                    title_str = alt.get("vi") or alt.get("en") or next(iter(alt.values()), "")
                                    if title_str:
                                        break
                        if title_str:
                            detail_title_map[manga_id] = str(title_str)
                            detail_title_map[f"mdx-{manga_id}"] = str(title_str)
                except Exception:
                    pass  # Non-critical: falls back to slug display

            # Resolve OTruyen titles for top unresolved slugs to avoid showing raw IDs/slugs.
            unresolved_for_external = [
                s
                for s in slugs
                if s not in title_map and s not in detail_title_map and not _extract_mdx_uuid(s)
            ]
            if ADMIN_ANALYTICS_ENABLE_OTRUYEN_TITLE_ENRICH and unresolved_for_external:
                async def _resolve_otruyen_title(slug_value: str) -> tuple[str, str]:
                    try:
                        detail = await asyncio.wait_for(
                            otruyen_service.get_manga_detail(slug_value),
                            timeout=ADMIN_ANALYTICS_OTRUYEN_TITLE_TIMEOUT_SECONDS,
                        )
                        item = (detail or {}).get("data", {}).get("item", {}) if isinstance(detail, dict) else {}
                        title = str(
                            item.get("name")
                            or item.get("title")
                            or item.get("comic_name")
                            or ""
                        ).strip()
                        return slug_value, title
                    except Exception:
                        return slug_value, ""

                resolved_titles = await asyncio.gather(
                    *[
                        _resolve_otruyen_title(s)
                        for s in unresolved_for_external[:ADMIN_ANALYTICS_OTRUYEN_TITLE_LIMIT]
                    ],
                    return_exceptions=False,
                )
                for slug_value, title_value in resolved_titles:
                    if title_value:
                        detail_title_map[slug_value] = title_value

            # Also check manga_uploads for any locally uploaded manga titles
            upload_slugs = [s for s in slugs if s not in title_map and s not in detail_title_map]
            if upload_slugs:
                try:
                    up_title_res = await asyncio.to_thread(
                        lambda: db.table("manga_uploads")
                        .select("manga_slug, title")
                        .in_("manga_slug", upload_slugs)
                        .execute()
                    )
                    for r in (up_title_res.data or []):
                        s = str(r.get("manga_slug") or "")
                        t = str(r.get("title") or "")
                        if s and t:
                            detail_title_map[s] = t
                except Exception:
                    pass

            # Merge
            merged: dict[str, dict[str, Any]] = {}
            for item in valid_rows:
                slug = item["slug"]
                title = (
                    source_map.get(slug)
                    or title_map.get(slug)
                    or detail_title_map.get(slug)
                    or _humanize_slug_title(slug)
                    or slug
                )
                key = _normalize_title_key(title) or slug
                progresses = progress_map.get(slug, [])
                progress_sum = sum(progresses)
                progress_count = len(progresses)
                if key in merged:
                    merged[key]["views"] += int(item.get("views") or 0)
                    merged[key]["progress_sum"] += progress_sum
                    merged[key]["progress_count"] += progress_count
                    cur_title = str(merged[key]["title"] or "")
                    if cur_title and "[" in cur_title and "[" not in title:
                        merged[key]["title"] = title
                else:
                    merged[key] = {
                        "slug": slug,
                        "title": title,
                        "views": int(item.get("views") or 0),
                        "progress_sum": progress_sum,
                        "progress_count": progress_count,
                    }

            top_manga = [
                {
                    "slug": data["slug"],
                    "title": data["title"],
                    "views": int(data["views"] or 0),
                    "completion_rate": round(data["progress_sum"] / data["progress_count"])
                    if data["progress_count"] > 0
                    else 0,
                }
                for data in merged.values()
            ]
            top_manga.sort(key=lambda x: x.get("views", 0), reverse=True)
            top_manga = top_manga[:8]
    except Exception:
        top_manga = []

    result = {
        "analytics": {
            "monthly_views": monthly_views,
            "monthly_new_users": monthly_new_users,
            "month_labels": month_labels,
            "weekly_views": weekly_views,
            "weekly_labels": weekly_labels,
            "views_today": views_today,
            "top_manga": top_manga,
        }
    }
    _cache_set_with_stale(
        "admin_analytics",
        result,
        ADMIN_ANALYTICS_CACHE_TTL_SECONDS,
        ADMIN_ANALYTICS_STALE_TTL_SECONDS,
    )
    return result


async def prewarm_admin_dashboard_cache(db: Any) -> None:
    """Best-effort warmup so first admin dashboard load can serve from cache."""
    if db is None:
        return

    try:
        if _cache_get("admin_stats") is None and _cache_get("admin_stats:stale") is None:
            await admin_stats(admin={"role": "admin"}, db=db)
    except Exception:
        pass

    try:
        if _cache_get("admin_analytics") is None and _cache_get("admin_analytics:stale") is None:
            await _compute_admin_analytics_and_cache(db)
    except Exception:
        pass


@router.get("/users")
async def list_users(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    role: str = Query(None),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Danh sách users (admin)."""
    query = db.table("profiles").select("*")
    search_filter = _build_ilike_or_filter(("username", "display_name", "email"), search)

    if search_filter:
        query = query.or_(search_filter)

    if role:
        query = query.eq("role", role)

    offset = (page - 1) * limit
    result = (
        query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    )

    total_query = db.table("profiles").select("id", count="exact")
    if search_filter:
        total_query = total_query.or_(search_filter)
    if role:
        total_query = total_query.eq("role", role)
    total = total_query.execute()

    return {
        "users": result.data,
        "total": total.count or 0,
        "page": page,
        "limit": limit,
    }


# ─── Manga Management ─────────────────────────────────────────────────────────

@router.get("/manga-list")
async def admin_manga_list(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    search: str = Query(None),
    source: str = Query("db"),       # "db" | "otruyen" | "mangadex" | "uploaded"
    filter_hidden: str = Query(None), # "hidden" | "visible" | None = all
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """
    All manga from all sources:
    - source=db       : manga_views (interacted) + manga_uploads
    - source=otruyen  : browse/search OTruyen full catalog via API
    - source=mangadex : search MangaDex Vi catalog
    - source=uploaded : only manga_uploads table
    """
    from fastapi_app.services import otruyen_service, mangadex_service

    def _coerce_views(*values: Any) -> int:
        for value in values:
            if value is None:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                return max(0, int(value))

            text = str(value).strip()
            if not text:
                continue
            text = text.replace(",", "")
            try:
                return max(0, int(float(text)))
            except Exception:
                continue
        return 0

    _SAFE_SLUG_FILTER_RE = re.compile(r"^[a-z0-9_-]+$")

    def _normalize_view_lookup_key(value: Any) -> str:
        return str(value or "").strip().strip("/").lower()

    def _canonical_view_slug(value: Any) -> str:
        normalized = _normalize_view_lookup_key(value)
        if not normalized:
            return ""
        if normalized.startswith("mdx-"):
            raw = normalized[4:]
            if _MANGADEX_ID_RE.fullmatch(raw):
                return raw
        if _MANGADEX_ID_RE.fullmatch(normalized):
            return normalized
        cleaned = _clean_slug(normalized)
        return cleaned or normalized

    def _view_slug_candidates(slug: Any) -> list[str]:
        normalized = _normalize_view_lookup_key(slug)
        if not normalized:
            return []

        candidates: set[str] = set()
        if normalized:
            candidates.add(normalized)

        cleaned = _clean_slug(normalized)
        if cleaned:
            candidates.add(cleaned)

        if normalized.startswith("mdx-"):
            raw = normalized[4:]
            if _MANGADEX_ID_RE.fullmatch(raw):
                candidates.add(raw)
                candidates.add(f"mdx-{raw}")
        elif _MANGADEX_ID_RE.fullmatch(normalized):
            candidates.add(normalized)
            candidates.add(f"mdx-{normalized}")

        # Only keep safe values for PostgREST filter expressions
        return [c for c in candidates if _SAFE_SLUG_FILTER_RE.fullmatch(c)]

    async def _fetch_local_views_map(slugs: list[Any]) -> dict[str, int]:
        lookup_candidates = sorted(
            {
                candidate
                for slug in slugs
                for candidate in _view_slug_candidates(slug)
                if candidate
            }
        )
        if not lookup_candidates:
            return {}

        rows: list[dict[str, Any]] = []
        chunk_size = 40
        for start in range(0, len(lookup_candidates), chunk_size):
            chunk = lookup_candidates[start : start + chunk_size]
            or_expr = ",".join(f"manga_slug.ilike.{value}" for value in chunk)
            try:
                chunk_res = await asyncio.to_thread(
                    lambda expression=or_expr: db.table("manga_views")
                    .select("manga_slug, views")
                    .or_(expression)
                    .execute()
                )
                rows.extend(chunk_res.data or [])
            except Exception:
                continue

        views_map: dict[str, int] = {}
        for row in rows:
            key = _normalize_view_lookup_key(row.get("manga_slug"))
            if not key:
                continue
            views_map[key] = views_map.get(key, 0) + _coerce_views(row.get("views"))

        # Fallback: if manga_views misses some slugs, derive count from view events.
        missing_candidates = [
            candidate
            for candidate in lookup_candidates
            if _normalize_view_lookup_key(candidate) not in views_map
        ]
        if missing_candidates:
            async def _count_events_for_slug(slug_value: str) -> tuple[str, int]:
                key = _normalize_view_lookup_key(slug_value)
                if not key:
                    return "", 0
                try:
                    res = await asyncio.to_thread(
                        lambda s=slug_value: db.table("manga_view_events")
                        .select("id", count="exact")
                        .ilike("manga_slug", s)
                        .limit(1)
                        .execute()
                    )
                    return key, int(res.count or 0)
                except Exception:
                    return key, 0

            event_counts = await asyncio.gather(
                *[_count_events_for_slug(candidate) for candidate in missing_candidates],
                return_exceptions=False,
            )
            for key, count in event_counts:
                if key and count > 0:
                    views_map[key] = max(views_map.get(key, 0), count)

        # Persist recovered counts back into manga_views so next requests are consistent.
        if views_map:
            canonical_totals: dict[str, int] = {}
            for raw_key, raw_count in views_map.items():
                canonical = _canonical_view_slug(raw_key)
                count = _coerce_views(raw_count)
                if not canonical or count <= 0:
                    continue
                canonical_totals[canonical] = max(canonical_totals.get(canonical, 0), count)

            if canonical_totals:
                try:
                    existing_res = await asyncio.to_thread(
                        lambda: db.table("manga_views")
                        .select("manga_slug, views")
                        .in_("manga_slug", list(canonical_totals.keys()))
                        .execute()
                    )
                    existing_map = {
                        _normalize_view_lookup_key(row.get("manga_slug")): _coerce_views(row.get("views"))
                        for row in (existing_res.data or [])
                    }

                    upsert_rows = []
                    for canonical_slug, recovered_count in canonical_totals.items():
                        current_count = existing_map.get(canonical_slug, 0)
                        merged_count = max(current_count, recovered_count)
                        if merged_count <= 0:
                            continue
                        upsert_rows.append({"manga_slug": canonical_slug, "views": merged_count})

                    if upsert_rows:
                        await asyncio.to_thread(
                            lambda rows=upsert_rows: db.table("manga_views")
                            .upsert(rows, on_conflict="manga_slug")
                            .execute()
                        )
                except Exception:
                    pass
        return views_map

    def _sum_local_views(views_map: dict[str, int], slug: Any) -> int:
        total_views = 0
        for candidate in _view_slug_candidates(slug):
            total_views += views_map.get(_normalize_view_lookup_key(candidate), 0)
        return total_views

    # ── Special path: "Đang ẩn" always queries manga_overrides directly ──────
    # Bypasses source-based queries so ALL hidden manga appear, even ones no
    # user has ever opened (not in manga_views).
    if filter_hidden == "hidden":
        offset = (page - 1) * limit
        q = (
            db.table("manga_overrides")
            .select("manga_slug, hidden_reason, is_featured, admin_notes, hidden_at")
            .eq("is_hidden", True)
        )
        if search:
            q = q.ilike("manga_slug", f"%{search}%")
        ov_res, cnt_res = await asyncio.gather(
            asyncio.to_thread(lambda: q.order("hidden_at", desc=True).range(offset, offset + limit - 1).execute()),
            asyncio.to_thread(lambda: db.table("manga_overrides").select("manga_slug", count="exact").eq("is_hidden", True).execute()),
            return_exceptions=True,
        )
        ov_rows  = [] if isinstance(ov_res,  Exception) else (ov_res.data  or [])
        total_hd = 0  if isinstance(cnt_res, Exception) else (cnt_res.count or 0)

        # Enrich with title/cover from manga_uploads (uploaded manga only)
        ov_slugs = [r["manga_slug"] for r in ov_rows]
        uploads_map: dict[str, dict] = {}
        local_views_map: dict[str, int] = {}
        if ov_slugs:
            try:
                up_res = await asyncio.to_thread(
                    lambda: db.table("manga_uploads")
                    .select("manga_slug, title, cover_url, status, views")
                    .in_("manga_slug", ov_slugs)
                    .execute()
                )
                for u in (up_res.data or []):
                    uploads_map[u["manga_slug"]] = u
            except Exception:
                pass

            try:
                local_views_map = await _fetch_local_views_map(ov_slugs)
            except Exception:
                pass

        result_rows = []
        for r in ov_rows:
            slug   = r["manga_slug"]
            upload = uploads_map.get(slug, {})
            local_views = _sum_local_views(local_views_map, slug)
            upload_views = _coerce_views(upload.get("views"))
            result_rows.append({
                "slug":         slug,
                "title":        upload.get("title") or slug,
                "cover_url":    upload.get("cover_url") or "",
                "views":        upload_views + local_views,
                "source":       "uploaded" if upload else "external",
                "upload_status": upload.get("status"),
                "is_hidden":    True,
                "hidden_reason": r.get("hidden_reason"),
                "hidden_at":    r.get("hidden_at"),
                "is_featured":  bool(r.get("is_featured", False)),
                "admin_notes":  r.get("admin_notes"),
            })
        return {"manga": result_rows, "total": total_hd, "page": page, "limit": limit}

    raw_items: list[dict] = []
    total = 0

    # ── OTruyen ───────────────────────────────────────────────
    if source == "otruyen":
        if search:
            resp = await otruyen_service.search_manga(search, page)
        else:
            resp = await otruyen_service.get_list("truyen-moi", page)

        if isinstance(resp, dict) and resp.get("status") != "error":
            data = resp.get("data", {})
            items = data.get("items") or []
            pagination = (data.get("params") or {}).get("pagination") or {}
            total = int(pagination.get("totalItems") or len(items))
            for it in items:
                slug = str(it.get("slug") or "")
                if not slug:
                    continue
                raw_items.append({
                    "slug": slug,
                    "title": str(it.get("name") or it.get("title") or slug),
                    "cover_url": otruyen_service.get_image_url(str(it.get("thumb_url") or "")),
                    "views": _coerce_views(it.get("views"), it.get("view_count"), it.get("view")),
                    "source": "otruyen",
                    "upload_status": None,
                })

    # ── MangaDex ──────────────────────────────────────────────
    elif source == "mangadex":
        # "mangadex" is a special tag in search_manga that triggers
        # catalog-listing mode: all VI manga ordered by latest chapter.
        # When admin types a search term, use that instead.
        kw = search or "mangadex"
        resp = await mangadex_service.search_manga(kw, page, limit)
        if isinstance(resp, dict):
            data = resp.get("data", {})
            items = data.get("items") or []
            pagination = (data.get("params") or {}).get("pagination") or {}
            total = int(pagination.get("totalItems") or len(items))
            for it in items:
                # MangaDex items use "id" as slug (UUID), "name" as title
                slug = str(it.get("id") or it.get("slug") or "")
                if not slug:
                    continue
                raw_items.append({
                    "slug": slug,
                    "title": str(it.get("name") or it.get("title") or slug),
                    "cover_url": str(it.get("thumb_url") or it.get("cover_url") or ""),
                    "views": _coerce_views(it.get("views"), it.get("view_count"), it.get("view")),
                    "source": "mangadex",
                    "upload_status": None,
                })

    # ── Uploaded ──────────────────────────────────────────────
    elif source == "uploaded":
        offset = (page - 1) * limit
        q = db.table("manga_uploads").select(
            "manga_slug, title, cover_url, status, views"
        )
        search_filter = _build_ilike_or_filter(("title", "manga_slug"), search)
        if search_filter:
            q = q.or_(search_filter)
        count_q = db.table("manga_uploads").select("id", count="exact")
        if search_filter:
            count_q = count_q.or_(search_filter)
        up_res, cnt_res = await asyncio.gather(
            asyncio.to_thread(lambda: q.order("created_at", desc=True).range(offset, offset + limit - 1).execute()),
            asyncio.to_thread(lambda: count_q.execute()),
            return_exceptions=True,
        )
        for u in ([] if isinstance(up_res, Exception) else (up_res.data or [])):
            raw_items.append({
                "slug": u["manga_slug"],
                "title": u.get("title") or u["manga_slug"],
                "cover_url": u.get("cover_url") or "",
                "views": _coerce_views(u.get("views")),
                "source": "uploaded",
                "upload_status": u.get("status"),
            })
        total = 0 if isinstance(cnt_res, Exception) else (cnt_res.count or 0)

    # ── DB (default) — manga_views + manga_uploads ─────────────
    else:
        offset = (page - 1) * limit
        q = db.table("manga_views").select("manga_slug, views")
        if search:
            q = q.ilike("manga_slug", f"%{search}%")
        views_res, total_res, up_all_res = await asyncio.gather(
            asyncio.to_thread(lambda: q.order("views", desc=True).range(offset, offset + limit - 1).execute()),
            asyncio.to_thread(lambda: db.table("manga_views").select("manga_slug", count="exact").execute()),
            asyncio.to_thread(
                lambda: db.table("manga_uploads")
                .select("manga_slug, title, cover_url, status")
                .execute()
            ),
            return_exceptions=True,
        )
        view_rows = [] if isinstance(views_res, Exception) else (views_res.data or [])
        total = 0 if isinstance(total_res, Exception) else (total_res.count or 0)

        # Build upload lookup
        all_uploads_map: dict[str, dict] = {
            u["manga_slug"]: u
            for u in ([] if isinstance(up_all_res, Exception) else (up_all_res.data or []))
        }

        # Filter invalid slugs (chapter0, uploads, MD5 hashes, pure numbers, dates...)
        valid_view_rows = [r for r in view_rows if not _is_invalid_manga_slug(r.get("manga_slug"))]

        # Slugs needing title resolution
        view_slugs = [r["manga_slug"] for r in valid_view_rows]
        need_title = [s for s in view_slugs if s not in all_uploads_map]
        need_title_unique = list(
            dict.fromkeys(
                [str(s or "").strip() for s in need_title if str(s or "").strip()]
            )
        )

        def _pick_title_from_map(slug: str, title_map: dict[str, str]) -> str:
            for candidate in _view_slug_candidates(slug):
                title = title_map.get(_normalize_view_lookup_key(candidate))
                if title:
                    return title
            return ""

        # Phase 1: reading_history (covers most cases — OTruyen + some MangaDex)
        history_title_map: dict[str, str] = {}
        if need_title_unique:
            history_lookup_slugs = sorted(
                {
                    candidate
                    for slug in need_title_unique
                    for candidate in _view_slug_candidates(slug)
                    if candidate
                }
            )
            chunk_size = 60
            for start in range(0, len(history_lookup_slugs), chunk_size):
                chunk = history_lookup_slugs[start : start + chunk_size]
                if not chunk:
                    continue
                try:
                    hist_res = await asyncio.to_thread(
                        lambda values=chunk: db.table("reading_history")
                        .select("manga_slug, manga_title")
                        .in_("manga_slug", values)
                        .neq("manga_title", "")
                        .order("read_at", desc=True)
                        .limit(max(len(values) * 2, 80))
                        .execute()
                    )
                    for h in (hist_res.data or []):
                        s = _normalize_view_lookup_key(h.get("manga_slug"))
                        t = str(h.get("manga_title") or "").strip()
                        if s and t and s not in history_title_map:
                            history_title_map[s] = t
                except Exception:
                    continue

        # Phase 2: Batch MangaDex API for mdx- / raw UUID slugs still missing title
        _MDX_UUID = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
        )
        mdx_title_map: dict[str, str] = {}
        mdx_to_fetch: list[tuple[str, str]] = []  # (original_slug, uuid)
        for s in need_title_unique:
            if _pick_title_from_map(s, history_title_map):
                continue
            normalized = _normalize_view_lookup_key(s)
            if normalized.startswith("mdx-") and _MDX_UUID.match(normalized[4:]):
                mdx_to_fetch.append((s, normalized[4:]))
            elif _MDX_UUID.match(normalized):
                mdx_to_fetch.append((s, normalized))
        if mdx_to_fetch:
            try:
                from fastapi_app.services.mangadex_service import _request_json  # type: ignore
                all_uuids = list(dict.fromkeys([uuid for _, uuid in mdx_to_fetch if uuid]))
                for start in range(0, len(all_uuids), 20):
                    batch = all_uuids[start : start + 20]
                    if not batch:
                        continue
                    result = await asyncio.wait_for(
                        _request_json("/manga", {"ids[]": batch, "limit": len(batch)}),
                        timeout=5.0,
                    )
                    for item in (result.get("data") or []):
                        mid = str(item.get("id") or "")
                        attrs = item.get("attributes") or {}
                        title_obj = attrs.get("title") or {}
                        t = title_obj.get("vi") or title_obj.get("en") or next(iter(title_obj.values()), "")
                        if not t:
                            for alt in (attrs.get("altTitles") or []):
                                if isinstance(alt, dict):
                                    t = alt.get("vi") or alt.get("en") or next(iter(alt.values()), "")
                                    if t:
                                        break
                        if t and mid:
                            mdx_title_map[mid] = str(t)
                            mdx_title_map[f"mdx-{mid}"] = str(t)
            except Exception:
                pass

        # Phase 3: OTruyen detail fallback for unresolved slugs in current page.
        detail_title_map: dict[str, str] = {}
        unresolved_otruyen_slugs = [
            s
            for s in need_title_unique
            if not _pick_title_from_map(s, history_title_map)
            and not _pick_title_from_map(s, mdx_title_map)
            and not _MDX_UUID.match(_normalize_view_lookup_key(s).replace("mdx-", ""))
        ]
        if unresolved_otruyen_slugs:
            async def _resolve_otruyen_title(slug_value: str) -> tuple[str, str]:
                cache_key = f"admin:db-title:{slug_value}"
                cached_title = _cache_get(cache_key)
                if isinstance(cached_title, str) and cached_title.strip():
                    return slug_value, cached_title.strip()
                try:
                    detail = await asyncio.wait_for(
                        otruyen_service.get_manga_detail(slug_value),
                        timeout=5.0,
                    )
                    item = (detail or {}).get("data", {}).get("item", {}) if isinstance(detail, dict) else {}
                    resolved = str(
                        item.get("name")
                        or item.get("title")
                        or item.get("comic_name")
                        or ""
                    ).strip()
                    if resolved:
                        _cache_set(cache_key, resolved, 60 * 60)
                    return slug_value, resolved
                except Exception:
                    return slug_value, ""

            resolved_rows = await asyncio.gather(
                *[_resolve_otruyen_title(s) for s in unresolved_otruyen_slugs[:20]],
                return_exceptions=False,
            )
            for slug_value, resolved_title in resolved_rows:
                if resolved_title:
                    detail_title_map[_normalize_view_lookup_key(slug_value)] = resolved_title

        def _resolve_db_title(slug: str) -> str:
            u = all_uploads_map.get(slug, {})
            if u.get("title"):
                return u["title"]
            return (
                _pick_title_from_map(slug, history_title_map)
                or _pick_title_from_map(slug, mdx_title_map)
                or _pick_title_from_map(slug, detail_title_map)
                or slug
            )

        for r in valid_view_rows:
            slug = r["manga_slug"]
            u = all_uploads_map.get(slug, {})
            raw_items.append({
                "slug": slug,
                "title": _resolve_db_title(slug),
                "cover_url": u.get("cover_url") or "",
                "views": _coerce_views(r.get("views", 0)),
                "source": "uploaded" if u else "external",
                "upload_status": u.get("status"),
            })

    # External sources often do not provide reliable views.
    # Merge in local tracked views to avoid showing all-zero rows.
    if source in {"otruyen", "mangadex"} and raw_items:
        source_slugs = [str(item.get("slug") or "") for item in raw_items if str(item.get("slug") or "")]
        if source_slugs:
            try:
                local_views_map = await _fetch_local_views_map(source_slugs)
                for item in raw_items:
                    slug = str(item.get("slug") or "")
                    local_views = _sum_local_views(local_views_map, slug)
                    item["views"] = _coerce_views(item.get("views")) + local_views
            except Exception:
                pass

        # Fallback by title: some legacy rows were stored with inconsistent slugs,
        # so resolve the best matching viewed slug from reading_history titles.
        unresolved_by_slug = [
            item
            for item in raw_items
            if _coerce_views(item.get("views")) <= 0 and str(item.get("title") or "").strip()
        ]
        if unresolved_by_slug:
            title_key_to_text: dict[str, str] = {}
            for item in unresolved_by_slug:
                key = _normalize_title_key(item.get("title"))
                title_text = str(item.get("title") or "").strip()
                if key and title_text and key not in title_key_to_text:
                    title_key_to_text[key] = title_text

            async def _lookup_history_slugs_by_title(title_text: str) -> tuple[str, set[str]]:
                try:
                    history_res = await asyncio.to_thread(
                        lambda title=title_text: db.table("reading_history")
                        .select("manga_slug")
                        .ilike("manga_title", title)
                        .limit(200)
                        .execute()
                    )
                    return title_text, {
                        str(row.get("manga_slug") or "").strip()
                        for row in (history_res.data or [])
                        if str(row.get("manga_slug") or "").strip()
                    }
                except Exception:
                    return title_text, set()

            title_results = await asyncio.gather(
                *[_lookup_history_slugs_by_title(text) for text in title_key_to_text.values()],
                return_exceptions=False,
            )

            title_text_to_slugs = {text: slugs for text, slugs in title_results}
            title_key_to_slugs = {
                key: title_text_to_slugs.get(text, set())
                for key, text in title_key_to_text.items()
            }
            fallback_slugs = sorted({slug for slugs in title_key_to_slugs.values() for slug in slugs if slug})

            if fallback_slugs:
                try:
                    fallback_views_map = await _fetch_local_views_map(fallback_slugs)
                    for item in unresolved_by_slug:
                        key = _normalize_title_key(item.get("title"))
                        slugs = title_key_to_slugs.get(key, set())
                        if not slugs:
                            continue
                        # Use max instead of sum to avoid over-counting duplicate titles.
                        best_title_match_views = max(
                            (_sum_local_views(fallback_views_map, candidate_slug) for candidate_slug in slugs),
                            default=0,
                        )
                        if best_title_match_views > 0:
                            item["views"] = max(_coerce_views(item.get("views")), best_title_match_views)
                except Exception:
                    pass

    # ── Augment with override data ──────────────────────────────
    slugs = [r["slug"] for r in raw_items]
    overrides_map: dict[str, dict] = {}
    override_lookup_slugs = sorted(
        {
            candidate
            for slug in slugs
            for candidate in _override_slug_candidates(slug)
            if candidate
        }
    )
    if override_lookup_slugs:
        try:
            ov_res = await asyncio.to_thread(
                lambda: db.table("manga_overrides")
                .select("manga_slug, is_hidden, hidden_reason, is_featured, admin_notes, hidden_at")
                .in_("manga_slug", override_lookup_slugs)
                .execute()
            )
            for o in (ov_res.data or []):
                key = str(o.get("manga_slug") or "").strip().strip("/").lower()
                if key:
                    overrides_map[key] = o
        except Exception:
            pass

    result_rows = []
    for r in raw_items:
        override = {}
        for candidate in _override_slug_candidates(r.get("slug")):
            matched = overrides_map.get(candidate)
            if matched:
                override = matched
                break
        is_hidden = bool(override.get("is_hidden", False))
        if filter_hidden == "hidden" and not is_hidden:
            continue
        if filter_hidden == "visible" and is_hidden:
            continue
        result_rows.append({
            **r,
            "is_hidden": is_hidden,
            "hidden_reason": override.get("hidden_reason"),
            "hidden_at": override.get("hidden_at"),
            "is_featured": bool(override.get("is_featured", False)),
            "admin_notes": override.get("admin_notes"),
        })

    return {"manga": result_rows, "total": total, "page": page, "limit": limit}


@router.post("/manga/{slug}/hide")
async def admin_hide_manga(
    slug: str,
    reason: str = Query(""),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Ẩn manga khỏi website."""
    from datetime import datetime, timezone
    from fastapi_app.routers.manga import invalidate_hidden_cache

    target_slug = _canonical_manga_override_slug(slug)
    if not target_slug:
        raise HTTPException(status_code=400, detail="Slug manga không hợp lệ")

    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "manga_slug": target_slug,
        "is_hidden": True,
        "hidden_reason": reason or "Ẩn bởi admin",
        "hidden_at": now,
        "hidden_by": admin["id"],
        "updated_at": now,
    }
    rows = [payload]
    legacy_alias = _legacy_mangadex_alias(target_slug)
    if legacy_alias and legacy_alias != target_slug:
        rows.append({**payload, "manga_slug": legacy_alias})

    db.table("manga_overrides").upsert(rows, on_conflict="manga_slug").execute()
    _cache_invalidate_prefix(f"manga_{target_slug}")
    if legacy_alias:
        _cache_invalidate_prefix(f"manga_{legacy_alias}")
    invalidate_hidden_cache()  # Clear in-memory hidden-slug cache immediately
    return {"message": f"Đã ẩn manga '{target_slug}'"}


@router.post("/manga/{slug}/show")
async def admin_show_manga(
    slug: str,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Hiện lại manga."""
    from datetime import datetime, timezone
    from fastapi_app.routers.manga import invalidate_hidden_cache

    target_slug = _canonical_manga_override_slug(slug)
    if not target_slug:
        raise HTTPException(status_code=400, detail="Slug manga không hợp lệ")

    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "manga_slug": target_slug,
        "is_hidden": False,
        "hidden_reason": None,
        "hidden_at": None,
        "hidden_by": None,
        "updated_at": now,
    }
    rows = [payload]
    legacy_alias = _legacy_mangadex_alias(target_slug)
    if legacy_alias and legacy_alias != target_slug:
        rows.append({**payload, "manga_slug": legacy_alias})

    db.table("manga_overrides").upsert(rows, on_conflict="manga_slug").execute()
    _cache_invalidate_prefix(f"manga_{target_slug}")
    if legacy_alias:
        _cache_invalidate_prefix(f"manga_{legacy_alias}")
    invalidate_hidden_cache()  # Clear in-memory hidden-slug cache immediately
    return {"message": f"Đã hiện lại manga '{target_slug}'"}


@router.put("/manga/{slug}/settings")
async def admin_update_manga_settings(
    slug: str,
    payload: MangaSettingsUpdate | None = None,
    is_featured: bool | None = Query(None),
    admin_notes: str | None = Query(None),
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Cập nhật featured / ghi chú admin cho manga."""
    from datetime import datetime, timezone

    resolved_is_featured = is_featured
    resolved_admin_notes = admin_notes
    if payload is not None:
        if payload.is_featured is not None:
            resolved_is_featured = payload.is_featured
        if payload.admin_notes is not None:
            resolved_admin_notes = payload.admin_notes

    if resolved_is_featured is None and resolved_admin_notes is None:
        raise HTTPException(status_code=400, detail="Thiếu dữ liệu cập nhật")

    target_slug = _canonical_manga_override_slug(slug)
    if not target_slug:
        raise HTTPException(status_code=400, detail="Slug manga không hợp lệ")

    now = datetime.now(timezone.utc).isoformat()
    data: dict = {"manga_slug": target_slug, "updated_at": now}
    if resolved_is_featured is not None:
        data["is_featured"] = resolved_is_featured
        if resolved_is_featured:
            data["featured_at"] = now
            data["featured_by"] = admin["id"]
        else:
            data["featured_at"] = None
            data["featured_by"] = None
    if resolved_admin_notes is not None:
        data["admin_notes"] = resolved_admin_notes

    rows = [data]
    legacy_alias = _legacy_mangadex_alias(target_slug)
    if legacy_alias and legacy_alias != target_slug:
        rows.append({**data, "manga_slug": legacy_alias})

    db.table("manga_overrides").upsert(rows, on_conflict="manga_slug").execute()
    return {"message": "Đã cập nhật settings"}


@router.post("/ban")
async def ban_user(
    data: BanUser, admin=Depends(require_role("moderator", "admin")), db=Depends(get_supabase)
):
    """Cấm user."""
    target_role = _fetch_profile_role(db, data.user_id)
    _ensure_moderator_not_targeting_admin(
        admin,
        target_role,
        "Moderator không thể cấm admin",
    )
    if target_role == "admin":
        raise HTTPException(status_code=403, detail="Không thể cấm admin")

    db.table("profiles").update(
        {
            "is_banned": True,
            "ban_reason": data.ban_reason,
        }
    ).eq("id", data.user_id).execute()

    _log_action(db, admin, "Ban user", data.user_id)
    return {"message": "Đã cấm user"}


@router.post("/unban/{user_id}")
async def unban_user(
    user_id: str, admin=Depends(require_admin), db=Depends(get_supabase)
):
    """Bỏ cấm user."""
    db.table("profiles").update(
        {
            "is_banned": False,
            "ban_reason": None,
        }
    ).eq("id", user_id).execute()
    _log_action(db, admin, "Unban user", user_id)
    return {"message": "Đã bỏ cấm user"}


@router.post("/change-role")
async def change_role(
    data: ChangeRole,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Thay đổi role user."""
    # Only super-admin can set admin role
    if data.role.value == "admin" and admin.get("role") != "admin":
        raise HTTPException(
            status_code=403, detail="Chỉ admin mới có thể cấp quyền admin"
        )

    db.table("profiles").update(
        {
            "role": data.role.value,
        }
    ).eq("id", data.user_id).execute()

    _log_action(db, admin, "Đổi role", f"{data.user_id} → {data.role.value}")
    return {"message": f"Đã đổi role thành {data.role.value}"}


@router.get("/reports")
async def admin_reports(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Danh sách reports (admin)."""
    query = db.table("reports").select(
        "*, profiles!reporter_id(username, display_name)"
    )

    if status:
        query = query.eq("status", status)

    offset = (page - 1) * limit
    result = (
        query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    )

    return {"reports": result.data}


@router.put("/reports/{report_id}")
async def update_report(
    report_id: str,
    status: str = Query(...),
    admin_note: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Cập nhật status report."""
    update_data = {"status": status}
    if admin_note:
        update_data["admin_note"] = admin_note
    if status in ("resolved", "dismissed"):
        update_data["resolved_at"] = datetime.now(timezone.utc).isoformat()

    db.table("reports").update(update_data).eq("id", report_id).execute()
    return {"message": "Đã cập nhật report"}


@router.get("/comments/{comment_id}")
async def admin_get_comment(
    comment_id: str,
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    result = (
        db.table("comments")
        .select(
            "id, user_id, manga_slug, chapter_id, content, image_url, is_deleted, created_at, "
            "profiles!comments_user_id_fkey(id, username, display_name, is_banned, role)"
        )
        .eq("id", comment_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Không tìm thấy bình luận")
    row = rows[0]
    profile = row.pop("profiles", {}) or {}
    target_role = str(profile.get("role") or "").strip().lower()
    _ensure_moderator_not_targeting_admin(
        admin,
        target_role,
        "Moderator không thể thao tác với bình luận của admin",
    )
    return {
        "comment": {
            **row,
            "username": profile.get("display_name") or profile.get("username", ""),
            "profile_id": profile.get("id", ""),
            "role": target_role or "reader",
            "user_is_banned": profile.get("is_banned", False),
        }
    }


@router.delete("/comments/{comment_id}")
async def admin_delete_comment(
    comment_id: str,
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin xóa bình luận."""
    row = (
        db.table("comments").select("id, image_url, user_id").eq("id", comment_id).limit(1).execute()
    )
    record = (row.data or [None])[0]
    if not record:
        raise HTTPException(status_code=404, detail="Không tìm thấy bình luận")

    target_role = _fetch_profile_role(db, record.get("user_id"))
    _ensure_moderator_not_targeting_admin(
        admin,
        target_role,
        "Moderator không thể xóa bình luận của admin",
    )

    _remove_comment_image(db, str(record.get("image_url") or ""))
    db.table("comments").update({"is_deleted": True}).eq("id", comment_id).execute()
    _log_action(db, admin, "Xóa bình luận", f"Comment {comment_id}")
    return {"message": "Đã xóa bình luận"}


# ── Helper: audit log ──
def _log_action(db, admin, action: str, target: str = "", details: dict = None):
    try:
        db.table("audit_log").insert(
            {
                "admin_id": admin["id"],
                "admin_name": admin.get("email", ""),
                "action": action,
                "target": target,
                "details": details or {},
            }
        ).execute()
    except Exception:
        pass  # Don't block main operation


# ── Audit Log ──
@router.get("/maintenance")
async def admin_get_maintenance(admin=Depends(require_admin)):
    _ = admin
    return {"maintenance": await asyncio.to_thread(get_maintenance_state, force=True)}


@router.put("/maintenance")
async def admin_update_maintenance(
    payload: MaintenanceModeUpdate,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    title = str(payload.title or "").strip() or None
    message = str(payload.message or "").strip() or None
    image_url = str(payload.image_url or "").strip() or None
    starts_at = str(payload.starts_at or "").strip() or None
    ends_at = str(payload.ends_at or "").strip() or None
    state = await asyncio.to_thread(
        set_maintenance_state,
        enabled=payload.enabled,
        title=title,
        message=message,
        image_url=image_url,
        starts_at=starts_at,
        ends_at=ends_at,
        updated_by=admin["id"],
    )
    _log_action(
        db,
        admin,
        "Bật bảo trì" if state.get("enabled") else "Tắt bảo trì",
        state.get("title") or "",
        {"maintenance": state},
    )
    return {
        "message": "Đã bật chế độ bảo trì" if state.get("enabled") else "Đã tắt chế độ bảo trì",
        "maintenance": state,
    }


@router.get("/audit-log")
async def get_audit_log(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Nhật ký hoạt động admin."""
    offset = (page - 1) * limit
    result = (
        db.table("audit_log")
        .select("*")
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return {"logs": result.data}


# ── User Detail (comments, history) ──
@router.get("/users/{user_id}/comments")
async def get_user_comments(
    user_id: str,
    limit: int = Query(10, ge=1, le=50),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Xem bình luận của user."""
    target_role = _fetch_profile_role(db, user_id)
    _ensure_moderator_not_targeting_admin(
        admin,
        target_role,
        "Moderator không thể truy cập dữ liệu của admin",
    )

    result = (
        db.table("comments")
        .select("*")
        .eq("user_id", user_id)
        .eq("is_deleted", False)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {"comments": result.data}


@router.get("/users/{user_id}/history")
async def get_user_history(
    user_id: str,
    limit: int = Query(10, ge=1, le=50),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Xem lịch sử đọc của user."""
    target_role = _fetch_profile_role(db, user_id)
    _ensure_moderator_not_targeting_admin(
        admin,
        target_role,
        "Moderator không thể truy cập dữ liệu của admin",
    )

    result = (
        db.table("reading_history")
        .select("*")
        .eq("user_id", user_id)
        .order("read_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {"history": result.data}


# ── Pending Uploads (for review) ──
async def admin_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Danh sách uploads (admin/moderator)."""
    query = db.table("chapter_uploads").select(
        "*, profiles!uploader_id(username, display_name)"
    )
    if status:
        query = query.eq("status", status)
    offset = (page - 1) * limit
    result = (
        query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    )
    return {"uploads": result.data}


async def review_upload(
    upload_id: str,
    action: str = Query(..., regex="^(approve|reject)$"),
    reason: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Duyệt hoặc từ chối upload."""
    upload_row_res = (
        db.table("chapter_uploads")
        .select("id, uploader_id, manga_title, chapter_number, profiles!uploader_id(role)")
        .eq("id", upload_id)
        .limit(1)
        .execute()
    )
    upload_row = (upload_row_res.data or [None])[0]
    if not upload_row:
        raise HTTPException(status_code=404, detail="Không tìm thấy upload")

    uploader_role = _extract_joined_profile_role(upload_row.get("profiles"))
    if not uploader_role:
        uploader_role = _fetch_profile_role(db, upload_row.get("uploader_id"))
    _ensure_moderator_not_targeting_admin(
        admin,
        uploader_role,
        "Moderator không thể duyệt chapter do admin đăng",
    )

    update_data = {
        "reviewed_by": admin["id"],
    }
    if action == "approve":
        update_data["status"] = "published"
        update_data["published_at"] = datetime.now(timezone.utc).isoformat()
    else:
        update_data["status"] = "rejected"
        update_data["rejection_reason"] = reason or ""

    db.table("chapter_uploads").update(update_data).eq("id", upload_id).execute()
    target_name = (
        f"{upload_row.get('manga_title', '')} Ch.{upload_row.get('chapter_number', '?')}"
        if upload_row
        else upload_id
    )
    _log_action(
        db,
        admin,
        f"{'Duyệt' if action == 'approve' else 'Từ chối'} chapter",
        target_name,
    )
    return {"message": f"Đã {'duyệt' if action == 'approve' else 'từ chối'} upload"}


async def admin_manga_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Danh sách manga uploads (admin/moderator)."""
    query = db.table("manga_uploads").select(
        "*, profiles!uploader_id(username, display_name)"
    )
    if status:
        query = query.eq("status", status)
    offset = (page - 1) * limit
    result = (
        query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    )
    return {"uploads": result.data}


async def review_manga_upload(
    upload_id: str,
    action: str = Query(..., regex="^(approve|reject)$"),
    reason: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Duyệt hoặc từ chối manga upload."""
    upload_row_res = (
        db.table("manga_uploads")
        .select("id, uploader_id, title, profiles!uploader_id(role)")
        .eq("id", upload_id)
        .limit(1)
        .execute()
    )
    upload_row = (upload_row_res.data or [None])[0]
    if not upload_row:
        raise HTTPException(status_code=404, detail="Không tìm thấy manga upload")

    uploader_role = _extract_joined_profile_role(upload_row.get("profiles"))
    if not uploader_role:
        uploader_role = _fetch_profile_role(db, upload_row.get("uploader_id"))
    _ensure_moderator_not_targeting_admin(
        admin,
        uploader_role,
        "Moderator không thể duyệt manga do admin đăng",
    )

    update_data = {
        "reviewed_by": admin["id"],
    }
    if action == "approve":
        update_data["status"] = "published"
        update_data["published_at"] = datetime.now(timezone.utc).isoformat()
    else:
        update_data["status"] = "rejected"
        update_data["rejection_reason"] = reason or ""

    db.table("manga_uploads").update(update_data).eq("id", upload_id).execute()
    target_name = upload_row.get("title", upload_id) if upload_row else upload_id
    _log_action(
        db, admin, f"{'Duyệt' if action == 'approve' else 'Từ chối'} manga", target_name
    )
    return {
        "message": f"Đã {'duyệt' if action == 'approve' else 'từ chối'} manga upload"
    }


# ── Broadcast Notification ──
@router.post("/notify")
async def broadcast_notification(
    data: NotifyRequest,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Gửi thông báo hệ thống tới tất cả hoặc nhóm user cụ thể."""
    announcement = await asyncio.to_thread(_create_site_announcement, db, data, admin)

    # Build user_ids list based on target
    try:
        query = db.table("profiles").select("id")
        if data.target != "all":
            query = query.eq("role", data.target)
        query = query.eq("is_banned", False)
        users = query.execute()
        user_ids = [u["id"] for u in (users.data or [])]
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Không thể lấy danh sách user: {str(e)}"
        )

    if not user_ids:
        return {
            "message": "Không có user nào phù hợp"
            + (" nhưng đã tạo popup home" if announcement else ""),
            "sent": 0,
            "announcement": announcement,
        }

    # Batch insert notifications (chunks of 100 to avoid payload limits)
    CHUNK = 100
    sent = 0
    for i in range(0, len(user_ids), CHUNK):
        chunk = user_ids[i : i + CHUNK]
        rows = [
            {
                "user_id": uid,
                "type": data.notify_type
                if data.notify_type
                in ("system", "new_chapter", "reply", "follow_update")
                else "system",
                "title": data.title,
                "message": data.message,
            }
            for uid in chunk
        ]
        try:
            db.table("notifications").insert(rows).execute()
            sent += len(chunk)
        except Exception:
            pass  # Continue with next chunk even if one fails

    popup_text = " + popup home" if announcement else ""
    _log_action(db, admin, "Broadcast thông báo", f"→ {sent} users{popup_text}: {data.title}")
    return {
        "message": f"Đã gửi thông báo tới {sent} người dùng"
        + (" và hiện popup home" if announcement else ""),
        "sent": sent,
        "announcement": announcement,
    }


# ── VIP Management ──
@router.put("/users/{user_id}/vip")
async def set_user_vip(
    user_id: str,
    data: VipUpdate,
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Cấp hoặc thu hồi VIP — optimized with parallel IO."""
    # Fetch + build update payload concurrently
    update_payload: dict[str, Any] = {"is_vip": data.is_vip}
    if data.is_vip and data.vip_expiry:
        update_payload["vip_expiry"] = data.vip_expiry
    elif not data.is_vip:
        update_payload["vip_expiry"] = None

    target_res, _ = await asyncio.gather(
        asyncio.to_thread(
            lambda: db.table("profiles")
            .select("role, username, display_name")
            .eq("id", user_id)
            .single()
            .execute()
        ),
        asyncio.to_thread(
            lambda: db.table("profiles")
            .update(update_payload)
            .eq("id", user_id)
            .execute()
        ),
        return_exceptions=True,
    )

    if isinstance(target_res, Exception) or not target_res.data:
        raise HTTPException(status_code=404, detail="User không tồn tại")

    user_label = (
        target_res.data.get("display_name") or target_res.data.get("username") or user_id
    )
    action_label = "Cấp VIP" if data.is_vip else "Thu hồi VIP"

    # Fire-and-forget: audit log + notification (don't block response)
    async def _background():
        try:
            _log_action(db, admin, action_label, user_label)
        except Exception:
            pass
        try:
            if data.is_vip:
                msg = "Chúc mừng! Bạn đã được cấp VIP."
                if data.vip_expiry:
                    try:
                        exp_dt = datetime.fromisoformat(data.vip_expiry.replace("Z", "+00:00"))
                        msg += f" Hạn sử dụng: {exp_dt.strftime('%d/%m/%Y')}."
                    except Exception:
                        pass
            else:
                msg = "VIP của bạn đã bị thu hồi."
            await asyncio.to_thread(
                lambda: db.table("notifications").insert(
                    {"user_id": user_id, "type": "system", "title": "Cập nhật VIP", "message": msg}
                ).execute()
            )
        except Exception:
            pass

    asyncio.create_task(_background())
    _cache_invalidate_prefix("admin_stats")  # refresh dashboard on next load

    return {
        "message": f"{'Đã cấp' if data.is_vip else 'Đã thu hồi'} VIP cho {user_label}",
        "user_id": user_id,
        "is_vip": data.is_vip,
    }


# ── All Comments (for moderation) ──
@router.get("/comments")
async def list_all_comments(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    manga_slug: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Liệt kê tất cả bình luận để kiểm duyệt."""
    query = (
        db.table("comments")
        .select(
            "id, manga_slug, chapter_id, content, image_url, likes, is_deleted, created_at, "
            "profiles!comments_user_id_fkey(id, username, display_name, avatar, role, is_banned)"
        )
        .order("created_at", desc=True)
    )

    if manga_slug:
        query = query.eq("manga_slug", manga_slug)
    if search:
        query = query.ilike("content", f"%{search}%")

    offset = (page - 1) * limit
    result = query.range(offset, offset + limit - 1).execute()

    total_res = db.table("comments").select("id", count="exact")
    if manga_slug:
        total_res = total_res.eq("manga_slug", manga_slug)
    if search:
        total_res = total_res.ilike("content", f"%{search}%")
    total_res = total_res.execute()

    rows = []
    for c in result.data or []:
        profile = c.pop("profiles", {}) or {}
        rows.append(
            {
                **c,
                "username": profile.get("display_name") or profile.get("username", ""),
                "user_id": profile.get("id", ""),
                "avatar": profile.get("avatar", ""),
                "role": profile.get("role", "reader"),
                "user_is_banned": profile.get("is_banned", False),
            }
        )

    return {
        "comments": rows,
        "total": total_res.count or 0,
        "page": page,
        "limit": limit,
    }


# ── Export Users CSV ──
@router.get("/export/users")
async def export_users_csv(
    admin=Depends(require_admin),
    db=Depends(get_supabase),
):
    """Xuất danh sách users dưới dạng CSV."""
    import csv
    import io

    from fastapi.responses import StreamingResponse

    result = (
        db.table("profiles")
        .select(
            "id, username, display_name, email, role, is_vip, is_banned, "
            "chapters_read, comments_posted, created_at, ban_reason"
        )
        .order("created_at", desc=True)
        .limit(10000)
        .execute()
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "ID",
            "Username",
            "Display Name",
            "Email",
            "Role",
            "VIP",
            "Banned",
            "Chapters Read",
            "Comments",
            "Joined",
            "Ban Reason",
        ]
    )
    for u in result.data or []:
        writer.writerow(
            [
                u.get("id", ""),
                u.get("username", ""),
                u.get("display_name", ""),
                u.get("email", ""),
                u.get("role", "reader"),
                "Yes" if u.get("is_vip") else "No",
                "Yes" if u.get("is_banned") else "No",
                u.get("chapters_read", 0),
                u.get("comments_posted", 0),
                u.get("created_at", ""),
                u.get("ban_reason", ""),
            ]
        )

    output.seek(0)
    from datetime import datetime, timezone

    filename = (
        f"users_export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.csv"
    )

    _log_action(db, admin, "Xuất CSV users", f"{len(result.data or [])} users")

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─── Chapter Upload Management ──────────────────────────────────────────────


def _update_upload_review_row(db, table: str, upload_id: str, update_data: dict):
    attempts = [dict(update_data)]
    if "rejection_reason" in update_data and "reject_reason" in update_data:
        without_reject_reason = dict(update_data)
        without_reject_reason.pop("reject_reason", None)
        attempts.append(without_reject_reason)

        without_rejection_reason = dict(update_data)
        without_rejection_reason.pop("rejection_reason", None)
        attempts.append(without_rejection_reason)

    attempts.append({"status": update_data["status"]})
    last_error = None
    for payload in attempts:
        try:
            db.table(table).update(payload).eq("id", upload_id).execute()
            return
        except Exception as error:
            last_error = error
    if last_error:
        raise last_error


@router.get("/uploads")
async def admin_get_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: danh sách chapter uploads (all users)."""
    _ = admin
    offset = (page - 1) * limit
    query = db.table("chapter_uploads").select(
        "*, profiles!chapter_uploads_uploader_id_fkey(display_name, username, avatar)"
    )
    if status:
        query = query.eq("status", status)
    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()

    count_query = db.table("chapter_uploads").select("id", count="exact")
    if status:
        count_query = count_query.eq("status", status)
    total = count_query.execute()

    return {"uploads": result.data or [], "total": total.count or 0, "page": page}


@router.put("/uploads/{upload_id}")
async def admin_review_upload(
    upload_id: str,
    action: str = Query(...),
    reason: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: duyệt hoặc từ chối chapter upload."""
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Action phải là 'approve' hoặc 'reject'")

    existing = db.table("chapter_uploads").select("*").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Upload không tồn tại")

    uploader_role = _fetch_profile_role(db, existing.data.get("uploader_id"))
    _ensure_moderator_not_targeting_admin(
        admin,
        uploader_role,
        "Moderator không thể duyệt chapter do admin đăng",
    )

    if action == "approve":
        update_data = {
            "status": "published",
            "published_at": datetime.now(timezone.utc).isoformat(),
            "reviewed_by": admin["id"],
        }
    else:
        update_data = {
            "status": "rejected",
            "rejection_reason": reason or "",
            "reject_reason": reason or "",
            "reviewed_by": admin["id"],
        }

    _update_upload_review_row(db, "chapter_uploads", upload_id, update_data)

    # On reject: delete uploaded images from Supabase Storage
    if action == "reject":
        _delete_chapter_storage_files(db, existing.data)

    target_name = f"{existing.data.get('manga_title', '')} Ch.{existing.data.get('chapter_number', '?')}"
    _log_action(
        db,
        admin,
        f"{'Duyệt' if action == 'approve' else 'Từ chối'} chapter",
        target_name,
    )
    return {"message": f"Đã {'duyệt' if action == 'approve' else 'từ chối'} chapter upload"}


def _delete_chapter_storage_files(db, upload_data: dict):
    """Delete chapter page images from Supabase Storage bucket 'manga-pages'."""
    BUCKET = "manga-pages"
    pages = upload_data.get("pages") or []

    # Method 1: Extract storage paths from page URLs
    storage_paths = []
    for url in pages:
        url_str = str(url or "").strip()
        if not url_str:
            continue
        marker = f"/storage/v1/object/public/{BUCKET}/"
        idx = url_str.find(marker)
        if idx >= 0:
            path = url_str[idx + len(marker):].split("?")[0].strip("/")
            if path:
                storage_paths.append(path)

    if storage_paths:
        try:
            db.storage.from_(BUCKET).remove(storage_paths)
        except Exception:
            pass
        return

    # Method 2: Try folder-based cleanup (slug/chapter/uploader_id/)
    slug = upload_data.get("manga_slug", "")
    ch = upload_data.get("chapter_number", "")
    uploader_id = upload_data.get("uploader_id", "")
    if slug and ch and uploader_id:
        try:
            folder = f"{slug}/{ch}/{uploader_id}"
            files = db.storage.from_(BUCKET).list(folder)
            if files:
                paths = [f"{folder}/{f['name']}" for f in files]
                db.storage.from_(BUCKET).remove(paths)
        except Exception:
            pass


@router.delete("/uploads/{upload_id}")
async def admin_delete_upload(
    upload_id: str,
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: xóa chapter upload + ảnh trong Supabase Storage."""
    existing = db.table("chapter_uploads").select("*").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Upload không tồn tại")

    # Delete images from storage first
    _delete_chapter_storage_files(db, existing.data)

    # Then delete the DB record
    db.table("chapter_uploads").delete().eq("id", upload_id).execute()
    return {"message": "Đã xóa chapter upload và ảnh"}


@router.get("/manga-uploads")
async def admin_get_manga_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: danh sách manga uploads (all users)."""
    _ = admin
    offset = (page - 1) * limit
    query = db.table("manga_uploads").select("*")
    if status:
        query = query.eq("status", status)
    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()

    count_query = db.table("manga_uploads").select("id", count="exact")
    if status:
        count_query = count_query.eq("status", status)
    total = count_query.execute()

    return {"uploads": result.data or [], "total": total.count or 0, "page": page}


@router.put("/manga-uploads/{upload_id}")
async def admin_review_manga_upload(
    upload_id: str,
    action: str = Query(...),
    reason: str = Query(None),
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: duyệt hoặc từ chối manga upload."""
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Action phải là 'approve' hoặc 'reject'")

    existing = db.table("manga_uploads").select("*").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Manga upload không tồn tại")

    uploader_role = _fetch_profile_role(db, existing.data.get("uploader_id"))
    _ensure_moderator_not_targeting_admin(
        admin,
        uploader_role,
        "Moderator không thể duyệt manga do admin đăng",
    )

    if action == "approve":
        update_data = {
            "status": "published",
            "published_at": datetime.now(timezone.utc).isoformat(),
            "reviewed_by": admin["id"],
        }
    else:
        update_data = {
            "status": "rejected",
            "rejection_reason": reason or "",
            "reject_reason": reason or "",
            "reviewed_by": admin["id"],
        }

    _update_upload_review_row(db, "manga_uploads", upload_id, update_data)

    _log_action(
        db,
        admin,
        f"{'Duyệt' if action == 'approve' else 'Từ chối'} manga",
        existing.data.get("title", upload_id),
    )
    return {"message": f"Đã {'duyệt' if action == 'approve' else 'từ chối'} manga upload"}


@router.delete("/manga-uploads/{upload_id}")
async def admin_delete_manga_upload(
    upload_id: str,
    admin=Depends(require_role("moderator", "admin")),
    db=Depends(get_supabase),
):
    """Admin: xóa manga upload + cover image trong Supabase Storage."""
    existing = db.table("manga_uploads").select("*").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Manga upload không tồn tại")

    # Delete cover image from storage if it exists
    cover_url = existing.data.get("cover_url", "")
    if cover_url:
        BUCKET = "manga-pages"
        marker = f"/storage/v1/object/public/{BUCKET}/"
        idx = cover_url.find(marker)
        if idx >= 0:
            path = cover_url[idx + len(marker):].split("?")[0].strip("/")
            if path:
                try:
                    db.storage.from_(BUCKET).remove([path])
                except Exception:
                    pass

    db.table("manga_uploads").delete().eq("id", upload_id).execute()
    return {"message": "Đã xóa manga upload"}
