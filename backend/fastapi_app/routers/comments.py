"""
Comments router — CRUD, replies, likes.
"""
import asyncio
from serverless_runtime import create_task
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from fastapi_app.dependencies import (
    get_current_user,
    get_optional_user,
    get_supabase,
    get_supabase_public,
)
from fastapi_app.models.schemas import CommentCreate, CommentUpdate
from fastapi_app.services import mangadex_service
from fastapi_app.utils.anti_spam import (
    check_fixed_window,
    check_recent_once,
    enforce_user_action_limit,
    get_client_ip,
    hash_value,
    request_fingerprint,
)
from fastapi_app.utils.upload_security import IMAGE_EXT_BY_CONTENT_TYPE, read_upload_limited
from vip_access import normalize_vip_profile

router = APIRouter()
logger = logging.getLogger(__name__)
COMMENT_IMAGE_BUCKET = "comment-images"
COMMENT_IMAGE_MAX_SIZE = 5 * 1024 * 1024
ALLOWED_COMMENT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
COMMENT_MIN_INTERVAL_SECONDS = 4
COMMENT_SHORT_WINDOW_SECONDS = 60
COMMENT_SHORT_WINDOW_LIMIT = 8
COMMENT_LONG_WINDOW_SECONDS = 60 * 60
COMMENT_LONG_WINDOW_LIMIT = 80
COMMENT_DUPLICATE_WINDOW_SECONDS = 5 * 60
COMMENT_IP_SHORT_WINDOW_LIMIT = 240
COMMENT_IMAGE_UPLOAD_LIMIT = 10
COMMENT_IMAGE_UPLOAD_IP_MULTIPLIER = 20
COMMENT_IMAGE_UPLOAD_WINDOW_SECONDS = 10 * 60
COMMENT_REACTION_ACTION_LIMIT_PER_MINUTE = 30
COMMENT_REACTION_ACTION_LIMIT_PER_10_MINUTES = 120
MANGADEX_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)


def _is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.TimeoutException):
        return True
    message = str(exc).lower()
    return "timed out" in message or "timeout" in message


def _execute_with_retry(label: str, fn, retries: int = 1):
    last_exc: Exception | None = None
    total_attempts = retries + 1
    for attempt in range(total_attempts):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "comments.%s failed (attempt %s/%s): %s",
                label,
                attempt + 1,
                total_attempts,
                exc,
            )
            if attempt >= retries or not _is_timeout_error(exc):
                break
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"comments.{label} failed")


def _clean_text(value) -> str:
    return str(value or "").strip()


def _normalize_comment_body(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def _parse_db_datetime(value) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _rpc_json_payload(result) -> dict | None:
    data = getattr(result, "data", result)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            if "create_comment_checked" in first and isinstance(first["create_comment_checked"], dict):
                return first["create_comment_checked"]
            return first
    return None


def _comment_rate_limit_detail(reason: str) -> tuple[int, str]:
    messages = {
        "unauthorized": (401, "Chưa đăng nhập"),
        "invalid-manga": (400, "Manga không hợp lệ"),
        "empty-comment": (400, "Bình luận phải có nội dung hoặc ảnh"),
        "cooldown": (429, f"Vui lòng chờ {COMMENT_MIN_INTERVAL_SECONDS}s trước khi bình luận tiếp"),
        "minute-limit": (429, "Bạn đang gửi bình luận quá nhanh"),
        "hour-limit": (429, "Bạn đã gửi quá nhiều bình luận trong 1 giờ"),
        "duplicate": (429, "Nội dung bình luận bị lặp trong thời gian ngắn"),
    }
    return messages.get(str(reason or ""), (429, "Bình luận bị giới hạn để chống spam"))


def _create_comment_checked_rpc(
    db,
    *,
    user_id: str,
    data: CommentCreate,
    content: str,
    image_url: str,
) -> dict | None:
    try:
        result = db.rpc(
            "create_comment_checked",
            {
                "p_user_id": user_id,
                "p_manga_slug": data.manga_slug,
                "p_chapter_id": data.chapter_id,
                "p_parent_id": data.parent_id,
                "p_content": content,
                "p_image_url": image_url or None,
                "p_min_interval_seconds": COMMENT_MIN_INTERVAL_SECONDS,
                "p_short_window_seconds": COMMENT_SHORT_WINDOW_SECONDS,
                "p_short_window_limit": COMMENT_SHORT_WINDOW_LIMIT,
                "p_long_window_seconds": COMMENT_LONG_WINDOW_SECONDS,
                "p_long_window_limit": COMMENT_LONG_WINDOW_LIMIT,
                "p_duplicate_window_seconds": COMMENT_DUPLICATE_WINDOW_SECONDS,
            },
        ).execute()
        return _rpc_json_payload(result) or {"ok": True}
    except Exception as exc:
        logger.debug("comments.create checked rpc unavailable: %s", exc)
        return None


def _fetch_recent_user_comments(db, user_id: str, seconds: int, limit: int = 100) -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()
    try:
        result = (
            db.table("comments")
            .select("id, manga_slug, chapter_id, parent_id, content, image_url, created_at")
            .eq("user_id", user_id)
            .eq("is_deleted", False)
            .gte("created_at", cutoff)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception as exc:
        logger.warning("comments.recent_check skipped: %s", exc)
        return []


def _enforce_comment_spam_limits(
    *,
    db,
    request: Request,
    user: dict,
    data: CommentCreate,
    content: str,
    image_url: str,
) -> None:
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Chưa đăng nhập")

    viewer_key = request_fingerprint(request, user_id)
    client_ip = get_client_ip(request)

    allowed, _, reset_after = check_fixed_window(
        f"comment:user:min:{viewer_key}",
        COMMENT_SHORT_WINDOW_LIMIT,
        COMMENT_SHORT_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Bình luận quá nhanh, thử lại sau {reset_after}s",
        )

    allowed, _, reset_after = check_fixed_window(
        f"comment:user:hour:{viewer_key}",
        COMMENT_LONG_WINDOW_LIMIT,
        COMMENT_LONG_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Bình luận quá nhiều, thử lại sau {reset_after}s",
        )

    allowed, _, reset_after = check_fixed_window(
        f"comment:ip:min:{client_ip}",
        COMMENT_IP_SHORT_WINDOW_LIMIT,
        COMMENT_SHORT_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"IP gửi bình luận quá nhanh, thử lại sau {reset_after}s",
        )

    normalized_content = _normalize_comment_body(content)
    duplicate_key = (
        f"comment:dup:{viewer_key}:{data.manga_slug}:{data.chapter_id or ''}:"
        f"{data.parent_id or ''}:{hash_value(normalized_content)}"
    )
    if normalized_content:
        is_new, wait_seconds = check_recent_once(
            duplicate_key,
            COMMENT_DUPLICATE_WINDOW_SECONDS,
            mark=False,
        )
        if not is_new:
            raise HTTPException(
                status_code=429,
                detail=f"Nội dung bình luận bị lặp, thử lại sau {wait_seconds}s",
            )

    recent = _fetch_recent_user_comments(
        db,
        user_id,
        COMMENT_LONG_WINDOW_SECONDS,
        limit=COMMENT_LONG_WINDOW_LIMIT,
    )
    now = datetime.now(timezone.utc)
    if len(recent) >= COMMENT_LONG_WINDOW_LIMIT:
        raise HTTPException(status_code=429, detail="Bạn đã gửi quá nhiều bình luận trong 1 giờ")

    short_count = 0
    for row in recent:
        created_at = _parse_db_datetime(row.get("created_at"))
        if not created_at:
            continue
        age_seconds = (now - created_at).total_seconds()
        if age_seconds < COMMENT_MIN_INTERVAL_SECONDS:
            wait_seconds = max(1, int(COMMENT_MIN_INTERVAL_SECONDS - age_seconds))
            raise HTTPException(
                status_code=429,
                detail=f"Vui lòng chờ {wait_seconds}s trước khi bình luận tiếp",
            )
        if age_seconds <= COMMENT_SHORT_WINDOW_SECONDS:
            short_count += 1

        if normalized_content and age_seconds <= COMMENT_DUPLICATE_WINDOW_SECONDS:
            same_target = (
                str(row.get("manga_slug") or "") == str(data.manga_slug or "")
                and str(row.get("chapter_id") or "") == str(data.chapter_id or "")
                and str(row.get("parent_id") or "") == str(data.parent_id or "")
            )
            if same_target and _normalize_comment_body(row.get("content") or "") == normalized_content:
                raise HTTPException(
                    status_code=429,
                    detail="Nội dung bình luận bị lặp trong thời gian ngắn",
                )

    if short_count >= COMMENT_SHORT_WINDOW_LIMIT:
        raise HTTPException(status_code=429, detail="Bạn đang gửi bình luận quá nhanh")


def _normalize_mangadex_comment_id(value) -> str:
    raw = _clean_text(value).lower()
    if raw.startswith("mdx-"):
        raw = raw[4:]
    return raw if MANGADEX_ID_RE.match(raw) else ""


def _merge_manga_title_rows(
    title_by_slug: dict[str, str],
    rows: list[dict],
    *,
    slug_key: str = "manga_slug",
    title_keys: tuple[str, ...] = ("manga_title", "title"),
):
    for row in rows or []:
        slug = _clean_text(row.get(slug_key))
        if not slug or slug in title_by_slug:
            continue
        for title_key in title_keys:
            title = _clean_text(row.get(title_key))
            if title and title != slug:
                title_by_slug[slug] = title
                break


async def _enrich_mangadex_comment_titles(title_by_slug: dict[str, str], slugs: list[str]):
    missing_by_id: dict[str, list[str]] = {}
    for slug in slugs:
        if slug in title_by_slug:
            continue
        manga_id = _normalize_mangadex_comment_id(slug)
        if manga_id:
            missing_by_id.setdefault(manga_id, []).append(slug)
    if not missing_by_id:
        return

    semaphore = asyncio.Semaphore(3)

    async def resolve_title(manga_id: str) -> tuple[str, str]:
        async with semaphore:
            payload = await mangadex_service.get_manga_lookup(manga_id)
            title = _clean_text((payload.get("manga") or {}).get("title"))
            return manga_id, title

    tasks = [
        create_task(resolve_title(manga_id))
        for manga_id in list(missing_by_id.keys())[:12]
    ]
    try:
        for completed in asyncio.as_completed(tasks, timeout=4.0):
            try:
                manga_id, title = await completed
            except Exception as exc:
                logger.debug("comments.mangadex title lookup skipped: %s", exc)
                continue
            if not title:
                continue
            for slug in missing_by_id.get(manga_id, []):
                title_by_slug[slug] = title
    except TimeoutError:
        pass
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()


async def _enrich_my_comment_manga_titles(db, user_id: str, comments: list[dict]):
    slugs: list[str] = []
    for comment in comments or []:
        slug = _clean_text(comment.get("manga_slug"))
        if slug and slug not in slugs:
            slugs.append(slug)
    if not slugs:
        return

    title_by_slug: dict[str, str] = {}

    def fetch_titles(label: str, table: str, select_expr: str, *, user_scoped: bool):
        try:
            def run():
                query = db.table(table).select(select_expr).in_("manga_slug", slugs)
                if user_scoped:
                    query = query.eq("user_id", user_id)
                return query.execute()

            result = _execute_with_retry(label, run, retries=0)
            _merge_manga_title_rows(title_by_slug, result.data or [])
        except Exception as exc:
            logger.debug("comments.%s title enrichment skipped: %s", label, exc)

    fetch_titles(
        "my_comments_history_titles",
        "reading_history",
        "manga_slug,manga_title",
        user_scoped=True,
    )
    fetch_titles(
        "my_comments_bookmark_titles",
        "bookmarks",
        "manga_slug,manga_title",
        user_scoped=True,
    )
    fetch_titles(
        "my_comments_follow_titles",
        "follows",
        "manga_slug,manga_title",
        user_scoped=True,
    )
    fetch_titles(
        "my_comments_upload_titles",
        "manga_uploads",
        "manga_slug,title",
        user_scoped=False,
    )
    fetch_titles(
        "my_comments_chapter_upload_titles",
        "chapter_uploads",
        "manga_slug,manga_title",
        user_scoped=False,
    )
    await _enrich_mangadex_comment_titles(title_by_slug, slugs)

    for comment in comments:
        slug = _clean_text(comment.get("manga_slug"))
        title = title_by_slug.get(slug)
        if title:
            comment["manga_title"] = title


def _extract_storage_path(image_url: str, bucket: str) -> str:
    marker = f"/storage/v1/object/public/{bucket}/"
    if marker not in image_url:
        return ""
    return unquote(image_url.split(marker, 1)[1].split("?", 1)[0]).strip("/")


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


def _normalize_reaction_map(value) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    cleaned: dict[str, int] = {}
    for raw_emoji, raw_count in value.items():
        emoji = str(raw_emoji or "").strip()
        if not emoji:
            continue
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count > 0:
            cleaned[emoji] = count
    return cleaned


def _get_comment_target(db, comment_id: str) -> dict:
    comment_res = (
        db.table("comments")
        .select("id, user_id, manga_slug, chapter_id, is_deleted, reactions")
        .eq("id", comment_id)
        .limit(1)
        .execute()
    )
    comment_row = (comment_res.data or [None])[0]
    if not comment_row or comment_row.get("is_deleted"):
        raise HTTPException(status_code=404, detail="Không tìm thấy bình luận")
    return comment_row


def _get_actor_display_name(db, actor_id: str) -> str:
    try:
        profile = (
            db.table("profiles")
            .select("display_name, username")
            .eq("id", actor_id)
            .limit(1)
            .execute()
        )
        row = (profile.data or [None])[0]
        if row:
            return row.get("display_name") or row.get("username") or "Ai đó"
    except Exception:
        pass
    return "Ai đó"


def _create_comment_notification(
    db,
    actor_id: str,
    owner_id: str,
    title: str,
    message: str,
    manga_slug: str | None,
    chapter_id: str | None,
):
    if not owner_id or owner_id == actor_id:
        return
    payload = {
        "user_id": owner_id,
        "type": "reply",
        "title": title,
        "message": message,
        "manga_slug": manga_slug,
        "chapter_id": chapter_id,
    }
    try:
        db.table("notifications").insert(payload).execute()
    except Exception:
        # Never block primary comment actions when notification insert fails.
        pass


def _notify_parent_reply(db, actor_id: str, data: CommentCreate) -> None:
    if not data.parent_id:
        return
    try:
        parent = (
            db.table("comments")
            .select("user_id")
            .eq("id", data.parent_id)
            .single()
            .execute()
        )
        if parent.data and parent.data["user_id"] != actor_id:
            profile = (
                db.table("profiles")
                .select("display_name")
                .eq("id", actor_id)
                .single()
                .execute()
            )
            name = profile.data.get("display_name", "Ai đó") if profile.data else "Ai đó"
            db.table("notifications").insert(
                {
                    "user_id": parent.data["user_id"],
                    "type": "reply",
                    "title": "Phản hồi bình luận",
                    "message": f"{name} đã trả lời bình luận của bạn.",
                    "manga_slug": data.manga_slug,
                    "chapter_id": data.chapter_id,
                }
            ).execute()
    except Exception:
        pass


class CommentReactionPayload(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=16)
    previous_emoji: str | None = Field(default=None, max_length=16)


@router.get("/me")
async def get_my_comments(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Lấy bình luận của chính user hiện tại."""
    offset = (page - 1) * limit
    try:
        result = _execute_with_retry(
            "get_my_comments",
            lambda: (
                db.table("comments")
                .select(
                    "id, manga_slug, chapter_id, content, image_url, likes, reactions, created_at"
                )
                .eq("user_id", user["id"])
                .eq("is_deleted", False)
                .order("created_at", desc=True)
                .range(offset, offset + limit - 1)
                .execute()
            ),
            retries=1,
        )
    except Exception as exc:
        if _is_timeout_error(exc):
            return {"comments": [], "degraded": True}
        raise HTTPException(status_code=503, detail="Không tải được bình luận lúc này") from exc

    comments = result.data or []
    await _enrich_my_comment_manga_titles(db, user["id"], comments)
    return {"comments": comments, "degraded": False}


@router.get("/manga/{manga_slug}")
async def get_comments(
    manga_slug: str,
    chapter_id: str = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=50),
    user=Depends(get_optional_user),
    db=Depends(get_supabase_public),
):
    """Lấy bình luận cho truyện/chapter — optimized batch queries."""
    return await asyncio.to_thread(_get_comments_sync, manga_slug, chapter_id, page, limit, user, db)


def _get_comments_sync(manga_slug, chapter_id, page, limit, user, db):
    query = (
        db.table("comments")
        .select(
            "*, profiles!comments_user_id_fkey(id, username, display_name, avatar, role, is_vip, vip_expiry, name_color, name_font, name_effect)"
        )
        .eq("manga_slug", manga_slug)
        .eq("is_deleted", False)
        .is_("parent_id", "null")
    )

    if chapter_id:
        query = query.eq("chapter_id", chapter_id)

    offset = (page - 1) * limit
    try:
        result = _execute_with_retry(
            "get_comments_page",
            lambda: query.order("created_at", desc=True)
            .range(offset, offset + limit)
            .execute(),
            retries=1,
        )
    except Exception as exc:
        if _is_timeout_error(exc):
            return {
                "comments": [],
                "page": page,
                "limit": limit,
                "has_more": False,
                "degraded": True,
            }
        raise HTTPException(status_code=503, detail="Không tải được bình luận lúc này") from exc

    raw_rows = result.data or []
    has_more = len(raw_rows) > limit
    rows = raw_rows[:limit]

    if not rows:
        return {"comments": [], "page": page, "limit": limit, "has_more": False}

    def _fmt_profile(row: dict, profile: dict) -> dict:
        profile = normalize_vip_profile(profile)
        return {
            **row,
            "username": profile.get("display_name") or profile.get("username", ""),
            "profile_username": profile.get("username") or "",
            "avatar": profile.get("avatar", ""),
            "role": profile.get("role", "reader"),
            "is_vip": profile.get("is_vip", False),
            "name_color": profile.get("name_color"),
            "name_font": profile.get("name_font"),
            "name_effect": profile.get("name_effect"),
            "replies": [],
            "is_liked": False,
            "my_reaction": None,
        }

    # Format top-level comments
    top_by_id: dict[str, dict] = {}
    for c in rows:
        profile = c.pop("profiles", {}) or {}
        top_by_id[c["id"]] = _fmt_profile(c, profile)

    # Batch-fetch ALL replies at each depth level (O(depth) queries, not O(N*depth))
    all_replies_by_id: dict[str, dict] = {}
    ids_at_level = list(top_by_id.keys())

    degraded = False
    while ids_at_level:
        try:
            batch_res = _execute_with_retry(
                "get_replies_batch",
                lambda: (
                    db.table("comments")
                    .select(
                        "*, profiles!comments_user_id_fkey(id, username, display_name, avatar, role, is_vip, vip_expiry, name_color, name_font, name_effect)"
                    )
                    .in_("parent_id", ids_at_level)
                    .eq("is_deleted", False)
                    .order("created_at")
                    .execute()
                ),
                retries=1,
            )
        except Exception as exc:
            logger.warning("comments.get_replies_batch degraded: %s", exc)
            degraded = True
            break
        batch = batch_res.data or []
        if not batch:
            break
        ids_at_level = []
        for r in batch:
            rp = r.pop("profiles", {}) or {}
            fr = _fmt_profile(r, rp)
            all_replies_by_id[fr["id"]] = fr
            ids_at_level.append(fr["id"])

    # ONE batch query for all likes + my reactions
    reaction_map: dict[str, str] = {}
    if user:
        all_ids = list(top_by_id.keys()) + list(all_replies_by_id.keys())
        if all_ids:
            try:
                like_res = _execute_with_retry(
                    "get_my_likes",
                    lambda: (
                        db.table("comment_likes")
                        .select("comment_id")
                        .eq("user_id", user["id"])
                        .in_("comment_id", all_ids)
                        .execute()
                    ),
                    retries=1,
                )
                liked_set = {r["comment_id"] for r in (like_res.data or [])}

                reaction_res = (
                    db.table("comment_reactions")
                    .select("comment_id, emoji")
                    .eq("user_id", user["id"])
                    .in_("comment_id", all_ids)
                    .execute()
                )
                for row in reaction_res.data or []:
                    comment_key = row.get("comment_id")
                    emoji = str(row.get("emoji") or "").strip()
                    if comment_key and emoji:
                        reaction_map[comment_key] = emoji
            except Exception as exc:
                logger.warning("comments.get_reactions degraded: %s", exc)
                degraded = True
                liked_set = set()
                reaction_map = {}
        else:
            liked_set = set()
    else:
        liked_set = set()

    # Apply liked state
    for c in top_by_id.values():
        c["is_liked"] = c["id"] in liked_set
        c["my_reaction"] = reaction_map.get(c["id"])
    for r in all_replies_by_id.values():
        r["is_liked"] = r["id"] in liked_set
        r["my_reaction"] = reaction_map.get(r["id"])

    # Build reply tree in memory
    for reply in all_replies_by_id.values():
        pid = reply.get("parent_id")
        if pid in top_by_id:
            top_by_id[pid]["replies"].append(reply)
        elif pid in all_replies_by_id:
            all_replies_by_id[pid]["replies"].append(reply)

    return {
        "comments": list(top_by_id.values()),
        "page": page,
        "limit": limit,
        "has_more": has_more,
        "degraded": degraded,
    }


@router.post("/upload-image")
async def upload_comment_image(
    request: Request,
    manga_slug: str = Form(...),
    chapter_id: str | None = Form(None),
    image: UploadFile = File(...),
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    user_key = request_fingerprint(request, str(user.get("id") or ""))
    allowed, _, reset_after = check_fixed_window(
        f"comment-image:user:{user_key}",
        COMMENT_IMAGE_UPLOAD_LIMIT,
        COMMENT_IMAGE_UPLOAD_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Upload ảnh bình luận quá nhiều, thử lại sau {reset_after}s",
        )

    client_ip = get_client_ip(request)
    allowed, _, reset_after = check_fixed_window(
        f"comment-image:ip:{client_ip}",
        COMMENT_IMAGE_UPLOAD_LIMIT * COMMENT_IMAGE_UPLOAD_IP_MULTIPLIER,
        COMMENT_IMAGE_UPLOAD_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"IP upload ảnh bình luận quá nhiều, thử lại sau {reset_after}s",
        )

    content, content_type = await read_upload_limited(
        image,
        max_size=COMMENT_IMAGE_MAX_SIZE,
        allowed_types=ALLOWED_COMMENT_IMAGE_TYPES,
        label="Ảnh",
    )
    ext = IMAGE_EXT_BY_CONTENT_TYPE.get(content_type, "jpg")
    safe_slug = (manga_slug or "").strip() or "unknown"
    safe_chapter = (chapter_id or "").strip() or "general"
    path = f"{safe_slug}/{safe_chapter}/{user['id']}/{uuid.uuid4().hex}.{ext}"

    try:
        db.storage.from_(COMMENT_IMAGE_BUCKET).upload(
            path,
            content,
            file_options={"content-type": content_type},
        )
        image_url = db.storage.from_(COMMENT_IMAGE_BUCKET).get_public_url(path)
    except Exception as e:
        logger.exception("Comment image upload failed")
        raise HTTPException(status_code=500, detail="Upload ảnh bình luận thất bại") from e

    return {"message": "Upload ảnh thành công", "image_url": image_url}


@router.post("/")
async def create_comment(
    request: Request,
    data: CommentCreate,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Tạo bình luận mới."""
    content = (data.content or "").strip()
    image_url = (data.image_url or "").strip()
    if not content and not image_url:
        raise HTTPException(status_code=400, detail="Bình luận phải có nội dung hoặc ảnh")

    checked_comment = _create_comment_checked_rpc(
        db,
        user_id=user["id"],
        data=data,
        content=content,
        image_url=image_url,
    )
    if checked_comment is not None:
        if not checked_comment.get("ok"):
            status, detail = _comment_rate_limit_detail(str(checked_comment.get("reason") or ""))
            raise HTTPException(status_code=status, detail=detail)
        comment = checked_comment.get("comment")
        _notify_parent_reply(db, user["id"], data)
        return {
            "message": "Đã đăng bình luận",
            "comment": comment if isinstance(comment, dict) else None,
        }

    _enforce_comment_spam_limits(
        db=db,
        request=request,
        user=user,
        data=data,
        content=content,
        image_url=image_url,
    )

    insert_data = {
        "user_id": user["id"],
        "manga_slug": data.manga_slug,
        "content": content,
    }
    if image_url:
        insert_data["image_url"] = image_url
    if data.chapter_id:
        insert_data["chapter_id"] = data.chapter_id
    if data.parent_id:
        insert_data["parent_id"] = data.parent_id

    result = db.table("comments").insert(insert_data).execute()

    count_result = (
        db.table("comments")
        .select("id", count="exact")
        .eq("user_id", user["id"])
        .eq("is_deleted", False)
        .execute()
    )
    db.table("profiles").update({"comments_posted": count_result.count or 0}).eq(
        "id", user["id"]
    ).execute()

    _notify_parent_reply(db, user["id"], data)

    return {
        "message": "Đã đăng bình luận",
        "comment": result.data[0] if result.data else None,
    }


@router.put("/{comment_id}")
async def update_comment(
    comment_id: str,
    data: CommentUpdate,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Sửa bình luận."""
    # Verify ownership
    existing = (
        db.table("comments").select("user_id").eq("id", comment_id).single().execute()
    )
    if not existing.data or existing.data["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Không có quyền sửa")

    result = (
        db.table("comments")
        .update({"content": data.content})
        .eq("id", comment_id)
        .execute()
    )

    return {
        "message": "Đã cập nhật",
        "comment": result.data[0] if result.data else None,
    }


@router.delete("/{comment_id}")
async def delete_comment(
    comment_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Xóa bình luận (soft delete)."""
    existing = (
        db.table("comments")
        .select("user_id, image_url")
        .eq("id", comment_id)
        .single()
        .execute()
    )
    if not existing.data or existing.data["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Không có quyền xóa")

    _remove_comment_image(db, str(existing.data.get("image_url") or ""))
    db.table("comments").update({"is_deleted": True}).eq("id", comment_id).execute()

    count_result = (
        db.table("comments")
        .select("id", count="exact")
        .eq("user_id", user["id"])
        .eq("is_deleted", False)
        .execute()
    )
    db.table("profiles").update({"comments_posted": count_result.count or 0}).eq(
        "id", user["id"]
    ).execute()

    return {"message": "Đã xóa bình luận"}


@router.post("/{comment_id}/like")
async def toggle_like(
    request: Request,
    comment_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Like/unlike bình luận."""
    _ = request
    enforce_user_action_limit(
        "comment-like:min",
        user["id"],
        limit=COMMENT_REACTION_ACTION_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác thích bình luận quá nhanh",
    )
    enforce_user_action_limit(
        "comment-like:10m",
        user["id"],
        limit=COMMENT_REACTION_ACTION_LIMIT_PER_10_MINUTES,
        window_seconds=10 * 60,
        detail="Thao tác thích bình luận quá nhiều",
    )
    comment_row = _get_comment_target(db, comment_id)

    existing = (
        db.table("comment_likes")
        .select("comment_id")
        .eq("user_id", user["id"])
        .eq("comment_id", comment_id)
        .execute()
    )

    if existing.data:
        # Unlike
        db.table("comment_likes").delete().eq("user_id", user["id"]).eq(
            "comment_id", comment_id
        ).execute()
        return {"message": "Đã bỏ like", "liked": False}
    else:
        # Like
        db.table("comment_likes").insert(
            {
                "user_id": user["id"],
                "comment_id": comment_id,
            }
        ).execute()

        actor_name = _get_actor_display_name(db, user["id"])
        _create_comment_notification(
            db,
            actor_id=user["id"],
            owner_id=comment_row.get("user_id"),
            title="Bình luận được thích",
            message=f"{actor_name} đã thích bình luận của bạn.",
            manga_slug=comment_row.get("manga_slug"),
            chapter_id=comment_row.get("chapter_id"),
        )

        return {"message": "Đã like", "liked": True}


@router.post("/{comment_id}/reaction")
async def toggle_reaction(
    request: Request,
    comment_id: str,
    data: CommentReactionPayload,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Thả/gỡ/chuyển reaction cho bình luận."""
    _ = request
    enforce_user_action_limit(
        "comment-reaction:min",
        user["id"],
        limit=COMMENT_REACTION_ACTION_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác reaction quá nhanh",
    )
    enforce_user_action_limit(
        "comment-reaction:10m",
        user["id"],
        limit=COMMENT_REACTION_ACTION_LIMIT_PER_10_MINUTES,
        window_seconds=10 * 60,
        detail="Thao tác reaction quá nhiều",
    )
    emoji = (data.emoji or "").strip()
    if not emoji:
        raise HTTPException(status_code=400, detail="Reaction không hợp lệ")

    comment_row = _get_comment_target(db, comment_id)
    reactions = _normalize_reaction_map(comment_row.get("reactions"))

    existing_reaction = None
    try:
        reaction_row = (
            db.table("comment_reactions")
            .select("emoji")
            .eq("user_id", user["id"])
            .eq("comment_id", comment_id)
            .limit(1)
            .execute()
        )
        existing = (reaction_row.data or [None])[0]
        if existing:
            existing_reaction = str(existing.get("emoji") or "").strip() or None

        if existing_reaction == emoji:
            db.table("comment_reactions").delete().eq("user_id", user["id"]).eq(
                "comment_id", comment_id
            ).execute()

            next_count = reactions.get(emoji, 0) - 1
            if next_count > 0:
                reactions[emoji] = next_count
            else:
                reactions.pop(emoji, None)

            selected_reaction = None
            message = "Đã gỡ reaction"
            should_notify = False
        elif existing_reaction:
            db.table("comment_reactions").update({"emoji": emoji}).eq(
                "user_id", user["id"]
            ).eq("comment_id", comment_id).execute()

            prev_count = reactions.get(existing_reaction, 0) - 1
            if prev_count > 0:
                reactions[existing_reaction] = prev_count
            else:
                reactions.pop(existing_reaction, None)

            reactions[emoji] = reactions.get(emoji, 0) + 1
            selected_reaction = emoji
            message = "Đã cập nhật reaction"
            # Changing emoji should not create extra notifications.
            should_notify = False
        else:
            db.table("comment_reactions").insert(
                {
                    "user_id": user["id"],
                    "comment_id": comment_id,
                    "emoji": emoji,
                }
            ).execute()

            reactions[emoji] = reactions.get(emoji, 0) + 1
            selected_reaction = emoji
            message = "Đã thả reaction"
            should_notify = True
    except Exception:
        # Fallback behavior for environments where comment_reactions table
        # is not migrated yet.
        previous_emoji = (data.previous_emoji or "").strip() or None
        if previous_emoji == emoji:
            next_count = reactions.get(emoji, 0) - 1
            if next_count > 0:
                reactions[emoji] = next_count
            else:
                reactions.pop(emoji, None)
            selected_reaction = None
            message = "Đã gỡ reaction"
            should_notify = False
        else:
            if previous_emoji:
                prev_count = reactions.get(previous_emoji, 0) - 1
                if prev_count > 0:
                    reactions[previous_emoji] = prev_count
                else:
                    reactions.pop(previous_emoji, None)

            reactions[emoji] = reactions.get(emoji, 0) + 1
            selected_reaction = emoji
            message = "Đã cập nhật reaction"
            # Do not notify when user is changing existing reaction.
            should_notify = previous_emoji is None

    db.table("comments").update({"reactions": reactions}).eq("id", comment_id).execute()

    if should_notify:
        actor_name = _get_actor_display_name(db, user["id"])
        _create_comment_notification(
            db,
            actor_id=user["id"],
            owner_id=comment_row.get("user_id"),
            title="Bình luận có reaction mới",
            message=f"{actor_name} đã bày tỏ {emoji} cho bình luận của bạn.",
            manga_slug=comment_row.get("manga_slug"),
            chapter_id=comment_row.get("chapter_id"),
        )

    return {
        "message": message,
        "reactions": reactions,
        "selected_reaction": selected_reaction,
    }
