import asyncio
import importlib.util
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def standby(monkeypatch):
    inner = FastAPI()
    @inner.get('/api/plain')
    async def plain():
        return {'full_app': True}
    monkeypatch.setitem(sys.modules, 'app', SimpleNamespace(app=inner))
    monkeypatch.setenv('STANDBY_ORIGIN_SECRET', 'test-origin-secret')
    spec = importlib.util.spec_from_file_location('standby_capacity_fixture', Path(__file__).parents[1] / 'standby_app.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_private_status_never_exposes_capacity_to_anonymous_clients(standby):
    with TestClient(standby.app) as client:
        assert client.get('/internal/origin-status').status_code == 404
        assert client.get('/internal/origin-status', headers={'X-MangaHub-Origin-Secret':'wrong'}).status_code == 404
        assert client.get('/api/plain').json() == {'full_app': True}


def test_status_requires_recent_successful_dependency_probe(standby, monkeypatch):
    monkeypatch.setattr(standby, 'verify_ready', lambda: False)
    headers = {'X-MangaHub-Origin-Secret':'test-origin-secret'}
    with TestClient(standby.app) as client:
        assert client.get('/internal/origin-status', headers=headers).status_code == 503
        standby.app.ready_at = time.monotonic()
        assert client.get('/internal/origin-status', headers=headers).json()['status'] == 'ready'
        standby.app.ready_at = time.monotonic() - 21
        assert client.get('/internal/origin-status', headers=headers).status_code == 503
        assert client.post('/internal/origin-status', headers=headers).status_code == 405


def test_capacity_is_conservative_when_memory_or_concurrency_is_exhausted(standby, monkeypatch):
    monkeypatch.setattr(standby.os, 'getloadavg', lambda: (1, 1, 1), raising=False)
    def read(path):
        return 'MemAvailable: 300000 kB\n' if str(path).endswith('meminfo') else 'some avg10=0.00 avg60=0.00'
    monkeypatch.setattr(standby.Path, 'read_text', read)
    assert standby.capacity(2)['accept_extra'] is True
    assert standby.capacity(9)['accept_extra'] is False
    monkeypatch.setattr(standby.Path, 'read_text', lambda p: 'MemAvailable: 20000 kB\n' if str(p).endswith('meminfo') else 'some avg10=0.00')
    assert standby.capacity(2)['accept_extra'] is False


def test_cancelled_reader_releases_its_capacity_slot(standby):
    async def inner(scope, receive, send):
        assert wrapper.active == 1
        raise asyncio.CancelledError()
    wrapper = standby.OriginStatusMiddleware(inner)
    async def scenario():
        with pytest.raises(asyncio.CancelledError):
            await wrapper({'type':'http','path':'/api/manga/chapter/fixture'},None,None)
        assert wrapper.active == 0
    asyncio.run(scenario())


def test_readiness_keeps_running_when_default_database_threads_are_busy(standby, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    release, started = threading.Event(), threading.Event()
    monkeypatch.setattr(standby, 'verify_ready', lambda: True)
    async def scenario():
        loop=asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        def blocked():
            started.set()
            release.wait(2)
        busy=loop.run_in_executor(None,blocked)
        while not started.is_set():await asyncio.sleep(.001)
        monitor=asyncio.create_task(standby.app._monitor())
        try:
            async def ready():
                while not standby.app.ready_at:await asyncio.sleep(.001)
            await asyncio.wait_for(ready(),.5)
        finally:
            release.set()
            monitor.cancel()
            await asyncio.gather(monitor,return_exceptions=True)
            await busy
            standby.app.probe_pool.shutdown(wait=False,cancel_futures=True)
    asyncio.run(scenario())
