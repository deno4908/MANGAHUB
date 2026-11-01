import asyncio
from unittest.mock import Mock

import httpx
import pytest

from fastapi_app.services import mangadex_service as mdx


def test_httpx_identifies_as_an_api_client_without_browser_cookies(monkeypatch):
    async def run():
        requests = []

        def upstream(request):
            requests.append(request)
            # Reproduce the upstream distinction: browser-looking traffic is
            # challenged, while a server API client gets the API object.
            if "Mozilla/" in request.headers.get("user-agent", ""):
                return httpx.Response(302, headers={"Location": "https://mangadex.org/edge/challenge"})
            return httpx.Response(200, json={"result": "ok", "data": []})

        async with httpx.AsyncClient(
            headers=mdx.REQUEST_HEADERS, transport=httpx.MockTransport(upstream)
        ) as client:
            monkeypatch.setattr(mdx, "_http_client", client)
            assert await mdx._request_json_via_httpx(mdx.BASE_URL + "/manga", {"limit": 1}) == {
                "result": "ok", "data": []
            }
        request, = requests
        assert request.headers["user-agent"].startswith("MangaHub/")
        assert "cookie" not in request.headers
        assert "origin" not in request.headers
        assert request.url.params["limit"] == "1"

    asyncio.run(run())


@pytest.mark.parametrize("status,headers,body", [
    (302, {"Location": "https://mangadex.org/edge/challenge?pbchal=private-challenge"}, b"redirect"),
    (200, {"Content-Type": "text/html"}, b"<html>private-challenge</html>"),
    (403, {"Content-Type": "text/html"}, b"<html>private-challenge</html>"),
    (307, {"Location": "https://untrusted.example/private-challenge"}, b"redirect"),
])
def test_redirects_and_html_stop_at_the_api_without_exposing_challenge(monkeypatch, status, headers, body):
    async def run():
        requests = []

        def upstream(request):
            requests.append(request)
            assert request.url.host == "api.mangadex.org"
            return httpx.Response(status, headers=headers, content=body)

        # Even a caller-configured redirect-following client must not follow
        # a challenge or send the API request on to another host.
        async with httpx.AsyncClient(
            follow_redirects=True, transport=httpx.MockTransport(upstream)
        ) as client:
            monkeypatch.setattr(mdx, "_http_client", client)
            with pytest.raises(mdx._MangaDexStatusError) as caught:
                await mdx._request_json_via_httpx(mdx.BASE_URL + "/manga", {})
        assert len(requests) == 1
        assert caught.value.status_code == 503
        assert caught.value.retry_after == "30"
        assert "private-challenge" not in str(caught.value)

    asyncio.run(run())


def test_curl_uses_the_same_api_identity_and_stops_before_a_challenge(monkeypatch):
    response = httpx.Response(302, headers={
        "Location": "https://mangadex.org/edge/challenge?pbchal=private-challenge"
    })
    session = Mock()
    session.get.return_value = response
    factory = Mock(return_value=session)
    monkeypatch.setattr(mdx, "CurlSession", factory)
    monkeypatch.setattr(mdx, "_curl_session", None)
    with pytest.raises(mdx._MangaDexStatusError):
        mdx._request_json_via_curl_sync(mdx.BASE_URL + "/manga", {"limit": 1})
    assert factory.call_args.kwargs["headers"]["User-Agent"].startswith("MangaHub/")
    assert session.get.call_args.kwargs["allow_redirects"] is False
    assert session.get.call_count == 1


def test_json_rate_limit_retains_its_status_and_retry_after():
    response = httpx.Response(429, headers={"Retry-After": "12"}, json={"result": "error"})
    with pytest.raises(mdx._MangaDexStatusError) as caught:
        mdx._decode_api_response(response)
    assert caught.value.status_code == 429
    assert caught.value.retry_after == "12"


@pytest.mark.parametrize("body", [b"not json", b"[]", b"null"])
def test_non_api_payloads_are_never_returned_for_caching(body):
    response = httpx.Response(200, headers={"Content-Type": "application/json"}, content=body)
    with pytest.raises(mdx._MangaDexNetworkError):
        mdx._decode_api_response(response)
