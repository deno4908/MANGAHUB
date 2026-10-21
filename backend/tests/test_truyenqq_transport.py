from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from fastapi_app.services import truyenqq_transport as transport
from truyenapi.truyenapi.client import SourceClient
from truyenapi.truyenapi.config import Settings
from truyenapi.truyenapi.service import LiveService


@pytest.fixture
def browser(monkeypatch):
    session = Mock()
    monkeypatch.setattr(transport, "Session", Mock(return_value=session))
    session.request.return_value = SimpleNamespace(
        status_code=200, content=b'<div class="list_grid"></div><a href="/tim-kiem-nang-cao/trang-2">2</a>',
        # curl has decompressed the bytes even though the headers still say gzip.
        headers=httpx.Headers({'content-encoding': 'gzip', 'content-type': 'text/html'}),
    )
    return session


def test_browser_transport_preserves_filters_and_search_form(browser):
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    service = LiveService(client.settings, client)
    try:
        assert service.discover(page=2, sort='views_desc', status='completed')['items'] == []
        request = browser.request.call_args
        assert request.args == ('GET', 'https://truyenqqko.com/tim-kiem-nang-cao/trang-2?sort=4&status=2')
        assert request.kwargs['allow_redirects'] is False
        assert request.kwargs['headers']['referer'] == 'https://truyenqqko.com/'
        assert 'user-agent' not in request.kwargs['headers']
        browser.request.return_value.content = b'''<li><a href="/truyen-tranh/one-piece-128">
            <div class="search_info"><p class="name">One Piece</p></div></a></li>'''
        assert service.search('one piece')['items'][0]['title'] == 'One Piece'
        request = browser.request.call_args
        assert request.args == ('POST', 'https://truyenqqko.com/frontend/search/search')
        assert request.kwargs['data'] == b'search=one+piece&type=0'
        assert request.kwargs['headers']['content-type'] == 'application/x-www-form-urlencoded'
        transport.Session.assert_called_once_with(impersonate='chrome131')
    finally:
        service.close()
    browser.close.assert_called_once()


@pytest.mark.parametrize('status', [403, 429, 503])
def test_browser_transport_keeps_http_errors_for_source_policy(browser, status):
    browser.request.return_value.status_code = status
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    try:
        with pytest.raises(httpx.HTTPStatusError) as error:
            client.request('https://truyenqqko.com/doc-truyen')
        assert error.value.response.status_code == status
    finally:
        client.close()


def test_source_redirect_still_requires_explicit_domain_configuration(browser):
    browser.request.return_value.status_code = 302
    browser.request.return_value.headers = httpx.Headers({'location': 'https://other.example/doc-truyen'})
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    try:
        with pytest.raises(ValueError, match='Source redirected'):
            client.request('https://truyenqqko.com/doc-truyen')
        assert browser.request.call_count == 1
    finally:
        client.close()


def test_invalid_listing_does_not_poison_retry_cache(browser):
    browser.request.return_value.content = b'<html>Source temporarily blocked</html>'
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    service = LiveService(client.settings, client)
    try:
        with pytest.raises(ValueError, match='Missing comic listing'):
            service.discover(sort='views_desc')
        browser.request.return_value.content = b'<div class="list_grid"></div>'
        assert service.discover(sort='views_desc')['items'] == []
        assert browser.request.call_count == 2
    finally:
        service.close()


@pytest.mark.parametrize('browser_error, http_error', [
    (transport.Timeout('timeout'), httpx.ReadTimeout),
    (transport.RequestException('network error'), httpx.ConnectError),
])
def test_browser_network_errors_keep_httpx_retry_semantics(browser, browser_error, http_error):
    browser.request.side_effect = browser_error
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    try:
        with pytest.raises(http_error):
            client.request('https://truyenqqko.com/doc-truyen')
    finally:
        client.close()
