from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from fastapi_app.services import truyenqq_transport as transport
from fastapi_app.services.truyenqq_service import _source_error_headers
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
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url=''))
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


@pytest.mark.parametrize('error, code', [
    (ValueError('Source redirected to https://source.example/?token=private'), 'redirect'),
    (ValueError('Missing comic listing; source may be blocked or layout changed'), 'invalid-listing'),
    (ValueError('Unexpected search response; source may be blocked or layout changed'), 'invalid-search'),
    (httpx.ConnectError('private transport details'), 'network'),
    (httpx.ReadTimeout('private transport details'), 'timeout'),
    (httpx.HTTPStatusError('private response details', request=httpx.Request('GET', 'https://source.example'),
                          response=httpx.Response(403)), 'http-403'),
])
def test_source_error_diagnostics_are_bounded_and_not_cacheable(error, code):
    assert _source_error_headers(error) == {'X-TruyenQQ-Error': code, 'Cache-Control': 'no-store'}


def test_blocked_datacenter_retries_same_qq_filter_via_edge_then_reuses_it(browser):
    edge = 'https://worker.example/api/truyenqq-edge'
    success = browser.request.return_value
    blocked = SimpleNamespace(status_code=403, content=b'Forbidden', headers=httpx.Headers())
    browser.request.side_effect = [blocked, success, success]
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url=edge))
    client.http.headers['Authorization'] = 'private-header'
    client.http.cookies.set('private', 'cookie')
    try:
        source = 'https://truyenqqko.com/tim-kiem-nang-cao/trang-2?sort=4&category=26'
        assert client.request(source).status_code == 200
        client.request('https://truyenqqko.com/frontend/search/search', data={'search': 'one piece', 'type': 0})
        calls = browser.request.call_args_list
        assert calls[0].args[1] == source
        assert calls[1].args[1] == edge + '/tim-kiem-nang-cao/trang-2?sort=4&category=26'
        assert calls[2].args[:2] == ('POST', edge + '/frontend/search/search')
        assert calls[2].kwargs['data'] == b'search=one+piece&type=0'
        assert client.http.cookies.get('private') == 'cookie'
        for call in calls[1:]:
            assert set(call.kwargs['headers']).isdisjoint({'host', 'authorization', 'cookie'})
    finally:
        client.close()


@pytest.mark.parametrize('url, method', [
    ('https://img.example/cover.jpg', 'GET'),
    ('https://truyenqqko.com/frontend/comment/list', 'POST'),
])
def test_edge_fallback_does_not_relay_other_hosts_or_other_posts(browser, url, method):
    browser.request.return_value.status_code = 403
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    try:
        with pytest.raises(httpx.HTTPStatusError):
            client.request(url, data={'x': 'y'} if method == 'POST' else None)
        assert browser.request.call_count == 1
    finally:
        client.close()


def test_browser_recovery_hint_contains_only_public_source_fields():
    request = httpx.Request('POST', 'https://truyenqqko.com/frontend/search/search',
                            headers={'Authorization': 'private-token', 'Cookie': 'private-cookie'},
                            data={'search': 'one piece', 'type': '0', 'csrf': 'private-csrf'})
    error = httpx.HTTPStatusError('blocked', request=request, response=httpx.Response(403))
    hints = _source_error_headers(error)
    assert hints['X-TruyenQQ-Source-Path'] == '/frontend/search/search'
    assert hints['X-TruyenQQ-Search'] == 'one%20piece'
    assert 'private' not in str(hints)
