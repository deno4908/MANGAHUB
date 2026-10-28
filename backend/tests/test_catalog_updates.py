import asyncio
import fnmatch
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from fastapi_app.services import cache_service, mangadex_service as mdx, truyenqq_service as qq
from fastapi_app.services.catalog_updates import CatalogUpdates, STATE_PREFIX
from fastapi_app.routers import catalog_updates as events_router
from truyenapi.truyenapi.cache import MemoryCache

MANGA = '11111111-1111-4111-8111-111111111111'


class Cache:
    def __init__(self):
        self.values = {}
        self.invalidations = []

    def get(self, key):
        return self.values.get(key)

    def get_many(self, keys):
        return {key: self.values.get(key) for key in keys}

    def set(self, key, value, ttl=300):
        self.values[key] = value

    def set_many(self, values, ttl=300):
        self.values.update(values)

    def delete(self, key):
        self.values.pop(key, None)

    def flush_pattern(self, pattern):
        self.invalidations.append(pattern)
        for key in list(self.values):
            if fnmatch.fnmatchcase(key, pattern):
                self.delete(key)

    def flush_patterns(self, patterns):
        for pattern in patterns:
            self.flush_pattern(pattern)


@pytest.fixture
def cache(monkeypatch):
    value = Cache()
    monkeypatch.setattr(cache_service, 'cache', value)
    monkeypatch.setattr(mdx, 'cache', value)
    monkeypatch.setattr(qq, 'cache', value)
    monkeypatch.setattr(qq, '_live', None)
    return value


def test_moe_update_invalidates_only_its_details_and_preserves_mdx(monkeypatch, cache):
    from fastapi_app.services import moetruyen_service as moe
    from unittest.mock import AsyncMock
    row = {'id': '1048', 'slug': '1048-book', 'title': 'Book', 'genres': [],
           'latest_chapter': {'number': '2'}, 'adult': False}
    monkeypatch.setattr(moe, 'run', AsyncMock(return_value={'items': [row]}))
    monkeypatch.setattr(moe, '_remember_cards', AsyncMock())
    cache.set('moetruyen:detail:v1:moe-1048', 'old')
    cache.set('moetruyen:list:v1:old', 'old')
    cache.set('mangadex:metadata:book', 'keep')
    async def check():
        publisher = CatalogUpdates()
        event = await publisher.publish('moetruyen', await publisher.probe('moetruyen'))
        assert event['changes'][0]['chapter_id'] == 'moe--1048--2'
    asyncio.run(check())
    assert cache.get('moetruyen:detail:v1:moe-1048') is None
    assert cache.get('moetruyen:list:v1:old') is None
    assert cache.get('mangadex:metadata:book') == 'keep'


def test_upstream_change_reaches_detail_feed_other_worker_and_stream(monkeypatch, cache):
    number = 1
    calls = []

    async def request(path, params=None):
        calls.append((path, params))
        if path.startswith('/manga/'):
            return {'data': {'id': MANGA, 'attributes': {'title': {'en': 'Live book'}}, 'relationships': []}}
        return {'total': number, 'data': [{'id': f'chapter-{number}',
            'attributes': {'chapter': str(number), 'translatedLanguage': 'vi', 'pages': 10},
            'relationships': [{'type': 'manga', 'id': MANGA,
                'attributes': {'title': {'en': 'Live book'}, 'contentRating': 'safe'}}]}]}

    async def covers(ids):
        return {}

    monkeypatch.setattr(mdx, '_request_json', request)
    monkeypatch.setattr(mdx, '_fetch_cover_urls_for_manga_ids', covers)

    async def check():
        nonlocal number
        publisher, worker = CatalogUpdates(), CatalogUpdates()
        await publisher.publish('mangadex', await publisher.probe('mangadex'))
        first = await mdx.get_manga_detail(MANGA)
        assert first['manga']['chapters'][0]['chapter'] == '1'
        number = 2
        event = await publisher.publish('mangadex', await publisher.probe('mangadex'))
        assert event['changes'][0]['chapter_name'] == '2'
        second = await mdx.get_manga_detail(MANGA)
        assert second['manga']['chapters'][0]['chapter'] == '2'
        before_feed = len(calls)
        feed = await mdx.get_latest_vi_chapter_feed(snapshot=True)
        assert feed['data']['items'][0]['chaptersLatest'][0]['chapter_name'] == '2'
        assert len(calls) == before_feed  # the shared probe is reused; no extra crawl
        await worker.sync()
        assert worker.current['mangadex']['revision'] == event['revision']
        monkeypatch.setattr(events_router, 'catalog_updates', worker)
        request_mock = Mock()
        request_mock.state.site_access_authorization = None
        request_mock.is_disconnected = _connected
        stream = events_router.event_stream(request_mock)
        assert 'event: ready' in await anext(stream)
        message = await anext(stream)
        assert 'catalog-update' in message and 'chapter-2' in message
        await stream.aclose()
        invalidations = len(cache.invalidations)
        assert await publisher.publish('mangadex', await publisher.probe('mangadex')) is None
        assert len(cache.invalidations) == invalidations
    asyncio.run(check())


async def _connected():
    return False


def test_late_response_cannot_repopulate_new_mangadex_revision(monkeypatch, cache):
    async def check():
        started, release = asyncio.Event(), asyncio.Event()
        version = 1
        async def request(path, params=None):
            captured = version
            if path.startswith('/manga/'):
                return {'data': {'id': MANGA, 'attributes': {}, 'relationships': []}}
            if captured == 1:
                started.set()
                await release.wait()
            return {'total': 1, 'data': [{'id': f'chapter-{captured}',
                'attributes': {'chapter': str(captured), 'translatedLanguage': 'vi'}}]}
        monkeypatch.setattr(mdx, '_request_json', request)
        old = asyncio.create_task(mdx.get_manga_detail(MANGA))
        await started.wait()
        version = 2
        await CatalogUpdates().publish('mangadex', {MANGA: {'slug': MANGA, 'chapter_id': 'chapter-2', 'chapter_name': '2'}})
        new = await asyncio.wait_for(mdx.get_manga_detail(MANGA), 2)
        assert new['manga']['chapters'][0]['chapter'] == '2'
        release.set()
        await old
        again = await mdx.get_manga_detail(MANGA)
        assert again['manga']['chapters'][0]['chapter'] == '2'
    asyncio.run(check())


def test_invalidated_qq_inflight_loader_cannot_overwrite_new_result():
    cache = MemoryCache()
    started, release = threading.Event(), threading.Event()
    def old_loader():
        started.set()
        assert release.wait(2)
        return 'old'
    with ThreadPoolExecutor(2) as pool:
        pending = pool.submit(cache.get, ('comic', 'url'), 60, old_loader)
        assert started.wait(2)
        cache.invalidate_matching(lambda key: key[0] == 'comic')
        assert cache.get(('comic', 'url'), 60, lambda: 'new') == 'new'
        release.set()
        assert pending.result(2) == 'old'
    assert cache.peek(('comic', 'url')) == 'new'


def test_workers_claim_one_probe_per_interval(monkeypatch, cache):
    class Redis:
        locks = {}
        def set(self, key, value, nx, ex):
            if key in self.locks:
                return False
            self.locks[key] = value
            return True
        def eval(self, script, count, key, value):
            if self.locks.get(key) == value:
                self.locks.pop(key)
    cache._client = Redis()
    first, second = CatalogUpdates(), CatalogUpdates()
    claim = first._claim('mangadex')
    assert claim
    assert not second._claim('mangadex')
    first._release('mangadex', claim)
    assert not second._claim('mangadex')  # interval is still claimed after releasing the active lease
    assert second._claim('truyenqq')


def test_failed_probe_does_not_replace_last_good_state(monkeypatch, cache):
    async def empty(*args, **kwargs):
        return {'data': []}
    monkeypatch.setattr(mdx, '_request_json', empty)
    saved = json.dumps({'event': {'revision': 'good'}})
    cache.set(STATE_PREFIX + 'mangadex', saved)
    with pytest.raises(ValueError):
        asyncio.run(CatalogUpdates().probe('mangadex'))
    assert cache.get(STATE_PREFIX + 'mangadex') == saved


def test_discovery_snapshot_merges_new_chapters_without_recrawling_catalog(cache):
    key = 'mangadex:vi-catalog:2000'
    cache.set(key, json.dumps({'mangas': [{'id': MANGA, 'chapters': [
        {'id': 'old', 'chapter': '1'}]}]}))
    cache.set('catalog:probe:mangadex', json.dumps({'data': [
        {'id': 'new', 'attributes': {'chapter': '2', 'translatedLanguage': 'vi',
            'readableAt': '2026-10-20T12:00:00Z'},
         'relationships': [{'type': 'manga', 'id': MANGA}]}]}))
    for _ in range(2):
        result = mdx._load_json_cache_payload(key)
        assert [chapter['chapter'] for chapter in result['mangas'][0]['chapters']] == ['1', '2']
        assert result['mangas'][0]['local_last_published_at'] == '2026-10-20T12:00:00Z'
    # The stored base snapshot is not mutated or duplicated on subsequent reads.
    assert len(json.loads(cache.get(key))['mangas'][0]['chapters']) == 1


def test_qq_shared_listing_key_changes_with_source_revision(cache):
    before = qq.live_list_cache_key('truyen-moi', 1)
    cache.set('catalog:source-version:truyenqq', 'new')
    assert qq.live_list_cache_key('truyen-moi', 1) != before


def test_batched_redis_invalidation_scans_namespaces_once_and_keeps_unrelated_keys():
    client = Mock()
    keys = ['mangadex:detail:v4:book:all', 'mangadex:detail:v4:other:all',
            'mangadex:metadata:book', 'manga:list-combined:old']
    client.scan_iter.side_effect = lambda match, count: iter(key for key in keys if fnmatch.fnmatchcase(key, match))
    cache = cache_service._RedisCache(client)
    cache.flush_patterns(['mangadex:detail:*:book:*', 'mangadex:metadata:book*', 'manga:list-combined:*'])
    assert client.scan_iter.call_count == 2
    deleted = [key for call in client.delete.call_args_list for key in call.args]
    assert set(deleted) == set(keys) - {'mangadex:detail:v4:other:all'}
