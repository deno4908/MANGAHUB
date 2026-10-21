"""Bounded, coalesced optional database reads for public catalog pages.

Authentication, moderation decisions and writes never use this cache.
"""
import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import time

_executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="public-db")
_values = OrderedDict()
_pending = {}


async def cached_public_read(key, loader, default, *, ttl=15, wait_seconds=1.0):
    now = time.monotonic()
    previous = _values.get(key)
    if previous and previous[0] > now:
        _values.move_to_end(key)
        return deepcopy(previous[1])
    pending_key = (asyncio.get_running_loop(), key)
    task = _pending.get(pending_key)
    if task is None:
        if len(_pending) >= 24:
            return deepcopy(previous[1] if previous else default)

        async def fetch():
            lifetime = ttl
            try:
                value = await asyncio.get_running_loop().run_in_executor(_executor, loader)
            except Exception:
                value = previous[1] if previous else default
                lifetime = 10
            _values[key] = (time.monotonic() + lifetime, deepcopy(value))
            _values.move_to_end(key)
            while len(_values) > 128:
                _values.popitem(last=False)
            return value

        task = asyncio.create_task(fetch())
        _pending[pending_key] = task

        def finished(done):
            _pending.pop(pending_key, None)
            if not done.cancelled():
                done.exception()
        task.add_done_callback(finished)
    # An expired successful value is immediately usable while it refreshes.
    if previous:
        return deepcopy(previous[1])
    try:
        return deepcopy(await asyncio.wait_for(asyncio.shield(task), timeout=wait_seconds))
    except asyncio.TimeoutError:
        return deepcopy(default)
