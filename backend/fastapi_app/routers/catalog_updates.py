import asyncio
import json
import time

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from fastapi_app.services.catalog_updates import catalog_updates, POLL_SECONDS

router = APIRouter()


@router.get("/updates")
async def update_versions():
    return {"sources": catalog_updates.current, "poll_interval_seconds": POLL_SECONDS}


async def event_stream(request):
    seen = {}
    initial = True
    heartbeat_at = 0
    yield "retry: 5000\nevent: ready\ndata: {}\n\n"
    while not await request.is_disconnected():
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


@router.get("/updates/stream")
async def live_updates(request: Request):
    return StreamingResponse(event_stream(request), media_type="text/event-stream", headers={
        "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})
