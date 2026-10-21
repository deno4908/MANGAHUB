"""
FastAPI application — main REST API service.
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from config import config
from fastapi_app.dependencies import (
    authorize_api_request,
    get_supabase_admin,
    require_admin,
)
from maintenance import (
    get_maintenance_state,
    get_maintenance_state_async,
    is_admin_authorized,
    maintenance_payload,
    set_maintenance_state,
)

from fastapi_app.routers import (
    manga,
    truyenqq,
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
    catalog_updates as catalog_updates_router,
)
from fastapi_app.services import truyenqq_service
from fastapi_app.routers import site_access as site_access_router
import site_access as access_policy
from fastapi_app.services.catalog_updates import catalog_updates
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
    detail_jobs = [truyenqq_service.get_manga_detail(slug) for slug in unique_slugs]
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
            jobs.append(truyenqq_service.get_category_manga(slug, page))
    if jobs:
        await asyncio.gather(*jobs, return_exceptions=True)


async def _warmup_cache_core():
    """Pre-fill cache with commonly accessed data so first page load is fast."""
    import logging
    logger = logging.getLogger(__name__)
    logger.info("⏳ Core cache warmup...")
    try:
        warmup_jobs = [truyenqq_service.get_filtered(sort="views_desc"), truyenqq_service.get_categories()]
        for list_type in CORE_PREWARM_LIST_TYPES:
            for page in CORE_PREWARM_LIST_PAGES:
                warmup_jobs.append(truyenqq_service.get_list(list_type, page))
        results = await asyncio.gather(*warmup_jobs, return_exceptions=True)
        categories_payload = results[1]
        category_slugs = _collect_category_slugs(categories_payload)
        ok = sum(1 for r in results if r and not isinstance(r, Exception))
        logger.info(f"✅ Core warmup done — {ok}/{len(warmup_jobs)} endpoints cached")
        # Populate random pool from freshly cached data
        await truyenqq_service.refresh_random_pool()
        await _prewarm_category_cache(category_slugs, CORE_PREWARM_CATEGORY_LIMIT)
    except Exception as e:
        logger.warning(f"Core warmup failed: {e}")


async def _warmup_cache_extended():
    import logging
    logger = logging.getLogger(__name__)
    try:
        categories_payload = await truyenqq_service.get_categories()
        category_slugs = _collect_category_slugs(categories_payload)
        await _prewarm_category_cache(category_slugs, PREWARM_CATEGORY_LIMIT)
        warmup_jobs = []
        for list_type in PREWARM_LIST_TYPES:
            for page in PREWARM_LIST_PAGES:
                warmup_jobs.append(truyenqq_service.get_list(list_type, page))
        results = await asyncio.gather(*warmup_jobs, return_exceptions=True)
        # Listing cards already carry cover hints. Fetching twenty complete
        # comic/chapter lists here delays readers and wastes upstream bandwidth.
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
            await truyenqq_service.refresh_random_pool()
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
    if config.IS_VERCEL:
        # Functions handle finite request work. Do not start permanent polling
        # loops on every cold start; live requests refresh the shared catalog.
        try:
            yield
        finally:
            await truyenqq_service.close()
        return
    images.schedule_image_cache_prune(force=True)
    core_warmup_task = asyncio.create_task(_warmup_cache_core())
    task = asyncio.create_task(chapter_check_loop())
    refresh_task = asyncio.create_task(_cache_refresh_loop())
    deferred_warmup_task = asyncio.create_task(_deferred_warmup_loop())
    admin_dashboard_warmup_task = asyncio.create_task(_prewarm_admin_dashboard_cache())
    database_cleanup_task = asyncio.create_task(_database_cleanup_loop())
    vip_expiry_sweep_task = asyncio.create_task(_vip_expiry_sweep_loop())
    live_catalog_task = asyncio.create_task(catalog_updates.run())
    # Pre-warm MangaDex vi_catalog in background so /manga loads immediately
    manga.schedule_startup_warmup()
    yield
    core_warmup_task.cancel()
    task.cancel()
    refresh_task.cancel()
    deferred_warmup_task.cancel()
    admin_dashboard_warmup_task.cancel()
    database_cleanup_task.cancel()
    vip_expiry_sweep_task.cancel()
    live_catalog_task.cancel()
    try:
        await asyncio.gather(
            core_warmup_task,
            task,
            refresh_task,
            deferred_warmup_task,
            admin_dashboard_warmup_task,
            database_cleanup_task,
            vip_expiry_sweep_task,
            live_catalog_task,
            return_exceptions=True,
        )
    except asyncio.CancelledError:
        pass
    await truyenqq_service.close()


app = FastAPI(
    title="Manga-Bliss API",
    description="REST API for Manga-Bliss — powered by TruyenQQ + MangaDex + Supabase",
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

_PUBLIC_ADMIN_PATHS = frozenset({"/api/admin/announcements/active"})
_PUBLIC_UPLOAD_PATH_PREFIXES = ("/api/uploads/published/",)


def _minimum_api_role_for_path(path: str) -> str | None:
    """Return the role floor for privileged API namespaces.

    Individual endpoints still enforce their exact roles. This is a defensive
    boundary so a future endpoint cannot accidentally expose an admin, upload,
    or editor operation just because it missed a dependency declaration.
    """
    if path.startswith("/api/admin/"):
        return None if path in _PUBLIC_ADMIN_PATHS else "moderator"
    if path.startswith("/api/uploads/"):
        if path.startswith(_PUBLIC_UPLOAD_PATH_PREFIXES):
            return None
        return "uploader"
    if path.startswith("/api/editor/"):
        return "uploader"
    return None


def _api_auth_error_headers(request: Request) -> dict[str, str]:
    headers = {"Cache-Control": "no-store, max-age=0"}
    origin = request.headers.get("Origin")
    if origin in _cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return headers

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-TruyenQQ-Error", "X-TruyenQQ-Source-Path", "X-TruyenQQ-Search"],
)


@app.middleware("http")
async def enforce_maintenance_mode(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    if path in {"/health", "/api/maintenance", "/docs", "/redoc", "/openapi.json"}:
        return await call_next(request)

    state = await get_maintenance_state_async()
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


@app.middleware("http")
async def enforce_api_access_policy(request: Request, call_next):
    """Reject banned/invalid supplied tokens and protect privileged namespaces."""
    if request.method == "OPTIONS" or not request.url.path.startswith("/api/"):
        return await call_next(request)

    try:
        path = request.url.path
        minimum_role = _minimum_api_role_for_path(path)
        authorization = request.headers.get("Authorization")
        # Cookie grants are only for public reads (including <img> requests).
        # Mutations and privileged namespaces always require their bearer token.
        if not authorization and minimum_role is None and request.method in {"GET", "HEAD"} and path not in {"/api/site-access", "/api/maintenance"}:
            token = access_policy.asset_token(request.cookies.get(access_policy.COOKIE_NAME))
            if token:
                authorization = "Bearer " + token
        user = await authorize_api_request(authorization, minimum_role=minimum_role)
        request.state.api_user = user
        request.state.site_access_authorization = authorization
        if path not in {"/api/site-access", "/api/maintenance"}:
            # Admins must remain able to repair settings even if the store fails.
            if not user or user.get("role") != "admin":
                state = await asyncio.to_thread(access_policy.get_state)
                if not await asyncio.to_thread(access_policy.is_allowed, state, user):
                    return JSONResponse(status_code=403, content={
                        "code": "WHITELIST_REQUIRED", "detail": state["message"],
                        "site_access": {"enabled": True, "allowed": False,
                                        "authenticated": user is not None, "message": state["message"]},
                    }, headers=_api_auth_error_headers(request))
    except access_policy.AccessUnavailable as exc:
        return JSONResponse(status_code=503, content={"code": "SITE_ACCESS_UNAVAILABLE", "detail": str(exc)},
                            headers=_api_auth_error_headers(request))
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=_api_auth_error_headers(request),
        )

    context = access_policy.source_authorization.set(authorization if user else None)
    try:
        response = await call_next(request)
    finally:
        access_policy.source_authorization.reset(context)
    # A shared CDN cache must never bypass a later whitelist decision.
    response.headers["Vercel-CDN-Cache-Control"] = "no-store"
    response.headers["CDN-Cache-Control"] = "no-store"
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.get("/api/maintenance")
async def maintenance_status():
    return {"maintenance": await get_maintenance_state_async()}


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
app.include_router(manga.router, prefix="/api/manga", tags=["Manga"])
app.include_router(site_access_router.router, prefix="/api", tags=["Site access"])
app.include_router(catalog_updates_router.router, prefix="/api/manga", tags=["Catalog Updates"])
app.include_router(truyenqq.router, prefix="/api/manga", tags=["TruyenQQ"])
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
