import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.responses import Response

from fastapi_app.routers import manga, ratings
from fastapi_app.services import card_metadata, local_popular, qq_rating


@pytest.fixture(autouse=True)
def isolated_popularity_snapshots(monkeypatch):
    original = local_popular.truyenqq_service.get_filtered
    monkeypatch.setattr(local_popular, "_frozen", lambda key, value=None: value)
    monkeypatch.setattr(local_popular, "_cached_source_size", lambda: None)
    monkeypatch.setattr(local_popular, "_remember_source_size", lambda *args: None)
    monkeypatch.setattr(qq_rating, "_read", lambda key: None)
    monkeypatch.setattr(qq_rating, "_save_page", lambda key, value: value)
    monkeypatch.setattr(qq_rating, "_checkpoints", lambda key, page: None)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", AsyncMock(return_value={"data": {"items": []}}))
    return original


class EmptyDB:
    def __getattr__(self, key):
        if key == "execute":
            return lambda: SimpleNamespace(data=[])
        return lambda *args, **kwargs: self


def test_signed_source_retry_replaces_only_its_matching_frozen_page(monkeypatch):
    from fastapi_app.services import truyenqq_recovery as recovery
    from test_catalog_updates import Cache
    import json
    store = Cache()
    monkeypatch.setattr(card_metadata, 'cache', store)
    path = '/tim-kiem-nang-cao/trang-1?sort=2'
    old = {'data': {'source_url': 'https://truyenqqko.com' + path, 'items': [{'slug': 'old-1'}]}}
    new = {'data': {'source_url': 'https://truyenqqko.com' + path, 'items': [{'slug': 'new-2'}]}}
    values = {'fixture:source:1': old, 'fixture:source:2': {'data': {
        'source_url': 'https://truyenqqko.com/tim-kiem-nang-cao/trang-2?sort=2', 'items': [{'slug': 'unrelated-3'}]}}}
    monkeypatch.setattr(local_popular, '_frozen', lambda key, value=None: values.get(key, value))
    source = AsyncMock(return_value=new)
    monkeypatch.setattr(local_popular.truyenqq_service, 'get_filtered', source)
    async def run():
        ctx = recovery.recovered_source.set({'path': path, 'sha256': 'fixture'})
        try:
            assert await local_popular._source_page((), '', 1, 'fixture', 'updated_desc') == new
            assert json.loads(store.values['fixture:source:1']) == new
            assert await local_popular._source_page((), '', 2, 'fixture', 'updated_desc') == values['fixture:source:2']
            source.assert_awaited_once()
        finally:
            recovery.recovered_source.reset(ctx)
    asyncio.run(run())


def test_qq_source_page_starts_while_uncached_cards_are_still_being_resolved(monkeypatch):
    monkeypatch.setattr(manga, '_fetch_local_views_lookup', lambda db: {'rated-1': 10})
    monkeypatch.setattr(local_popular, '_cached_labels', lambda ids: {})
    monkeypatch.setattr(local_popular, 'remember_matches', lambda values: None)
    async def run():
        source_started = asyncio.Event()
        async def source(**kwargs):
            source_started.set()
            return {'data': {'items': [{'slug': 'latest-2'}], 'params': {'pagination': {
                'totalItemsPerPage': 42, 'totalItems': 1, 'totalPages': 1}}}}
        async def metadata(ids, **kwargs):
            await asyncio.wait_for(source_started.wait(), .5)
            return {'rated-1': qq('rated-1')}
        fetch = AsyncMock(side_effect=source)
        monkeypatch.setattr(local_popular.truyenqq_service, 'get_filtered', fetch)
        monkeypatch.setattr(card_metadata, 'get_many', AsyncMock(side_effect=metadata))
        result = await local_popular.qq_popular(page=1, limit=42, genres=[], status='',
                                               show_mature=True, hidden={}, db=EmptyDB())
        assert result['data']['items'][0]['slug'] == 'rated-1'
        fetch.assert_awaited_once()
    asyncio.run(run())


def qq(slug, **extra):
    return {"id": slug, "slug": slug, "source": "truyenqq", "title": slug,
            "cover_url": f"/api/manga/truyenqq/cover/{slug}", "genres": ["Action"], **extra}


@pytest.mark.parametrize("sort", ["latest", "popular", "rating"])
def test_24_title_pages_share_native_pages_without_losing_or_repeating_books(monkeypatch, sort):
    snapshots = {}
    def frozen(key, value=None):
        if value is not None:
            snapshots.setdefault(key, deepcopy(value))
        return deepcopy(snapshots.get(key))
    monkeypatch.setattr(local_popular, "_frozen", frozen)
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {})
    monkeypatch.setattr(ratings, "get_top_rated_manga", AsyncMock(return_value={"items": []}))
    calls = []
    async def listing(**kwargs):
        assert kwargs["sort"] == ("views_desc" if sort == "popular" else "updated_desc")
        assert kwargs["genres"] == ["action"] and kwargs["status"] == "ongoing"
        calls.append(kwargs["page"])
        start = (kwargs["page"] - 1) * 42
        return {"data": {"items": [{"slug": f"book-{index}", "status": "ongoing",
            "category": [{"slug": "action", "name": "Action"}]} for index in range(start, min(start + 42, 100))],
            "params": {"pagination": {"totalItemsPerPage": 42, "totalPages": 3, "totalItems": 100}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    async def run():
        rows = []
        for number in range(1, 6):
            result = (await local_popular.qq_popular(page=number, limit=24, genres=["action"], status="ongoing",
                show_mature=True, hidden={}, db=EmptyDB(), sort=sort))["data"]
            assert len(result["items"]) == (24 if number < 5 else 4)
            assert result["params"]["pagination"]["totalPages"] == 5
            assert result["params"]["pagination"]["totalItemsPerPage"] == 24
            rows.extend(row["slug"] for row in result["items"])
        return rows
    assert asyncio.run(run()) == [f"book-{index}" for index in range(100)]
    assert calls == [1, 2, 3]  # crossing a UI page reuses the same native source snapshot


def test_rated_qq_prefix_fills_to_24_with_latest_and_does_not_forge_views(monkeypatch):
    monkeypatch.setattr(ratings, "get_top_rated_manga", AsyncMock(return_value={"items": [
        {"manga_slug": "book-30", "average": 4.8, "count": 5, "weighted_score": 4.5}]}))
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: pytest.fail("Rating must not load view ranking"))
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {key: qq(key) for key in ids})
    monkeypatch.setattr(local_popular, "remember_matches", lambda value: None)
    async def listing(**kwargs):
        assert kwargs["sort"] == "updated_desc"
        return {"data": {"items": [{"slug": f"book-{index}"} for index in range(42)],
            "params": {"pagination": {"totalItemsPerPage": 42, "totalItems": 42, "totalPages": 1}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    async def run():
        args = dict(limit=24, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB(), sort="rating")
        return [(await local_popular.qq_popular(page=number, **args))["data"]["items"] for number in (1, 2)]
    first, second = asyncio.run(run())
    assert len(first) == 24 and len(second) == 18
    assert first[0]["slug"] == "book-30" and first[0]["rating_average"] == 4.8
    assert first[0]["views"] == 0
    assert [row["slug"] for row in first[1:]] == [f"book-{index}" for index in range(23)]
    assert len({row["slug"] for row in first + second}) == 42


def test_source_filtered_cards_need_no_extra_detail_reads_for_missing_genre_labels(monkeypatch):
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(side_effect=AssertionError("No per-title detail crawl")))
    source = AsyncMock(return_value={"data": {"items": [{"slug": f"book-{index}"} for index in range(42)],
        "params": {"pagination": {"totalItemsPerPage": 42, "totalPages": 1}}}})
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    result = asyncio.run(local_popular.qq_popular(page=1, limit=24, genres=["action"], status="ongoing",
        show_mature=True, hidden={}, db=EmptyDB(), sort="latest"))["data"]
    assert len(result["items"]) == 24
    source.assert_awaited_once()
    assert source.call_args.kwargs["genres"] == ["action"]
    assert source.call_args.kwargs["status"] == "ongoing"


@pytest.mark.parametrize("known_size, expected", [(None, [1, 171, 172]), (42, [171, 172])])
def test_jumping_to_page_300_with_24_titles_does_not_walk_the_catalog(monkeypatch, known_size, expected):
    monkeypatch.setattr(local_popular, "_cached_source_size", lambda: known_size)
    calls = []
    async def listing(**kwargs):
        number = kwargs["page"]
        calls.append(number)
        start = (number - 1) * 42
        return {"data": {"items": [{"slug": f"book-{index}"} for index in range(start, start + 42)],
            "params": {"pagination": {"totalItemsPerPage": 42, "totalPages": 445}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    result = asyncio.run(local_popular.qq_popular(page=300, limit=24, genres=[], status="",
        show_mature=True, hidden={}, db=EmptyDB(), sort="latest"))["data"]
    assert [row["slug"] for row in result["items"]] == [f"book-{index}" for index in range(7176, 7200)]
    assert calls == expected


def test_qq_popular_paginates_local_counts_before_source_order_and_keeps_alias_views(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {
        "slow-source-1": 4, "top-book-2": 90, "old-top-book": 11, "third-book-3": 3})
    labels = {"slow-source-1": qq("slow-source-1"), "top-book-2": qq("top-book-2"),
              "old-top-book": qq("top-book-2"), "third-book-3": qq("third-book-3")}
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: labels.get(identifier) if identifier == "old-top-book" else None)
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(side_effect=lambda ids, **kwargs: {key: labels[key] for key in ids}))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    source = AsyncMock(return_value={"data": {"items": [
        {"slug": "third-book-3"}, {"slug": "unread-book-4"}, {"slug": "top-book-2"}, {"slug": "slow-source-1"}],
        "params": {"pagination": {"totalItems": 4, "totalPages": 1}}}})
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)

    async def run():
        args = dict(limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        first = await local_popular.qq_popular(page=1, **args)
        source.assert_awaited_once()  # also read the authoritative catalog size
        second = await local_popular.qq_popular(page=2, **args)
        return first["data"]["items"] + second["data"]["items"]
    rows = asyncio.run(run())
    assert [row["slug"] for row in rows] == ["top-book-2", "slow-source-1", "third-book-3", "unread-book-4"]
    assert [row["views"] for row in rows] == [101, 4, 3, 0]
    assert source.call_args.kwargs["sort"] == "views_desc"


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


def test_qq_shows_verified_ranking_while_slow_legacy_titles_finish(monkeypatch):
    monkeypatch.setattr(card_metadata, "has_pending_reads", lambda identifiers: bool(list(identifiers)))
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"waiting-1": 100, "ready-2": 50})
    metadata = AsyncMock(side_effect=[{"ready-2": qq("ready-2")},
                                     {"waiting-1": qq("waiting-1"), "ready-2": qq("ready-2")}])
    monkeypatch.setattr(card_metadata, "get_many", metadata)
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    source = AsyncMock(return_value={"data": {"items": [{"slug": "ready-2"}, {"slug": "unread-3"}],
                                              "params": {"pagination": {"totalPages": 1}}}})
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    async def run():
        args = dict(page=1, limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        pending = await local_popular.qq_popular(**args)
        ready = await local_popular.qq_popular(**args)
        return pending["data"], ready["data"]
    pending, ready = asyncio.run(run())
    assert pending["ranking_pending"] is True
    assert [row["slug"] for row in pending["items"]] == ["ready-2", "unread-3"]
    assert [row["views"] for row in ready["items"]] == [100, 50]
    assert not ready.get("ranking_pending")


def test_mangadex_popular_endpoint_uses_global_local_ranking_not_upstream_follows(monkeypatch):
    from fastapi_app.services import mangadex_browse
    builder = AsyncMock(return_value={"data": {"items": []}})
    monkeypatch.setattr(mangadex_browse, "page", builder)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_async_attach_local_views_to_mangadex_payload", AsyncMock())
    asyncio.run(manga.mangadex_search(keyword="", page=2, limit=24, genre_slugs="action", translated_language="vi",
                original_language="", status="", sort="popular", show_mature=True, attach_ratings=False,
                filter_hidden=True, year=None, min_rating=0, feed_snapshot="", user=None, db=EmptyDB()))
    assert builder.await_count == 1
    assert builder.call_args.kwargs["page"] == 2
    assert builder.call_args.kwargs["genres"] == ["action"]
    assert builder.call_args.kwargs["sort"] == "popular"


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


def test_slow_publication_checks_keep_verified_qq_and_do_not_misclassify_uploads(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ready-1": 90, "own-book": 10})
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: qq("ready-1") if identifier == "ready-1" else None)
    publications = AsyncMock(side_effect=HTTPException(503, "Database read pending"))
    monkeypatch.setattr(local_popular, "published_uploads", publications)
    external = AsyncMock(side_effect=AssertionError("Unverified local publications must not be queried on QQ"))
    monkeypatch.setattr(card_metadata, "get_many", external)
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", AsyncMock(return_value={"data": {"items": []}}))
    result = asyncio.run(local_popular.qq_popular(page=1, limit=24, genres=[], status="", show_mature=True,
                                                hidden={}, db=EmptyDB()))["data"]
    assert result["ranking_pending"] is False
    assert [(row["slug"], row["views"]) for row in result["items"]] == [("ready-1", 90)]
    publications.assert_awaited_once()
    assert publications.call_args.args[1] == ["own-book"]
    external.assert_not_awaited()


def test_warm_qq_popularity_does_not_need_an_extra_publication_database_read(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ready-1": 90})
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: qq("ready-1"))
    publications = AsyncMock(side_effect=AssertionError("Verified QQ identity needs no local upload query"))
    monkeypatch.setattr(local_popular, "published_uploads", publications)
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    result = asyncio.run(local_popular.qq_popular(page=1, limit=1, genres=[], status="", show_mature=True,
                                                hidden={}, db=EmptyDB()))["data"]
    assert result["items"][0]["views"] == 90
    assert not result.get("ranking_pending")
    publications.assert_not_awaited()


def test_source_filler_outage_does_not_discard_the_local_popularity_ranking(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ranked-1": 90})
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: qq("ranked-1"))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    source = AsyncMock(side_effect=HTTPException(502, "Temporary source outage"))
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    result = asyncio.run(local_popular.qq_popular(page=1, limit=24, genres=[], status="", show_mature=True,
                                                hidden={}, db=EmptyDB()))["data"]
    assert [(row["slug"], row["views"]) for row in result["items"]] == [("ranked-1", 90)]
    assert result["ranking_pending"] is True
    assert source.call_args.kwargs["sort"] == "views_desc"


def test_partial_qq_ranking_keeps_source_hints_for_browser_recovery(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ranked-1": 90})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {"ranked-1": qq("ranked-1")})
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_fetch_override_rows_by_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    headers = {"X-TruyenQQ-Error": "http-403", "X-TruyenQQ-Source-Path": "/tim-kiem-nang-cao/trang-1?sort=4",
               "Cache-Control": "no-store"}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered",
                        AsyncMock(side_effect=HTTPException(502, "Source rejected request", headers=headers)))
    response = Response()
    result = asyncio.run(manga.otruyen_filtered_manga(genre_slugs="", status="", sort="popular", page=1,
        limit=42, show_mature=True, base_slug="", attach_ratings=False, user=None, db=EmptyDB(), response=response))["data"]
    assert [row["slug"] for row in result["items"]] == ["ranked-1"]
    assert result["ranking_pending"] is True
    assert result["source_error"] == {"status": 502, "code": "http-403"}
    for name, value in headers.items():
        assert response.headers[name] == value


def test_filtered_route_preserves_the_sum_of_verified_legacy_alias_views(monkeypatch):
    lookup = {"old-book": 9, "canonical-123": 4}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: lookup)
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: qq("canonical-123"))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_fetch_override_rows_by_slugs", AsyncMock(return_value={}))
    async def stale_view_attachment(payload, db):
        for item in payload["data"]["items"]:
            item.update(views=0, view_count=0, local_view_count=0)
    attach = AsyncMock(side_effect=stale_view_attachment)
    monkeypatch.setattr(manga, "_async_attach_local_views_to_otruyen_payload", attach)
    payload = asyncio.run(manga.otruyen_filtered_manga(genre_slugs="", status="", sort="popular", page=1,
        limit=1, show_mature=True, base_slug="", attach_ratings=False, user=None, db=EmptyDB()))
    row = payload["data"]["items"][0]
    assert row["slug"] == "canonical-123"
    assert row["views"] == row["view_count"] == row["local_view_count"] == 13
    attach.assert_not_awaited()


def test_unverified_old_aliases_do_not_block_a_full_page_or_trigger_bulk_search(monkeypatch):
    lookup = {"ready-1": 40, "unmapped-old-title": 100}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: lookup)
    monkeypatch.setattr(card_metadata.cache, "get_many", lambda keys: {})
    monkeypatch.setattr(card_metadata, "cached_metadata", lambda identifier, values: qq("ready-1") if identifier == "ready-1" else None)
    external = AsyncMock(side_effect=AssertionError("Browse must not search every old OTruyen title"))
    monkeypatch.setattr(card_metadata, "get_many", external)
    monkeypatch.setattr(local_popular, "published_uploads", AsyncMock(return_value={}))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    source = AsyncMock(return_value={"data": {"items": [{"slug": "ready-1"}] + [{"slug": f"zero-{i}", "views": 99999}
        for i in range(2, 43)], "params": {"pagination": {"totalItems": None,
        "totalItemsPerPage": 42, "totalPages": 100}}}})
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    result = asyncio.run(local_popular.qq_popular(page=1, limit=42, genres=[], status="", show_mature=True,
                                                hidden={}, db=EmptyDB()))["data"]
    assert len(result["items"]) == 42 and not result["ranking_pending"]
    assert [row["views"] for row in result["items"]] == [40] + [0] * 41
    assert result["params"]["pagination"]["totalPages"] == 100
    assert "unmapped-old-title" not in {row["slug"] for row in result["items"]}
    external.assert_not_awaited()
    source.assert_awaited_once()


def test_normal_listing_can_confirm_an_old_slug_before_sorting_the_first_page(monkeypatch):
    labels = {}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"old-book": 70})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: dict(labels))
    monkeypatch.setattr(local_popular, "published_uploads", AsyncMock(return_value={}))
    external = AsyncMock(side_effect=AssertionError("No individual legacy search"))
    monkeypatch.setattr(card_metadata, "get_many", external)
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    async def listing(**kwargs):
        labels["old-book"] = qq("old-book-123")
        return {"data": {"items": [{"slug": "old-book-123"}, {"slug": "zero-2"}],
                         "params": {"pagination": {"totalPages": 1}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    result = asyncio.run(local_popular.qq_popular(page=1, limit=2, genres=[], status="", show_mature=True,
                                                hidden={}, db=EmptyDB()))["data"]
    assert [(row["slug"], row["views"]) for row in result["items"]] == [("old-book-123", 70), ("zero-2", 0)]
    assert not result["ranking_pending"]
    external.assert_not_awaited()


def test_cold_source_refresh_finishes_after_the_bounded_popularity_response(monkeypatch, isolated_popularity_snapshots):
    store = {}
    source = local_popular.truyenqq_service
    monkeypatch.setattr(source, "get_filtered", isolated_popularity_snapshots)
    monkeypatch.setattr(source.cache, "get", store.get)
    monkeypatch.setattr(source.cache, "get_many", lambda keys: {key: store.get(key) for key in keys})
    monkeypatch.setattr(source.cache, "set", lambda key, value, **kw: store.__setitem__(key, value))
    monkeypatch.setattr(source.cache, "set_many", lambda items, **kw: store.update(items))
    monkeypatch.setattr(source, "_catalog_jobs", {})
    monkeypatch.setattr(source, "_overlay_latest", lambda payload, **kwargs: payload)
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ready-1": 50})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {"ready-1": qq("ready-1")})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    monkeypatch.setattr(local_popular, "SOURCE_WAIT_SECONDS", 0.02)
    gate = asyncio.Event()
    started = asyncio.Event()
    async def cold(*args, **kwargs):
        started.set()
        await gate.wait()
        return {"items": [{"id": "1", "url": "https://truyenqqko.com/truyen-tranh/ready-1", "title": "Ready"},
                          {"id": "3", "url": "https://truyenqqko.com/truyen-tranh/filler-3", "title": "Filler"}],
                "page": 1, "total_pages": 1}
    fetch = AsyncMock(side_effect=cold)
    monkeypatch.setattr(source, "run_live", fetch)
    async def run():
        args = dict(page=1, limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        first = (await asyncio.wait_for(local_popular.qq_popular(**args), 0.5))["data"]
        assert first["ranking_pending"] and len(first["items"]) == 1
        await asyncio.wait_for(started.wait(), 0.5)
        assert source._catalog_jobs
        gate.set()
        await asyncio.gather(*list(source._catalog_jobs.values()))
        ready = (await local_popular.qq_popular(**args))["data"]
        assert [(row["slug"], row["views"]) for row in ready["items"]] == [("ready-1", 50), ("filler-3", 0)]
        assert not ready["ranking_pending"]
    asyncio.run(run())
    fetch.assert_awaited_once()


def test_source_updates_do_not_repeat_titles_across_popularity_pages(monkeypatch):
    snapshots = {}
    def frozen(key, value=None):
        if value is not None:
            snapshots.setdefault(key, deepcopy(value))
        return deepcopy(snapshots.get(key))
    monkeypatch.setattr(local_popular, "_frozen", frozen)
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"ready-1": 20})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {"ready-1": qq("ready-1")})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    changed = False
    calls = []
    async def listing(**kwargs):
        calls.append(kwargs["page"])
        items = (["new-insertion-99", "zero-2", "zero-3"] if changed else ["zero-2", "zero-3", "zero-4"]) if kwargs["page"] == 1 else ["zero-5", "zero-6", "ready-1"]
        return {"data": {"items": [{"slug": slug} for slug in items],
                         "params": {"pagination": {"totalItemsPerPage": 3, "totalPages": 2}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    async def run():
        nonlocal changed
        args = dict(limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        first = await local_popular.qq_popular(page=1, **args)
        changed = True
        second = await local_popular.qq_popular(page=2, **args)
        third = await local_popular.qq_popular(page=3, **args)
        return [row for payload in [first, second, third] for row in payload["data"]["items"]]
    rows = asyncio.run(run())
    assert [row["slug"] for row in rows] == ["ready-1", "zero-3", "zero-4", "zero-5", "zero-6", "zero-2"]
    assert [row["views"] for row in rows] == [20, 0, 0, 0, 0, 0]
    assert calls == [1, 2]


@pytest.mark.parametrize("ranked_positions", [[0, 8, 16], [2, 3, 4, 5, 14, 16], []])
def test_slot_swaps_preserve_the_entire_catalog_without_repeats(monkeypatch, ranked_positions):
    catalog = [{"slug": f"book-{i}"} for i in range(17)]
    lookup = {catalog[position]["slug"]: 100 - rank for rank, position in enumerate(ranked_positions)}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: lookup)
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {key: qq(key) for key in ids})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    async def listing(**kwargs):
        start = (kwargs["page"] - 1) * 4
        return {"data": {"items": catalog[start:start + 4], "params": {"pagination": {
            "totalItemsPerPage": 4, "totalItems": 17, "totalPages": 5}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    async def run():
        output = []
        for page in range(1, 6):
            payload = await local_popular.qq_popular(page=page, limit=4, genres=[], status="",
                                                    show_mature=True, hidden={}, db=EmptyDB())
            assert payload["data"]["params"]["pagination"]["totalPages"] == 5
            output.extend(payload["data"]["items"])
        return output
    rows = asyncio.run(run())
    assert len(rows) == len({row["slug"] for row in rows}) == 17
    assert {row["slug"] for row in rows} == {row["slug"] for row in catalog}
    assert [row["views"] for row in rows] == sorted([row["views"] for row in rows], reverse=True)


def test_random_qq_page_reads_only_prefix_and_target_page(monkeypatch):
    lookup = {"book-18000": 90, "book-12000": 50}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: lookup)
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {key: qq(key) for key in ids})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    calls = []
    async def listing(**kwargs):
        number = kwargs["page"]
        calls.append(number)
        return {"data": {"items": [{"slug": f"book-{i}"} for i in range((number-1)*42, number*42)],
                         "params": {"pagination": {"totalItemsPerPage": 42, "totalPages": 445}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    result = asyncio.run(local_popular.qq_popular(page=300, limit=42, genres=[], status="",
                        show_mature=True, hidden={}, db=EmptyDB()))["data"]
    assert calls == [1, 300]
    assert len(result["items"]) == 42
    assert result["items"][0]["slug"] == f"book-{299*42}"
    assert result["params"]["pagination"]["totalPages"] == 445
    assert not result["ranking_pending"]


def test_failed_native_metadata_does_not_leave_a_completed_page_polling_forever(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"unreachable-123": 100})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda identifiers: {})
    monkeypatch.setattr(local_popular, "published_uploads", AsyncMock(return_value={}))
    monkeypatch.setattr(card_metadata, "get_many", AsyncMock(return_value={}))
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", AsyncMock(return_value={"data": {
        "items": [{"slug": f"book-{i}"} for i in range(42)],
        "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}))
    payload = asyncio.run(local_popular.qq_popular(page=2, limit=42, genres=[], status="",
                                                 show_mature=True, hidden={}, db=EmptyDB()))["data"]
    assert len(payload["items"]) == 42
    assert payload["ranking_pending"] is False


def test_view_count_changes_do_not_restart_the_source_snapshot(monkeypatch):
    lookup = {"ready-1": 50}
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: dict(lookup))
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {"ready-1": qq("ready-1")})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    keys = []
    async def source(genres, status, number, snapshot_key):
        keys.append(snapshot_key)
        return {"data": {"items": [{"slug": "ready-1"}, {"slug": "zero-2"}],
                         "params": {"pagination": {"totalPages": 1, "totalItemsPerPage": 2}}}}
    monkeypatch.setattr(local_popular, "_source_page", source)
    async def run():
        args = dict(page=1, limit=2, genres=[], status="", show_mature=True, hidden={}, db=EmptyDB())
        await local_popular.qq_popular(**args)
        lookup["ready-1"] += 1
        await local_popular.qq_popular(**args)
    asyncio.run(run())
    assert len(set(keys)) == 1


def test_page_two_waits_for_a_normal_cold_read_instead_of_returning_empty_pending(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {})
    async def listing(**kwargs):
        if kwargs["page"] == 2:
            await asyncio.sleep(1.6)  # a healthy read exceeded the former 1.5s cutoff
        return {"data": {"items": [{"slug": f"book-{kwargs['page']}-{i}"} for i in range(42)],
                         "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}
    source = AsyncMock(side_effect=listing)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    async def run():
        return await asyncio.wait_for(local_popular.qq_popular(page=2, limit=42, genres=[], status="",
                         show_mature=True, hidden={}, db=EmptyDB()), 3)
    result = asyncio.run(run())["data"]
    assert len(result["items"]) == 42
    assert result["ranking_pending"] is False
    assert [call.kwargs["page"] for call in source.await_args_list] == [1, 2]


def test_cold_header_and_page_two_are_loaded_concurrently(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {})
    started = set()
    both_started = asyncio.Event()
    async def listing(**kwargs):
        started.add(kwargs["page"])
        if started == {1, 2}:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), 0.5)
        return {"data": {"items": [{"slug": f"book-{kwargs['page']}-{i}"} for i in range(42)],
                         "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    result = asyncio.run(local_popular.qq_popular(page=2, limit=42, genres=[], status="",
                         show_mature=True, hidden={}, db=EmptyDB()))["data"]
    assert len(result["items"]) == 42 and not result["ranking_pending"]


@pytest.mark.parametrize("page", [3, 4, 37, 445])
def test_later_pages_use_the_native_qq_popularity_order(monkeypatch, page):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {"promoted-17000": 99})
    monkeypatch.setattr(local_popular, "_cached_labels", lambda ids: {"promoted-17000": qq("promoted-17000")})
    monkeypatch.setattr(local_popular, "remember_matches", lambda values: None)
    async def listing(**kwargs):
        assert kwargs["sort"] == "views_desc"
        assert kwargs["overlay_latest"] is False
        number = kwargs["page"]
        return {"data": {"items": [{"slug": f"qq-popular-{number}-{index}"} for index in range(42)],
                         "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}
    source = AsyncMock(side_effect=listing)
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", source)
    result = asyncio.run(local_popular.qq_popular(page=page, limit=42, genres=[], status="",
                         show_mature=True, hidden={}, db=EmptyDB()))["data"]
    assert [row["slug"] for row in result["items"]] == [f"qq-popular-{page}-{i}" for i in range(42)]
    assert result["ranking_pending"] is False
    assert [call.kwargs["page"] for call in source.await_args_list] == [1, page]


def test_later_source_failure_is_an_http_error_not_a_false_pending_ranking(monkeypatch):
    monkeypatch.setattr(manga, "_fetch_local_views_lookup", lambda db: {})
    async def listing(**kwargs):
        if kwargs["page"] == 3:
            raise HTTPException(503, "Source unavailable", headers={"X-TruyenQQ-Error": "http-503"})
        return {"data": {"items": [{"slug": f"book-{i}"} for i in range(42)],
                         "params": {"pagination": {"totalPages": 445, "totalItemsPerPage": 42}}}}
    monkeypatch.setattr(local_popular.truyenqq_service, "get_filtered", listing)
    with pytest.raises(HTTPException) as error:
        asyncio.run(local_popular.qq_popular(page=3, limit=42, genres=[], status="",
                    show_mature=True, hidden={}, db=EmptyDB()))
    assert error.value.status_code == 503
    assert error.value.headers["X-TruyenQQ-Error"] == "http-503"
