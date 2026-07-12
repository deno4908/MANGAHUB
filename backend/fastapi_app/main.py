"""
FastAPI application — main REST API service.
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from config import config
from fastapi_app.dependencies import get_supabase_admin, require_admin
from maintenance import (
    get_maintenance_state,
    is_admin_authorized,
    maintenance_payload,
    set_maintenance_state,
)

from fastapi_app.routers import (
    manga,
    users,
    bookmarks,
    history,
    comments,
    notifications,
    reports,
    admin,
    uploads,
    groups,
    images,
    ratings,
    editor,
)
from fastapi_app.services import otruyen_service
from fastapi_app.services.chapter_checker import chapter_check_loop
from security_runtime import ensure_security_redis_available
from vip_access import revoke_expired_vips

logging.getLogger("multipart.multipart").setLevel(logging.ERROR)
logging.getLogger("python_multipart.multipart").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

CACHE_REFRESH_INTERVAL = 600  # 10 minutes
PREWARM_LIST_PAGES = (1, 2)
PREWARM_LIST_TYPES = ("truyen-moi", "dang-phat-hanh", "hoan-thanh")
PREWARM_DETAIL_LIMIT = 20
PREWARM_CATEGORY_PAGES = (1,)
CORE_PREWARM_CATEGORY_LIMIT = 4
PREWARM_CATEGORY_LIMIT = 8
CORE_PREWARM_LIST_PAGES = (1,)
CORE_PREWARM_LIST_TYPES = ("truyen-moi", "dang-phat-hanh")
DEFERRED_WARMUP_DELAY_SECONDS = 2
DATABASE_CLEANUP_INTERVAL_SECONDS = 6 * 60 * 60
DATABASE_CLEANUP_INITIAL_DELAY_SECONDS = 60
VIEW_SESSION_RETENTION_DAYS = 7
VIEW_EVENT_RETENTION_DAYS = 90
VIP_EXPIRY_SWEEP_INTERVAL_SECONDS = 5 * 60


class MaintenanceModeUpdate(BaseModel):
    enabled: bool
    title: str | None = Field(default=None, max_length=120)
    message: str | None = Field(default=None, max_length=1000)
    image_url: str | None = Field(default=None, max_length=1000)
    starts_at: str | None = Field(default=None, max_length=80)
    ends_at: str | None = Field(default=None, max_length=80)


def _collect_list_payloads(results: list[object]) -> list[dict]:
    payloads: list[dict] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        data = result.get("data", {})
        if not isinstance(data, dict):
            continue
        if not isinstance(data.get("items"), list):
            continue
        pagination = data.get("params", {}).get("pagination")
        if not isinstance(pagination, dict):
            continue
        payloads.append(result)
    return payloads


async def _prewarm_detail_cache(list_payloads: list[dict]):
    slugs: list[str] = []
    for payload in list_payloads:
        items = payload.get("data", {}).get("items") or []
        for item in items:
            slug = str((item or {}).get("slug") or "").strip()
            if slug:
                slugs.append(slug)
    unique_slugs = list(dict.fromkeys(slugs))[:PREWARM_DETAIL_LIMIT]
    if not unique_slugs:
        return
    detail_jobs = [otruyen_service.get_manga_detail(slug) for slug in unique_slugs]
    await asyncio.gather(*detail_jobs, return_exceptions=True)


def _collect_category_slugs(categories_payload: object) -> list[str]:
    if not isinstance(categories_payload, dict):
        return []
    data = categories_payload.get("data", {})
    if not isinstance(data, dict):
        return []
    items = data.get("items", [])
    if not isinstance(items, list):
        return []
    slugs: list[str] = []
    for item in items:
        slug = str((item or {}).get("slug") or "").strip()
        if slug:
            slugs.append(slug)
    return list(dict.fromkeys(slugs))


async def _prewarm_category_cache(category_slugs: list[str], limit: int):
    if not category_slugs:
        return
    jobs = []
    for slug in category_slugs[:limit]:
        for page in PREWARM_CATEGORY_PAGES:
            jobs.append(otruyen_service.get_category_manga(slug, page))
    if jobs:
        await asyncio.gather(*jobs, return_exceptions=True)


async def _warmup_cache_core():
    """Pre-fill cache with commonly accessed data so first page load is fast."""
    import logging
    logger = logging.getLogger(__name__)
    logger.info("⏳ Core cache warmup...")
    try:
        categories_payload = await otruyen_service.get_categories()
        category_slugs = _collect_category_slugs(categories_payload)
        await _prewarm_category_cache(category_slugs, CORE_PREWARM_CATEGORY_LIMIT)
        warmup_jobs = []
        for list_type in CORE_PREWARM_LIST_TYPES:
            for page in CORE_PREWARM_LIST_PAGES:
                warmup_jobs.append(otruyen_service.get_list(list_type, page))
        results = await asyncio.gather(*warmup_jobs, return_exceptions=True)
        ok = sum(1 for r in results if r and not isinstance(r, Exception))
        logger.info(f"✅ Core warmup done — {ok}/{len(warmup_jobs)} endpoints cached")
        # Populate random pool from freshly cached data
        await otruyen_service.refresh_random_pool()
    except Exception as e:
        logger.warning(f"Core warmup failed: {e}")


async def _warmup_cache_extended():
    import logging
    logger = logging.getLogger(__name__)
    try:
        categories_payload = await otruyen_service.get_categories()
        category_slugs = _collect_category_slugs(categories_payload)
        await _prewarm_category_cache(category_slugs, PREWARM_CATEGORY_LIMIT)
        warmup_jobs = []
        for list_type in PREWARM_LIST_TYPES:
            for page in PREWARM_LIST_PAGES:
                warmup_jobs.append(otruyen_service.get_list(list_type, page))
        results = await asyncio.gather(*warmup_jobs, return_exceptions=True)
        list_payloads = _collect_list_payloads(results)
        await _prewarm_detail_cache(list_payloads)
        logger.debug("✅ Extended warmup done")
    except Exception as e:
        logger.debug(f"Extended warmup failed: {e}")


async def _cache_refresh_loop():
    """Background loop that keeps cache fresh — data is ALWAYS served from cache."""
    import logging
    logger = logging.getLogger(__name__)
    while True:
        await asyncio.sleep(CACHE_REFRESH_INTERVAL)
        try:
            await _warmup_cache_extended()
            # Refresh random pool with latest data
            await otruyen_service.refresh_random_pool()
            logger.debug("🔄 Cache refreshed")
        except Exception:
            pass


async def _deferred_warmup_loop():
    await asyncio.sleep(DEFERRED_WARMUP_DELAY_SECONDS)
    await _warmup_cache_extended()


async def _prewarm_admin_dashboard_cache():
    """Warm admin dashboard caches in background so first admin load is faster."""
    logger = logging.getLogger(__name__)
    try:
        db = get_supabase_admin()
        await admin.prewarm_admin_dashboard_cache(db)
        logger.debug("✅ Admin dashboard cache warmed")
    except Exception as exc:
        logger.debug(f"Admin dashboard warmup skipped: {exc}")


async def _run_database_cleanup_once():
    """Prune anti-spam event tables if migration v15 RPC is available."""
    logger = logging.getLogger(__name__)
    try:
        db = get_supabase_admin()
        result = await asyncio.to_thread(
            lambda: db.rpc(
                "cleanup_view_anti_spam_events",
                {
                    "p_session_retention_days": VIEW_SESSION_RETENTION_DAYS,
                    "p_event_retention_days": VIEW_EVENT_RETENTION_DAYS,
                },
            ).execute()
        )
        logger.debug("Database cleanup result: %s", getattr(result, "data", None))
    except Exception as exc:
        logger.debug("Database cleanup skipped: %s", exc)


async def _database_cleanup_loop():
    await asyncio.sleep(DATABASE_CLEANUP_INITIAL_DELAY_SECONDS)
    while True:
        await _run_database_cleanup_once()
        await asyncio.sleep(DATABASE_CLEANUP_INTERVAL_SECONDS)


async def _vip_expiry_sweep_loop():
    """Keep persisted VIP flags aligned with their expiry timestamps."""
    logger = logging.getLogger(__name__)
    while True:
        try:
            db = get_supabase_admin()
            revoked = await asyncio.to_thread(revoke_expired_vips, db, force=True)
            if revoked:
                logger.info("Revoked %s expired VIP account(s)", revoked)
        except Exception as exc:
            logger.debug("VIP expiry sweep skipped: %s", exc)
        await asyncio.sleep(VIP_EXPIRY_SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle — warm cache + start background tasks."""
    await asyncio.to_thread(ensure_security_redis_available)
    images.schedule_image_cache_prune(force=True)
    await _warmup_cache_core()
    task = asyncio.create_task(chapter_check_loop())
    refresh_task = asyncio.create_task(_cache_refresh_loop())
    deferred_warmup_task = asyncio.create_task(_deferred_warmup_loop())
    admin_dashboard_warmup_task = asyncio.create_task(_prewarm_admin_dashboard_cache())
    database_cleanup_task = asyncio.create_task(_database_cleanup_loop())
    vip_expiry_sweep_task = asyncio.create_task(_vip_expiry_sweep_loop())
    # Pre-warm MangaDex vi_catalog in background so /manga loads immediately
    manga.schedule_startup_warmup()
    yield
    task.cancel()
    refresh_task.cancel()
    deferred_warmup_task.cancel()
    admin_dashboard_warmup_task.cancel()
    database_cleanup_task.cancel()
    vip_expiry_sweep_task.cancel()
    try:
        await asyncio.gather(
            task,
            refresh_task,
            deferred_warmup_task,
            admin_dashboard_warmup_task,
            database_cleanup_task,
            vip_expiry_sweep_task,
            return_exceptions=True,
        )
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="Manga-Bliss API",
    description="REST API for Manga-Bliss — powered by OTruyenAPI + Supabase",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)


def _public_server_error_message(status_code: int) -> str:
    if status_code in {502, 503, 504}:
        return "Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau."
    return "Đã xảy ra lỗi máy chủ. Vui lòng thử lại sau."


@app.exception_handler(StarletteHTTPException)
async def sanitized_http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code < 500:
        return await http_exception_handler(request, exc)

    logger.error(
        "Suppressed HTTP error method=%s path=%s status=%s detail=%r",
        request.method,
        request.url.path,
        exc.status_code,
        str(exc.detail)[:2000],
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": _public_server_error_message(exc.status_code)},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def sanitized_unhandled_exception_handler(request: Request, exc: Exception):
    logger.error(
        "Unhandled API error method=%s path=%s",
        request.method,
        request.url.path,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return JSONResponse(
        status_code=500,
        content={"detail": _public_server_error_message(500)},
    )

_cors_origins = [config.FRONTEND_URL]
if getattr(config, "CORS_ALLOW_LOCALHOST", False):
    _cors_origins.extend(
        [
            "http://localhost:5173",
            "http://localhost:8080",
            "http://localhost:3000",
        ]
    )
_cors_origins = list(dict.fromkeys(origin for origin in _cors_origins if origin))

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def enforce_maintenance_mode(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    if path in {"/health", "/api/maintenance", "/docs", "/redoc", "/openapi.json"}:
        return await call_next(request)

    state = await asyncio.to_thread(get_maintenance_state)
    if not state.get("enabled"):
        return await call_next(request)

    is_admin = await asyncio.to_thread(
        is_admin_authorized,
        request.headers.get("Authorization"),
    )
    if is_admin:
        return await call_next(request)

    headers = {
        "Retry-After": "60",
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    origin = request.headers.get("Origin")
    if origin in _cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"

    return JSONResponse(
        status_code=503,
        content=maintenance_payload(state),
        headers=headers,
    )


@app.get("/api/maintenance")
async def maintenance_status():
    return {"maintenance": await asyncio.to_thread(get_maintenance_state)}


@app.get("/api/admin/maintenance")
async def admin_maintenance_status(admin_user=Depends(require_admin)):
    _ = admin_user
    return {"maintenance": await asyncio.to_thread(get_maintenance_state, force=True)}


@app.put("/api/admin/maintenance")
async def admin_set_maintenance(
    payload: MaintenanceModeUpdate,
    admin_user=Depends(require_admin),
):
    state = await asyncio.to_thread(
        set_maintenance_state,
        enabled=payload.enabled,
        title=str(payload.title or "").strip() or None,
        message=str(payload.message or "").strip() or None,
        image_url=str(payload.image_url or "").strip() or None,
        starts_at=str(payload.starts_at or "").strip() or None,
        ends_at=str(payload.ends_at or "").strip() or None,
        updated_by=admin_user["id"],
    )
    return {
        "message": "Đã bật chế độ bảo trì" if state.get("enabled") else "Đã tắt chế độ bảo trì",
        "maintenance": state,
    }

# Include routers
app.include_router(manga.router, prefix="/api/manga", tags=["Manga (OTruyenAPI)"])
app.include_router(users.router, prefix="/api/users", tags=["Users"])
app.include_router(bookmarks.router, prefix="/api/bookmarks", tags=["Bookmarks & Follows"])
app.include_router(history.router, prefix="/api/history", tags=["Reading History"])
app.include_router(comments.router, prefix="/api/comments", tags=["Comments"])
app.include_router(notifications.router, prefix="/api/notifications", tags=["Notifications"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(uploads.router, prefix="/api/uploads", tags=["Uploads"])
app.include_router(groups.router, prefix="/api/groups", tags=["Groups"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(ratings.router, prefix="/api/ratings", tags=["Ratings"])
app.include_router(images.router, prefix="/api/images", tags=["Image Proxy"])
app.include_router(editor.router, prefix="/api/editor", tags=["Image Editor"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "fastapi-api"}
