import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fastapi_app import main
from fastapi_app.services import cache_service, truyenqq_recovery as recovery, truyenqq_service as qq
from fastapi_app.services.truyenqq_transport import TruyenQQTransport
from test_catalog_updates import Cache

SECRET = 'fixture-qq-source-signing-key-not-production'
HTML = '<div class="list_grid"><a>Verified source page</a></div>'
PATH = '/tim-kiem-nang-cao/trang-5?category=85&sort=2'


def snapshot(path=PATH, html=HTML, *, observed=None, keyword=''):
    observed = int(time.time()) if observed is None else observed
    raw = json.dumps({'v': 1, 'path': path, 'keyword': keyword, 'observed': observed,
        'expires': observed + 120, 'sha256': hashlib.sha256(html.encode()).hexdigest()},
        ensure_ascii=False, separators=(',', ':')).encode()
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    return {'html': html, 'proof': encode(raw) + '.' + encode(hmac.new(SECRET.encode(), raw, hashlib.sha256).digest())}


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv('QQ_RECOVERY_SECRET', SECRET)
    value = Cache()
    monkeypatch.setattr(cache_service, 'cache', value)
    monkeypatch.setattr(qq, '_live', None)
    return value


def application(monkeypatch, allowed=True):
    monkeypatch.setattr(main, 'authorize_api_request', AsyncMock(return_value={'id': 'fixture', 'role': 'member'}))
    monkeypatch.setattr(main.access_policy, 'get_state', lambda **kwargs: {'enabled': True, 'message': 'Restricted'})
    monkeypatch.setattr(main.access_policy, 'is_allowed', lambda *args, **kwargs: allowed)
    app = FastAPI()
    app.middleware('http')(main.enforce_api_access_policy)
    app.add_middleware(recovery.QQRecoveryMiddleware, allowed_origins=['https://standby.mangahub.art'])
    @app.get('/api/manga/truyenqq-filtered')
    async def read():
        request = httpx.Request('GET', 'https://truyenqqko.com' + PATH)
        return {'html': recovery.lookup(request).decode(), 'reader_authorized': True}
    return TestClient(app)


def test_signed_handoff_replaces_one_read_retry_and_reuses_source_without_network(monkeypatch, store):
    client = application(monkeypatch)
    with client:
        response = client.post('/api/manga/truyenqq-filtered?page=8', json=snapshot(),
            headers={'X-TruyenQQ-Recovery': '1', 'Authorization': 'Bearer fixture'})
    assert response.status_code == 200
    assert response.json() == {'html': HTML, 'reader_authorized': True}
    assert response.headers['Cache-Control'] == 'private, no-store'
    main.authorize_api_request.assert_awaited_once_with('Bearer fixture', minimum_role=None)
    transport = TruyenQQTransport(edge_url='https://owned.example/api/truyenqq-edge')
    session = Mock(side_effect=AssertionError('An imported source must not fetch the relay again'))
    monkeypatch.setattr(transport, '_session', session)
    request = httpx.Request('GET', 'https://truyenqqko.com' + PATH)
    result = transport.handle_request(request)
    assert result.status_code == 200 and result.text == HTML
    session.assert_not_called()


def test_stale_http_success_exposes_recovery_but_never_turns_into_an_access_grant(monkeypatch, store):
    monkeypatch.setattr(qq, 'cache', store)
    monkeypatch.setattr(qq, 'run_live', AsyncMock(side_effect=AssertionError('No source call during cooldown')))
    hints = {'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/truyen-tranh/stale-123',
             'X-TruyenQQ-Recovery': '1'}
    store.values['truyenqq:detail-last-good:stale-123'] = json.dumps({'data': {'item': {
        'source': 'truyenqq', 'slug': 'stale-123', 'chapters': []}}})
    store.values['truyenqq:detail-refresh:stale-123:1'] = json.dumps(hints)
    client = application(monkeypatch)
    @client.app.get('/api/manga/detail/stale-123')
    async def read_stale():
        return await qq.get_manga_detail('stale-123')
    with client:
        response = client.get('/api/manga/detail/stale-123', headers={'Authorization': 'Bearer fixture'})
        assert response.status_code == 200
        assert response.json()['data']['item']['slug'] == 'stale-123'
        assert response.headers['X-TruyenQQ-Stale'] == '1'
        assert response.headers['X-TruyenQQ-Source-Path'] == '/truyen-tranh/stale-123'
        monkeypatch.setattr(main.access_policy, 'is_allowed', lambda *args, **kwargs: False)
        assert client.get('/api/manga/detail/stale-123', headers={'Authorization': 'Bearer fixture'}).status_code == 403
    qq.run_live.assert_not_awaited()


def test_each_coalesced_waiter_receives_stale_hints_in_its_own_request_context():
    import asyncio
    from fastapi_app.services.request_coalescing import coalesce_reads
    async def run():
        called = 0
        @recovery.surface_stale_hints
        @coalesce_reads
        async def shared():
            nonlocal called
            called += 1
            await asyncio.sleep(.01)
            return {'data': {'items': [], 'source_stale': {
                'X-TruyenQQ-Error': 'http-403', 'X-TruyenQQ-Source-Path': '/doc-truyen'}}}
        async def reader():
            hints = {}
            marker = recovery.response_hints.set(hints)
            try:
                await shared()
                return hints
            finally:
                recovery.response_hints.reset(marker)
        results = await asyncio.gather(*(reader() for _ in range(4)))
        assert called == 1
        assert all(value['X-TruyenQQ-Source-Path'] == '/doc-truyen' for value in results)
        assert recovery.response_hints.get() is None
    asyncio.run(run())


@pytest.mark.parametrize('kind', ['changed-body', 'changed-proof', 'expired', 'challenge', 'external-url'])
def test_untrusted_or_expired_snapshots_cannot_populate_shared_cache(monkeypatch, store, kind):
    value = snapshot()
    if kind == 'changed-body':
        value['html'] += ' changed'
    elif kind == 'changed-proof':
        value['proof'] = value['proof'][:-6] + 'AAAAAA'
    elif kind == 'expired':
        value = snapshot(observed=int(time.time()) - 121)
    elif kind == 'challenge':
        value = snapshot(html=HTML + '<script>challenge-platform</script>')
    else:
        value = snapshot(path='https://external.example/private')
    with application(monkeypatch) as client:
        response = client.post('/api/manga/truyenqq-filtered', json=value,
            headers={'X-TruyenQQ-Recovery': '1', 'Origin': 'https://standby.mangahub.art'})
    assert response.status_code == 400
    assert response.headers['Access-Control-Allow-Origin'] == 'https://standby.mangahub.art'
    assert not store.values
    main.authorize_api_request.assert_not_awaited()


def test_valid_source_proof_never_grants_a_reader_access(monkeypatch, store):
    with application(monkeypatch, allowed=False) as client:
        response = client.post('/api/manga/truyenqq-filtered', json=snapshot(),
            headers={'X-TruyenQQ-Recovery': '1', 'Authorization': 'Bearer unapproved'})
    assert response.status_code == 403
    assert not store.values
    main.authorize_api_request.assert_awaited_once()


def test_revoked_reader_and_mutation_paths_cannot_import_source(monkeypatch, store):
    with application(monkeypatch) as client:
        main.authorize_api_request.side_effect = HTTPException(403, 'Revoked')
        response = client.post('/api/manga/truyenqq-filtered', json=snapshot(),
            headers={'X-TruyenQQ-Recovery': '1', 'Authorization': 'Bearer revoked'})
        assert response.status_code == 403
        main.authorize_api_request.reset_mock()
        response = client.post('/api/admin/settings', json=snapshot(), headers={'X-TruyenQQ-Recovery': '1'})
        assert response.status_code == 400
        main.authorize_api_request.assert_not_awaited()
    assert not store.values


def test_replay_does_not_extend_source_freshness_and_search_keys_keep_exact_query(monkeypatch, store):
    now = int(time.time())
    monkeypatch.setattr(recovery.time, 'time', lambda: now)
    value = snapshot('/frontend/search/search', '<li>search_info</li>', observed=now - 100, keyword='Truyện thử')
    writes = Mock(wraps=store.set)
    monkeypatch.setattr(store, 'set', writes)
    recovery.accept(value)
    assert writes.call_args.kwargs['ttl'] == 20
    request = httpx.Request('POST', 'https://truyenqqko.com/frontend/search/search',
        data={'search': 'Truyện thử', 'type': '0'})
    assert recovery.lookup(request) == b'<li>search_info</li>'
    assert recovery.lookup(httpx.Request('POST', str(request.url), data={'search': 'different'})) is None
    assert recovery.lookup(httpx.Request('GET', 'https://external.example/frontend/search/search')) is None
    monkeypatch.setattr(recovery.time, 'time', lambda: now + 21)
    assert recovery.lookup(request) is None


def test_oversized_source_handoff_is_rejected_before_authorization(monkeypatch, store):
    with application(monkeypatch) as client:
        response = client.post('/api/manga/truyenqq-filtered', content=b'X' * (recovery.MAX_BYTES * 2 + 16385),
            headers={'X-TruyenQQ-Recovery': '1'})
    assert response.status_code == 413 and not store.values
    main.authorize_api_request.assert_not_awaited()


def test_a_cold_scraper_process_cannot_extend_the_signed_html_lifetime(monkeypatch, store):
    from truyenapi.truyenapi.client import SourceClient
    from truyenapi.truyenapi.config import Settings
    from truyenapi.truyenapi.service import LiveService
    recovery.accept(snapshot(observed=int(time.time()) - 110))
    transport = TruyenQQTransport(edge_url='https://owned.example/api/truyenqq-edge')
    monkeypatch.setattr(transport, '_session', Mock(side_effect=AssertionError('No source fetch is needed')))
    settings = Settings(request_delay=0, cache_ttl=60)
    service = LiveService(settings, SourceClient(settings, transport=transport))
    try:
        url = 'https://truyenqqko.com' + PATH
        assert service.html(url) == HTML
        assert 0 < service.html_cache.remaining(url) <= 10
    finally:
        service.close()
