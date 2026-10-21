import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from fastapi import FastAPI

from fastapi_app.routers import images, manga, ratings
from fastapi_app.services import public_reads, truyenqq_service as qq
import maintenance


def test_source_view_counts_never_replace_local_counts():
    for lookup, expected in (({"truyen-thu-123": 7}, 7), ({}, 0)):
        item = {"slug": "truyen-thu-123", "view_count": 90000000, "views": 90000000}
        manga._otruyen_apply_local_views(item, lookup)
        assert item["view_count"] == item["views"] == item["local_view_count"] == expected


def test_slow_maintenance_lookup_is_shared_and_has_a_deadline(monkeypatch):
    gate = threading.Event()
    calls = 0
    def slow():
        nonlocal calls
        calls += 1
        gate.wait(2)
        return maintenance._default_state()
    monkeypatch.setattr(maintenance, '_state_cache', None)
    monkeypatch.setattr(maintenance, 'get_maintenance_state', slow)
    async def check():
        try:
            result = await asyncio.wait_for(asyncio.gather(*[
                maintenance.get_maintenance_state_async() for _ in range(3)]), 1.5)
            assert len(result) == 3 and calls == 1
        finally:
            gate.set()
            await asyncio.sleep(0.02)
    asyncio.run(check())


def test_maintenance_network_failure_keeps_an_enabled_last_known_state(monkeypatch):
    state = {**maintenance._default_state(), 'enabled': True}
    monkeypatch.setattr(maintenance, '_state_cache', (time.monotonic() - 1, state))
    def unavailable():
        raise OSError('DNS unavailable')
    monkeypatch.setattr(maintenance, '_get_supabase_admin', unavailable)
    assert maintenance.get_maintenance_state()['enabled'] is True


def test_slow_public_rating_query_does_not_block_other_requests():
    started, release = threading.Event(), threading.Event()
    class DB:
        def __getattr__(self, name):
            if name == "execute":
                def execute():
                    started.set()
                    release.wait(1)
                    return SimpleNamespace(data=[])
                return execute
            return lambda *args, **kwargs: self
    async def check():
        task = asyncio.create_task(ratings.get_top_rated_manga(limit=24, db=DB()))
        try:
            await asyncio.sleep(0.05)
            assert started.is_set()
            assert not task.done()  # the event loop progressed while SQL is waiting
        finally:
            release.set()
            await task
    asyncio.run(check())


def test_public_reads_share_work_and_return_with_a_deadline():
    gate = threading.Event()
    calls = 0
    key = ("performance-test", object())
    def load():
        nonlocal calls
        calls += 1
        gate.wait(1)
        return {"views": 7}
    async def check():
        try:
            first, second = await asyncio.gather(*[
                public_reads.cached_public_read(key, load, {"views": 0}, wait_seconds=0.02)
                for _ in range(2)])
            assert first == second == {"views": 0}
            assert calls == 1
            gate.set()
            await asyncio.sleep(0.05)
            assert await public_reads.cached_public_read(key, load, {}) == {"views": 7}
            assert calls == 1
        finally:
            gate.set()
            public_reads._values.pop(key, None)
    asyncio.run(check())


def test_qq_reader_and_images_do_not_wait_for_catalog_workers(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    active = 0
    lock = threading.Lock()
    class Live:
        def basic(self, value):
            nonlocal active
            with lock:
                active += 1
                if active == 5:
                    started.set()
            release.wait(2)
            return {}
        def image(self):
            return b"image", "image/jpeg"
        def chapter(self):
            return {"images": []}
    monkeypatch.setattr(qq, "get_live", lambda: Live())
    async def check():
        jobs = [asyncio.create_task(qq.run_live("basic", str(n))) for n in range(5)]
        try:
            assert await asyncio.to_thread(started.wait, 1)
            assert await asyncio.wait_for(qq.run_live("image"), 0.3) == (b"image", "image/jpeg")
            assert await asyncio.wait_for(qq.run_live("chapter"), 0.3) == {"images": []}
        finally:
            release.set()
            await asyncio.gather(*jobs)
    asyncio.run(check())


def test_mangadex_slow_transport_has_a_fast_fallback(monkeypatch):
    monkeypatch.setattr(images, "_preferred_mangadex_transports", {})
    async def slow(url):
        await asyncio.sleep(5)
        return None, None, "timeout", True
    monkeypatch.setattr(images, "_transport_order", lambda _: ["curl_cffi", "httpx"])
    monkeypatch.setattr(images, "_fetch_once_curl", slow)
    monkeypatch.setattr(images, "_fetch_once_httpx", AsyncMock(return_value=(b"image", "image/jpeg", "", False)))
    result = asyncio.run(asyncio.wait_for(images._fetch_mangadex_candidate("https://uploads.mangadex.org/covers/test.jpg"), 1))
    assert result[0] == b"image" and result[4] == "httpx"


def test_mangadex_reuses_winning_transport_and_recovers_if_it_fails(monkeypatch):
    monkeypatch.setattr(images, "_preferred_mangadex_transports", {})
    monkeypatch.setattr(images, "CurlSession", object())
    calls = []
    curl_slow = True
    httpx_failed = False

    async def curl(url):
        calls.append(("curl", url))
        if curl_slow:
            await asyncio.sleep(5)
        return b"curl-image", "image/jpeg", "", False

    async def http(url):
        calls.append(("httpx", url))
        if httpx_failed:
            return None, None, "connection failed", True
        return b"httpx-image", "image/jpeg", "", False

    monkeypatch.setattr(images, "_fetch_once_curl", curl)
    monkeypatch.setattr(images, "_fetch_once_httpx", http)

    async def check():
        nonlocal curl_slow, httpx_failed
        base = "https://uploads.mangadex.org/covers/"
        assert (await images._fetch_mangadex_candidate(base + "one.jpg"))[4] == "httpx"
        calls.clear()
        assert (await images._fetch_mangadex_candidate(base + "two.jpg"))[4] == "httpx"
        assert calls == [("httpx", base + "two.jpg")]
        curl_slow, httpx_failed = False, True
        assert (await images._fetch_mangadex_candidate(base + "three.jpg"))[4] == "curl_cffi"
        assert images._transport_order(base + "four.jpg") == ["curl_cffi", "httpx"]

    asyncio.run(check())


def test_mangadex_transport_preference_expires_and_is_scoped_to_host(monkeypatch):
    monkeypatch.setattr(images, "CurlSession", object())
    monkeypatch.setattr(images, "_preferred_mangadex_transports", {
        "uploads.mangadex.org": ("httpx", time.monotonic() + 60),
    })
    assert images._transport_order("https://uploads.mangadex.org/covers/a.jpg")[0] == "httpx"
    assert images._transport_order("https://node.mangadex.network/data/a.jpg")[0] == "curl_cffi"
    images._preferred_mangadex_transports["uploads.mangadex.org"] = ("httpx", time.monotonic() - 1)
    assert images._transport_order("https://uploads.mangadex.org/covers/b.jpg")[0] == "curl_cffi"


def test_mangadex_transport_preference_has_a_size_bound(monkeypatch):
    preferences = {str(n): ("httpx", time.monotonic() + 60) for n in range(32)}
    monkeypatch.setattr(images, "_preferred_mangadex_transports", preferences)
    monkeypatch.setattr(images, "_transport_order", lambda _: ["httpx"])
    monkeypatch.setattr(images, "_fetch_once_httpx", AsyncMock(return_value=(b"image", "image/jpeg", "", False)))
    asyncio.run(images._fetch_mangadex_candidate("https://uploads.mangadex.org/covers/a.jpg"))
    assert set(preferences) == {"uploads.mangadex.org"}


def test_preload_and_visible_image_share_one_download(monkeypatch, tmp_path):
    monkeypatch.setattr(images, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(images, "_validate_image_url", AsyncMock(return_value=None))
    monkeypatch.setattr(images, "schedule_image_cache_prune", lambda **kw: None)
    calls = 0
    async def fetch(url, retry_hint=0):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.02)
        return b"\xff\xd8\xfftest", url, "image/jpeg", "test"
    monkeypatch.setattr(images, "_fetch_image", fetch)
    app = FastAPI()
    app.include_router(images.router, prefix="/api/images")
    async def check():
        url = "https://uploads.mangadex.org/covers/coalesce-test.jpg"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            preload, visible, duplicate = await asyncio.gather(
                client.get("/api/images/preload", params={"urls": url}),
                client.get("/api/images/img", params={"url": url}),
                client.get("/api/images/img", params={"url": url}))
            assert all(response.status_code == 200 for response in (preload, visible, duplicate))
            assert visible.content == duplicate.content == b"\xff\xd8\xfftest"
            assert calls == 1
    asyncio.run(check())
