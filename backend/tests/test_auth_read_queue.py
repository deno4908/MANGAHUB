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


@pytest.mark.parametrize('credential', ['cookie', 'ticket-header'])
def test_image_middleware_ticket_decode_bypasses_busy_catalog_queue_and_rechecks_revocation(monkeypatch, credential):
    from fastapi import Request, Response
    from fastapi_app import main
    context = ContextVar('image-ticket-middleware-fixture', default=None)
    revoked = False
    calls = []
    def decode(value):
        assert context.get() == 'reader-request'
        calls.append(value)
        if revoked:
            raise main.access_tickets.Rejected('revoked fixture')
        return {'fixture': True}
    monkeypatch.setattr(main.access_tickets, 'decode', decode)
    monkeypatch.setattr(main.access_tickets, 'user', lambda record: {'id': 'fixture-reader', 'role': 'reader'})
    delivered = []
    async def image(request):
        delivered.append(request.state.api_user['id'])
        return Response(b'private-image', media_type='image/jpeg')
    async def run():
        nonlocal revoked
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        entered, release = threading.Event(), threading.Event()
        def catalog():
            entered.set()
            release.wait(3)
        busy = loop.run_in_executor(None, catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        request_headers = [(b'authorization', b'AccessTicket fixture-read-ticket')] if credential == 'ticket-header' else [
            (b'cookie', (main.access_tickets.cookie_name() + '=fixture-read-ticket').encode())]
        def request():
            return Request({'type': 'http', 'method': 'GET', 'path': '/api/images/img',
                'query_string': b'', 'scheme': 'https', 'headers': request_headers})
        token = context.set('reader-request')
        try:
            first = await asyncio.wait_for(main.enforce_api_access_policy(request(), image), .5)
            assert first.status_code == 200 and first.body == b'private-image'
            assert first.headers['Cache-Control'] == 'private, no-store'
            revoked = True
            second = await asyncio.wait_for(main.enforce_api_access_policy(request(), image), .5)
            assert second.status_code == 403
            assert calls == ['fixture-read-ticket', 'fixture-read-ticket']
            assert delivered == ['fixture-reader']
            assert not busy.done()
        finally:
            context.reset(token)
            release.set()
            await busy
    asyncio.run(run())


@pytest.mark.parametrize('credential', ['cookie', 'ticket-header'])
def test_concurrent_image_tickets_share_only_the_inflight_revocation_read(monkeypatch, credential):
    from fastapi import Request, Response
    from fastapi_app import main
    from copy import deepcopy
    entered, release = threading.Event(), threading.Event()
    calls, delivered = [], []
    revoked = False
    def decode(value):
        calls.append(value)
        entered.set()
        release.wait(1)
        if revoked:
            raise main.access_tickets.Rejected('revoked fixture')
        return {'uid': 'fixture-reader', 'role': 'reader'}
    monkeypatch.setattr(main.access_tickets, 'decode', decode)
    monkeypatch.setattr(main.access_tickets, 'user', lambda record: {'id': record['uid'], 'role': record['role']})
    async def image(request):
        record = request.state.access_ticket
        delivered.append(deepcopy(record))
        # A response cannot mutate another reader's shared authorization record.
        record['uid'] = 'changed-response'
        return Response(b'image', media_type='image/jpeg')
    headers = [(b'authorization', b'AccessTicket concurrent-image-ticket')] if credential == 'ticket-header' else [
        (b'cookie', (main.access_tickets.cookie_name() + '=concurrent-image-ticket').encode())]
    def request():
        return Request({'type': 'http', 'method': 'GET', 'path': '/api/images/img',
                        'query_string': b'', 'scheme': 'https', 'headers': headers})
    async def run():
        nonlocal revoked
        jobs = [asyncio.create_task(main.enforce_api_access_policy(request(), image)) for _ in range(10)]
        try:
            assert await asyncio.to_thread(entered.wait, .5)
            await asyncio.sleep(.02)
            release.set()
            responses = await asyncio.gather(*jobs)
            assert all(response.status_code == 200 for response in responses)
            assert len(calls) == 1, 'Each image queued another read of the same active access session'
            assert all(record['uid'] == 'fixture-reader' for record in delivered)
            revoked = True
            response = await main.enforce_api_access_policy(request(), image)
            assert response.status_code == 403
            assert len(calls) == 2, 'The completed access verdict was reused after revocation'
            assert len(delivered) == 10
        finally:
            release.set()
            await asyncio.gather(*jobs, return_exceptions=True)
    asyncio.run(run())


def test_different_tickets_cannot_share_an_access_record(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def decode(value):
        calls.append(value)
        if len(calls) == 2:
            entered.set()
        release.wait(1)
        return {'uid': value}
    monkeypatch.setattr(auth.access_tickets, 'decode', decode)
    async def run():
        jobs = [asyncio.create_task(auth._shared_capability_read(value))
                for value in ['reader-one', 'reader-two', 'reader-one']]
        try:
            assert await asyncio.to_thread(entered.wait, .5)
        finally:
            release.set()
        records = await asyncio.gather(*jobs)
        assert records == [{'uid': 'reader-one'}, {'uid': 'reader-two'}, {'uid': 'reader-one'}]
        records[0]['uid'] = 'changed'
        assert records[2]['uid'] == 'reader-one'
    asyncio.run(run())
    assert sorted(calls) == ['reader-one', 'reader-two']


@pytest.mark.parametrize('failure', [auth.access_tickets.Rejected, auth.access_tickets.Unavailable])
def test_a_failed_inflight_ticket_read_never_becomes_an_authorization_grant(monkeypatch, failure):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def decode(value):
        calls.append(value)
        entered.set()
        release.wait(1)
        raise failure('unavailable or revoked fixture')
    monkeypatch.setattr(auth.access_tickets, 'decode', decode)
    async def run():
        jobs = [asyncio.create_task(auth._shared_capability_read('same-reader')) for _ in range(8)]
        try:
            assert await asyncio.to_thread(entered.wait, .5)
            await asyncio.sleep(.02)
        finally:
            release.set()
        errors = await asyncio.gather(*jobs, return_exceptions=True)
        assert all(isinstance(error, failure) for error in errors)
        assert len(calls) == 1
        with pytest.raises(failure):
            await auth._shared_capability_read('same-reader')
        assert len(calls) == 2
    asyncio.run(run())
