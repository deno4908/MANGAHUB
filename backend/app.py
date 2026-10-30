"""Vercel entrypoint: one backend project serves the API and Flask auth routes."""
import asyncio
import hmac
import os

from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.wsgi import WSGIMiddleware
from serverless_runtime import IS_VERCEL, RequestTasksMiddleware, writable_path

if IS_VERCEL:
    os.environ.setdefault("EASYOCR_MODULE_PATH", str(writable_path("easyocr")))
    os.environ.setdefault("TORCH_HOME", str(writable_path("torch")))

from config import config
from flask_app import create_app
from flask_app.auth.credentials import get_private_key
from fastapi_app.main import app as api_app
from fastapi_app.services.redis_failover import RedisRecoveryMiddleware


class AuthGatewayMiddleware:
    def __init__(self, app, auth_app):
        self.app = app
        self.auth = WSGIMiddleware(auth_app)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] == "http" and (path == "/auth" or path.startswith("/auth/")):
            # Preserve /auth in PATH_INFO: Flask already registers that prefix.
            return await self.auth(scope, receive, send)
        return await self.app(scope, receive, send)


auth_app = create_app()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None,
              lifespan=api_app.router.lifespan_context)
if config.IS_VERCEL:
    get_private_key()  # Reject missing/invalid shared encryption keys on startup.


@auth_app.get("/auth/health")
def auth_health():
    revision = os.getenv("VERCEL_GIT_COMMIT_SHA", "")
    headers = {}
    if len(revision) == 40 and all(char in "0123456789abcdef" for char in revision.lower()):
        headers["X-MangaHub-Revision"] = revision[:12]
    return {"status": "ok", "service": "flask-gateway"}, 200, headers


app.add_middleware(AuthGatewayMiddleware, auth_app=auth_app)
app.add_middleware(RedisRecoveryMiddleware)
app.add_middleware(RequestTasksMiddleware)


@app.get("/internal/maintenance-tasks", include_in_schema=False)
async def scheduled_maintenance(request: Request):
    secret = os.getenv("CRON_SECRET", "")
    supplied = request.headers.get("authorization", "")
    if not secret or not hmac.compare_digest(supplied.encode(), ("Bearer " + secret).encode()):
        raise HTTPException(401, "Unauthorized")
    from fastapi_app.dependencies import get_supabase_admin
    from fastapi_app.main import _run_database_cleanup_once
    from fastapi_app.services.chapter_checker import _check_new_chapters
    from vip_access import revoke_expired_vips
    from fastapi_app.services.cache_service import cache

    async def expire_vips():
        db = get_supabase_admin()
        await asyncio.to_thread(revoke_expired_vips, db, force=True)

    async def check_redis():
        if cache.recovery_due():
            await asyncio.to_thread(cache.check_primary)

    jobs = [asyncio.create_task(job()) for job in
            (_run_database_cleanup_once, _check_new_chapters, expire_vips, check_redis)]
    done, pending = await asyncio.wait(jobs, timeout=240)
    for job in pending:
        job.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    failed = sum(job.cancelled() or job.exception() is not None for job in done)
    return {"status": "partial" if pending or failed else "ok",
            "completed": len(done) - failed, "failed": failed, "unfinished": len(pending)}


app.mount("/", api_app)
