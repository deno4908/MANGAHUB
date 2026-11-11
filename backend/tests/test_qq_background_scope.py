import asyncio
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi_app.services import truyenqq_service as qq
from site_access import source_authorization


def test_approved_reader_does_not_join_anonymous_native_warmup(monkeypatch):
    """Native lifespan warmups have no reader token, unlike request-scoped work."""
    monkeypatch.setattr(qq, "cache", SimpleNamespace(get=lambda *a: None, set=lambda *a, **kw: None))
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def load(method):
            authorized = bool(source_authorization.get())
            calls.append(authorized)
            if not authorized:
                started.set()
                await release.wait()
                raise HTTPException(502, "anonymous relay denied")
            return []
        monkeypatch.setattr(qq, "run_live", load)
        token = source_authorization.set(None)
        background = asyncio.create_task(qq.get_categories())
        await started.wait()
        source_authorization.set("Bearer approved-fixture")
        reader = asyncio.create_task(qq.get_categories())
        try:
            done, _ = await asyncio.wait([reader], timeout=.3)
            assert reader in done, "Reader joined unauthenticated startup request"
            assert reader.result()["status"] == "success"
            assert calls == [False, True]
        finally:
            release.set()
            await asyncio.gather(background, reader, return_exceptions=True)
            source_authorization.reset(token)
    asyncio.run(scenario())


def test_approved_readers_still_share_one_public_source_read(monkeypatch):
    monkeypatch.setattr(qq, "cache", SimpleNamespace(get=lambda *a: None, set=lambda *a, **kw: None))
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def load(method):
            calls.append(True)
            started.set()
            await release.wait()
            return []
        monkeypatch.setattr(qq, "run_live", load)
        token = source_authorization.set("Bearer reader-a")
        first = asyncio.create_task(qq.get_categories())
        await started.wait()
        source_authorization.set("Bearer reader-b")
        second = asyncio.create_task(qq.get_categories())
        try:
            await asyncio.sleep(.05)
            assert calls == [True]
            release.set()
            a, b = await asyncio.gather(first, second)
            assert a == b and a is not b
        finally:
            release.set()
            source_authorization.reset(token)
    asyncio.run(scenario())


def test_cold_catalog_reader_does_not_join_anonymous_snapshot_refresh(monkeypatch):
    monkeypatch.setattr(qq, "cache", SimpleNamespace(get=lambda *a: None, set=lambda *a, **kw: None, set_many=lambda *a, **kw: None))
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def load(method, *args, **kwargs):
            authorized = bool(source_authorization.get())
            calls.append(authorized)
            if not authorized:
                started.set()
                await release.wait()
                raise HTTPException(502, "anonymous relay denied")
            return {"items": [], "page": 1}
        monkeypatch.setattr(qq, "run_live", load)
        token = source_authorization.set(None)
        background = asyncio.create_task(qq._catalog_page("collection", "latest", 1))
        await started.wait()
        source_authorization.set("Bearer approved-fixture")
        reader = asyncio.create_task(qq._catalog_page("collection", "latest", 1))
        try:
            done, _ = await asyncio.wait([reader], timeout=.3)
            assert reader in done, "Reader joined anonymous catalog snapshot refresh"
            assert reader.result()["status"] == "success"
            assert calls == [False, True]
        finally:
            release.set()
            await asyncio.gather(background, reader, return_exceptions=True)
            source_authorization.reset(token)
    asyncio.run(scenario())
