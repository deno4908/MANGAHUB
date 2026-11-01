import asyncio
import json
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException

from fastapi_app.routers import manga
from fastapi_app.services import mangadex_service as mdx

MANGA = "11111111-1111-4111-8111-111111111111"
COVER = f"https://uploads.mangadex.org/covers/{MANGA}/cover.jpg.512.jpg"


@pytest.fixture
def stored(monkeypatch):
    values = {}
    cache = Mock()
    cache.get.side_effect = values.get
    cache.get_many.side_effect = lambda keys: {key: values.get(key) for key in keys}
    cache.set.side_effect = lambda key, value, **kwargs: values.__setitem__(key, value)
    cache.set_many.side_effect = lambda rows, **kwargs: values.update(rows)
    monkeypatch.setattr(mdx, "cache", cache)
    monkeypatch.setattr(mdx, "_get_cached_vi_catalog_manga", lambda _: None)
    return values, cache


@pytest.mark.parametrize("source", ["url", "stale", "card", "metadata", "lookup", "catalog"])
def test_cover_uses_existing_urls_without_contacting_a_down_source(stored, monkeypatch, source):
    values, _ = stored
    if source in {"url", "stale"}:
        values[f"mangadex:cover-url:v2:{MANGA}" + (":stale" if source == "stale" else "")] = COVER
    elif source == "card":
        values[f"catalog:card-metadata:v1:{MANGA}"] = json.dumps({"cover_url": COVER})
    elif source == "metadata":
        values[f"mangadex:metadata:{MANGA}:rev=:stale"] = json.dumps({"data": {"relationships": [{"type": "cover_art", "attributes": {"fileName": "cover.jpg"}}]}})
    elif source == "lookup":
        values[f"mangadex:lookup:{MANGA}:rev=:stale"] = json.dumps({"manga": {"cover_url": COVER}})
    else:
        monkeypatch.setattr(mdx, "_get_cached_vi_catalog_manga", lambda _: {"cover_url": COVER})
    upstream = AsyncMock(side_effect=RuntimeError("source down"))
    monkeypatch.setattr(mdx, "_request_json", upstream)
    response = asyncio.run(manga.mangadex_cover(MANGA))
    assert response.status_code == 302
    target = urlparse(response.headers["location"])
    assert target.path == "/api/images/img"
    assert parse_qs(target.query)["url"] == [COVER]
    upstream.assert_not_called()


def test_cover_outage_is_not_reported_or_cached_as_missing(stored, monkeypatch):
    values, cache = stored
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(side_effect=mdx._MangaDexStatusError("private source detail", status_code=503)))
    response = asyncio.run(manga.mangadex_cover(MANGA))
    assert response.status_code == 503
    assert json.loads(response.body)["code"] == "MANGADEX_UNAVAILABLE"
    assert b"private source" not in response.body
    assert response.headers["retry-after"] == "30"
    cache.set.assert_not_called()
    assert not values


def test_true_missing_cover_is_still_404(stored, monkeypatch):
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(return_value={"data": {"relationships": []}}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(manga.mangadex_cover(MANGA))
    assert error.value.status_code == 404


def test_successful_cover_is_kept_for_the_next_outage_and_parallel_reads_share_work(stored, monkeypatch):
    values, cache = stored
    async def run():
        calls = 0
        async def request(*args, **kwargs):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return {"data": {"relationships": [{"type": "cover_art", "attributes": {"fileName": "cover.jpg"}}]}}
        monkeypatch.setattr(mdx, "_request_json", request)
        assert await asyncio.gather(*(mdx.get_cover_url(MANGA) for _ in range(8))) == [COVER] * 8
        assert calls == 1
        del values[f"mangadex:cover-url:v2:{MANGA}"]
        monkeypatch.setattr(mdx, "_request_json", AsyncMock(side_effect=RuntimeError("down")))
        assert await mdx.get_cover_url(MANGA) == COVER
    asyncio.run(run())
    assert values[f"mangadex:cover-url:v2:{MANGA}:stale"] == COVER
    assert cache.set_many.call_args.kwargs["ttl"] == 7 * 24 * 3600


def test_untrusted_or_different_book_cover_hints_are_not_used(stored, monkeypatch):
    values, _ = stored
    values[f"mangadex:cover-url:v2:{MANGA}:stale"] = "https://attacker.example/image.jpg"
    values[f"catalog:card-metadata:v1:{MANGA}"] = json.dumps({"cover_url": "https://uploads.mangadex.org/covers/other-book/cover.jpg"})
    upstream = AsyncMock(return_value={"data": {"relationships": []}})
    monkeypatch.setattr(mdx, "_request_json", upstream)
    assert asyncio.run(mdx.get_cover_url(MANGA)) == ""
    upstream.assert_awaited_once()


def test_search_recovers_the_exact_page_after_catalog_invalidation(stored, monkeypatch):
    values, _ = stored
    async def request(*args, **kwargs):
        return {"total": 72, "data": [{"id": MANGA, "attributes": {"title": {"en": "Book"}},
            "relationships": [{"type": "cover_art", "attributes": {"fileName": "cover.jpg"}}]}]}
    monkeypatch.setattr(mdx, "_request_json", request)
    args = dict(keyword="", page=2, limit=24, sort="popular", attach_latest=False, content_ratings=["safe", "suggestive"])
    expected = asyncio.run(mdx.search_manga(**args))
    assert values[f"mangadex:cover-url:v2:{MANGA}:stale"] == COVER
    values["catalog:source-version:mangadex"] = "new-revision"
    for key in list(values):
        if key.startswith("mangadex:search:"):
            del values[key]
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(side_effect=RuntimeError("maintenance")))
    actual = asyncio.run(mdx.search_manga(**args))
    assert actual == expected
    assert actual["data"]["params"]["pagination"]["currentPage"] == 2
    # Never substitute the cached page for another page, keyword or mature filter.
    for change in [{"page": 3}, {"keyword": "other"}, {"content_ratings": ["safe", "suggestive", "erotica"]}]:
        with pytest.raises(RuntimeError):
            asyncio.run(mdx.search_manga(**{**args, **change}))


def test_search_without_a_snapshot_reports_a_source_error(stored, monkeypatch):
    monkeypatch.setattr(mdx, "search_manga", AsyncMock(side_effect=RuntimeError("private source response")))
    response = asyncio.run(manga.mangadex_search(keyword="", page=2, limit=24,
        genre_slugs="", translated_language="vi", original_language="", status="", sort="popular",
        show_mature=True, attach_ratings=False, filter_hidden=False, user=None, db=None))
    assert response.status_code == 503
    assert json.loads(response.body)["code"] == "MANGADEX_UNAVAILABLE"
    assert b"private source" not in response.body


def test_home_keeps_last_good_snapshot_across_source_failures_but_not_other_filters(stored, monkeypatch):
    good = {"data": {"items": [{"slug": MANGA, "name": "Known title"}]}}
    live = AsyncMock(return_value=good)
    monkeypatch.setattr(mdx, "_get_indexed_vi_feed", live)
    assert asyncio.run(mdx.get_latest_vi_chapter_feed(snapshot=True)) == good
    live.side_effect = RuntimeError("source unavailable")
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(snapshot=True))
    assert result["data"]["items"] == good["data"]["items"]
    assert result["data"]["source_unavailable"] is True
    for change in [{"content_ratings": ["safe"]}, {"excluded_manga_ids": [MANGA]}, {"snapshot": False}]:
        with pytest.raises(RuntimeError):
            asyncio.run(mdx.get_latest_vi_chapter_feed(**{"snapshot": True, **change}))


def test_cover_batch_requests_current_relationships_once_instead_of_cover_history(stored, monkeypatch):
    request = AsyncMock(return_value={"data": [{"id": MANGA, "relationships": [
        {"id": "current-cover", "type": "cover_art", "attributes": {"fileName": "current.jpg"}}
    ]}]})
    monkeypatch.setattr(mdx, "_request_json", request)
    individual = AsyncMock(side_effect=AssertionError("must not fan out to individual titles"))
    monkeypatch.setattr(mdx, "_fetch_cover_url_by_manga_id", individual)
    result = asyncio.run(mdx._fetch_cover_urls_for_manga_ids([MANGA]))
    assert result[MANGA].endswith("/current.jpg.512.jpg")
    request.assert_awaited_once_with("/manga", {
        "ids[]": [MANGA], "includes[]": ["cover_art"], "limit": 1,
        "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
    })
    individual.assert_not_called()


def test_missing_cover_relationship_does_not_trigger_individual_requests(stored, monkeypatch):
    request = AsyncMock(return_value={"data": [{"id": MANGA, "relationships": []}]})
    monkeypatch.setattr(mdx, "_request_json", request)
    assert asyncio.run(mdx._fetch_cover_urls_for_manga_ids([MANGA])) == {}
    request.assert_awaited_once()


def test_cover_batch_outage_reuses_stale_urls_without_extending_their_lifetime(stored, monkeypatch):
    values, cache = stored
    values[f"mangadex:cover-url:v2:{MANGA}:stale"] = COVER
    request = AsyncMock(side_effect=RuntimeError("source unavailable"))
    monkeypatch.setattr(mdx, "_request_json", request)
    assert asyncio.run(mdx._fetch_cover_urls_for_manga_ids([MANGA]))[MANGA] == COVER
    assert f"mangadex:cover-url:v2:{MANGA}" not in cache.set_many.call_args.args[0]
