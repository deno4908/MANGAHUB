"""VPS entrypoint: the complete combined app plus private standby coordination.

The public Vercel entrypoint is unchanged. No user mutation is retried here.
Routing state lives on disk, outside the disposable Redis content cache.
"""
import asyncio
import hmac
import json
import os
import threading
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse
from app import app
from flask_app.auth.credentials import get_private_key
from redis_runtime import client_for, security_client
from config import config
from standby_primary import frontend_healthy

HOSTS = ("mangahub.art", "api.mangahub.art", "auth.mangahub.art")
_guard = threading.Lock()
STATE_FILE = Path(os.getenv("STANDBY_STATE_FILE", "/var/lib/mangahub/failover-state.json"))
# Sharing the encryption key is mandatory; never generate an isolated auth key.
if not os.getenv("AUTH_CREDENTIAL_PRIVATE_JWK") or not config.REDIS_SECURITY_URL:
    raise RuntimeError("Standby requires the shared authentication key and security Redis")
get_private_key()


def read_state():
    try:
        state = json.loads(STATE_FILE.read_text())
        if not isinstance(state, dict) or set(state.get("modes", {})) != set(HOSTS):
            raise ValueError()
        if any(mode not in {"primary", "backup"} for mode in state["modes"].values()):
            raise ValueError()
        return state
    except (OSError, ValueError, TypeError):
        return {"modes": dict.fromkeys(HOSTS, "primary"), "successes": {}, "updated_at": 0}


def advance_state(health):
    with _guard:
        state = read_state()
        counts = state.setdefault("successes", {})
        for host in HOSTS:
            if not health[host]:
                state["modes"][host] = "backup"
                counts[host] = 0
            else:
                counts[host] = min(3, counts.get(host, 0) + 1)
                if counts[host] >= 3:
                    state["modes"][host] = "primary"
        state["updated_at"] = int(time.time())
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = STATE_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(state))
        os.replace(temporary, STATE_FILE)
        return state


def ready(*, drill=False):
    if not drill and os.getenv("STANDBY_READY", "false").lower() != "true":
        raise RuntimeError("Standby activation checklist is incomplete")
    if drill and not (config.RECAPTCHA_SECRET_KEY and config.RECAPTCHA_REQUIRED):
        raise RuntimeError("Standby reCAPTCHA configuration is incomplete")
    # Verify reads AND writes, not just a PING that can succeed after quota exhaustion.
    from uuid import uuid4
    for client in (security_client(), client_for(config.REDIS_URL)):
        key = "mh:standby-probe:" + uuid4().hex
        client.set(key, "ready", ex=10)
        if client.get(key) != "ready":
            raise RuntimeError("Redis probe failed")
        client.delete(key)


@app.middleware("http")
async def standby_control(request: Request, call_next):
    if request.url.path not in {"/internal/standby-health", "/internal/standby-drill-health", "/internal/standby-primary-health", "/internal/standby-control"}:
        return await call_next(request)
    secret = os.getenv("STANDBY_ORIGIN_SECRET", "")
    supplied = request.headers.get("x-mangahub-origin-secret", "")
    if not secret or not hmac.compare_digest(secret.encode(), supplied.encode()):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    headers = {"Cache-Control": "private, no-store"}
    if request.url.path == "/internal/standby-primary-health":
        if request.method not in {"GET", "HEAD"}:
            return JSONResponse({"detail": "Method not allowed"}, status_code=405, headers=headers)
        return JSONResponse({"healthy": await asyncio.to_thread(frontend_healthy)}, headers=headers)
    if request.url.path.endswith("health"):
        if request.method not in {"GET", "HEAD"}:
            return JSONResponse({"detail": "Method not allowed"}, status_code=405, headers=headers)
        try:
            await asyncio.to_thread(ready, drill=request.url.path.endswith("standby-drill-health"))
            return JSONResponse({"status": "ready"}, headers=headers)
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503, headers=headers)
    if request.method == "GET":
        return JSONResponse(await asyncio.to_thread(read_state), headers=headers)
    if request.method == "POST":
        # A tiny, authenticated control message; never forward end-user bodies here.
        data = await request.body()
        if len(data) > 1024:
            return JSONResponse({"detail": "Too large"}, status_code=413, headers=headers)
        try:
            health = json.loads(data)["health"]
            if set(health) != set(HOSTS) or any(type(health[h]) is not bool for h in HOSTS):
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            return JSONResponse({"detail": "Invalid probe"}, status_code=400, headers=headers)
        return JSONResponse(await asyncio.to_thread(advance_state, health), headers=headers)
    return JSONResponse({"detail": "Method not allowed"}, status_code=405, headers=headers)
