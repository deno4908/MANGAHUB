import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import threading

import pytest
from fastapi import HTTPException

from fastapi_app import dependencies as auth


def test_image_permission_reads_do_not_wait_for_catalog_workers(monkeypatch):
    context = ContextVar('auth-read-queue-fixture', default=None)
    calls = []
    def verify(token):
        assert context.get() == 'request-context'
        calls.append(token)
        return {'uid': 'fixture-reader', 'role': 'reader'}, False
    monkeypatch.setattr(auth, '_ticket_read', verify)
    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        entered, release = threading.Event(), threading.Event()
        def catalog():
            entered.set()
            release.wait(3)
        busy = loop.run_in_executor(None, catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        token = context.set('request-context')
        try:
            values = await asyncio.wait_for(asyncio.gather(*[
                auth._shared_ticket_read('Bearer fixture') for _ in range(8)]), .5)
            assert all(value[0]['uid'] == 'fixture-reader' for value in values)
            assert calls == ['Bearer fixture']
            assert not busy.done()
        finally:
            context.reset(token)
            release.set()
            await busy
    asyncio.run(run())


def test_auth_queue_never_reuses_a_completed_revocation_verdict(monkeypatch):
    revoked = False
    calls = []
    def verify(token):
        calls.append(token)
        if revoked:
            raise HTTPException(401, 'revoked')
        return {'uid': 'fixture-reader', 'role': 'reader'}, False
    monkeypatch.setattr(auth, '_ticket_read', verify)
    async def run():
        nonlocal revoked
        assert (await auth._shared_ticket_read('Bearer fixture-revocable'))[0]['role'] == 'reader'
        revoked = True
        with pytest.raises(HTTPException, match='revoked'):
            await auth._shared_ticket_read('Bearer fixture-revocable')
        assert len(calls) == 2
    asyncio.run(run())
