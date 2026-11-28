import asyncio
from concurrent.futures import ThreadPoolExecutor
import socket
import threading
import time

import pytest
from starlette.requests import Request
from starlette.responses import Response
from unittest.mock import AsyncMock

from fastapi_app.routers import images

COVER = 'https://uploads.mangadex.org/covers/manga/cover.jpg.256.jpg'
HOST = 'uploads.mangadex.org'


@pytest.mark.parametrize('preload', [False, True])
def test_cached_image_validation_keeps_other_api_requests_responsive(monkeypatch, tmp_path, preload):
    """A disk read / Pillow decode must not pause preflight and reader requests."""
    monkeypatch.setattr(images, 'CACHE_DIR', tmp_path)
    monkeypatch.setattr(images, '_validate_image_url', AsyncMock(return_value=None))
    monkeypatch.setattr(images, '_cache_fetch_locks', {})
    monkeypatch.setattr(images, 'schedule_image_cache_prune', lambda: None)
    download = AsyncMock(side_effect=AssertionError('A valid cached image was downloaded again'))
    monkeypatch.setattr(images, '_fetch_image', download)
    path = tmp_path / images._cache_key(COVER)
    path.write_bytes(b'\xff\xd8\xffcached-image')
    entered, release = threading.Event(), threading.Event()
    validation_threads = []

    def inspect_cache(_path):
        validation_threads.append(threading.current_thread().name)
        entered.set()
        release.wait(.5)
        return False

    monkeypatch.setattr(images, '_cached_file_is_mangadex_placeholder', inspect_cache)

    async def run():
        request = Request({'type': 'http', 'method': 'GET', 'headers': []})
        task = asyncio.create_task(images.preload_images(COVER) if preload else images.proxy_image(COVER, request))
        try:
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            # A second request can run while the cache validation is still busy.
            assert not task.done(), 'Cache validation blocked the API event loop'
        finally:
            release.set()
            response = await task
        if preload:
            assert response == {'cached': 1, 'total': 1}
        else:
            assert response.status_code == 200 and response.headers['x-cache'] == 'HIT'
        download.assert_not_awaited()

    asyncio.run(run())
    assert validation_threads and all(name.startswith('image-cache') for name in validation_threads)


@pytest.mark.parametrize('placeholder', [False, True])
def test_httpx_image_validation_does_not_pause_other_requests(monkeypatch, placeholder):
    import httpx
    entered, release = threading.Event(), threading.Event()
    validation_threads = []
    payload = b'\xff\xd8\xffdownloaded-image'
    message = 'MangaDex returned hotlink placeholder' if placeholder else ''

    def validate(data, url):
        assert data == payload and url == COVER
        validation_threads.append(threading.current_thread().name)
        entered.set()
        release.wait(.5)
        return message

    monkeypatch.setattr(images, '_validate_image_url', AsyncMock(return_value=None))
    monkeypatch.setattr(images, '_validate_mangadex_image_payload', validate)
    monkeypatch.setattr(images, '_reset_client', AsyncMock())

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(
            200, headers={'Content-Type': 'image/jpeg'}, content=payload))) as client:
            monkeypatch.setattr(images, '_mangadex_http_client', client)
            task = asyncio.create_task(images._fetch_once_httpx(COVER))
            try:
                await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
                assert not task.done(), 'Decoded image bytes blocked the API event loop'
            finally:
                release.set()
                response = await task
        if placeholder:
            assert response == (None, None, message, True)
        else:
            assert response == (payload, 'image/jpeg', '', False)

    asyncio.run(run())
    assert validation_threads and all(name.startswith('image-cache') for name in validation_threads)


def test_ready_qq_image_is_not_held_behind_catalog_disk_jobs(monkeypatch, tmp_path):
    from fastapi_app.routers import truyenqq
    monkeypatch.setattr(truyenqq, 'IMAGE_CACHE_DIR', tmp_path)
    monkeypatch.setattr(images, '_cache_fetch_locks', {})
    monkeypatch.setattr(images, 'schedule_image_cache_prune', lambda: None)
    entered, release = threading.Event(), threading.Event()
    payload = b'\xff\xd8\xffqq-image'
    loader = AsyncMock(return_value=(payload, 'image/jpeg'))

    def catalog():
        entered.set()
        release.wait(2)

    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        busy = loop.run_in_executor(None, catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            response = await asyncio.wait_for(truyenqq._serve_image(
                'chapter:qq-test:1:1', Request({'type': 'http', 'method': 'GET', 'headers': []}),
                loader, ttl=86400), .5)
            assert response.status_code == 200 and response.body == payload
            assert not busy.done()
            assert next(tmp_path.glob('qq-v1-*.jpg')).read_bytes() == payload
            loader.assert_awaited_once()
        finally:
            release.set()
            await busy

    asyncio.run(run())


def test_cache_pruning_preserves_recent_images_and_ignores_links_outside_the_cache(monkeypatch, tmp_path):
    import os
    root = tmp_path / 'images'
    root.mkdir()
    protected = tmp_path / 'outside.jpg'
    protected.write_bytes(b'outside-image')
    nested = root / 'nested'
    nested.mkdir()
    (nested / 'nested.jpg').write_bytes(b'nested-image')
    paths = []
    for index in range(4):
        path = root / f'cached-{index}.jpg'
        path.write_bytes(b'x' * 10)
        os.utime(path, (index + 1, index + 1))
        paths.append(path)
    try:
        (root / 'external.jpg').symlink_to(protected)
    except OSError:
        pass  # Windows can require a separate permission for symlinks.
    monkeypatch.setattr(images, 'CACHE_DIR', root)
    monkeypatch.setattr(images, 'MAX_CACHE_SIZE', 35)
    monkeypatch.setattr(images, 'IMAGE_CACHE_TARGET_SIZE', 20)
    monkeypatch.setattr(images, '_image_cache_prune_running', True)
    images._prune_image_cache_sync()
    assert [path.exists() for path in paths] == [False, False, True, True]
    assert protected.read_bytes() == b'outside-image'
    assert (nested / 'nested.jpg').read_bytes() == b'nested-image'
    assert not images._image_cache_prune_running


def test_cached_qq_image_disk_check_does_not_block_the_api_loop(monkeypatch):
    from fastapi_app.routers import truyenqq
    entered, release = threading.Event(), threading.Event()
    loader = AsyncMock(side_effect=AssertionError('Cached QQ image fetched again'))

    def cached(*args):
        entered.set()
        release.wait(.5)
        return Response(b'qq-image', media_type='image/jpeg')

    monkeypatch.setattr(truyenqq, '_cached_image', cached)

    async def run():
        task = asyncio.create_task(truyenqq._serve_image(
            'chapter:qq-test:1:1', Request({'type': 'http', 'method': 'GET', 'headers': []}),
            loader, ttl=86400))
        try:
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            assert not task.done(), 'QQ cache disk read blocked the API event loop'
        finally:
            release.set()
            response = await task
        assert response.status_code == 200 and response.body == b'qq-image'
        loader.assert_not_awaited()

    asyncio.run(run())


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
            response = await asyncio.wait_for(pending, .5)
            assert response.status_code == 200
            assert not busy.done(), 'A warm cover queued behind unrelated catalog work'
        finally:
            release.set()
            await busy
            await pending

    asyncio.run(run())


@pytest.mark.parametrize('preload', [False, True])
def test_downloaded_image_is_not_held_by_the_catalog_executor(monkeypatch, tmp_path, preload):
    """Ready CDN bytes must reach the reader even while catalog jobs are busy."""
    from unittest.mock import AsyncMock
    monkeypatch.setattr(images, 'CACHE_DIR', tmp_path)
    monkeypatch.setattr(images, '_validate_image_url', AsyncMock(return_value=None))
    monkeypatch.setattr(images, '_fetch_image', AsyncMock(return_value=(b'jpeg-bytes', '', 'image/jpeg', 'fixture')))
    monkeypatch.setattr(images, 'schedule_image_cache_prune', lambda: None)
    monkeypatch.setattr(images, '_cache_fetch_locks', {})
    entered, release = threading.Event(), threading.Event()
    def catalog():
        entered.set()
        release.wait(3)
    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        busy = loop.run_in_executor(None, catalog)
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            if preload:
                result = await asyncio.wait_for(images.preload_images(COVER), .5)
                assert result['cached'] == 1
            else:
                result = await asyncio.wait_for(images.proxy_image(COVER, Request({'type':'http','method':'GET','headers':[]})), .5)
                assert result.status_code == 200 and result.body == b'jpeg-bytes'
            assert not busy.done()
            assert (tmp_path / images._cache_key(COVER)).read_bytes() == b'jpeg-bytes'
        finally:
            release.set()
            await busy
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
