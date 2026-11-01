import asyncio
from unittest.mock import AsyncMock
import math
import pytest

from fastapi_app.routers import manga
from test_catalog_request_logic import EmptyDB, isolate, page


def options(**extra):
    return dict(keyword='O', page=1, include_mangadex=True, attach_ratings=False,
        mangadex_limit=24, mangadex_timeout_ms=0, mangadex_translated_language='vi',
        mangadex_attach_latest=False, user=None, db=EmptyDB(), **extra)


def test_all_116_pages_are_reachable_without_repeating_or_losing_surplus_matches(monkeypatch):
    isolate(monkeypatch)
    qq = [{'slug': f'qq-{n}'} for n in range(20)]
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page(qq, 20)))
    async def mdx(**kwargs):
        start, size = kwargs['offset_override'], kwargs['limit']
        return page([{'slug': f'mdx-{n}'} for n in range(start, min(2754, start + size))], 2754)
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', mdx)
    async def read():
        found = []
        for number in range(1, 117):
            kwargs = options()
            kwargs['page'] = number
            result = await manga.search(**kwargs)
            items = result['data']['items']
            assert len(items) == (24 if number < 116 else 14)
            assert result['data']['params']['pagination'] == dict(
                totalItems=2774, totalItemsPerPage=24, currentPage=number, totalPages=116)
            found.extend(item['slug'] for item in items)
        assert found == [*(item['slug'] for item in qq), *(f'mdx-{n}' for n in range(2754))]
    asyncio.run(read())


def test_uploads_and_qq_are_filtered_and_deduplicated_before_counting_or_slicing(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'hidden': 'hidden'}))
    monkeypatch.setattr(manga, '_search_uploads', AsyncMock(return_value=[{'slug': 'upload', 'category': [{'slug': 'action'}]}]))
    qq = [{'slug': 'upload'}, {'slug': 'hidden'}, {'slug': 'adult', 'content_rating': 'pornographic'},
        {'slug': 'wrong-genre', 'category': [{'slug': 'romance'}]},
        {'slug': 'qq', 'category': [{'slug': 'action'}]}]
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page(qq, 5)))
    source = AsyncMock(return_value=page([{'slug': 'mdx'}], 1))
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', source)
    result = asyncio.run(manga.search(**options(show_mature=False, genre_slugs='action')))
    assert [item['slug'] for item in result['data']['items']] == ['upload', 'qq', 'mdx']
    assert result['data']['params']['pagination']['totalItems'] == 3
    assert source.call_args.kwargs['offset_override'] == 0
    assert source.call_args.kwargs['included_tag_slugs'] == ['action']
    assert source.call_args.kwargs['content_ratings'] == ['safe', 'suggestive']


def test_upload_prefix_spans_pages_and_is_counted_once(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga, '_search_uploads', AsyncMock(return_value=[{'slug': f'upload-{n}'} for n in range(30)]))
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page([], 0)))
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', AsyncMock(return_value=page([], 0)))
    kwargs = options()
    first = asyncio.run(manga.search(**kwargs))
    kwargs['page'] = 2
    second = asyncio.run(manga.search(**kwargs))
    assert len(first['data']['items']) == 24
    assert [item['slug'] for item in second['data']['items']] == [f'upload-{n}' for n in range(24, 30)]
    assert first['data']['params']['pagination']['totalItems'] == 30


def test_suggestions_are_bounded_and_skip_upload_rating_and_chapter_enrichment(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga, '_search_uploads', AsyncMock(side_effect=AssertionError('No upload crawl for suggestions')))
    source = AsyncMock(return_value=page([{'slug': f'mdx-{n}'} for n in range(12)], 12))
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', source)
    result = asyncio.run(manga.search_suggestions(keyword='one', source='mangadex', limit=6, show_mature=False, db=EmptyDB()))
    assert len(result['data']['items']) == 6
    assert source.call_args.kwargs['attach_latest'] is False
    assert source.call_args.kwargs['limit'] == 6
    manga._async_attach_ratings_to_items.assert_not_awaited()
    manga._async_attach_local_views_to_mangadex_payload.assert_not_awaited()


def test_suggestions_still_enforce_hidden_and_mature_filters(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'hidden': 'hidden'}))
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page([
        {'slug': 'hidden'}, {'slug': 'adult', 'content_rating': 'pornographic'}, {'slug': 'allowed'}], 3)))
    result = asyncio.run(manga.search_suggestions(keyword='one', source='truyenqq', limit=6, show_mature=False, db=EmptyDB()))
    assert result['data']['items'] == [{'slug': 'allowed'}]


def test_uploaded_suggestions_only_read_six_rows_and_preserve_published_only(monkeypatch):
    isolate(monkeypatch)
    class DB(EmptyDB):
        def eq(self, field, value):
            assert (field, value) == ('status', 'published')
            return self
        def range(self, start, end):
            assert (start, end) == (0, 5)
            return self
    result = asyncio.run(manga.search_suggestions(keyword='one', source='uploaded', limit=6, show_mature=False, db=DB()))
    assert result['data']['items'] == []


def test_http_contract_reads_the_requested_page_and_validates_suggestion_limits(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    isolate(monkeypatch)
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page([{'slug': f'qq-{n}'} for n in range(20)], 20)))
    async def mdx(**kwargs):
        start, size = kwargs.get('offset_override', 0), kwargs['limit']
        return page([{'slug': f'mdx-{n}'} for n in range(start, start + size)], 2754)
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', mdx)
    app = FastAPI()
    app.include_router(manga.router, prefix='/api/manga')
    app.dependency_overrides[manga.get_supabase_public] = lambda: EmptyDB()
    app.dependency_overrides[manga.get_optional_user] = lambda: None
    with TestClient(app) as client:
        response = client.get('/api/manga/search', params={'keyword': 'O', 'page': 2, 'limit': 24, 'attach_ratings': False, 'mangadex_attach_latest': False})
        assert response.status_code == 200
        assert [row['slug'] for row in response.json()['data']['items']] == [f'mdx-{n}' for n in range(4, 28)]
        assert response.json()['data']['params']['pagination']['totalPages'] == 116
        suggestions = client.get('/api/manga/suggestions', params={'keyword': 'one', 'source': 'mangadex', 'limit': 6})
        assert suggestions.status_code == 200
        assert len(suggestions.json()['data']['items']) == 6
        assert client.get('/api/manga/suggestions', params={'keyword': 'one', 'source': 'mangadex', 'limit': 7}).status_code == 422


@pytest.mark.parametrize('total', [0, 4, 94, 96, 100, 10000])
def test_cached_block_boundaries_keep_the_exact_result_stream_and_short_last_page(monkeypatch, total):
    isolate(monkeypatch)
    qq = [{'slug': f'qq-{n}'} for n in range(20)]
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page(qq, 20)))
    async def source(**kwargs):
        start, size = kwargs['offset_override'], kwargs['limit']
        assert start == 0 or start < total, 'Do not trigger native last-page redirection'
        return page([{'slug': f'mdx-{n}'} for n in range(start, min(total, start + size))], total)
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', source)
    async def read():
        found = []
        for number in range(1, math.ceil((total + 20) / 24) + 1):
            kwargs = options()
            kwargs['page'] = number
            result = await manga.search(**kwargs)
            found.extend(row['slug'] for row in result['data']['items'])
            assert len(result['data']['items']) == min(24, total + 20 - (number - 1) * 24)
        assert found == [*(row['slug'] for row in qq), *(f'mdx-{n}' for n in range(total))]
    asyncio.run(read())


def test_real_source_cache_serves_four_ui_pages_with_one_upstream_request(monkeypatch):
    from unittest.mock import Mock
    from uuid import UUID
    from fastapi_app.services import mangadex_service as mdx
    isolate(monkeypatch)
    values, calls = {}, []
    store = Mock()
    store.get.side_effect = values.get
    store.set.side_effect = lambda key, value, **kwargs: values.__setitem__(key, value)
    store.set_many.side_effect = lambda entries, **kwargs: values.update(entries)
    monkeypatch.setattr(mdx, 'cache', store)
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page([{'slug': f'qq-{n}'} for n in range(20)], 20)))
    async def upstream(path, params):
        calls.append(dict(params))
        return {'total': 2754, 'data': [{'id': str(UUID(int=n + 1)), 'attributes': {'title': {'en': f'Book {n}'}}}
            for n in range(params['offset'], params['offset'] + params['limit'])]}
    monkeypatch.setattr(mdx, '_request_json', upstream)
    async def read():
        found = []
        for number in range(1, 7):
            kwargs = options()
            kwargs['page'] = number
            result = await manga.search(**kwargs)
            assert len(result['data']['items']) == 24
            found.extend(row['slug'] for row in result['data']['items'])
            assert len(calls) == (1 if number <= 4 else 2)
        assert len(set(found)) == len(found)
        assert [call['offset'] for call in calls] == [0, 96]
    asyncio.run(read())


def test_hidden_titles_before_the_requested_window_do_not_shift_later_pages(monkeypatch):
    isolate(monkeypatch)
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'mdx-1': 'hidden'}))
    monkeypatch.setattr(manga.truyenqq_service, 'search_manga', AsyncMock(return_value=page([{'slug': f'qq-{n}'} for n in range(20)], 20)))
    monkeypatch.setattr(manga.mangadex_service, 'search_manga', AsyncMock(return_value=page([{'slug': f'mdx-{n}'} for n in range(96)], 200)))
    kwargs = options()
    kwargs['page'] = 2
    result = asyncio.run(manga.search(**kwargs))
    assert [row['slug'] for row in result['data']['items']] == [f'mdx-{n}' for n in range(4, 28)]
