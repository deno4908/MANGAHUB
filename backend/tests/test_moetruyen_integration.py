import asyncio
from copy import deepcopy
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from fastapi_app.services import moetruyen_service as moe
from fastapi_app.services import card_metadata, catalog_visibility, truyenqq_service as qq
from fastapi_app.routers import manga, moetruyen
from fastapi_app.dependencies import get_supabase_public, get_optional_user


@pytest.fixture
def memory(monkeypatch):
    values = {}
    monkeypatch.setattr(moe.cache, 'get', lambda key: values.get(key))
    monkeypatch.setattr(moe.cache, 'set', lambda key, value, **kwargs: values.__setitem__(key, value))
    monkeypatch.setattr(moe.cache, 'get_many', lambda keys: {key: values.get(key) for key in keys})
    monkeypatch.setattr(moe.cache, 'set_many', lambda items, **kwargs: values.update(items))
    return values


def raw(identifier='1048'):
    return {'id': identifier, 'slug': identifier + '-book', 'title': 'Bữa cơm làm hòa',
        'url': 'https://truyen.moe/manga/' + identifier + '-book', 'genres': ['Comedy'],
        'adult': False, 'thumbnail_url': 'https://u.truyen.moe/uploads/covers/book.webp',
        'thumbnail_fallback_urls': [], 'status': 'Còn tiếp',
        'latest_chapter': {'number': '9.5', 'title': 'Ngoại truyện', 'updated_at': '1 ngày trước'}}


def test_source_ids_tokens_and_metadata_do_not_use_qq_or_mdx():
    row = moe.item(raw())
    assert row['id'] == row['slug'] == 'moe-1048'
    assert row['source'] == 'moetruyen'
    assert row['chaptersLatest'][0]['chapter_api_data'] == 'moe--1048--9.5'
    assert moe.chapter_identity('moe--1048--oneshot') == ('moe-1048', 'oneshot')
    assert not catalog_visibility.legacy_qq_identifier('moe-1048')
    assert moe.metadata(row)['source'] == 'moetruyen'
    assert row['view_count'] == 0
    for token in ['qq--1048--1', 'moe--1048--../../auth', 'moe--1048--1?url=https://example.com']:
        with pytest.raises(HTTPException):
            moe.chapter_identity(token)


def test_listing_maps_filters_and_source_pagination_without_scanning(memory, monkeypatch):
    observed = []
    class Source:
        def listing(self, filters):
            observed.append(filters)
            return {'items': [raw()], 'page': 3, 'page_size': 24, 'total': 2318, 'total_pages': 97}
    async def run(method, *args):
        return method(Source(), *args)
    monkeypatch.setattr(moe, 'run', run)
    monkeypatch.setattr(moe, 'get_categories', AsyncMock(return_value=[
        {'id': '13', 'slug': 'comedy', 'name': 'Comedy'}, {'id': '64', 'slug': 'ecchi', 'name': 'Ecchi'}]))
    result = asyncio.run(moe.get_filtered(3, 24, 'alphabetical', 'completed', ('comedy',), 'book', False))
    assert len(observed) == 1
    assert observed[0].sort == 'title_asc'
    assert observed[0].status == 'Hoàn thành'
    assert observed[0].include == ['13']
    assert observed[0].exclude == ['64']
    assert result['data']['params']['pagination'] == {'currentPage': 3, 'totalItemsPerPage': 24, 'totalItems': 2318, 'totalPages': 97}
    assert result['data']['items'][0]['slug'] == 'moe-1048'
    assert json.loads(memory['catalog:card-metadata:v1:moe-1048'])['source'] == 'moetruyen'


def test_unsupported_genre_returns_empty_instead_of_source_failure(memory, monkeypatch):
    monkeypatch.setattr(moe, 'get_categories', AsyncMock(return_value=[]))
    source = AsyncMock(side_effect=AssertionError('do not crawl unsupported genres'))
    monkeypatch.setattr(moe, 'run', source)
    result = asyncio.run(moe.get_filtered(genres=('not-on-moe',)))
    assert result['data']['items'] == []
    assert result['meta']['unsupported_genres'] == ['not-on-moe']
    source.assert_not_awaited()


def test_complete_detail_follows_all_chapter_pages_and_preserves_specials(memory, monkeypatch):
    first = {**raw(), 'chapters': [{'id': 'a', 'number': '10', 'title': 'Ten'}],
             'chapter_pagination': {'total_pages': 2}}
    all_rows = [{'id': 'a', 'number': '10'}, {'id': 'b', 'number': '9.5'}, {'id': 'c', 'number': 'oneshot'}]
    class Source:
        def detail(self, identifier):
            assert identifier == '1048'
            return deepcopy(first)
        def all_chapters(self, identifier):
            return {'items': all_rows, 'complete': True}
    async def run(method, *args):
        return method(Source(), *args)
    monkeypatch.setattr(moe, 'run', run)
    data = asyncio.run(qq.get_manga_detail('moe-1048'))
    assert data['meta']['chapters_complete'] is True
    assert [ch['chapter_api_data'] for ch in data['data']['item']['chapters'][0]['server_data']] == [
        'moe--1048--10', 'moe--1048--9.5', 'moe--1048--oneshot']


def test_moe_saved_metadata_never_uses_qq_matching(memory, monkeypatch):
    monkeypatch.setattr(moe, 'get_basic', AsyncMock(return_value=moe.item(raw())))
    monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=AssertionError('wrong source')))
    result = asyncio.run(card_metadata._qq_metadata('moe-1048'))
    assert result['title'] == raw()['title']
    assert result['source'] == 'moetruyen'


def test_updated_imgx_pages_are_rebased_without_leaking_reader_keys(monkeypatch):
    monkeypatch.setenv('MOE_READER_API_URL', 'https://renderer.example')
    monkeypatch.setenv('MOE_READER_API_KEY', 'server-only-test-key')
    remote = AsyncMock(return_value={'comic_title': 'Book', 'images': [
        {'index': 0, 'protected': True, 'url': '/api/v1/comics/1048/chapters/1/images/0?format=jpeg'},
        {'index': 1, 'protected': False, 'url': 'https://u.truyen.moe/page.jpg'}]})
    monkeypatch.setattr(moe, '_remote', remote)
    result = asyncio.run(qq.get_chapter('moe--1048--1'))
    assert result['data']['item']['chapter_image'] == [
        {'image_page': 0, 'image_file': '/api/manga/moetruyen/image/moe-1048/1/0'},
        {'image_page': 1, 'image_file': 'https://u.truyen.moe/page.jpg'}]
    assert 'server-only-test-key' not in json.dumps(result)
    assert 'renderer.example' not in json.dumps(result)
    remote.assert_awaited_once_with('/api/v1/comics/1048/chapters/1')


def test_qq_source_filter_does_not_absorb_moe_statistics():
    assert manga._trending_source_matches('moe-1048', 'all')
    assert not manga._trending_source_matches('moe-1048', 'truyenqq')
    assert not manga._trending_source_matches('moe-1048', 'mangadex')


def test_renderer_endpoint_accepts_only_server_key_and_proxies_image(monkeypatch):
    import base64
    from moetruyen_api.api import create_app
    from moetruyen_api.config import Settings
    from moetruyen_api.imgx import Frame
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XkAAAAASUVORK5CYII=')
    html = '<main data-reading-chapter-id="1"><div class="reader-pages" data-reader-total-pages="1"><img class="page-media" data-imgx-page-index="0" src="data:image/gif;base64,AA=="></div></main>'
    class Renderer:
        def render(self, url, cookie, index, **kwargs):
            assert index == 0
            return Frame(png, 1, 1, 'image/png')
        def prefetch(self, *args, **kwargs):
            pass
        def close(self):
            pass
    source_app = create_app(Settings(_env_file=None, api_key='server-key', imgx_prestart=False),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, text=html)), imgx_renderer=Renderer())
    client_type = httpx.AsyncClient
    def client(**kwargs):
        return client_type(transport=httpx.ASGITransport(source_app), **kwargs)
    monkeypatch.setattr(moe.httpx, 'AsyncClient', client)
    monkeypatch.setenv('MOE_READER_API_URL', 'https://renderer.example')
    monkeypatch.setenv('MOE_READER_API_KEY', 'server-key')
    assert asyncio.run(moe.get_image('moe-1048', '1', 0)) == (png, 'image/png')
    monkeypatch.setenv('MOE_READER_API_KEY', 'wrong-key')
    with pytest.raises(HTTPException) as error:
        asyncio.run(moe.get_image('moe-1048', '1', 0))
    assert error.value.status_code == 502  # source auth failure must not log out MangaHub users


def test_moe_popularity_promotes_local_views_without_losing_or_duplicating_native_slots(memory, monkeypatch):
    from fastapi_app.services import local_popular
    monkeypatch.setattr(moe.cache, 'add', lambda key, value, **kwargs: False if key in memory else (memory.__setitem__(key, value) or True))
    rows = [moe.item(raw(str(number))) for number in range(1, 6)]
    memory['catalog:card-metadata:v1:moe-4'] = json.dumps(moe.metadata(rows[3]))
    monkeypatch.setattr(manga, '_fetch_local_views_lookup', lambda db: {'moe-4': 12, 'qq-5': 100})
    async def source(genres, status, number, snapshot_key, show_mature):
        return {'data': {'items': rows, 'params': {'pagination': {'currentPage': 1, 'totalItemsPerPage': 5, 'totalItems': 5, 'totalPages': 1}}}}
    monkeypatch.setattr(local_popular, '_moe_source_page', source)
    async def check():
        pages = [await local_popular.qq_popular(page=page, limit=2, genres=(), status='', show_mature=True,
                   hidden={}, db=object(), source_name='moetruyen') for page in range(1, 4)]
        ids = [row['slug'] for page in pages for row in page['data']['items']]
        assert ids == ['moe-4', 'moe-2', 'moe-3', 'moe-1', 'moe-5']
        assert len(ids) == len(set(ids))
        assert pages[0]['data']['params']['pagination']['totalPages'] == 3
    asyncio.run(check())


def test_moe_http_listing_honors_admin_hiding_and_enrichment(monkeypatch):
    app = FastAPI()
    app.include_router(moetruyen.router, prefix='/api/manga')
    app.dependency_overrides[get_supabase_public] = lambda: object()
    app.dependency_overrides[get_optional_user] = lambda: None
    source_payload = {'data': {'items': [moe.item(raw()), moe.item(raw('1049'))]}}
    monkeypatch.setattr(moe, 'get_filtered', AsyncMock(return_value=source_payload))
    monkeypatch.setattr(manga, '_get_hidden_slugs', AsyncMock(return_value={'moe-1048': 'hidden'}))
    overrides = AsyncMock()
    monkeypatch.setattr(manga, '_attach_overrides_to_otruyen_payload', overrides)
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='https://test') as client:
            response = await client.get('/api/manga/moetruyen-filtered')
        assert response.status_code == 200
        assert [row['id'] for row in response.json()['data']['items']] == ['moe-1049']
        assert len(source_payload['data']['items']) == 2
    asyncio.run(check())
    overrides.assert_awaited_once()
