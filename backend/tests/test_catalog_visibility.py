import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fastapi_app.routers import manga
from fastapi_app.services import catalog_visibility as visibility, card_metadata, truyenqq_service as qq


@pytest.fixture
def memory(monkeypatch):
    values = {}
    monkeypatch.setattr(visibility.cache, "get", values.get)
    monkeypatch.setattr(visibility.cache, "get_many", lambda keys: {key: values.get(key) for key in keys})
    monkeypatch.setattr(visibility.cache, "set_many", lambda entries, **kw: values.update(entries))
    return values


def test_only_confirmed_legacy_misses_are_hidden_and_a_native_match_restores_them(memory):
    missing, matched, pending = "old-unmatched", "old-matched", "old-pending"
    visibility.remember_matches({missing: None, matched: {"title": "Matched"}})
    assert visibility.unmatched([missing, matched, pending, "book-123"]) == {missing}
    rows = [{"slug": slug, "title": "Title", "views": 83} for slug in [missing, matched, pending]]
    assert [row["slug"] for row in manga._filter_trending_items(rows)] == [matched, pending]
    assert rows[0]["views"] == 83
    qq._item({"id": "123", "url": "https://truyenqqko.com/truyen-tranh/old-unmatched-123", "title": "Recovered"})
    assert visibility.unmatched([missing]) == set()
    assert manga._filter_trending_items(rows)[0]["views"] == 83


def test_transport_errors_never_mark_a_title_as_missing(memory, monkeypatch):
    async def check():
        for status in (502, 503):
            monkeypatch.setattr(qq, "run_live", AsyncMock(side_effect=HTTPException(status, "Source unavailable")))
            found = await card_metadata.get_many(["old-transient"])
            visibility.remember_matches(found)
            assert "old-transient" not in found
            assert visibility.unmatched(["old-transient"]) == set()
        monkeypatch.setattr(qq, "run_live", AsyncMock(side_effect=HTTPException(404, "Missing")))
        found = await card_metadata.get_many(["old-missing"])
        visibility.remember_matches(found)
        assert found == {"old-missing": None}
        assert visibility.unmatched(["old-missing"]) == {"old-missing"}
        source = AsyncMock(side_effect=AssertionError("Known missing titles must not crawl again"))
        monkeypatch.setattr(qq, "run_live", source)
        assert await card_metadata.get_many(["old-missing"]) == {"old-missing": None}
        source.assert_not_awaited()
    asyncio.run(check())


class UploadDB:
    def __init__(self, rows):
        self.rows = rows
    def table(self, name):
        assert name == "manga_uploads"
        return self
    def select(self, fields):
        return self
    def in_(self, field, identifiers):
        return self
    def eq(self, field, value):
        assert (field, value) == ("status", "published")
        return self
    def execute(self):
        return SimpleNamespace(data=self.rows)


def test_local_publications_are_preserved_without_external_requests(memory, monkeypatch):
    from fastapi_app.services import public_reads
    public_reads._values.clear()
    db = UploadDB([{"manga_slug": "own-local-book", "title": "Own book", "genres": []}])
    source = AsyncMock(side_effect=AssertionError("Do not search QQ for a local upload"))
    monkeypatch.setattr(card_metadata, "get_many", source)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    async def check():
        result = await manga.card_metadata_batch(manga.CardMetadataRequest(identifiers=["own-local-book"]), db)
        assert result["items"]["own-local-book"]["source"] == "uploaded"
        assert visibility.unmatched(["own-local-book"]) == set()
    # get_many([]) is intentionally harmless; assert only that no local ID is passed.
    source.side_effect = None
    source.return_value = {}
    asyncio.run(check())
    source.assert_awaited_once_with([])


def test_database_failure_keeps_sync_state_unknown(memory):
    from fastapi_app.services import public_reads
    public_reads._values.clear()
    async def check():
        with pytest.raises(HTTPException) as exc:
            await visibility.published_uploads(object(), ["local-or-legacy"])
        assert exc.value.status_code == 503
        assert visibility.unmatched(["local-or-legacy"]) == set()
    asyncio.run(check())


def test_top_ratings_hide_unmatched_books_without_deleting_scores(memory):
    from fastapi_app.routers.ratings import get_top_rated_manga
    rows = [{"user_id": "reader", "manga_slug": slug, "score": 5, "updated_at": "2026-10-21"}
            for slug in ["old-missing", "old-matched"]]
    class RatingsDB:
        def table(self, name):
            assert name == "ratings"
            return self
        def select(self, *args):
            return self
        def order(self, *args, **kwargs):
            return self
        def limit(self, *args):
            return self
        def execute(self):
            return SimpleNamespace(data=rows)
    visibility.remember_matches({"old-missing": None})
    result = asyncio.run(get_top_rated_manga(limit=24, db=RatingsDB()))
    assert [item["manga_slug"] for item in result["items"]] == ["old-matched"]
    assert result["items"][0]["average"] == 5
    assert len(rows) == 2 and rows[0]["score"] == 5
