"""Share ongoing reads without letting a disconnected caller cancel other readers."""
import asyncio
from serverless_runtime import create_task
import functools
import inspect
from copy import deepcopy


def coalesce_reads(function=None, *, revision=None, scope=None):
    if function is None:
        return lambda target: coalesce_reads(target, revision=revision, scope=scope)
    signature = inspect.signature(function)
    pending = {}

    @functools.wraps(function)
    async def wrapped(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        # Revision providers read shared Redis state. A slow network must not
        # pause all image/catalog requests on the ASGI event loop.
        version = await asyncio.to_thread(revision) if revision else None
        key = (asyncio.get_running_loop(), repr(bound.arguments), version, scope() if scope else None)
        task = pending.get(key)
        if task is None:
            task = create_task(function(*args, **kwargs))
            pending[key] = task

            def finished(done):
                if pending.get(key) is done:
                    pending.pop(key, None)
                if not done.cancelled():
                    done.exception()  # retrieve errors even when all callers disconnected

            task.add_done_callback(finished)
        # Routers enrich responses in place; each reader needs its own object.
        return deepcopy(await asyncio.shield(task))

    return wrapped
