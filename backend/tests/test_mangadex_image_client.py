import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from fastapi_app.routers import images


COVER = "https://uploads.mangadex.org/covers/4509fd84-c003-4c57-ab07-e207e6999dab/cover.jpg.512.jpg"
PAGE = "https://node.mangadex.network/data/hash/page.jpg"
JPEG = b"\xff\xd8\xffimage-test"


@pytest.mark.parametrize("url", [COVER, PAGE])
def test_httpx_image_request_identifies_as_a_server_client(monkeypatch, url):
    async def run():
        seen = []

        def upstream(request):
            seen.append(request)
            if "Mozilla/" in request.headers.get("user-agent", ""):
                return httpx.Response(302, headers={"Location": "https://mangadex.org/edge/challenge"})
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"}, content=JPEG)

        monkeypatch.setattr(images, "_validate_image_url", AsyncMock(return_value=None))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            monkeypatch.setattr(images, "_mangadex_http_client", client)
            assert await images._fetch_once_httpx(url) == (JPEG, "image/jpeg", "", False)
        request, = seen
        assert request.headers["user-agent"].startswith("MangaHub/")
        assert "cookie" not in request.headers
        assert request.headers["referer"].startswith("https://mangadex.org/")

    asyncio.run(run())


@pytest.mark.parametrize("url", [COVER, PAGE])
def test_curl_image_request_uses_the_same_identity(monkeypatch, url):
    seen = []

    def get(target, **kwargs):
        seen.append((target, kwargs))
        if "Mozilla/" in kwargs["headers"]["User-Agent"]:
            return SimpleNamespace(status_code=302, headers={"location": "https://mangadex.org/edge/challenge"})
        return SimpleNamespace(status_code=200, headers={"content-type": "image/jpeg"},
                               iter_content=lambda **kwargs: iter([JPEG]), close=lambda: None)

    monkeypatch.setattr(images, "_validate_image_url_sync", lambda _: None)
    monkeypatch.setattr(images, "_get_curl_session", lambda: SimpleNamespace(get=get))
    assert images._fetch_once_curl_sync(url) == (JPEG, "image/jpeg", "", False)
    assert len(seen) == 1
    assert seen[0][1]["allow_redirects"] is False


def test_image_client_still_rejects_html_instead_of_caching_it(monkeypatch):
    async def run():
        monkeypatch.setattr(images, "_validate_image_url", AsyncMock(return_value=None))
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(
            200, headers={"Content-Type": "text/html"}, content=b"<html>challenge</html>"
        ))) as client:
            monkeypatch.setattr(images, "_mangadex_http_client", client)
            data, content_type, error, _ = await images._fetch_once_httpx(COVER)
        assert data is None and content_type is None
        assert error

    asyncio.run(run())


@pytest.mark.parametrize('status', [403, 404, 429, 503])
def test_one_http_error_does_not_close_a_pool_with_other_images_in_flight(monkeypatch, status):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        class PageStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                started.set()
                await release.wait()
                yield JPEG
        def upstream(request):
            if request.url.path.endswith('missing.jpg'):
                return httpx.Response(status)
            return httpx.Response(200, headers={'Content-Type':'image/jpeg'}, stream=PageStream())
        monkeypatch.setattr(images, '_validate_image_url', AsyncMock(return_value=None))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            monkeypatch.setattr(images, '_mangadex_http_client', client)
            # The real reset closes all connections, including the healthy
            # page body that has not finished yet.
            reset = AsyncMock(side_effect=client.aclose)
            monkeypatch.setattr(images, '_reset_client', reset)
            pending = asyncio.create_task(images._fetch_once_httpx(PAGE))
            try:
                await asyncio.wait_for(started.wait(), 1)
                result = await images._fetch_once_httpx(PAGE.replace('page.jpg','missing.jpg'))
                assert result[0] is None and f'HTTP {status}' in result[2]
                assert not client.is_closed
                reset.assert_not_awaited()
            finally:
                release.set()
            assert (await pending)[0] == JPEG
    asyncio.run(run())
