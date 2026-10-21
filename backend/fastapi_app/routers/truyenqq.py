"""Source-aware QQ image routes. Clients select a comic/page, never an arbitrary URL."""
import asyncio
import hashlib
import time

from fastapi import APIRouter, HTTPException, Path, Request, Response
from fastapi.responses import FileResponse
from fastapi_app.services import truyenqq_service as qq
from fastapi_app.routers import images

router = APIRouter()
IMAGE_CACHE_DIR = images.CACHE_DIR
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


def image_response(result):
    content, mime = result
    return Response(content, media_type=mime, headers={
        "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff"})


def _cached_image(key, request, ttl):
    candidates = [IMAGE_CACHE_DIR / (key + ext) for ext in IMAGE_TYPES.values()]
    existing = [path for path in candidates if path.is_file() and path.stat().st_size > 0
                and time.time() - path.stat().st_mtime < ttl]
    if not existing:
        return None
    path = max(existing, key=lambda entry: entry.stat().st_mtime_ns)
    etag = images._etag_for_file(path)
    headers = {"Cache-Control": "public, max-age=3600", "ETag": etag,
               "X-Content-Type-Options": "nosniff", "X-Cache": "HIT"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=images.EXT_CONTENT_TYPE[path.suffix], headers=headers)


async def _serve_image(identity, request, loader, ttl):
    key = "qq-v1-" + hashlib.sha256(identity.encode()).hexdigest()
    cached = _cached_image(key, request, ttl)
    if cached is not None:
        return cached
    async with images._cache_lock_for_key(key):
        cached = _cached_image(key, request, ttl)
        if cached is not None:
            return cached
        result = await loader()
        content, mime = result
        extension = IMAGE_TYPES.get(mime)
        if extension and content:
            try:
                await asyncio.to_thread(images._write_cache_atomic, IMAGE_CACHE_DIR / (key + extension), content)
                images.schedule_image_cache_prune()
            except OSError:
                pass
        response = image_response(result)
        response.headers["X-Cache"] = "MISS"
        response.headers["Cache-Control"] = "public, max-age=3600"
        if extension:
            path = IMAGE_CACHE_DIR / (key + extension)
            if path.is_file():
                response.headers["ETag"] = images._etag_for_file(path)
        return response


@router.get("/truyenqq/cover/{identifier}")
async def cover(identifier: str, request: Request):
    async def load():
        value = await qq.get_cover_info(identifier)
        if not value["cover_urls"]:
            raise HTTPException(404, "Truyện chưa có ảnh bìa")
        return await qq.run_live("image", value["cover_urls"], value["url"])
    return await _serve_image("cover:" + identifier, request, load, ttl=86400)


@router.get("/truyenqq/image/{identifier}/{number}/{index}")
async def chapter_image(identifier: str, number: str, request: Request, index: int = Path(ge=1)):
    async def load():
        return await qq.run_live("chapter_image", identifier, number, index)
    return await _serve_image(f"chapter:{identifier}:{number}:{index}", request, load, ttl=7 * 86400)
