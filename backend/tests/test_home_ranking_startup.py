import asyncio
import threading
from unittest.mock import AsyncMock, Mock

from fastapi_app.routers import manga
from test_catalog_request_logic import EmptyDB


def test_parallel_cold_home_requests_share_ranking_work_and_never_fetch_latest_fill(monkeypatch):
    started, finish = asyncio.Event(), asyncio.Event()
    reads = 0
    async def hidden(_db):
        nonlocal reads
        reads += 1
        started.set()
        await finish.wait()
        return {}
    monkeypatch.setattr(manga, '_get_hidden_slugs', hidden)
    monkeypatch.setattr(manga, '_fetch_local_views_lookup', lambda _db: {})
    monkeypatch.setattr(manga, '_load_recent_trending_fallback', lambda **kwargs: [])
    latest = AsyncMock(side_effect=AssertionError('Do not call a source listing to fill a ranking'))
    monkeypatch.setattr(manga, '_build_otruyen_fallback_trending', latest)
    async def run():
        db = EmptyDB()
        tasks = [asyncio.create_task(manga._compute_trending_from_db(50, db, 'all')) for _ in range(3)]
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.sleep(0)
        assert reads == 1
        finish.set()
        assert await asyncio.gather(*tasks) == [[], [], []]
    asyncio.run(run())
    latest.assert_not_awaited()


def test_slow_revision_and_cache_writes_do_not_block_other_home_requests(monkeypatch):
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={}))
    monkeypatch.setattr(manga, '_load_json_cache', lambda _key: None)
    monkeypatch.setattr(manga, '_trending_memory_cache', {})
    monkeypatch.setattr(manga, '_compute_trending_from_db', AsyncMock(return_value=[{
        'slug': 'ranked-12345', 'title': 'Real ranked title', 'thumb': '/real.jpg', 'views': 10}]))
    main_thread = threading.get_ident()
    def revision(_source):
        assert threading.get_ident() != main_thread
        return 'revision'
    def save(*args, **kwargs):
        assert threading.get_ident() != main_thread
    monkeypatch.setattr(manga, '_source_revision', revision)
    monkeypatch.setattr(manga, 'cache', Mock(set=Mock(side_effect=save)))
    result = asyncio.run(manga.trending_manga(limit=50, source='all', db=EmptyDB(), user=None))
    assert result['trending'][0]['title'] == 'Real ranked title'
    manga.cache.set.assert_called_once()


def test_cached_home_ranking_is_filtered_for_new_moderation_before_returning(monkeypatch):
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'hidden-12345': 'hidden'}))
    monkeypatch.setattr(manga, '_source_revision', lambda _source: '')
    monkeypatch.setattr(manga, '_trending_memory_cache', {})
    monkeypatch.setattr(manga, '_load_json_cache', lambda _key: {'trending': [
        {'slug': 'hidden-12345', 'title': 'Hidden', 'views': 200},
        {'slug': 'allowed-12345', 'title': 'Allowed title', 'thumb': '/cover.jpg', 'views': 100}]})
    compute = AsyncMock(side_effect=AssertionError('Use cached ranked data'))
    monkeypatch.setattr(manga, '_compute_trending_from_db', compute)
    result = asyncio.run(manga.trending_manga(limit=50, source='all', db=EmptyDB(), user=None))
    assert [row['slug'] for row in result['trending']] == ['allowed-12345']
    compute.assert_not_awaited()
