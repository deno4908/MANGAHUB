import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fastapi_app.routers import manga, ratings
from fastapi_app.services import card_metadata, local_popular


class EmptyDB:
    def __getattr__(self, key):
        if key == "execute":
            return lambda: SimpleNamespace(data=[])
        return lambda *args, **kwargs: self


def qq(slug, **extra):
    return {"id": slug, "slug": slug, "source": "truyenqq", "title": slug,
            "cover_url": f"/api/manga/truyenqq/cover/{slug}", "genres": ["Action"], **extra}


def test_qq_popular_paginates_local_counts_before_source_order_and_keeps_alias_views(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {
        "slow-source-1": 4, "top-book-2": 90, "old-top-book": 11, "third-book-3": 3})
    labels = {"slow-source-1": qq("slow-source-1"), "top-book-2": qq("top-book-2"),
              "old-top-book": qq("top-book-2"), "third-book-3": qq("third-book-3")}
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(return_value=labels))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    source = AsyncMock(return_value={"data": {"items": [
        {"slug": "third-book-3"}, {"slug": "unread-book-4"}, {"slug": "top-book-2"}],
        "params": {"pagination": {"totalItems": 4, "totalPages": 1}}}})
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)

    async def run():
        args = dict(limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        first = await local_popular.qq_popular(page=1, **args)
        source.assert_not_awaited()
        second = await local_popular.qq_popular(page=2, **args)
        return first["data"]["items"] + second["data"]["items"]
    rows = asyncio.run(run())
    assert [row["slug"] for row in rows] == ["top-book-2", "slow-source-1", "third-book-3", "unread-book-4"]
    assert [row["views"] for row in rows] == [101, 4, 3, 0]


def test_qq_ranking_preserves_genre_status_hidden_and_mature_filters(monkeypatch):
    labels = {"adult-1": qq("adult-1", genres=["Adult"]),
              "hidden-2": qq("hidden-2"), "ended-3": qq("ended-3", status="completed"),
              "action-4": qq("action-4", status="ongoing")}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: dict.fromkeys(labels, 10))
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(return_value=labels))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", AsyncMock(return_value={"data": {"items": []}}))
    result = asyncio.run(local_popular.qq_popular(page=1, limit=24, genres=["action"], status="ongoing",
                        show_mature=False, hidden={"hidden-2": "hidden"}, db=EmptyDB()))
    assert [row["slug"] for row in result["data"]["items"]] == ["action-4"]


def test_qq_does_not_misrepresent_a_slow_high_ranked_title_as_missing(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"waiting-1": 100})
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(return_value={}))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(local_popular.qq_popular(page=1, limit=24, genres=[], status="", show_mature=True,
                                           hidden={}, db=EmptyDB()))
    assert error.value.status_code == 503


def test_mangadex_popular_endpoint_uses_global_local_ranking_not_upstream_follows(monkeypatch):
    builder = AsyncMock(return_value={"data": {"items": []}})
    monkeypatch.setattr(manga, "_build_mangadex_popular_with_local_views", builder)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_async_attach_local_views_to_mangadex_payload", AsyncMock())
    asyncio.run(manga.mangadex_search(keyword="", page=2, limit=24, genre_slugs="action", translated_language="vi",
                original_language="", status="", sort="popular", show_mature=True, attach_ratings=False,
                filter_hidden=True, user=None, db=EmptyDB()))
    assert builder.await_count == 1
    assert builder.call_args.kwargs["page"] == 2
    assert builder.call_args.kwargs["genre_values"] == ["action"]


def test_cold_mangadex_ranking_does_not_depend_on_the_home_catalog_cache(monkeypatch):
    identifier = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
    class ViewsDB(EmptyDB):
        def execute(self):
            return SimpleNamespace(data=[{"manga_slug": identifier, "views": 83}])
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_canonical_view_slug", AsyncMock(side_effect=lambda slug: slug))
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {identifier: 83})
    monkeypatch.setattr(manga, "_load_trending_snapshots", lambda *args: {})
    monkeypatch.setattr(manga, "_source_revision", lambda *args: "test")
    metadata = AsyncMock(return_value={identifier: {"title": "Cold MangaDex title", "cover_url": "https://uploads.mangadex.org/cover.jpg", "content_rating": "safe"}})
    monkeypatch.setattr(card_metadata, "get_many", metadata)
    result = asyncio.run(manga._compute_trending_from_db(12, ViewsDB(), "mangadex"))
    assert [(row["slug"], row["views"], row["title"]) for row in result] == [(identifier, 83, "Cold MangaDex title")]
    metadata.assert_awaited_once_with([identifier])


def test_ratings_merge_all_saved_mangadex_prefixes():
    identifier = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
    for value in (identifier, "mdx-" + identifier, "mangadex-" + identifier, "mangadex:" + identifier):
        assert ratings._normalize_manga_slug(value) == identifier


def test_mangadex_local_views_order_is_continuous_across_pages(monkeypatch):
    lookup = {f"{index:08x}-1111-4111-8111-111111111111": index for index in range(1, 31)}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: lookup)
    async def resolve(ranked, **kwargs):
        # Source metadata can arrive in a different order from the view ranking.
        return [{"id": identifier, "slug": identifier, "name": identifier} for identifier, views in reversed(ranked)]
    monkeypatch.setattr(manga, "_resolve_local_viewed_mangadex_search_rows_batch", resolve)
    monkeypatch.setattr(manga, "_fetch_mangadex_latest_search_fill", AsyncMock(return_value=([], 30)))
    async def attach(payload, db):
        manga._attach_local_views_to_mangadex_payload(payload, db, views_lookup=lookup)
    monkeypatch.setattr(manga, "_async_attach_local_views_to_mangadex_payload", attach)
    async def run():
        args = dict(keyword="", limit=12, translated_language="vi", genre_values=[], original_language_values=[],
                    status_values=[], content_ratings=["safe"], hidden={}, db=EmptyDB())
        first = await manga._build_mangadex_popular_with_local_views(page=1, **args)
        second = await manga._build_mangadex_popular_with_local_views(page=2, **args)
        return first["data"]["items"] + second["data"]["items"]
    rows = asyncio.run(run())
    assert [row["views"] for row in rows] == list(range(30, 6, -1))
    assert len({row["id"] for row in rows}) == 24


def test_old_mangadex_colon_alias_is_not_counted_twice(monkeypatch):
    identifier = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
    class DB(EmptyDB):
        def execute(self):
            return SimpleNamespace(data=[{"manga_slug": "mangadex:" + identifier, "views": 12},
                                         {"manga_slug": "mdx-" + identifier, "views": 8}])
    monkeypatch.setattr(manga, "_manga_views_lookup_cache", {})
    monkeypatch.setattr(manga, "_manga_views_lookup_cache_at", 0)
    lookup = manga._fetch_local_views_lookup(DB())
    assert manga._local_views_for_mangadex_id(lookup, identifier) == 20


def test_both_sources_remain_in_trending_when_their_titles_are_identical(monkeypatch):
    identifier = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
    rows = [{"manga_slug": slug, "views": views, "manga_title": "Shared source title",
             "manga_thumb": "https://example.com/cover.jpg"} for slug, views in [(identifier, 83), ("qq-book-123", 50)]]
    class DB(EmptyDB):
        def execute(self):
            return SimpleNamespace(data=rows)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_canonical_view_slug", AsyncMock(side_effect=lambda slug: slug))
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {identifier: 83})
    monkeypatch.setattr(manga, "_load_trending_snapshots", lambda *args: {})
    monkeypatch.setattr(manga, "_source_revision", lambda *args: "test")
    monkeypatch.setattr(manga, "_build_otruyen_fallback_trending", AsyncMock(return_value=[]))
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(return_value={identifier: {
        "title": "Shared source title", "cover_url": "https://uploads.mangadex.org/cover.jpg", "content_rating": "safe"}}))
    result = asyncio.run(manga._compute_trending_from_db(2, DB(), "all"))
    assert [(row["slug"], row["views"]) for row in result] == [(identifier, 83), ("qq-book-123", 50)]


def test_popularity_does_not_mark_a_local_upload_as_missing_on_qq(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"own-book": 10})
    monkeypatch.setattr(local_popular, "published_uploads", AsyncMock(return_value={"own-book": {
        "id": "own-book", "slug": "own-book", "source": "uploaded", "title": "Own publication", "cover_url": "/own.jpg"}}))
    external = AsyncMock(side_effect=AssertionError("Local uploads do not use the QQ source"))
    monkeypatch.setattr(card_metadata, "get_many", external)
    remember = []
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: remember.append(values))
    result = asyncio.run(local_popular.qq_popular(page=1, limit=1, genres=[], status="", show_mature=True,
                                               hidden={}, db=EmptyDB()))
    assert result["data"]["items"][0]["source"] == "uploaded"
    assert remember == [{}]
    external.assert_not_awaited()
