import asyncio
import json
import threading
from unittest.mock import AsyncMock

import pytest

from fastapi_app.services import truyenqq_service as qq
from test_catalog_updates import Cache


class CountedCache(Cache):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.owner = threading.get_ident()

    def get(self, key):
        assert threading.get_ident() != self.owner
        self.calls.append(('get', key))
        return self.values.get(key)

    def get_many(self, keys):
        assert threading.get_ident() != self.owner
        self.calls.append(('get_many', list(keys)))
        return {key: self.values.get(key) for key in keys}

    def set_many(self, values, ttl=300):
        assert threading.get_ident() != self.owner
        self.calls.append(('set_many', list(values)))
        self.values.update(values)


def source_page():
    return {'items': [{'id': '123', 'url': 'https://truyenqqko.com/truyen-tranh/canonical-123',
        'title': 'Canonical title', 'status': 'completed', 'genres': ['Action'],
        'cover_urls': ['https://images.example/cover.jpg'],
        'latest_chapter': {'number': '4', 'title': 'Chapter 4'}}],
        'page': 3, 'total_pages': 8, 'fetched_at': '2026-11-02T00:00:00+00:00'}


@pytest.fixture
def stored(monkeypatch):
    store = CountedCache()
    monkeypatch.setattr(qq, 'cache', store)
    monkeypatch.setattr(qq, '_catalog_jobs', {})
    monkeypatch.setattr(qq, 'run_live', AsyncMock(return_value=source_page()))
    return store


def test_cached_list_uses_one_batch_read_without_dropping_any_metadata(stored):
    async def run():
        expected = await qq.get_list(page=3)
        stored.calls.clear()
        result = await qq.get_list(page=3)
        assert result == expected
        assert [kind for kind, _ in stored.calls] == ['get_many']
        assert qq.run_live.await_count == 1
        result['data']['items'][0]['name'] = 'A caller changed its copy'
        assert (await qq.get_list(page=3)) == expected
        assert expected['data']['params']['pagination']['totalPages'] == 8
        assert expected['data']['items'][0]['category'] == [{'name': 'Action', 'slug': 'action'}]
    asyncio.run(run())


def test_filtered_cache_batches_latest_chapters_without_changing_genre_status_page_or_sort(stored):
    async def run():
        options = dict(genres=['action'], page=3, status='completed', sort='views_desc')
        first = await qq.get_filtered(**options)
        latest = json.loads(json.dumps(first))
        latest['data']['items'][0]['chaptersLatest'][0]['chapter_name'] = '99'
        stored.values['truyenqq:list:truyen-moi:1'] = json.dumps(latest)
        stored.calls.clear()
        result = await qq.get_filtered(**options)
        assert [kind for kind, _ in stored.calls] == ['get_many']
        assert len(stored.calls[0][1]) == 2
        assert result['data']['items'][0]['chaptersLatest'][0]['chapter_name'] == '99'
        assert result['data']['items'][0]['category'] == first['data']['items'][0]['category']
        assert result['data']['params'] == first['data']['params']
        qq.run_live.assert_awaited_once_with('discover', **options)
    asyncio.run(run())


def test_new_source_revision_rejects_old_fast_cache_and_preserves_published_chapters(stored):
    async def run():
        first = await qq.get_list()
        latest = json.loads(json.dumps(first))
        latest['data']['items'][0]['chaptersLatest'][0]['chapter_name'] = '99'
        stored.values['catalog:source-version:truyenqq'] = 'new-event'
        stored.values['truyenqq:list:truyen-moi:1'] = json.dumps(latest)
        assert (await qq.get_list())['data']['items'][0]['chaptersLatest'][0]['chapter_name'] == '99'
        # A slower reader from before the event must not clobber either alias.
        await asyncio.to_thread(qq.remember_list, 'truyen-moi', 1, first, revision='')
        assert (await qq.get_list())['data']['items'][0]['chaptersLatest'][0]['chapter_name'] == '99'
        assert json.loads(stored.values['truyenqq:list:truyen-moi:1']) == latest
    asyncio.run(run())


def test_parallel_cold_list_requests_share_source_work_and_publish_once(stored, monkeypatch):
    async def run():
        started, finish = asyncio.Event(), asyncio.Event()
        async def source(*args, **kwargs):
            started.set()
            await finish.wait()
            return source_page()
        monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=source))
        tasks = [asyncio.create_task(qq.get_list(page=3)) for _ in range(8)]
        await asyncio.wait_for(started.wait(), 1)
        finish.set()
        results = await asyncio.gather(*tasks)
        assert all(result == results[0] for result in results)
        assert qq.run_live.await_count == 1
        writes = [keys for kind, keys in stored.calls if kind == 'set_many'
                  and any(key.startswith('truyenqq:live-list:v2:') for key in keys)]
        assert len(writes) == 1
    asyncio.run(run())


def test_cold_filter_adopts_a_chapter_published_during_source_fetch(stored, monkeypatch):
    async def run():
        started, finish = asyncio.Event(), asyncio.Event()
        async def source(*args, **kwargs):
            started.set()
            await finish.wait()
            return source_page()
        monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=source))
        task = asyncio.create_task(qq.get_filtered(page=3))
        await asyncio.wait_for(started.wait(), 1)
        stored.values['truyenqq:list:truyen-moi:1'] = json.dumps({'data': {'items': [{
            'slug': 'canonical-123', 'chaptersLatest': [{'chapter_name': '99'}]}]}})
        finish.set()
        assert (await task)['data']['items'][0]['chaptersLatest'][0]['chapter_name'] == '99'
    asyncio.run(run())


def test_cached_genres_do_not_block_the_event_loop(stored):
    expected = {'data': {'items': [{'name': 'Action', 'slug': 'action'}]}}
    stored.values['truyenqq:genres:v1'] = json.dumps(expected)
    assert asyncio.run(qq.get_categories()) == expected
    qq.run_live.assert_not_awaited()


def test_verified_genres_remain_available_and_share_one_background_refresh(stored, monkeypatch):
    expected = {'status': 'success', 'data': {'items': [{'name': 'Action', 'slug': 'action'}]}}
    stored.values['truyenqq:genres:last-good:v1'] = json.dumps(expected)
    started, release = asyncio.Event(), asyncio.Event()
    async def unavailable(*args):
        started.set()
        await release.wait()
        raise RuntimeError('source temporarily unavailable')
    monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=unavailable))
    async def run():
        first = await qq.get_categories()
        await asyncio.wait_for(started.wait(), .5)
        second = await qq.get_categories()
        assert first == second == expected and first is not second
        assert qq.run_live.await_count == 1
        release.set()
        await asyncio.gather(*list(qq._catalog_jobs.values()))
        assert await qq.get_categories() == expected
        assert qq.run_live.await_count == 1
    asyncio.run(run())


def test_empty_source_genres_never_replace_a_verified_filter_list(stored, monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(qq, 'run_live', AsyncMock(return_value=[]))
    with pytest.raises(HTTPException):
        asyncio.run(qq.get_categories())
    assert 'truyenqq:genres:v1' not in stored.values
    assert 'truyenqq:genres:last-good:v1' not in stored.values
