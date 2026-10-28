import asyncio
import json
import threading
import time
from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from fastapi_app.services import cache_service, card_chapters, mangadex_service as mdx, truyenqq_service as qq
from fastapi_app.services.request_coalescing import coalesce_reads


def test_qq_browse_overlaps_moderation_and_source_and_enriches_views_only_once(monkeypatch):
    from fastapi_app.routers import manga
    source_started, hidden_started = asyncio.Event(), asyncio.Event()
    payload = {"data": {"items": [{"slug": "visible-1"}, {"slug": "hidden-2"}]}}
    async def source(**kwargs):
        source_started.set()
        await hidden_started.wait()
        return payload
    async def hidden(db):
        hidden_started.set()
        await source_started.wait()
        return {"hidden-2": "hidden by admin"}
    enriched = []
    async def views(payload, db):
        enriched.append([item["slug"] for item in payload["data"]["items"]])
        for item in payload["data"]["items"]:
            item["views"] = item["view_count"] = item["local_view_count"] = 7
    monkeypatch.setattr(qq, 'get_filtered', source)
    monkeypatch.setattr(manga, '_get_hidden_slugs', hidden)
    monkeypatch.setattr(manga, '_async_attach_local_views_to_otruyen_payload', views)
    monkeypatch.setattr(manga, '_fetch_override_rows_by_slugs', AsyncMock(return_value={}))
    async def check():
        result = await asyncio.wait_for(manga.otruyen_filtered_manga(
            genre_slugs='', status='', sort='latest', page=2, limit=42, show_mature=True,
            base_slug='', attach_ratings=False, user=None, db=object(), response=None), 1)
        assert [item['slug'] for item in result['data']['items']] == ['visible-1']
        assert result['data']['items'][0]['views'] == 7
        assert enriched == [['visible-1']]
    asyncio.run(check())


def test_popularity_reuses_stale_catalog_without_attaching_slow_vercel_jobs(monkeypatch):
    import serverless_runtime as runtime
    from fastapi_app.routers import manga
    from fastapi_app.services import local_popular
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    monkeypatch.setattr(local_popular, "_frozen", lambda key, value=None: value)
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {})
    payload = {"data": {"items": [{"slug": f"book-{i}"} for i in range(42)],
               "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}
    monkeypatch.setattr(qq, "_json_cached", lambda key: {"payload": payload, "fresh_until": 0})
    network = AsyncMock(side_effect=AssertionError("A cached popularity page must not launch refresh work"))
    monkeypatch.setattr(qq, "run_live", network)
    async def app(scope, receive, send):
        result = await local_popular.qq_popular(page=2, limit=42, genres=[], status="",
                                              show_mature=True, hidden={}, db=None)
        assert len(result["data"]["items"]) == 42
        assert result["data"]["ranking_pending"] is False
    async def run():
        # Include request-finalization work, not just time until JSON is produced.
        await asyncio.wait_for(runtime.RequestTasksMiddleware(app)({"type": "http"}, None, None), 1)
    asyncio.run(run())
    network.assert_not_awaited()


def test_cold_catalog_deadline_also_finishes_the_vercel_background_job(monkeypatch):
    import serverless_runtime as runtime
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    monkeypatch.setattr(qq, "_json_cached", lambda key: None)
    monkeypatch.setattr(qq, "_catalog_jobs", {})
    stopped = asyncio.Event()
    async def slow(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    monkeypatch.setattr(qq, "run_live", slow)
    async def app(scope, receive, send):
        with pytest.raises(asyncio.TimeoutError):
            await qq.get_filtered(page=2, background_refresh=False, refresh_timeout=0.02)
    async def run():
        await asyncio.wait_for(runtime.RequestTasksMiddleware(app)({"type": "http"}, None, None), 1)
        assert stopped.is_set()
        assert not qq._catalog_jobs
    asyncio.run(run())


def test_interactive_deadline_also_applies_to_an_existing_shared_catalog_job(monkeypatch):
    import serverless_runtime as runtime
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    monkeypatch.setattr(qq, "_json_cached", lambda key: None)
    monkeypatch.setattr(qq, "_catalog_jobs", {})
    started = asyncio.Event()
    async def blocked(*args, **kwargs):
        started.set()
        await asyncio.Event().wait()
    network = AsyncMock(side_effect=blocked)
    monkeypatch.setattr(qq, "run_live", network)
    async def app(scope, receive, send):
        with pytest.raises(asyncio.TimeoutError):
            await qq.get_filtered(page=2, background_refresh=False, refresh_timeout=0.02)
    async def run():
        # This refresh belongs to another request, outside this invocation's task set.
        existing = asyncio.create_task(qq.get_filtered(page=2))
        try:
            await asyncio.wait_for(started.wait(), 1)
            await asyncio.wait_for(runtime.RequestTasksMiddleware(app)({"type": "http"}, None, None), 1)
            assert not existing.done()
            network.assert_awaited_once()
        finally:
            jobs = [existing, *qq._catalog_jobs.values()]
            for task in jobs:
                task.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
    asyncio.run(run())


def test_shared_revision_lookup_does_not_block_the_event_loop():
    owner = threading.get_ident()
    def revision():
        assert threading.get_ident() != owner
        return "revision"
    @coalesce_reads(revision=revision)
    async def read():
        return {"chapter": 1}
    assert asyncio.run(read()) == {"chapter": 1}


def test_empty_catalog_is_read_once_for_a_batch_then_rechecked_after_invalidation(monkeypatch):
    cache = Mock()
    cache.get_many.side_effect = lambda keys: {key: None for key in keys}
    cache.get.side_effect = AssertionError("Empty catalogs must not cause sequential Redis scans")
    monkeypatch.setattr(mdx, "cache", cache)
    monkeypatch.setattr(mdx, "_vi_catalog_lookup_index", {})
    monkeypatch.setattr(mdx, "_vi_catalog_lookup_index_at", 0)
    for index in range(48):
        assert mdx._get_cached_vi_catalog_manga(f"book-{index}") is None
    assert cache.get_many.call_count == 1
    monkeypatch.setattr(mdx, "_vi_catalog_lookup_index_at", 0)
    assert mdx._get_cached_vi_catalog_manga("new-book") is None
    assert cache.get_many.call_count == 2


def test_trending_snapshots_use_one_batch_for_all_pages_and_both_sources(monkeypatch):
    from fastapi_app.routers import manga
    identifier = "11111111-1111-4111-8111-111111111111"
    payload = {"title": "Native title"}
    cache = Mock()
    def batch(keys):
        assert "mangadex:lookup:" + identifier in keys
        assert "mangadex:vi-catalog:all:stale" in keys
        assert "truyenqq:list:truyen-moi:20" in keys
        return {"truyenqq:detail:book-123": json.dumps(payload)}
    cache.get_many.side_effect = batch
    cache.get.side_effect = AssertionError("No per-page network reads")
    monkeypatch.setattr(manga, "cache", cache)
    assert manga._load_trending_snapshots(["book-123", identifier], "revision")["truyenqq:detail:book-123"] == payload
    cache.get_many.assert_called_once()


def test_mangadex_cover_batch_reuses_shared_urls_without_crawling(monkeypatch):
    identifier = "11111111-1111-4111-8111-111111111111"
    url = f"https://uploads.mangadex.org/covers/{identifier}/cover.jpg.512.jpg"
    cache = Mock()
    cache.get_many.return_value = {f"mangadex:cover-url:v2:{identifier}": url}
    monkeypatch.setattr(mdx, "cache", cache)
    upstream = Mock(side_effect=AssertionError("A cached cover must not wait for another API request"))
    monkeypatch.setattr(mdx, "_request_json", upstream)
    assert asyncio.run(mdx._fetch_cover_urls_for_manga_ids([identifier]))[identifier] == url
    upstream.assert_not_called()
    assert cache.set_many.call_args.args[0] == {}  # Do not extend the lifetime of old covers.


def test_home_announcements_cannot_hold_up_other_http_requests():
    import httpx
    from fastapi import FastAPI
    from types import SimpleNamespace
    from fastapi_app.routers import admin
    started, release = threading.Event(), threading.Event()
    class DB:
        def __getattr__(self, name):
            if name == "execute":
                def execute():
                    started.set()
                    release.wait(3)
                    return SimpleNamespace(data=[])
                return execute
            return lambda *args, **kwargs: self
    app = FastAPI()
    app.include_router(admin.router, prefix="/admin")
    app.dependency_overrides[admin.get_supabase] = lambda: DB()
    @app.get("/health")
    async def health():
        return {"ok": True}
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            pending = asyncio.create_task(client.get("/admin/announcements/active"))
            try:
                assert await asyncio.to_thread(started.wait, 1)
                assert not pending.done()
                assert (await asyncio.wait_for(client.get("/health"), 0.5)).json() == {"ok": True}
            finally:
                release.set()
                await pending
    asyncio.run(check())


def test_redis_page_write_is_one_pipeline_with_expiry_on_every_key():
    client = MagicMock()
    cache = cache_service._RedisCache(client)
    entries = {f"cover-{i}": str(i) for i in range(96)}
    cache.set_many(entries, ttl=86400)
    client.pipeline.assert_called_once_with(transaction=False)
    pipe = client.pipeline.return_value.__enter__.return_value
    assert pipe.setex.call_count == 96
    assert all(call.args[1] == 86400 for call in pipe.setex.call_args_list)
    pipe.execute.assert_called_once()
    client.setex.assert_not_called()
    client.mget.return_value = ["a", None]
    assert cache.get_many(["one", "two", "one"]) == {"one": "a", "two": None}
    client.mget.assert_called_once_with(["one", "two"])


def test_qq_page_publishes_all_cover_aliases_in_one_nonblocking_batch(monkeypatch):
    owner = threading.get_ident()
    cache = Mock(get=Mock(return_value=None))
    def batch(values, ttl):
        assert threading.get_ident() != owner
        assert len([key for key in values if key.startswith("truyenqq:cover-hint:")]) == 96
        assert len([key for key in values if key.startswith("catalog:qq-sync:v1:")]) == 96
        assert ttl == 86400
    cache.set_many.side_effect = batch
    monkeypatch.setattr(qq, "cache", cache)
    items = [{"id": str(i + 1000), "url": f"https://truyenqqko.com/truyen-tranh/book-{i}-{i + 1000}",
              "title": "Book", "cover_urls": ["https://example.com/cover.jpg"]}
             for i in range(1, 49)]
    async def source(*args, **kwargs):
        return {"items": items}
    monkeypatch.setattr(qq, "run_live", source)
    result = asyncio.run(qq._catalog_page("collection", "latest", 9876))
    assert len(result["data"]["items"]) == 48
    cache.set_many.assert_called_once()


def test_48_ready_chapter_cards_need_three_batch_reads_and_no_single_reads(monkeypatch):
    values = {}
    ids = [f"book-{i}" for i in range(1, 49)]
    for slug in ids:
        values[f"truyenqq:cover-hint:{slug}"] = json.dumps({"card_observed_at": time.time(), "card": {
            "slug": slug, "name": "Book", "category": [], "chaptersLatest": [{
                "chapter_name": "1", "updatedAt": "2026-10-22T12:00:00Z",
                "chapter_api_data": f"qq--{slug}--1"}]}})
    cache = Mock()
    cache.get.side_effect = AssertionError("One Redis round trip per card must not return")
    cache.get_many.side_effect = lambda keys: {key: values.get(key) for key in keys}
    monkeypatch.setattr(card_chapters, "cache", cache)
    result = asyncio.run(card_chapters.get_many(ids))
    assert len(result) == 48
    assert all(row["chapter"]["chapter_name"] == "1" and not row["pending"] for row in result.values())
    assert cache.get_many.call_count == 3


def test_qq_images_reuse_shared_manifest_after_instance_change(monkeypatch):
    values = {}
    cache = Mock()
    cache.get.side_effect = values.get
    cache.set.side_effect = lambda key, value, **kwargs: values.__setitem__(key, value)
    monkeypatch.setattr(qq, "cache", cache)
    calls = []
    async def source(method, *args):
        calls.append((method, args))
        if method == "chapter":
            return {"url": "https://truyenqqko.com/truyen-tranh/book-123-chap-1", "title": "Book",
                    "images": [{"index": 1, "url": "https://example.com/page.jpg",
                                "fallback_urls": ["https://cdn.example/page.jpg"]}], "context": {"unused": True}}
        assert method == "image"
        return b"image", "image/jpeg"
    monkeypatch.setattr(qq, "run_live", source)
    asyncio.run(qq.get_chapter("qq--book-123--1"))
    # A fresh application instance has no scraper chapter cache.
    replacement = Mock(get=Mock(side_effect=dict(values).get))
    monkeypatch.setattr(qq, "cache", replacement)
    assert asyncio.run(qq.get_chapter_image("book-123", "1", 1)) == (b"image", "image/jpeg")
    assert [method for method, _ in calls] == ["chapter", "image"]
    assert calls[-1][1][0] == ["https://example.com/page.jpg", "https://cdn.example/page.jpg"]
    assert "context" not in json.loads(next(iter(values.values())))
