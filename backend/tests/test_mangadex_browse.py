import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from fastapi_app.services import mangadex_browse as browse, cache_service

ID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(browse, "_local_stats", None)
    monkeypatch.setattr(browse, "_local_until", 0)
    monkeypatch.setattr(cache_service, "cache", Mock(get=Mock(return_value=None)))


def test_statistics_page_all_rows_and_merge_aliases_per_user():
    data = {
        "manga_views": [{"manga_slug": ID, "views": 10}, {"manga_slug": "mdx-" + ID, "views": 7}],
        "ratings": [{"manga_slug": ID, "user_id": "u1", "score": 1, "updated_at": "2026-01-01"},
                    {"manga_slug": "mdx-" + ID, "user_id": "u1", "score": 5, "updated_at": "2026-01-02"}]
                   + [{"manga_slug": ID, "user_id": f"other-{n}", "score": 4, "updated_at": "2026-01-02"}
                      for n in range(1201)],
    }
    requests = []

    class Query:
        def __init__(self, table): self.table, self.bounds = table, (0, 499)
        def select(self, fields): return self
        def order(self, field):
            assert field in {"manga_slug", "user_id"}  # ratings has no id column
            return self
        def range(self, start, end): self.bounds = start, end; return self
        def execute(self):
            start, end = self.bounds
            requests.append((self.table, start))
            return SimpleNamespace(data=data[self.table][start:end + 1])

    result = browse._read_statistics(SimpleNamespace(table=Query))
    assert result[ID] == {"views": 17, "rating_average": 4.0, "rating_count": 1202}
    assert sorted(requests) == [("manga_views", 0), ("ratings", 0), ("ratings", 500), ("ratings", 1000)]


def test_concurrent_statistics_share_one_database_read_and_use_shared_cache(monkeypatch):
    calls = []
    def read(db):
        calls.append(db)
        time.sleep(.02)
        return {ID: {"views": 10}}
    monkeypatch.setattr(browse, "_read_statistics", read)
    async def run():
        return await asyncio.gather(*(browse.statistics("db") for _ in range(8)))
    values = asyncio.run(run())
    assert len(calls) == 1
    assert all(v == {ID: {"views": 10}} for v in values)
    cache_service.cache.set.assert_called_once()
    saved = cache_service.cache.set.call_args.args[1]
    monkeypatch.setattr(browse, "_local_stats", None)
    monkeypatch.setattr(browse, "_local_until", 0)
    cache_service.cache.get.return_value = saved
    assert asyncio.run(browse.statistics("other-worker")) == values[0]
    assert len(calls) == 1


def test_database_outage_uses_previous_statistics_and_never_fakes_zero_ratings(monkeypatch):
    monkeypatch.setattr(browse, "_read_statistics", Mock(side_effect=RuntimeError("unavailable")))
    with pytest.raises(RuntimeError, match="temporarily unavailable"):
        asyncio.run(browse.statistics(None))
    saved = {"checked": 0, "items": {ID: {"rating_average": 4.5, "rating_count": 2}}}
    cache_service.cache.get.return_value = json.dumps(saved)
    assert asyncio.run(browse.statistics(None)) == saved["items"]


def test_stale_statistics_return_while_one_tracked_refresh_runs(monkeypatch):
    import threading
    entered, release = threading.Event(), threading.Event()
    previous = {ID: {"views": 10, "rating_average": 4}}
    newer = {ID: {"views": 11, "rating_average": 4.5}}
    cache_service.cache.get.return_value = json.dumps({"checked": 0, "items": previous})
    calls = []
    def read(db):
        calls.append(db)
        entered.set()
        assert release.wait(2)
        return newer
    monkeypatch.setattr(browse, "_read_statistics", read)
    async def check():
        try:
            assert await asyncio.wait_for(browse.statistics("db"), 1) == previous
            assert await asyncio.to_thread(entered.wait, 1)
            monkeypatch.setattr(browse, "_local_until", 0)
            values = await asyncio.gather(*(browse.statistics("db") for _ in range(8)))
            assert values == [previous] * 8
            assert len(calls) == 1
        finally:
            release.set()
        await asyncio.gather(*list(browse._refresh_tasks.values()))
        assert await browse.statistics("db") == newer
    asyncio.run(check())


@pytest.mark.parametrize("sort", ["latest", "popular", "rating", "alphabetical"])
def test_browse_http_contract_forwards_all_filters_before_pagination(monkeypatch, sort):
    from fastapi_app.routers import manga
    source = AsyncMock(return_value={"data": {"items": [], "params": {"pagination": {"totalItems": 0}}}})
    monkeypatch.setattr(browse, "page", source)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={"mdx-" + ID: "hidden"}))
    result = asyncio.run(manga.mangadex_browse(page=3, limit=24, sort=sort, genre_slugs="action,romance",
        status="ongoing", keyword="book", translated_language="vi", year=2025, min_rating=4,
        show_mature=False, filter_hidden=True, feed_snapshot="f" * 32, db="db"))
    assert result["data"]["items"] == []
    source.assert_awaited_once_with(db="db", page=3, limit=24, sort=sort,
        genres=["action", "romance"], statuses=["ongoing"], keyword="book", year=2025,
        min_rating=4, ratings=["safe", "suggestive"], excluded=[ID], feed_snapshot="f" * 32)
