"""
Uploads router — chapter upload CRUD + image upload to Supabase Storage.
"""
import json
import re
import time
import uuid
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi_app.dependencies import (
    get_current_user,
    get_supabase,
    get_supabase_public,
    require_role,
)
from fastapi_app.utils.upload_security import IMAGE_EXT_BY_CONTENT_TYPE, read_upload_limited

router = APIRouter()

BUCKET = "manga-pages"
MANGA_COVER_FOLDER = "manga-covers"
DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB default
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def _get_max_file_size(db) -> int:
    """Get max upload size from site_settings, fallback to default."""
    try:
        result = db.table("site_settings").select("value").eq(
            "key", "max_upload_size_mb"
        ).single().execute()
        if result.data:
            return int(result.data["value"]) * 1024 * 1024
    except Exception:
        pass
    return DEFAULT_MAX_FILE_SIZE


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9\s-]", "", text.lower())
    slug = re.sub(r"\s+", "-", slug).strip("-")
    return slug[:80] or f"manga-{int(time.time())}"


def _storage_path_from_public_url(url: str) -> str:
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        marker = f"/storage/v1/object/public/{BUCKET}/"
        idx = parsed.path.find(marker)
        if idx >= 0:
            return parsed.path[idx + len(marker):]
    except Exception:
        return ""
    return ""


def _validate_user_group_access(db, user_id: str, group_id: str | None):
    if not group_id:
        return
    member = db.table("group_members").select("group_id").eq(
        "group_id", group_id
    ).eq("user_id", user_id).limit(1).execute()
    if not member.data:
        raise HTTPException(status_code=403, detail="Bạn không thuộc nhóm dịch này")


# ─── Image Upload ───

@router.post("/images")
async def upload_images(
    manga_slug: str = Form(...),
    chapter_number: str = Form(...),
    files: list[UploadFile] = File(...),
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """
    Upload multiple chapter page images to Supabase Storage.
    Returns list of public URLs.
    """
    if len(files) > 100:
        raise HTTPException(status_code=400, detail="Tối đa 100 ảnh mỗi lần upload")

    uploaded_urls = []
    errors = []
    max_size = _get_max_file_size(db)

    for i, file in enumerate(files):
        try:
            content, content_type = await read_upload_limited(
                file,
                max_size=max_size,
                allowed_types=ALLOWED_TYPES,
                label=f"File {file.filename}",
            )
        except HTTPException as exc:
            errors.append(str(exc.detail))
            continue

        ext = IMAGE_EXT_BY_CONTENT_TYPE.get(content_type, "jpg")

        # Storage path: manga-slug/chapter-number/user-id/page-001.jpg
        page_num = str(i + 1).zfill(3)
        path = f"{manga_slug}/{chapter_number}/{user['id']}/{page_num}.{ext}"

        try:
            # Upload to Supabase Storage
            db.storage.from_(BUCKET).upload(
                path,
                content,
                file_options={"content-type": content_type},
            )

            # Get public URL
            url = db.storage.from_(BUCKET).get_public_url(path)
            uploaded_urls.append(url)

        except Exception as e:
            error_msg = str(e)
            # If file already exists, try removing and re-uploading
            if "Duplicate" in error_msg or "already exists" in error_msg:
                try:
                    db.storage.from_(BUCKET).remove([path])
                    db.storage.from_(BUCKET).upload(
                        path,
                        content,
                        file_options={"content-type": content_type},
                    )
                    url = db.storage.from_(BUCKET).get_public_url(path)
                    uploaded_urls.append(url)
                except Exception as e2:
                    errors.append(f"File {file.filename}: {str(e2)}")
            else:
                errors.append(f"File {file.filename}: {error_msg}")

    return {
        "urls": uploaded_urls,
        "count": len(uploaded_urls),
        "errors": errors if errors else None,
    }


# ─── Chapter Upload CRUD ───

@router.get("/")
async def get_my_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Danh sách uploads của user hiện tại."""
    query = db.table("chapter_uploads").select("*").eq("uploader_id", user["id"])
    if status:
        query = query.eq("status", status)
    offset = (page - 1) * limit
    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    total = db.table("chapter_uploads").select("id", count="exact").eq("uploader_id", user["id"]).execute()
    return {"uploads": result.data, "total": total.count or 0, "page": page}


@router.get("/manga")
async def get_my_manga_uploads(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Danh sách manga uploads của user hiện tại."""
    query = db.table("manga_uploads").select("*").eq("uploader_id", user["id"])
    if status:
        query = query.eq("status", status)
    offset = (page - 1) * limit
    result = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    total = db.table("manga_uploads").select("id", count="exact").eq("uploader_id", user["id"]).execute()
    return {"uploads": result.data, "total": total.count or 0, "page": page}


@router.post("/manga")
async def create_manga_upload(
    title: str = Form(...),
    author: str = Form(...),
    artist: str = Form(""),
    manga_type: str = Form("manga"),
    publish_status: str = Form("ongoing"),
    description: str = Form(""),
    genres: str = Form("[]"),
    language: str = Form("vi"),
    status: str = Form("draft"),
    group_id: str | None = Form(None),
    cover: UploadFile = File(...),
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Tạo đề xuất truyện mới (manga upload) cùng ảnh bìa."""
    if not title.strip() or len(title.strip()) < 2:
        raise HTTPException(status_code=400, detail="Tên truyện không hợp lệ")
    if not author.strip():
        raise HTTPException(status_code=400, detail="Tác giả là bắt buộc")

    if status not in ("draft", "pending"):
        raise HTTPException(status_code=400, detail="Status chỉ hỗ trợ draft hoặc pending")

    if manga_type not in ("manga", "manhwa", "webtoon"):
        raise HTTPException(status_code=400, detail="Loại truyện không hợp lệ")

    if publish_status not in ("ongoing", "completed"):
        raise HTTPException(status_code=400, detail="Trạng thái phát hành không hợp lệ")

    _validate_user_group_access(db, user["id"], group_id)

    genres_data = []
    try:
        parsed = json.loads(genres)
        if isinstance(parsed, list):
            genres_data = [str(g).strip() for g in parsed if str(g).strip()]
    except Exception:
        raise HTTPException(status_code=400, detail="Genres không đúng định dạng JSON array")

    max_size = _get_max_file_size(db)
    cover_bytes, cover_content_type = await read_upload_limited(
        cover,
        max_size=max_size,
        allowed_types=ALLOWED_TYPES,
        label="Ảnh bìa",
    )
    ext = IMAGE_EXT_BY_CONTENT_TYPE.get(cover_content_type, "jpg")

    base_slug = _slugify(title)
    slug = base_slug
    slug_exists = db.table("manga_uploads").select("id").eq("manga_slug", slug).limit(1).execute()
    if slug_exists.data:
        slug = f"{base_slug}-{int(time.time())}"

    cover_path = f"{MANGA_COVER_FOLDER}/{slug}/{uuid.uuid4().hex}.{ext}"
    try:
        db.storage.from_(BUCKET).upload(
            cover_path,
            cover_bytes,
            file_options={"content-type": cover_content_type},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload ảnh bìa thất bại: {str(e)}")

    cover_url = db.storage.from_(BUCKET).get_public_url(cover_path)

    insert_data = {
        "uploader_id": user["id"],
        "group_id": group_id,
        "manga_slug": slug,
        "title": title.strip(),
        "author": author.strip(),
        "artist": artist.strip(),
        "manga_type": manga_type,
        "publish_status": publish_status,
        "description": description,
        "genres": genres_data,
        "cover_url": cover_url,
        "language": language,
        "status": status,
    }

    result = db.table("manga_uploads").insert(insert_data).execute()
    return {
        "message": "Đã tạo đề xuất truyện",
        "upload": result.data[0] if result.data else None,
    }


@router.get("/manga/{upload_id}")
async def get_manga_upload(
    upload_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Chi tiết manga upload."""
    result = db.table("manga_uploads").select("*").eq("id", upload_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Manga upload không tồn tại")
    if result.data["uploader_id"] != user["id"] and user.get("role") not in ("moderator", "admin"):
        raise HTTPException(status_code=403, detail="Không có quyền xem")
    return {"upload": result.data}


@router.put("/manga/{upload_id}")
async def update_manga_upload(
    upload_id: str,
    data: dict,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Cập nhật manga upload (chủ sở hữu)."""
    existing = db.table("manga_uploads").select("uploader_id, status").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Manga upload không tồn tại")
    if existing.data["uploader_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Không có quyền sửa")
    if existing.data["status"] == "published":
        raise HTTPException(status_code=400, detail="Không thể sửa manga đã xuất bản")

    update_data = {}
    next_group_id = data.get("group_id") if "group_id" in data else None
    if "group_id" in data:
        _validate_user_group_access(db, user["id"], next_group_id)

    for key in (
        "title", "author", "artist", "manga_type",
        "publish_status", "description", "genres", "language", "status", "group_id"
    ):
        if key in data:
            update_data[key] = data[key]

    if update_data:
        db.table("manga_uploads").update(update_data).eq("id", upload_id).execute()
    return {"message": "Đã cập nhật manga upload"}


@router.delete("/manga/{upload_id}")
async def delete_manga_upload(
    upload_id: str,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Xóa manga upload (chỉ draft/rejected)."""
    existing = db.table("manga_uploads").select("uploader_id, status, cover_url").eq(
        "id", upload_id
    ).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Manga upload không tồn tại")
    if existing.data["uploader_id"] != user["id"] and user.get("role") not in ("moderator", "admin"):
        raise HTTPException(status_code=403, detail="Không có quyền xóa")
    if existing.data["status"] == "published":
        raise HTTPException(status_code=400, detail="Không thể xóa manga đã xuất bản")

    cover_path = _storage_path_from_public_url(existing.data.get("cover_url", ""))
    if cover_path:
        try:
            db.storage.from_(BUCKET).remove([cover_path])
        except Exception:
            pass

    db.table("manga_uploads").delete().eq("id", upload_id).execute()
    return {"message": "Đã xóa manga upload"}


@router.get("/{upload_id}")
async def get_upload(
    upload_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Chi tiết upload."""
    result = db.table("chapter_uploads").select("*").eq("id", upload_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Upload không tồn tại")
    if result.data["uploader_id"] != user["id"] and user.get("role") not in ("moderator", "admin"):
        raise HTTPException(status_code=403, detail="Không có quyền xem")
    return {"upload": result.data}


@router.post("/")
async def create_upload(
    data: dict,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Tạo upload mới (draft hoặc pending)."""
    _validate_user_group_access(db, user["id"], data.get("group_id"))

    # Safely parse chapter_number — DB column is integer but MangaDex sends decimals like "112.2"
    raw_chapter = str(data.get("chapter_number", "0")).strip().replace(",", ".")
    try:
        chapter_float = float(raw_chapter)
        chapter_int = int(chapter_float)
    except (ValueError, TypeError):
        chapter_int = 0

    # Preserve decimal part in chapter_title if present (e.g., "112.2" → chapter_number=112, title includes ".2")
    chapter_title = str(data.get("chapter_title", "")).strip()
    if chapter_float != chapter_int and not chapter_title:
        chapter_title = f"Chương {raw_chapter}"

    insert = {
        "uploader_id": user["id"],
        "manga_slug": data.get("manga_slug", ""),
        "manga_title": data.get("manga_title", ""),
        "chapter_number": chapter_int,
        "chapter_title": chapter_title,
        "language": data.get("language", "vi"),
        "pages": data.get("pages", []),
        "status": data.get("status", "draft"),
        "group_id": data.get("group_id"),
    }
    result = db.table("chapter_uploads").insert(insert).execute()
    return {"message": "Đã tạo upload", "upload": result.data[0] if result.data else None}


@router.put("/{upload_id}")
async def update_upload(
    upload_id: str,
    data: dict,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Cập nhật upload (chủ sở hữu)."""
    existing = db.table("chapter_uploads").select("uploader_id, status").eq("id", upload_id).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Upload không tồn tại")
    if existing.data["uploader_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Không có quyền sửa")
    if existing.data["status"] == "published":
        raise HTTPException(status_code=400, detail="Không thể sửa upload đã xuất bản")

    if "group_id" in data:
        _validate_user_group_access(db, user["id"], data.get("group_id"))

    update_data = {}
    for key in ("chapter_title", "pages", "status", "language", "group_id"):
        if key in data:
            update_data[key] = data[key]

    if update_data:
        db.table("chapter_uploads").update(update_data).eq("id", upload_id).execute()

    return {"message": "Đã cập nhật"}


@router.delete("/{upload_id}")
async def delete_upload(
    upload_id: str,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Xóa upload (chỉ draft/rejected)."""
    existing = db.table("chapter_uploads").select("uploader_id, status, manga_slug, chapter_number").eq(
        "id", upload_id
    ).single().execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Upload không tồn tại")
    if existing.data["uploader_id"] != user["id"] and user.get("role") not in ("moderator", "admin"):
        raise HTTPException(status_code=403, detail="Không có quyền xóa")
    if existing.data["status"] == "published":
        raise HTTPException(status_code=400, detail="Không thể xóa upload đã xuất bản")

    slug = existing.data.get("manga_slug", "")
    ch = existing.data.get("chapter_number", "")
    uploader_id = existing.data.get("uploader_id", "")
    if slug and ch and uploader_id:
        try:
            folder = f"{slug}/{ch}/{uploader_id}"
            files = db.storage.from_(BUCKET).list(folder)
            if files:
                paths = [f"{folder}/{f['name']}" for f in files]
                db.storage.from_(BUCKET).remove(paths)
        except Exception:
            pass

    db.table("chapter_uploads").delete().eq("id", upload_id).execute()
    return {"message": "Đã xóa upload"}


@router.get("/published/{manga_slug}")
async def get_published_chapters(
    manga_slug: str,
    db=Depends(get_supabase_public),
):
    """Public: get all published (approved) chapter uploads for a manga slug."""
    result = (
        db.table("chapter_uploads")
        .select("id, manga_slug, manga_title, chapter_number, chapter_title, language, pages, status, created_at, published_at, uploader_id, profiles!chapter_uploads_uploader_id_fkey(display_name, username)")
        .eq("manga_slug", manga_slug)
        .eq("status", "published")
        .order("chapter_number", desc=False)
        .execute()
    )
    chapters = result.data or []
    for chapter in chapters:
        chapter["translation_source"] = "local"
        chapter["translation_source_label"] = "Bản dịch web"
    return {"chapters": chapters}
