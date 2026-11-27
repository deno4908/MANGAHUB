"""Source-aware QQ image routes. Clients select a comic/page, never an arbitrary URL."""
import asyncio
import hashlib
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path as PathFile

from fastapi import APIRouter, HTTPException, Path, Request, Response
from fastapi.responses import FileResponse
from fastapi_app.services import truyenqq_service as qq
from fastapi_app.routers import images
from serverless_runtime import create_task

router = APIRouter()
IMAGE_CACHE_DIR = images.CACHE_DIR
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
_cover_refresh_jobs = {}
_cover_refresh_after = OrderedDict()
_thumbnail_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="qq-cover-resize")


def image_response(result):
    content, mime = result
    return Response(content, media_type=mime, headers={
        "Cache-Control": "public, max-age=3600",
        "Vercel-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff"})


def _cached_image(key, request, ttl):
    candidates = [IMAGE_CACHE_DIR / (key + ext) for ext in IMAGE_TYPES.values()]
    existing = [path for path in candidates if path.is_file() and path.stat().st_size > 0
                and time.time() - path.stat().st_mtime < ttl]
    if not existing:
        return None
    path = max(existing, key=lambda entry: entry.stat().st_mtime_ns)
    etag = images._etag_for_file(path)
    headers = {"Cache-Control": "public, max-age=3600", "ETag": etag,
               "Vercel-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
               "X-Content-Type-Options": "nosniff", "X-Cache": "HIT"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=images.EXT_CONTENT_TYPE[path.suffix], headers=headers)


async def _serve_image(identity, request, loader, ttl, *, stale_ttl=None):
    key = "qq-v1-" + hashlib.sha256(identity.encode()).hexdigest()
    cached = _cached_image(key, request, ttl)
    if cached is not None:
        return cached
    if stale_ttl:
        stale = _cached_image(key, request, stale_ttl)
        if stale is not None:
            # These are previously verified image bytes, still behind the
            # normal reader/whitelist middleware. A source challenge must not
            # blank every saved cover when its one-day freshness expires.
            stale.headers["X-Cache"] = "STALE"
            stale.headers["Cache-Control"] = "private, no-store"
            if "Vercel-CDN-Cache-Control" in stale.headers:
                del stale.headers["Vercel-CDN-Cache-Control"]
            job_key = (asyncio.get_running_loop(), key)
            if job_key not in _cover_refresh_jobs and _cover_refresh_after.get(key, 0) <= time.monotonic():
                _cover_refresh_after[key] = time.monotonic() + 300
                _cover_refresh_after.move_to_end(key)
                while len(_cover_refresh_after) > 256:
                    _cover_refresh_after.popitem(last=False)
                async def refresh():
                    try:
                        await _load_image(key, request, loader, ttl)
                    except Exception:
                        # Preserve bytes and the source's actual failure; no
                        # browser relay loop, cache timestamp extension or
                        # application access override is needed for this read.
                        pass
                    finally:
                        _cover_refresh_jobs.pop(job_key, None)
                _cover_refresh_jobs[job_key] = create_task(refresh())
            return stale
    return await _load_image(key, request, loader, ttl)


async def _load_image(key, request, loader, ttl):
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


def _cover_thumbnail(response, size):
    content = PathFile(response.path).read_bytes() if isinstance(response, FileResponse) else response.body
    mime = response.media_type or response.headers.get("content-type", "image/jpeg").split(";", 1)[0]
    if images.Image is None or len(content) < 40 * 1024:
        return content, mime
    try:
        with images.Image.open(BytesIO(content)) as image:
            if getattr(image, "is_animated", False):
                return content, mime
            image.thumbnail((size, size * 4), images.Image.Resampling.LANCZOS)
            output = BytesIO()
            image.convert("RGBA" if "A" in image.getbands() else "RGB").save(output, format="WEBP", quality=88, method=3)
        if output.tell() < len(content):
            return output.getvalue(), "image/webp"
    except (OSError, ValueError):
        pass
    return content, mime


@router.get("/truyenqq/cover/{identifier}")
async def cover(identifier: str, request: Request, size: int = 0):
    if size not in {0, 256, 512}:
        raise HTTPException(422, "Invalid cover size")
    async def load():
        value = await qq.get_cover_info(identifier)
        if not value["cover_urls"]:
            raise HTTPException(404, "Truyện chưa có ảnh bìa")
        return await qq.run_live("image", value["cover_urls"], value["url"])
    if not size:
        return await _serve_image("cover:" + identifier, request, load, ttl=86400, stale_ttl=7 * 86400)
    async def thumbnail():
        original_request = Request({**request.scope, "headers": [header for header in request.scope["headers"]
                                      if header[0].lower() != b"if-none-match"]})
        original = await _serve_image("cover:" + identifier, original_request, load, ttl=86400, stale_ttl=7 * 86400)
        return await asyncio.get_running_loop().run_in_executor(_thumbnail_executor, _cover_thumbnail, original, size)
    return await _serve_image(f"cover:{identifier}:{size}", request, thumbnail, ttl=86400, stale_ttl=7 * 86400)


@router.get("/truyenqq/image/{identifier}/{number}/{index}")
async def chapter_image(identifier: str, number: str, request: Request, index: int = Path(ge=1)):
    async def load():
        return await qq.get_chapter_image(identifier, number, index)
    return await _serve_image(f"chapter:{identifier}:{number}:{index}", request, load, ttl=7 * 86400)
