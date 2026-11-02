import asyncio
import json
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from fastapi_app.routers import manga
from fastapi_app.services import mangadex_service as mdx
from test_catalog_request_logic import EmptyDB, page, isolate


@pytest.fixture
def stored(monkeypatch):
    values = {}
    thread = threading.get_ident()
    def read(keys):
        assert threading.get_ident() != thread
        return {key: values.get(key) for key in keys}
    def write(key, value, **kwargs):
        assert threading.get_ident() != thread
        values[key] = value
    monkeypatch.setattr(mdx, 'cache', Mock(get_many=Mock(side_effect=read), set=Mock(side_effect=write)))
    return values


def test_warm_home_reads_never_download_index_or_resolve_covers_again(stored, monkeypatch):
    feed = page([{'slug': 'real-latest', 'name': 'Actual latest', 'chaptersLatest': [{'chapter_name': '7'}]}], 1)
    load = AsyncMock(return_value=feed)
    monkeypatch.setattr(mdx, '_get_indexed_vi_feed', load)
    async def run():
        first = await mdx.get_latest_vi_chapter_feed(snapshot=True)
        assert first == feed
        for _ in range(5):
            result = await mdx.get_latest_vi_chapter_feed(snapshot=True)
            assert result == feed
            result['data']['items'].clear()  # A router cannot mutate the snapshot.
        assert load.await_count == 1
        assert len(json.dumps(stored)) < 2000
    asyncio.run(run())


def test_expired_feed_returns_before_slow_refresh_and_coalesces_work(stored, monkeypatch):
    first = page([{'slug': 'first-release'}], 1)
    next_feed = page([{'slug': 'new-release'}], 1)
    load = AsyncMock(return_value=first)
    monkeypatch.setattr(mdx, '_get_indexed_vi_feed', load)
    async def run():
        assert await mdx.get_latest_vi_chapter_feed(snapshot=True) == first
        for key in list(stored):
            value = json.loads(stored[key])
            value['fresh_until'] = 0
            stored[key] = json.dumps(value)
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(**kwargs):
            started.set()
            await release.wait()
            return next_feed
        load.side_effect = slow
        results = await asyncio.wait_for(asyncio.gather(*[
            mdx.get_latest_vi_chapter_feed(snapshot=True) for _ in range(8)
        ]), timeout=1)
        assert results == [first] * 8  # first response is never a placeholder
        await asyncio.wait_for(started.wait(), 1)
        assert load.await_count == 2
        assert len(mdx._home_feed_jobs) == 1
        release.set()
        await asyncio.gather(*list(mdx._home_feed_jobs.values()))
        assert await mdx.get_latest_vi_chapter_feed(snapshot=True) == next_feed
        assert load.await_count == 2
    asyncio.run(run())


def test_explicit_chapter_event_is_visible_on_the_next_home_response(stored, monkeypatch):
    load = AsyncMock(side_effect=[page([{'slug': 'old-release'}], 1), page([{'slug': 'new-release'}], 1)])
    monkeypatch.setattr(mdx, '_get_indexed_vi_feed', load)
    async def run():
        assert (await mdx.get_latest_vi_chapter_feed(snapshot=True))['data']['items'] == [{'slug': 'old-release'}]
        stored['catalog:source-version:mangadex'] = 'new-chapter'
        assert (await mdx.get_latest_vi_chapter_feed(snapshot=True))['data']['items'] == [{'slug': 'new-release'}]
        assert load.await_count == 2
    asyncio.run(run())


def test_home_snapshot_never_crosses_mature_or_hidden_selection(stored, monkeypatch):
    load = AsyncMock(side_effect=[page([{'slug': 'safe-release'}], 1), RuntimeError('no approved snapshot')])
    monkeypatch.setattr(mdx, '_get_indexed_vi_feed', load)
    asyncio.run(mdx.get_latest_vi_chapter_feed(snapshot=True))
    with pytest.raises(RuntimeError):
        asyncio.run(mdx.get_latest_vi_chapter_feed(snapshot=True, content_ratings=['safe', 'suggestive', 'erotica']))
    load.side_effect = RuntimeError('no approved snapshot')
    with pytest.raises(RuntimeError):
        asyncio.run(mdx.get_latest_vi_chapter_feed(snapshot=True, excluded_manga_ids=['safe-release']))


def test_light_home_avoids_unneeded_ongoing_request_and_views_but_keeps_moderation(monkeypatch):
    isolate(monkeypatch)
    listing = AsyncMock(return_value=page([{'slug': 'visible'}, {'slug': 'hidden'}], 2))
    monkeypatch.setattr(manga.truyenqq_service, 'get_list', listing)
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'hidden': 'blocked'}))
    result = asyncio.run(manga.homepage(include_featured=False, include_ongoing=False,
        attach_ratings=False, lightweight=True, db=EmptyDB(), user=None))
    listing.assert_awaited_once_with('truyen-moi', 1)
    assert result['latest']['data']['items'] == [{'slug': 'visible'}]
    assert result['ongoing']['data']['items'] == []
    assert result['meta'] == {'unavailable_sections': [], 'omitted_sections': ['ongoing']}
    assert manga._attach_overrides_to_otruyen_payload.call_args.kwargs == {'attach_views': False}
    manga._async_attach_ratings_to_items.assert_not_awaited()


def test_light_mangadex_home_keeps_hidden_filter_without_waiting_for_view_enrichment(monkeypatch):
    isolate(monkeypatch)
    hidden_id = '11111111-1111-4111-8111-111111111111'
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={hidden_id: 'hidden'}))
    load = AsyncMock(return_value=page([{'slug': hidden_id}, {'slug': 'visible'}], 2))
    monkeypatch.setattr(manga.mangadex_service, 'get_latest_vi_chapter_feed', load)
    result = asyncio.run(manga.mangadex_home_banner(limit=24, show_mature=False, filter_hidden=True,
        attach_ratings=False, lightweight=True, db=EmptyDB(), user=None))
    assert result['data']['items'] == [{'slug': 'visible'}]
    assert load.call_args.kwargs['excluded_manga_ids'] == [hidden_id]
    assert load.call_args.kwargs['content_ratings'] == ['safe', 'suggestive']
    manga._async_attach_local_views_to_mangadex_payload.assert_not_awaited()
