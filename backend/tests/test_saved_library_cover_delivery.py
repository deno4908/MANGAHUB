import time
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import Response

from fastapi_app.routers import images, manga


MANGA = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f'
COVER = f'https://uploads.mangadex.org/covers/{MANGA}/cover.png.512.jpg'


@pytest.fixture
def cover_client(monkeypatch):
    app = FastAPI()
    app.include_router(manga.router, prefix='/api/manga')
    lookup = AsyncMock(return_value=COVER)
    monkeypatch.setattr(manga.mangadex_service, 'get_cover_url', lookup)
    monkeypatch.setattr(images, '_host_validation_cache', {
        'uploads.mangadex.org': (time.time() + 300, None)})
    return TestClient(app), lookup


@pytest.mark.parametrize('size', [256, 512])
def test_saved_cover_returns_image_in_one_request_and_shares_the_image_cache(cover_client, monkeypatch, size):
    client, lookup = cover_client
    source = COVER.replace('.512.jpg', f'.{size}.jpg')
    keys = []

    def cached(path, request, **kwargs):
        keys.append(path.name)
        assert request.headers.get('if-none-match') == '"saved-cover"'
        return Response(status_code=304, headers={
            'ETag': '"saved-cover"', 'Cache-Control': 'private, no-store', 'X-Cache': 'HIT'})

    monkeypatch.setattr(images, '_cached_image_response', cached)
    response = client.get(f'/api/manga/mangadex-cover/{MANGA}?size={size}',
                          headers={'If-None-Match': '"saved-cover"'}, follow_redirects=False)
    assert response.status_code == 304
    assert response.history == [] and 'location' not in response.headers
    assert response.headers['etag'] == '"saved-cover"'
    assert response.headers['cache-control'] == 'private, no-store'
    assert keys == [images._cache_key(source)]
    lookup.assert_awaited_once_with(MANGA)


def test_cold_saved_cover_fetches_the_thumbnail_once_without_a_redirect(cover_client, monkeypatch):
    client, _ = cover_client
    fetch = AsyncMock(return_value=(b'cover-bytes', COVER, 'image/jpeg', 'httpx'))
    monkeypatch.setattr(images, '_cached_image_response', lambda *a, **kw: None)
    monkeypatch.setattr(images, '_fetch_image', fetch)
    monkeypatch.setattr(images, '_write_cache_atomic', lambda *a: None)
    monkeypatch.setattr(images, 'schedule_image_cache_prune', lambda: None)
    response = client.get(f'/api/manga/mangadex-cover/{MANGA}?size=256', follow_redirects=False)
    assert response.status_code == 200 and response.content == b'cover-bytes'
    assert response.headers['content-type'].startswith('image/')
    assert 'location' not in response.headers
    fetch.assert_awaited_once_with(COVER.replace('.512.jpg', '.256.jpg'), retry_hint=0)


@pytest.mark.parametrize('suffix', ['/invalid?size=256', f'/{MANGA}?size=100'])
def test_invalid_saved_cover_does_not_contact_the_source(cover_client, suffix):
    client, lookup = cover_client
    assert client.get('/api/manga/mangadex-cover' + suffix).status_code == 400
    lookup.assert_not_awaited()


def test_missing_saved_cover_remains_a_not_found(cover_client):
    client, lookup = cover_client
    lookup.return_value = None
    assert client.get(f'/api/manga/mangadex-cover/{MANGA}').status_code == 404


def test_saved_cover_still_uses_the_image_url_security_checks(cover_client, monkeypatch):
    client, lookup = cover_client
    lookup.return_value = 'https://untrusted.example/private.png'
    fetch = AsyncMock()
    monkeypatch.setattr(images, '_fetch_image', fetch)
    assert client.get(f'/api/manga/mangadex-cover/{MANGA}', follow_redirects=False).status_code == 400
    fetch.assert_not_awaited()
