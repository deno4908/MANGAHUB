from __future__ import annotations

from fastapi import HTTPException, UploadFile


IMAGE_EXT_BY_CONTENT_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

_DECLARED_IMAGE_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/x-png": "image/png",
}

_LOOSE_UPLOAD_CONTENT_TYPES = {
    "",
    "application/octet-stream",
    "binary/octet-stream",
}


def normalize_declared_image_type(value: str | None) -> str:
    content_type = str(value or "").split(";", 1)[0].strip().lower()
    return _DECLARED_IMAGE_TYPE_ALIASES.get(content_type, content_type)


def detect_image_content_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _content_length(file: UploadFile) -> int | None:
    try:
        raw = file.headers.get("content-length")
        if raw:
            return int(raw)
    except Exception:
        return None
    return None


async def read_upload_limited(
    file: UploadFile,
    *,
    max_size: int,
    allowed_types: set[str] | frozenset[str],
    label: str = "File",
    chunk_size: int = 1024 * 1024,
) -> tuple[bytes, str]:
    declared_type = normalize_declared_image_type(file.content_type)
    if declared_type not in allowed_types and declared_type not in _LOOSE_UPLOAD_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"{label} phải là JPEG, PNG, WebP hoặc GIF",
        )

    length = _content_length(file)
    if length is not None and length > max_size:
        max_mb = max_size // (1024 * 1024)
        raise HTTPException(status_code=400, detail=f"{label} vượt quá {max_mb}MB")

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_size:
            max_mb = max_size // (1024 * 1024)
            raise HTTPException(status_code=400, detail=f"{label} vượt quá {max_mb}MB")
        chunks.append(chunk)

    content = b"".join(chunks)
    detected_type = detect_image_content_type(content)
    if detected_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"{label} không đúng định dạng ảnh được hỗ trợ",
        )
    if declared_type not in _LOOSE_UPLOAD_CONTENT_TYPES and detected_type != declared_type:
        raise HTTPException(
            status_code=400,
            detail=f"{label} có MIME không khớp nội dung ảnh",
        )
    return content, detected_type
