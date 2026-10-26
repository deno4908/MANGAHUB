import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
import time
import threading
from unittest.mock import AsyncMock

import httpx
import pytest

from fastapi_app import dependencies
from fastapi_app.routers import ratings
from fastapi_app.routers import manga
from fastapi_app.services import supabase_client, truyenqq_service as qq

ID = "c4ca02fb-8378-433b-8049-fbbea5d25cba"


class RatingDB:
    def __init__(self):
        self.calls, self.score, self.fail = 0, 5, False

    def table(self, name):
        db = self
        class Query:
            value = None
            def delete(self): self.value = {}; return self
            def __getattr__(self, method):
                if method == "execute":
                    def execute():
                        if self.value is not None:
                            if self.value: db.score = self.value["score"]
                            return SimpleNamespace(data=[])
                        db.calls += 1
                        if db.fail: raise OSError("temporary database failure")
                        time.sleep(0.02)
                        return SimpleNamespace(data=[{"manga_slug": ID, "user_id": "test-reader",
                            "score": db.score, "updated_at": "2026-10-26T00:00:00Z"}])
                    return execute
                if method == "upsert":
                    def upsert(value, **kwargs): self.value = value; return self
                    return upsert
                return lambda *args, **kwargs: self
        return Query()


@pytest.fixture(autouse=True)
def isolated_aggregate_cache():
    ratings._invalidate_aggregates()
    yield
    ratings._invalidate_aggregates()


def test_a_list_rating_warms_detail_without_another_database_query():
    db = RatingDB()
    async def run():
        batch = await ratings.get_batch_ratings(ratings.BatchRatingsRequest(manga_slugs=[ID]), user=None, db=db)
        single = await ratings.get_manga_rating(ID, db=db)
        assert batch["ratings"][ID] == {"average": single["average"], "count": single["count"]}
        assert single["average"] == 5 and single["count"] == 1
    asyncio.run(run())
    assert db.calls == 1


def test_simultaneous_rating_reads_share_work_and_writes_refresh_the_complete_aggregate(monkeypatch):
    db = RatingDB()
    monkeypatch.setattr(ratings, "enforce_user_action_limit", lambda *args, **kwargs: None)
    async def run():
        values = await asyncio.gather(*(ratings.get_manga_rating(ID, db=db) for _ in range(12)))
        assert all(value["average"] == 5 for value in values)
        assert db.calls == 1
        await ratings.rate_manga(None, ratings.RateRequest(manga_slug=ID, score=4), user={"id": "test-reader"}, db=db)
        assert (await ratings.get_manga_rating(ID, db=db))["average"] == 4
        assert db.calls == 2
    asyncio.run(run())


def test_rating_cache_expires_and_does_not_cache_a_database_failure(monkeypatch):
    db = RatingDB()
    clock = [100.0]
    # Override only the cache's time source, not asyncio's clock.
    monkeypatch.setattr(ratings, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    async def run():
        db.fail = True
        assert (await ratings.get_manga_rating(ID, db=db))["count"] == 0
        db.fail = False
        assert (await ratings.get_manga_rating(ID, db=db))["average"] == 5
        db.score = 2
        clock[0] += 11
        assert (await ratings.get_manga_rating(ID, db=db))["average"] == 2
        assert db.calls == 3
    asyncio.run(run())


def test_native_qq_routes_do_not_probe_legacy_aliases(monkeypatch):
    monkeypatch.setattr(qq.cache, "get", Mock(side_effect=AssertionError("Native QQ ID needs no alias lookups")))
    slug = "maigo-ni-natteita-youjo-15729"
    assert qq._cached_detail_identifier(slug) == slug


def test_cold_concurrent_requests_initialize_each_database_pool_once(monkeypatch):
    calls = []
    def factory(url, key):
        calls.append(key)
        time.sleep(0.02)
        return SimpleNamespace(postgrest=object())
    monkeypatch.setattr(dependencies, "_supabase_admin", None)
    monkeypatch.setattr(dependencies, "_supabase_anon", None)
    monkeypatch.setattr(dependencies, "create_client", factory)
    monkeypatch.setattr(dependencies.config, "SUPABASE_URL", "https://test.example")
    monkeypatch.setattr(dependencies.config, "SUPABASE_SERVICE_KEY", "test-service-key")
    monkeypatch.setattr(dependencies.config, "SUPABASE_KEY", "test-public-key")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: dependencies._init_clients(), range(8)))
    assert calls == ["test-service-key", "test-public-key"]


def test_database_transport_preserves_tls_schema_timeouts_and_credential_isolation(monkeypatch):
    original = httpx.Client
    options, requests = [], []
    def wire(request):
        requests.append(request)
        return httpx.Response(200, json=[])
    def session(*args, **kwargs):
        options.append(kwargs.copy())
        return original(*args, **kwargs, transport=httpx.MockTransport(wire))
    monkeypatch.setattr(supabase_client.httpx, "Client", session)
    for key in ["test-public-key", "test-service-key"]:
        db = supabase_client._DatabaseClient("https://test.example/rest/v1", headers={
            "apikey": key, "Authorization": "Bearer " + key}, schema="public", timeout=17)
        db.table("ratings").select("score").execute()
        db.session.close()
    assert all(option["verify"] is True and option["http2"] is False and option["timeout"] == 17 for option in options)
    assert [request.headers["authorization"] for request in requests] == ["Bearer test-public-key", "Bearer test-service-key"]
    assert all(request.headers["accept-profile"] == "public" for request in requests)


def test_qq_detail_fetches_independent_metadata_together_without_losing_fields(monkeypatch):
    started, gate, lock = set(), threading.Event(), threading.Lock()
    def arrive(name):
        with lock:
            started.add(name)
            if len(started) == 4: gate.set()
    slug = "complete-book-12345"
    chapter = "qq--complete-book-12345--1"
    rows = {"manga_views": [{"manga_slug": slug, "views": 9}],
            "chapter_first_seen": [{"chapter_id": chapter, "first_seen_at": "2026-10-01T00:00:00Z"}],
            "chapter_uploads": [{"chapter_number": "1", "published_at": "2026-10-02T00:00:00Z"}]}
    class DB:
        def table(self, name):
            class Query:
                def __getattr__(self, method):
                    if method == "execute":
                        def execute():
                            if name == "manga_uploads": return SimpleNamespace(data=None)
                            arrive(name)
                            assert gate.wait(3), "All metadata reads must start before any finishes"
                            return SimpleNamespace(data=rows[name])
                        return execute
                    return lambda *args, **kwargs: self
            return Query()
    async def overrides(*args):
        arrive("overrides")
        assert await asyncio.to_thread(gate.wait, 3)
        return {slug: {"is_featured": True, "admin_notes": "Keep this field"}}
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_fetch_override_rows_by_slugs", overrides)
    monkeypatch.setattr(qq, "get_manga_detail", AsyncMock(return_value={"data": {"item": {
        "source": "truyenqq", "slug": slug, "name": "Complete book", "content": "Full description",
        "chapters": [{"server_name": "QQ", "server_data": [{"chapter_name": "1",
            "chapter_api_data": "/api/manga/chapter/" + chapter}]}]}}}))
    result = asyncio.run(manga.manga_detail(slug, db=DB()))["data"]["item"]
    assert started == {"manga_views", "chapter_first_seen", "chapter_uploads", "overrides"}
    assert result["view_count"] == 9 and result["is_featured"] is True
    assert result["admin_notes"] == "Keep this field" and result["content"] == "Full description"
    ch = result["chapters"][0]["server_data"][0]
    assert ch["first_seen_at"] == "2026-10-01T00:00:00Z"
    assert ch["local_published_at"] == result["local_last_published_at"] == "2026-10-02T00:00:00Z"
