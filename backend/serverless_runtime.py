"""Writable paths and request-scoped background work for Vercel Functions."""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import tempfile
from pathlib import Path

IS_VERCEL = os.getenv("VERCEL") == "1"
_request_tasks = contextvars.ContextVar("vercel_request_tasks", default=None)
logger = logging.getLogger(__name__)


def writable_path(name: str) -> Path:
    root = Path(tempfile.gettempdir()) / "manga-bliss" if IS_VERCEL else Path(__file__).parent
    root.mkdir(parents=True, exist_ok=True)
    return root / name


def create_task(coroutine, **kwargs):
    """Keep finite work alive until its owning ASGI invocation finishes."""
    task = asyncio.create_task(coroutine, **kwargs)
    pending = _request_tasks.get()
    if pending is not None:
        pending.add(task)
    return task


class RequestTasksMiddleware:
    """Send the response promptly, then finish work before returning to Vercel.

    This is best-effort work bounded by the function duration, not a durable queue.
    Nested tasks inherit the same set, including reads shared with another caller.
    """

    def __init__(self, app, timeout_seconds=210):
        self.app = app
        self.timeout_seconds = timeout_seconds

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not IS_VERCEL:
            return await self.app(scope, receive, send)
        pending = set()
        token = _request_tasks.set(pending)
        deadline = asyncio.get_running_loop().time() + self.timeout_seconds
        try:
            await self.app(scope, receive, send)
        finally:
            try:
                while pending:
                    batch = set(pending)
                    pending.clear()
                    remaining = max(0, deadline - asyncio.get_running_loop().time())
                    done, unfinished = await asyncio.wait(batch, timeout=remaining)
                    for task in done:
                        if not task.cancelled() and task.exception() is not None:
                            logger.warning("Background request job failed: %s", type(task.exception()).__name__)
                    if unfinished:
                        for task in unfinished | pending:
                            task.cancel()
                        await asyncio.gather(*unfinished, *pending, return_exceptions=True)
                        logger.warning("Background request jobs exceeded their execution budget")
                        break
            finally:
                for task in pending:
                    if not task.done():
                        task.cancel()
                _request_tasks.reset(token)
