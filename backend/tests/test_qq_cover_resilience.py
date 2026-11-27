import asyncio
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock

from fastapi import HTTPException
from starlette.requests import Request

from fastapi_app.routers import truyenqq as routes
from fastapi_app.services import truyenqq_service as qq
from test_catalog_updates import Cache


SLUG = 'known-comic-123'
SOURCE = {'url': 'https://truyenqqko.com/truyen-tranh/' + SLUG,
          'cover_urls': ['https://images.example/cover.jpg']}


def request():
    return Request({'type': 'http', 'method': 'GET', 'path': '/api/manga/truyenqq/cover/' + SLUG,
                    'headers': [], 'query_string': b''})


def test_cover_source_survives_short_lived_card_metadata(monkeypatch):
    store = Cache()
    monkeypatch.setattr(qq, 'cache', store)
    qq._item({'id': '123', 'title': 'Known comic', **SOURCE})
    store.values.pop('truyenqq:cover-hint:' + SLUG)
    store.values.pop('truyenqq:cover-hint:known-comic')
    source = AsyncMock(side_effect=AssertionError('Known covers must not fetch source HTML'))
    monkeypatch.setattr(qq, 'run_live', source)
    assert asyncio.run(qq.get_cover_info(SLUG)) == SOURCE
    source.assert_not_awaited()


def test_saved_alias_uses_verified_native_source_and_rejects_other_identity(monkeypatch):
    store = Cache()
    store.values['catalog:card-metadata:v1:known-comic'] = json.dumps({
        'source': 'truyenqq', 'slug': SLUG, 'title': 'Known comic'})
    store.values['truyenqq:cover-source:v1:' + SLUG] = json.dumps(SOURCE)
    monkeypatch.setattr(qq, 'cache', store)
    monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=AssertionError('No source HTML expected')))
    assert asyncio.run(qq.get_cover_info('known-comic')) == SOURCE
    # A detail belonging to another book cannot provide this book's cover.
    store.values.clear()
    store.values['truyenqq:detail:' + SLUG] = json.dumps({'data': {'item': {
        'source': 'truyenqq', 'slug': 'different-comic-456', 'cover_original': SOURCE['cover_urls'][0]}}})
    assert qq._cached_cover_source(SLUG) == (None, SLUG)


def test_cached_native_detail_supplies_cover_without_html_lookup(monkeypatch):
    store = Cache()
    store.values['truyenqq:detail-last-good:' + SLUG] = json.dumps({'data': {'item': {
        'source': 'truyenqq', 'slug': SLUG, 'cover_original': SOURCE['cover_urls'][0]}}})
    monkeypatch.setattr(qq, 'cache', store)
    monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=AssertionError('No HTML expected')))
    assert asyncio.run(qq.get_cover_info(SLUG)) == SOURCE


def test_cached_cover_lookup_does_not_queue_behind_catalog_threads(monkeypatch):
    store = Cache()
    store.values['truyenqq:cover-source:v1:' + SLUG] = json.dumps(SOURCE)
    monkeypatch.setattr(qq, 'cache', store)
    async def run():
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        entered, release = threading.Event(), threading.Event()
        def blocked():
            entered.set()
            release.wait(3)
        task = loop.run_in_executor(None, blocked)
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            assert await asyncio.wait_for(qq.get_cover_info(SLUG), .5) == SOURCE
            assert not task.done()
        finally:
            release.set()
            await task
    asyncio.run(run())


def test_cold_cover_remembers_source_without_changing_card_freshness(monkeypatch):
    store = Cache()
    monkeypatch.setattr(qq, 'cache', store)
    source = AsyncMock(return_value=SOURCE)
    monkeypatch.setattr(qq, 'run_live', source)
    assert asyncio.run(qq.get_cover_info(SLUG)) == SOURCE
    assert json.loads(store.values['truyenqq:cover-source:v1:' + SLUG]) == SOURCE
    assert 'truyenqq:cover-hint:' + SLUG not in store.values


def test_expired_cover_is_served_immediately_and_refreshes_once_on_source_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, 'IMAGE_CACHE_DIR', tmp_path)
    monkeypatch.setattr(routes, '_cover_refresh_jobs', {})
    # Use an OrderedDict because the production backoff is bounded by LRU.
    from collections import OrderedDict
    monkeypatch.setattr(routes, '_cover_refresh_after', OrderedDict())
    key = 'qq-v1-' + hashlib.sha256(('cover:' + SLUG).encode()).hexdigest()
    path = tmp_path / (key + '.jpg')
    path.write_bytes(b'previously-verified-image')
    old_time = time.time() - 2 * 86400
    os.utime(path, (old_time, old_time))
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def unavailable():
            calls.append(1)
            started.set()
            await release.wait()
            raise HTTPException(503, 'source challenge')
        try:
            results = await asyncio.wait_for(asyncio.gather(*[
                routes._serve_image('cover:' + SLUG, request(), unavailable, 86400, stale_ttl=7 * 86400)
                for _ in range(12)]), .5)
            assert all(result.status_code == 200 and result.headers['X-Cache'] == 'STALE' for result in results)
            assert all(str(result.path) == str(path) for result in results)
            await asyncio.wait_for(started.wait(), .5)
            assert len(calls) == 1
            tasks = list(routes._cover_refresh_jobs.values())
        finally:
            release.set()
        await asyncio.gather(*tasks)
        response = await routes._serve_image('cover:' + SLUG, request(), unavailable, 86400, stale_ttl=7 * 86400)
        assert response.status_code == 200
        assert len(calls) == 1
        assert path.stat().st_mtime == old_time  # Do not extend stale freshness after failure.
    asyncio.run(run())


def test_old_or_empty_cover_bytes_cannot_mask_a_real_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(routes, 'IMAGE_CACHE_DIR', tmp_path)
    key = 'qq-v1-' + hashlib.sha256(('cover:' + SLUG).encode()).hexdigest()
    path = tmp_path / (key + '.jpg')
    async def run():
        async def unavailable():
            raise HTTPException(503, 'no verified cover')
        import pytest
        for age, content in [(8 * 86400, b'old-image'), (2 * 86400, b'')]:
            path.write_bytes(content)
            os.utime(path, (time.time() - age, time.time() - age))
            with pytest.raises(HTTPException, match='no verified cover'):
                await routes._serve_image('cover:' + SLUG, request(), unavailable, 86400, stale_ttl=7 * 86400)
    asyncio.run(run())
