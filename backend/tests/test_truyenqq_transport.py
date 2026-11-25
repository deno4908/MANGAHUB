from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from fastapi_app.services import truyenqq_transport as transport
from fastapi_app.services.truyenqq_service import _source_error_headers
from truyenapi.truyenapi.client import SourceClient
from truyenapi.truyenapi.config import Settings
from truyenapi.truyenapi.service import LiveService


@pytest.mark.parametrize('body,kind', [
    (b'{"code":"WHITELIST_REQUIRED"}', 'access-denied'),
    (b'<html>Just a moment <script>challenge-platform</script></html>', 'edge-challenge'),
    (b'Error 1027 daily requests limit', 'worker-quota'),
    (b'Other response', 'gateway-error'),
])
def test_gateway_diagnostic_contains_only_a_bounded_category(body, kind):
    value = SimpleNamespace(status_code=403, content=body, headers=httpx.Headers())
    assert transport._relay_failure_kind(value) == kind
    value.headers['x-truyenqq-relay'] = '1'
    assert transport._relay_failure_kind(value) is None


def test_policy_edge_challenge_is_classified_without_the_challenge_html():
    value = SimpleNamespace(status_code=503, content=b'{"error":"Access check unavailable"}',
                            headers=httpx.Headers({'X-Site-Access-Error': 'edge-challenge'}))
    assert transport._relay_failure_kind(value) == 'edge-challenge'


@pytest.mark.parametrize('denial', ['country', 'ticket', 'whitelist', 'authentication'])
def test_policy_denial_categories_do_not_include_credentials(denial):
    value = SimpleNamespace(status_code=403, content=b'{"code":"WHITELIST_REQUIRED"}',
                            headers=httpx.Headers({'X-Site-Access-Denial': denial}))
    assert transport._relay_failure_kind(value) == 'denied-' + denial


@pytest.fixture
def browser(monkeypatch):
    monkeypatch.setattr(transport.site_access, 'get_state', lambda: {'enabled': False})
    session = Mock()
    monkeypatch.setattr(transport, "Session", Mock(return_value=session))
    session.request.return_value = SimpleNamespace(
        status_code=200, content=b'<div class="list_grid"></div><a href="/tim-kiem-nang-cao/trang-2">2</a>',
        # curl has decompressed the bytes even though the headers still say gzip.
        headers=httpx.Headers({'content-encoding': 'gzip', 'content-type': 'text/html'}),
    )
    return session


def test_private_background_work_does_not_call_a_relay_that_would_deny_it(browser, monkeypatch):
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    monkeypatch.setattr(transport.site_access, 'get_state', lambda: {'enabled': True})
    marker = transport.source_authorization.set(None)
    client = httpx.Client(transport=transport.TruyenQQTransport(edge_url='https://worker.example/api/truyenqq-edge'))
    try:
        for path in ['/truyen-moi-cap-nhat/trang-1', '/frontend/search/search']:
            response = client.get('https://truyenqqko.com' + path)
            assert response.status_code == 403
            assert response.json()['code'] == 'WHITELIST_REQUIRED'
            assert response.extensions['truyenqq_transport'] == 'edge-gateway'
        browser.request.assert_not_called()
    finally:
        client.close()
        transport.source_authorization.reset(marker)


def test_private_reader_still_relays_normally_without_an_extra_policy_lookup(browser, monkeypatch):
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    def unexpected_lookup():
        raise AssertionError('Readers keep the existing relay authorization check')
    monkeypatch.setattr(transport.site_access, 'get_state', unexpected_lookup)
    marker = transport.source_authorization.set('AccessTicket verified-fixture')
    client = httpx.Client(transport=transport.TruyenQQTransport(edge_url='https://worker.example/api/truyenqq-edge'))
    try:
        assert client.get('https://truyenqqko.com/doc-truyen').status_code == 200
        browser.request.assert_called_once()
        assert browser.request.call_args.kwargs['headers']['Authorization'] == 'AccessTicket verified-fixture'
    finally:
        client.close()
        transport.source_authorization.reset(marker)


def test_background_relay_resumes_when_site_returns_to_public_mode(browser, monkeypatch):
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    state = {'enabled': True}
    monkeypatch.setattr(transport.site_access, 'get_state', lambda: state)
    marker = transport.source_authorization.set(None)
    client = httpx.Client(transport=transport.TruyenQQTransport(edge_url='https://worker.example/api/truyenqq-edge'))
    try:
        assert client.get('https://truyenqqko.com/doc-truyen').status_code == 403
        state['enabled'] = False
        assert client.get('https://truyenqqko.com/doc-truyen').status_code == 200
        browser.request.assert_called_once()
    finally:
        client.close()
        transport.source_authorization.reset(marker)


def test_missing_background_policy_never_starts_anonymous_relay_requests(browser, monkeypatch):
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    def unavailable():
        raise transport.site_access.AccessUnavailable('unavailable')
    monkeypatch.setattr(transport.site_access, 'get_state', unavailable)
    marker = transport.source_authorization.set(None)
    client = httpx.Client(transport=transport.TruyenQQTransport(edge_url='https://worker.example/api/truyenqq-edge'))
    try:
        assert client.get('https://truyenqqko.com/doc-truyen').status_code == 503
        browser.request.assert_not_called()
    finally:
        client.close()
        transport.source_authorization.reset(marker)


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
        response = client.request(source)
        assert response.status_code == 200
        assert response.extensions['truyenqq_transport'] == 'edge-gateway'
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


def test_verified_website_token_is_scoped_to_the_owned_relay_not_qq(browser):
    from site_access import source_authorization
    success = browser.request.return_value
    blocked = SimpleNamespace(status_code=403, content=b'Forbidden', headers=httpx.Headers())
    browser.request.side_effect = [blocked, success]
    marker = source_authorization.set('Bearer website-reader')
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport())
    try:
        client.request('https://truyenqqko.com/doc-truyen')
        direct, relay = browser.request.call_args_list
        assert 'Authorization' not in direct.kwargs['headers']
        assert relay.kwargs['headers']['Authorization'] == 'Bearer website-reader'
    finally:
        client.close()
        source_authorization.reset(marker)
    assert source_authorization.get() is None


def test_cold_vercel_browse_uses_the_owned_relay_before_a_direct_source_attempt(browser, monkeypatch):
    from site_access import source_authorization
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.delenv('TRUYENQQ_PREFER_EDGE', raising=False)
    marker = source_authorization.set('Bearer verified-reader')
    edge = 'https://worker.example/api/truyenqq-edge'
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url=edge))
    try:
        client.request('https://truyenqqko.com/tim-kiem-nang-cao/trang-3?sort=4')
        browser.request.assert_called_once()
        call = browser.request.call_args
        assert call.args == ('GET', edge + '/tim-kiem-nang-cao/trang-3?sort=4')
        assert call.kwargs['headers']['Authorization'] == 'Bearer verified-reader'
    finally:
        client.close()
        source_authorization.reset(marker)


@pytest.mark.parametrize('status', [403, 503])
def test_relay_access_failure_is_not_retried_directly_on_vercel(browser, monkeypatch, status):
    monkeypatch.setenv('VERCEL', '1')
    monkeypatch.delenv('TRUYENQQ_PREFER_EDGE', raising=False)
    browser.request.return_value.status_code = status
    edge = 'https://worker.example/api/truyenqq-edge'
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url=edge))
    try:
        with pytest.raises(httpx.HTTPStatusError):
            client.request('https://truyenqqko.com/tim-kiem-nang-cao/trang-3?sort=4')
        browser.request.assert_called_once()
        assert browser.request.call_args.args[1].startswith(edge)
    finally:
        client.close()


def test_source_rejection_at_the_authorized_relay_can_use_healthy_direct_egress(browser, monkeypatch):
    from site_access import source_authorization
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    success = browser.request.return_value
    blocked = SimpleNamespace(status_code=403, content=b'QQ rejected worker',
                              headers=httpx.Headers({'x-truyenqq-relay': '1', 'x-truyenqq-block': 'challenge'}))
    browser.request.side_effect = [blocked, success]
    marker = source_authorization.set('Bearer verified-reader')
    edge = 'https://worker.example/api/truyenqq-edge'
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url=edge))
    try:
        url = 'https://truyenqqko.com/tim-kiem-nang-cao/trang-1?sort=4'
        result = client.request(url)
        assert result.status_code == 200 and result.extensions['truyenqq_transport'] == 'direct'
        relay, direct = browser.request.call_args_list
        assert relay.args[1] == edge + '/tim-kiem-nang-cao/trang-1?sort=4'
        assert relay.kwargs['headers']['Authorization'] == 'Bearer verified-reader'
        assert direct.args[1] == url
        assert direct.kwargs['timeout'] == (3, 5)
        assert 'Authorization' not in direct.kwargs['headers']
    finally:
        client.close()
        source_authorization.reset(marker)


@pytest.mark.parametrize('direct_error', [False, True])
def test_both_egresses_failing_keep_the_relay_source_hints(browser, monkeypatch, direct_error):
    monkeypatch.setenv('TRUYENQQ_PREFER_EDGE', '1')
    blocked = SimpleNamespace(status_code=403, content=b'QQ source challenge',
                              headers=httpx.Headers({'x-truyenqq-relay': '1', 'x-truyenqq-block': 'challenge'}))
    direct = transport.Timeout('timeout') if direct_error else SimpleNamespace(
        status_code=403, content=b'Direct forbidden', headers=httpx.Headers())
    browser.request.side_effect = [blocked, direct]
    client = SourceClient(Settings(request_delay=0, retries=1), transport=transport.TruyenQQTransport(edge_url='https://worker.example/api/truyenqq-edge'))
    try:
        with pytest.raises(httpx.HTTPStatusError) as caught:
            client.request('https://truyenqqko.com/tim-kiem-nang-cao/trang-1?sort=4')
        hints = _source_error_headers(caught.value)
        assert hints['X-TruyenQQ-Error'] == 'http-403'
        assert hints['X-TruyenQQ-Transport'] == 'edge-source'
        assert hints['X-TruyenQQ-Block'] == 'challenge'
        assert hints['X-TruyenQQ-Source-Path'] == '/tim-kiem-nang-cao/trang-1?sort=4'
        assert browser.request.call_count == 2
    finally:
        client.close()
