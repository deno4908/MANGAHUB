import asyncio
from unittest.mock import Mock

import pytest

from fastapi_app.services import mangadex_service as mdx
from fastapi_app.services.request_coalescing import coalesce_reads

MANGA = "11111111-1111-4111-8111-111111111111"


@pytest.mark.parametrize("sort", ["latest", "popular", "title", "updated", "relevance"])
def test_search_keeps_title_filter_for_every_sort(monkeypatch, sort):
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    calls = []
    async def request(path, params=None):
        calls.append((path, params))
        return {"data": [], "total": 0}
    monkeypatch.setattr(mdx, "_request_json", request)
    asyncio.run(mdx.search_manga("one piece", sort=sort, attach_latest=False))
    assert len(calls) == 1
    assert calls[0][1]["title"] == "one piece"


def test_fast_chapter_hydration_never_sends_invalid_manga_array_requests(monkeypatch):
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    monkeypatch.setattr(mdx, "_latest_chapter_info_from_cached_catalog", lambda _: None)
    async def request(path, params=None):
        assert "manga[]" not in params
        assert params["manga"] == MANGA
        assert params["limit"] == 1
        return {"data": [{"id": "chapter", "attributes": {"chapter": "1"}}]}
    network = Mock(wraps=request)
    monkeypatch.setattr(mdx, "_request_json", network)
    assert asyncio.run(mdx.get_latest_vi_chapters_for_manga_ids([MANGA], allow_individual_fallback=False)) == {}
    assert network.call_count == 0
    result = asyncio.run(mdx.get_latest_vi_chapters_for_manga_ids([MANGA]))
    assert result[MANGA]["id"] == "chapter"
    assert network.call_count == 1


def test_unknown_tag_does_not_silently_turn_into_unfiltered_search(monkeypatch):
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    async def tags():
        return {"action": "tag-id"}
    monkeypatch.setattr(mdx, "_get_mangadex_tag_id_by_slug", tags)
    network = Mock(side_effect=AssertionError("must not send a broad search"))
    monkeypatch.setattr(mdx, "_request_json", network)
    result = asyncio.run(mdx.search_manga("", sort="latest", included_tag_slugs=["unknown"]))
    assert result["data"]["items"] == []
    network.assert_not_called()


def test_home_snapshot_reads_one_chapter_page_even_for_a_mass_upload(monkeypatch):
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    calls = []
    async def request(path, params=None):
        calls.append(path)
        return {"total": 10000, "data": [{"id": str(i), "attributes": {"translatedLanguage": "vi", "chapter": str(i)},
            "relationships": [{"type": "manga", "id": MANGA, "attributes": {"title": {"en": "Mass upload"}}}]} for i in range(100)]}
    async def covers(ids):
        return {}
    monkeypatch.setattr(mdx, "_request_json", request)
    monkeypatch.setattr(mdx, "_fetch_cover_urls_for_manga_ids", covers)
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24, snapshot=True))
    assert len(result["data"]["items"]) == 1
    assert calls == ["/chapter"]


def test_cancelled_reader_does_not_drop_shared_work():
    async def check():
        ready, release = asyncio.Event(), asyncio.Event()
        calls = 0
        @coalesce_reads
        async def load(identifier):
            nonlocal calls
            calls += 1
            ready.set()
            await release.wait()
            return {"id": identifier, "views": 0}
        first = asyncio.create_task(load(MANGA))
        await ready.wait()
        second = asyncio.create_task(load(MANGA))
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        third = asyncio.create_task(load(MANGA))
        release.set()
        a, b = await asyncio.gather(second, third)
        a["views"] = 123
        assert b["views"] == 0
        assert calls == 1
    asyncio.run(check())


def test_detail_fetches_metadata_and_chapters_concurrently_and_coalesces(monkeypatch):
    store = {}
    fake_cache = Mock()
    fake_cache.get.side_effect = store.get
    fake_cache.set.side_effect = lambda key, value, **kw: store.__setitem__(key, value)
    monkeypatch.setattr(mdx, "cache", fake_cache)
    async def check():
        started = set()
        calls = []
        both_started = asyncio.Event()
        async def request(path, params=None):
            calls.append((path, params))
            started.add(path)
            if len(started) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=1)
            if path.startswith("/manga/"):
                return {"data": {"id": MANGA, "attributes": {"title": {"en": "Example"}}, "relationships": []}}
            return {"data": [{"id": "22222222-2222-4222-8222-222222222222",
                              "attributes": {"chapter": "1", "translatedLanguage": "vi", "pages": 10}}], "total": 1}
        monkeypatch.setattr(mdx, "_request_json", request)
        a, b = await asyncio.gather(mdx.get_manga_detail(MANGA), mdx.get_manga_detail(manga_id=MANGA))
        assert len(calls) == 2
        assert a["meta"]["chapters_complete"] is True
        assert len(b["manga"]["chapters"]) == 1
        await mdx.get_manga_lookup(MANGA)
        assert len(calls) == 2  # metadata reused by lookup/filter changes
    asyncio.run(check())


def test_failed_chapter_fetch_does_not_cache_a_false_empty_detail(monkeypatch):
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    async def request(path, params=None):
        if path == "/chapter":
            raise RuntimeError("source unavailable")
        return {"data": {"id": MANGA, "attributes": {}, "relationships": []}}
    monkeypatch.setattr(mdx, "_request_json", request)
    with pytest.raises(RuntimeError, match="source unavailable"):
        asyncio.run(mdx.get_manga_detail(MANGA))
    cached_detail_keys = [args[0] for args, _ in mdx.cache.set.call_args_list]
    assert not any(key.startswith("mangadex:detail:") for key in cached_detail_keys)


def test_progressive_detail_reuses_first_chapter_page(monkeypatch):
    store = {}
    fake_cache = Mock()
    fake_cache.get.side_effect = store.get
    fake_cache.set.side_effect = lambda key, value, **kw: store.__setitem__(key, value)
    monkeypatch.setattr(mdx, "cache", fake_cache)
    offsets = []
    async def request(path, params=None):
        if path.startswith("/manga/"):
            return {"data": {"id": MANGA, "attributes": {}, "relationships": []}}
        offset, limit = params["offset"], params["limit"]
        offsets.append(offset)
        return {"data": [{"id": str(i), "attributes": {"chapter": str(i), "translatedLanguage": "vi"}}
                         for i in range(offset, min(offset + limit, 150))], "total": 150}
    monkeypatch.setattr(mdx, "_request_json", request)
    async def check():
        quick = await mdx.get_manga_detail(MANGA, max_chapters=100)
        full = await mdx.get_manga_detail(MANGA, max_chapters=None)
        assert len(quick["manga"]["chapters"]) == 100
        assert len(full["manga"]["chapters"]) == 150
        assert offsets == [0, 100]
    asyncio.run(check())
