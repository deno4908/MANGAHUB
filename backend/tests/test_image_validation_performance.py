import asyncio
from concurrent.futures import ThreadPoolExecutor
import socket
import threading
import time

import pytest
from starlette.requests import Request
from starlette.responses import Response

from fastapi_app.routers import images

COVER = 'https://uploads.mangadex.org/covers/manga/cover.jpg.256.jpg'
HOST = 'uploads.mangadex.org'


def test_cached_cover_does_not_wait_behind_blocking_catalog_work(monkeypatch):
    monkeypatch.setattr(images, '_host_validation_cache', {HOST: (time.time() + 300, None)})
    monkeypatch.setattr(images, '_cached_image_response', lambda *a, **k: Response(b'image', media_type='image/jpeg'))
    entered, release = threading.Event(), threading.Event()

    def busy_catalog():
        entered.set()
        release.wait(3)

    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        busy = loop.run_in_executor(None, busy_catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        request = Request({'type': 'http', 'method': 'GET', 'headers': []})
        pending = asyncio.create_task(images.proxy_image(COVER, request))
        try:
            await asyncio.sleep(0)
            assert pending.done(), 'A warm cover queued behind unrelated catalog work'
            assert (await pending).status_code == 200
        finally:
            release.set()
            await busy
            await pending

    asyncio.run(run())


def test_cold_image_dns_uses_a_bounded_pool_independent_of_catalog_work(monkeypatch):
    monkeypatch.setattr(images, '_host_validation_cache', {})
    resolver_threads = []

    def resolve(*args, **kwargs):
        resolver_threads.append(threading.current_thread().name)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 0))]

    monkeypatch.setattr(images.socket, 'getaddrinfo', resolve)
    entered, release = threading.Event(), threading.Event()

    def busy_catalog():
        entered.set()
        release.wait(3)

    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        busy = loop.run_in_executor(None, busy_catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            assert await asyncio.wait_for(images._validate_image_url(COVER), 1) is None
            assert not busy.done()
        finally:
            release.set()
            await busy

    asyncio.run(run())
    assert resolver_threads and all(name.startswith('image-dns') for name in resolver_threads)


@pytest.mark.parametrize('url', [
    COVER.replace('https:', 'http:'),
    COVER.replace(HOST, 'reader:secret@' + HOST),
    COVER.replace(HOST, HOST + ':8443'),
    COVER.replace(HOST, 'not-allowed.example'),
    'https://' + HOST + '/',
])
def test_dns_cache_never_bypasses_url_restrictions(monkeypatch, url):
    monkeypatch.setattr(images, '_host_validation_cache', {HOST: (time.time() + 300, None)})
    assert asyncio.run(images._validate_image_url(url))


def test_cached_dns_failure_still_blocks_the_image(monkeypatch):
    error = 'Image host resolved to a private address'
    monkeypatch.setattr(images, '_host_validation_cache', {HOST: (time.time() + 300, error)})
    assert asyncio.run(images._validate_image_url(COVER)) == error


def test_expired_dns_entry_is_rechecked_and_private_addresses_are_rejected(monkeypatch):
    monkeypatch.setattr(images, '_host_validation_cache', {HOST: (time.time() - 1, None)})
    monkeypatch.setattr(images.socket, 'getaddrinfo', lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 0))])
    assert asyncio.run(images._validate_image_url(COVER)) == 'Image host resolved to a private address'


def test_changed_host_allowlist_is_enforced_before_cached_dns(monkeypatch):
    monkeypatch.setattr(images, '_host_validation_cache', {HOST: (time.time() + 300, None)})
    monkeypatch.setattr(images, '_is_allowed_image_host', lambda host: False)
    assert asyncio.run(images._validate_image_url(COVER)) == 'Image host is not allowed'
