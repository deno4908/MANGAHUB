import asyncio
import json
import threading
import time
from unittest.mock import MagicMock, Mock

from fastapi_app.services import cache_service, card_chapters, mangadex_service as mdx, truyenqq_service as qq
from fastapi_app.services.request_coalescing import coalesce_reads


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
        assert len(values) == 96 and ttl == 86400
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
                "chapter_name": "1", "chapter_api_data": f"qq--{slug}--1"}]}})
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
