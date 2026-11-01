import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException

from fastapi_app.routers import manga


class EmptyDB:
    def __getattr__(self, name):
        if name == "execute":
            return lambda: SimpleNamespace(data=[], count=0)
        return lambda *args, **kwargs: self


def page(items, total, size=24, pages=None):
    pagination = {"totalItems": total, "totalItemsPerPage": size, "currentPage": 1}
    if pages is not None:
        pagination["totalPages"] = pages
    return {"data": {"items": items, "params": {"pagination": pagination}}}


def isolate(monkeypatch):
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_async_attach_local_views_to_mangadex_payload", AsyncMock())
    monkeypatch.setattr(manga, "_attach_overrides_to_otruyen_payload", AsyncMock())
    monkeypatch.setattr(manga, "_async_attach_ratings_to_items", AsyncMock())


def test_latest_search_uses_the_shared_eligible_catalog_with_filters(monkeypatch):
    from fastapi_app.services import mangadex_browse
    isolate(monkeypatch)
    expected = page([{"slug": "first"}, {"slug": "second"}], 2400)
    source = AsyncMock(return_value=expected)
    monkeypatch.setattr(mangadex_browse, "page", source)
    monkeypatch.setattr(manga, "_build_mangadex_popular_filtered_search", AsyncMock(side_effect=AssertionError("No candidate crawl")))
    result = asyncio.run(manga.mangadex_search(keyword="one piece", page=8, limit=24,
        genre_slugs="action", translated_language="vi", original_language="ja", status="ongoing",
        sort="latest", show_mature=False, attach_ratings=False, filter_hidden=True,
        year=None, min_rating=0, feed_snapshot="", user=None, db=EmptyDB()))
    assert result["data"]["items"] == expected["data"]["items"]
    assert source.await_count == 1
    assert source.call_args.kwargs["page"] == 8
    assert source.call_args.kwargs["keyword"] == "one piece"
    assert source.call_args.kwargs["genres"] == ["action"]
    assert source.call_args.kwargs["original_languages"] == ["ja"]


def test_combined_search_pagination_advances_each_source_page(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga.truyenqq_service, "search_manga", AsyncMock(return_value=page(
        [{"slug": "qq-1"}, {"slug": "qq-2"}], None, size=2, pages=1)))
    monkeypatch.setattr(manga.mangadex_service, "search_manga", AsyncMock(return_value=page(
        [{"slug": f"mdx-{i}"} for i in range(24)], 2400)))
    result = asyncio.run(manga.search(keyword="one piece", page=1, include_mangadex=True, attach_ratings=False,
        mangadex_limit=24, mangadex_timeout_ms=0, mangadex_translated_language="vi", mangadex_attach_latest=False,
        user=None, db=EmptyDB()))
    assert len(result["data"]["items"]) == 26
    assert result["data"]["params"]["pagination"]["totalPages"] == 100


def test_home_can_render_latest_when_the_other_section_fails(monkeypatch):
    isolate(monkeypatch)
    async def listing(kind, number):
        if kind == "dang-phat-hanh":
            raise RuntimeError("source temporarily unavailable")
        return page([{"slug": "available-123"}], 1)
    monkeypatch.setattr(manga.truyenqq_service, "get_list", listing)
    result = asyncio.run(manga.homepage(include_featured=False, user=None, db=EmptyDB()))
    assert result["latest"]["data"]["items"][0]["slug"] == "available-123"
    assert result["ongoing"]["data"]["items"] == []
    assert result["meta"]["unavailable_sections"] == ["ongoing"]


@pytest.mark.parametrize('attach_ratings', [False, True])
def test_home_allows_deferred_ratings_without_changing_catalog_or_default_enrichment(monkeypatch, attach_ratings):
    isolate(monkeypatch)
    monkeypatch.setattr(manga.truyenqq_service, 'get_list', AsyncMock(return_value=page([{'slug': 'ready-123'}], 1)))
    result = asyncio.run(manga.homepage(include_featured=False, attach_ratings=attach_ratings, user=None, db=EmptyDB()))
    assert result['latest']['data']['items'][0]['slug'] == 'ready-123'
    assert manga._async_attach_ratings_to_items.await_count == int(attach_ratings)
    manga._attach_overrides_to_otruyen_payload.assert_awaited_once()


@pytest.mark.parametrize('attach_ratings', [False, True])
def test_home_banner_defers_ratings_but_keeps_hidden_filter_and_local_views(monkeypatch, attach_ratings):
    isolate(monkeypatch)
    hidden_id = '11111111-1111-4111-8111-111111111111'
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={hidden_id: 'hidden'}))
    source = AsyncMock(return_value=page([{'slug': hidden_id}, {'slug': 'visible'}], 2))
    monkeypatch.setattr(manga.mangadex_service, 'get_latest_vi_chapter_feed', source)
    result = asyncio.run(manga.mangadex_home_banner(limit=24, show_mature=False, filter_hidden=True,
        attach_ratings=attach_ratings, user=None, db=EmptyDB()))
    assert result['data']['items'] == [{'slug': 'visible'}]
    assert source.call_args.kwargs['excluded_manga_ids'] == [hidden_id]
    assert source.call_args.kwargs['content_ratings'] == ['safe', 'suggestive']
    manga._async_attach_local_views_to_mangadex_payload.assert_awaited_once()
    assert manga._async_attach_ratings_to_items.await_count == int(attach_ratings)


def test_search_outage_is_not_reported_as_no_matching_books(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga.truyenqq_service, "search_manga", AsyncMock(side_effect=RuntimeError("source offline")))
    monkeypatch.setattr(manga.mangadex_service, "search_manga", AsyncMock(side_effect=RuntimeError("source offline")))
    with pytest.raises(HTTPException) as error:
        asyncio.run(manga.search(keyword="one piece", page=1, include_mangadex=True, attach_ratings=False,
            mangadex_limit=24, mangadex_timeout_ms=0, mangadex_translated_language="vi", mangadex_attach_latest=False,
            user=None, db=EmptyDB()))
    assert error.value.status_code == 503


def test_partial_combined_search_preserves_qq_recovery_instructions(monkeypatch):
    from fastapi.responses import Response
    isolate(monkeypatch)
    hints = {'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/frontend/search/search',
             'X-TruyenQQ-Search': 'one%20piece'}
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(side_effect=HTTPException(502, 'blocked', headers=hints)))
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', AsyncMock(return_value=page([{'slug': 'mdx-1'}], 1)))
    response = Response()
    result = asyncio.run(manga.search(keyword='one piece', page=1, include_mangadex=True, attach_ratings=False,
        mangadex_limit=24, mangadex_timeout_ms=0, mangadex_translated_language='vi', mangadex_attach_latest=False,
        user=None, db=EmptyDB(), response=response))
    assert result['data']['items'][0]['slug'] == 'mdx-1'
    assert result['meta']['unavailable_sources'] == ['truyenqq']
    assert response.headers['X-TruyenQQ-Source-Path'] == '/frontend/search/search'
    assert response.headers['X-TruyenQQ-Search'] == 'one%20piece'
