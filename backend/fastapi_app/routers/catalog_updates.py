import asyncio
import json
import time

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from fastapi_app.services.catalog_updates import catalog_updates, POLL_SECONDS
from serverless_runtime import IS_VERCEL, create_task
from fastapi_app.dependencies import authorize_api_request
import site_access as access_policy

router = APIRouter()


@router.get("/updates")
async def update_versions():
    if IS_VERCEL:
        await catalog_updates.sync()
        create_task(catalog_updates.refresh_once())
    return {"sources": catalog_updates.current, "poll_interval_seconds": POLL_SECONDS}


async def _catalog_event_stream(request):
    seen = {}
    initial = True
    heartbeat_at = 0
    started = time.monotonic()
    probe_at = 0
    probe_task = None
    yield "retry: 5000\nevent: ready\ndata: {}\n\n"
    while not await request.is_disconnected():
        if IS_VERCEL:
            if time.monotonic() - started >= 45:
                return  # EventSource reconnects; do not exhaust a Function.
            if time.monotonic() - probe_at >= POLL_SECONDS:
                await catalog_updates.sync()
                if probe_task is None or probe_task.done():
                    probe_task = create_task(catalog_updates.refresh_once())
                probe_at = time.monotonic()
        for source, event in tuple(catalog_updates.current.items()):
            if seen.get(source) != event["revision"]:
                seen[source] = event["revision"]
                payload = {**event, "snapshot": initial}
                yield f"id: {source}:{event['revision']}\nevent: catalog-update\ndata: {json.dumps(payload)}\n\n"
        initial = False
        if time.monotonic() - heartbeat_at >= 15:
            yield ": keepalive\n\n"
            heartbeat_at = time.monotonic()
        await asyncio.sleep(1)


async def event_stream(request):
    authorization = getattr(request.state, "site_access_authorization", None)
    context = access_policy.source_authorization.set(authorization)
    try:
        async for chunk in _catalog_event_stream(request):
            # Recheck existing streams as well as new HTTP connections.
            try:
                user = await authorize_api_request(authorization)
                state = await asyncio.to_thread(access_policy.get_state)
                if not await asyncio.to_thread(access_policy.is_allowed, state, user):
                    return
            except Exception:
                return
            yield chunk
    finally:
        access_policy.source_authorization.reset(context)


@router.get("/updates/stream")
async def live_updates(request: Request):
    return StreamingResponse(event_stream(request), media_type="text/event-stream", headers={
        "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})
