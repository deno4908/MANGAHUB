from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import Header, HTTPException, Request
from fastapi.responses import Response
from fastapi.testclient import TestClient
from itsdangerous.timed import TimestampSigner

import site_access as policy
from config import config
from fastapi_app import dependencies, main

REAL_GET_STATE = policy.get_state
ADMIN = '11111111-1111-4111-8111-111111111111'
READER = '22222222-2222-4222-8222-222222222222'
OTHER = '33333333-3333-4333-8333-333333333333'
MODERATOR = '44444444-4444-4444-8444-444444444444'
UPLOADER = '55555555-5555-4555-8555-555555555555'
BANNED = '66666666-6666-4666-8666-666666666666'


class Query:
    def __init__(self, db, name):
        self.db, self.name, self.filters, self.payload, self.removing = db, name, [], None, False
        self.start, self.stop = 0, None

    def select(self, *args, **kwargs): return self
    def order(self, *args, **kwargs): return self
    def eq(self, key, value):
        self.filters.append(lambda row: row.get(key) == value)
        return self
    def like(self, key, value):
        self.filters.append(lambda row: row.get(key, '').startswith(value[:-1]))
        return self
    def in_(self, key, values):
        self.filters.append(lambda row: row.get(key) in values)
        return self
    def limit(self, count):
        self.stop = count
        return self
    def range(self, start, end):
        self.start, self.stop = start, end + 1
        return self
    def upsert(self, payload, **kwargs):
        self.payload = payload
        return self
    def delete(self):
        self.removing = True
        return self
    def execute(self):
        rows = self.db.rows[self.name]
        if self.payload:
            rows[:] = [row for row in rows if row.get('key') != self.payload['key']]
            rows.append(deepcopy(self.payload))
            return SimpleNamespace(data=[self.payload])
        selected = [row for row in rows if all(check(row) for check in self.filters)]
        if self.removing:
            rows[:] = [row for row in rows if row not in selected]
        return SimpleNamespace(data=deepcopy(selected[self.start:self.stop]))


class DB:
    def __init__(self):
        self.rows = {'system_settings': [{'key': policy.SETTING_KEY, 'value': {'enabled': True}}],
                     'profiles': [{'id': uid, 'username': 'test-' + role, 'email': role + '@example.test', 'role': role}
                                  for uid, role in [(ADMIN, 'admin'), (READER, 'reader'), (OTHER, 'reader'), (MODERATOR, 'moderator'), (UPLOADER, 'uploader'), (BANNED, 'reader')]]}
    def table(self, name): return Query(self, name)


@main.app.get('/api/_site-access-test')
async def private_content(request: Request):
    return {'chapter': 'private chapter', 'source_actor': policy.source_authorization.get()}


@main.app.get('/api/images/_site-access-test')
async def private_image():
    return Response(b'image-bytes', media_type='image/png', headers={'Cache-Control': 'public,max-age=3600', 'Vercel-CDN-Cache-Control': 'public,s-maxage=3600'})


@main.app.post('/api/_site-access-test')
async def private_mutation(): return {'ok': True}


@pytest.fixture(autouse=True)
def isolated_policy(monkeypatch):
    db = DB()
    monkeypatch.setattr(policy, '_db', lambda: db)
    monkeypatch.setattr(policy, '_cache', {})
    monkeypatch.setattr(policy, 'get_state', REAL_GET_STATE)
    monkeypatch.setattr(config, 'FLASK_SECRET_KEY', 'test-site-access-signing-secret-32-characters')
    monkeypatch.setattr(config, 'FRONTEND_URL', 'https://mangahub.art')
    roles = {'admin': (ADMIN, 'admin'), 'reader': (READER, 'reader'), 'other': (OTHER, 'reader'),
             'moderator': (MODERATOR, 'moderator'), 'uploader': (UPLOADER, 'uploader')}
    async def authenticate(authorization: str = Header(None)):
        token = (authorization or '').removeprefix('Bearer ')
        if token == 'banned':
            raise HTTPException(403, dependencies.BANNED_ACCOUNT_DETAIL)
        if token not in roles:
            raise HTTPException(401, 'Invalid test token')
        uid, role = roles[token]
        return {'id': uid, 'role': role}
    original = dependencies.get_current_user
    monkeypatch.setattr(dependencies, 'get_current_user', authenticate)
    main.app.dependency_overrides[original] = authenticate
    monkeypatch.setattr(main, 'get_maintenance_state_async', _maintenance_off)
    yield db
    main.app.dependency_overrides.pop(original, None)


async def _maintenance_off(): return {'enabled': False}


@pytest.fixture
def client():
    # No lifespan jobs, external HTTP calls, or shared production data.
    return TestClient(main.app, base_url='https://api.mangahub.art')


def auth(token): return {'Authorization': 'Bearer ' + token}


@pytest.mark.parametrize('token', [None, 'reader', 'moderator', 'uploader'])
@pytest.mark.parametrize('path', ['/api/_site-access-test', '/api/images/_site-access-test', '/api/manga/detail/private-book', '/api/manga/mangadex/chapter/private-chapter', '/api/uploads/published/private-book'])
def test_every_content_namespace_denies_nonmembers(client, token, path):
    response = client.get(path, headers=auth(token) if token else {})
    assert response.status_code == 403
    assert response.json()['code'] == 'WHITELIST_REQUIRED'
    assert response.headers['cache-control'].startswith('no-store')


def test_admin_is_never_required_to_be_a_member(client):
    response = client.get('/api/_site-access-test', headers=auth('admin'))
    assert response.status_code == 200
    assert response.json()['source_actor'] == 'Bearer admin'
    assert policy.source_authorization.get() is None


def test_admin_can_grant_revoke_and_preserve_other_members(client):
    for uid in [READER, OTHER]:
        for _ in range(2):
            assert client.put('/api/admin/site-access/members/' + uid, headers=auth('admin'), json={'allowed': True}).status_code == 200
    assert client.get('/api/_site-access-test', headers=auth('reader')).status_code == 200
    assert client.put('/api/admin/site-access/members/' + READER, headers=auth('admin'), json={'allowed': False}).status_code == 200
    assert client.get('/api/_site-access-test', headers=auth('reader')).status_code == 403
    assert client.get('/api/_site-access-test', headers=auth('other')).status_code == 200
    data = client.get('/api/admin/site-access', headers=auth('admin')).json()
    assert [member['id'] for member in data['members']] == [OTHER]


@pytest.mark.parametrize('token', [None, 'reader', 'moderator', 'uploader'])
def test_only_admin_can_manage_access(client, token):
    headers = auth(token) if token else {}
    policy.set_member(READER, True, ADMIN)
    for method, path, body in [('GET', '/api/admin/site-access', None), ('PUT', '/api/admin/site-access', {'enabled': False}),
                               ('PUT', '/api/admin/site-access/members/' + OTHER, {'allowed': True})]:
        response = client.request(method, path, headers=headers, json=body)
        assert response.status_code in {401, 403}
    assert policy.get_state()['enabled'] is True
    assert not policy.is_allowed(policy.get_state(), {'id': OTHER, 'role': 'reader'})


def test_turning_mode_off_opens_content_and_turning_on_closes_it(client):
    assert client.put('/api/admin/site-access', headers=auth('admin'), json={'enabled': False}).status_code == 200
    response = client.get('/api/_site-access-test')
    assert response.status_code == 200
    assert response.headers['vercel-cdn-cache-control'] == 'no-store'
    assert client.put('/api/admin/site-access', headers=auth('admin'), json={'enabled': True}).status_code == 200
    assert client.get('/api/_site-access-test').status_code == 403


def test_status_is_public_but_does_not_disclose_whitelist(client):
    policy.set_member(READER, True, ADMIN)
    response = client.get('/api/site-access')
    assert response.status_code == 200
    assert response.json() == {'enabled': True, 'allowed': False, 'authenticated': False, 'is_admin': False, 'message': policy.DEFAULT_MESSAGE}
    assert READER not in response.text and 'example.test' not in response.text


def test_allowed_account_gets_http_only_host_cookie_for_images_and_revocation_wins(client):
    policy.set_member(READER, True, ADMIN)
    status = client.get('/api/site-access', headers=auth('reader'))
    cookie = status.headers['set-cookie'].lower()
    assert all(flag in cookie for flag in ['httponly', 'secure', 'samesite=lax', 'path=/', 'max-age=300'])
    assert 'domain=' not in cookie
    response = client.get('/api/images/_site-access-test')
    assert response.status_code == 200 and response.content == b'image-bytes'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['vercel-cdn-cache-control'] == 'no-store'
    assert client.post('/api/_site-access-test', json={}).status_code == 403  # Cookie cannot authorize mutations.
    assert client.put('/api/admin/site-access', json={'enabled': False}).status_code == 401
    policy.set_member(READER, False, ADMIN)
    assert client.get('/api/images/_site-access-test').status_code == 403


def test_status_ignores_old_cookie_after_logout_and_clears_it(client):
    policy.set_member(READER, True, ADMIN)
    client.get('/api/site-access', headers=auth('reader'))
    status = client.get('/api/site-access')
    assert status.json()['allowed'] is False
    assert 'Max-Age=0' in status.headers['set-cookie']
    assert client.get('/api/images/_site-access-test').status_code == 403


@pytest.mark.parametrize('cookie', ['forged-admin', '', 'e30.invalid.signature'])
def test_forged_image_grants_cannot_bypass_whitelist(client, cookie):
    client.cookies.set(policy.COOKIE_NAME, cookie)
    assert client.get('/api/images/_site-access-test').status_code == 403


def test_expired_grant_is_rejected_even_for_a_member(client, monkeypatch):
    policy.set_member(READER, True, ADMIN)
    monkeypatch.setattr(TimestampSigner, 'get_timestamp', lambda self: 1000)
    client.get('/api/site-access', headers=auth('reader'))
    monkeypatch.setattr(TimestampSigner, 'get_timestamp', lambda self: 1301)
    assert client.get('/api/images/_site-access-test').status_code == 403


@pytest.mark.parametrize('token', ['invalid', 'banned'])
def test_membership_does_not_allow_invalid_or_banned_tokens(client, token):
    policy.set_member(READER, True, ADMIN)
    assert client.get('/api/_site-access-test', headers=auth(token)).status_code in {401, 403}


def test_policy_database_failure_fails_closed_but_admin_can_reach_management(client, monkeypatch):
    def failed(): raise RuntimeError('private database connection details')
    monkeypatch.setattr(policy, '_db', failed)
    response = client.get('/api/_site-access-test')
    assert response.status_code == 503
    assert response.json()['code'] == 'SITE_ACCESS_UNAVAILABLE'
    assert 'private database' not in response.text
    assert client.get('/api/_site-access-test', headers=auth('admin')).status_code == 200
    assert client.get('/api/site-access').status_code == 503
    for token in ['reader', 'moderator', 'uploader']:
        assert client.get('/api/site-access', headers=auth(token)).status_code == 503
    admin_status = client.get('/api/site-access', headers=auth('admin'))
    assert admin_status.status_code == 200
    assert admin_status.json()['allowed'] is True
    assert admin_status.json()['is_admin'] is True
    assert admin_status.json()['enabled'] is True
    assert 'private database' not in admin_status.text


def test_missing_policy_is_public_by_default_but_malformed_policy_is_not(isolated_policy):
    isolated_policy.rows['system_settings'] = []
    assert policy.get_state()['enabled'] is False
    isolated_policy.rows['system_settings'] = [{'key': policy.SETTING_KEY, 'value': {'enabled': 'true'}}]
    with pytest.raises(policy.AccessUnavailable): policy.get_state(force=True)


def test_cross_instance_revocation_is_rechecked_after_short_cache_ttl(client, isolated_policy, monkeypatch):
    policy.set_member(READER, True, ADMIN)
    assert client.get('/api/_site-access-test', headers=auth('reader')).status_code == 200
    isolated_policy.rows['system_settings'] = [row for row in isolated_policy.rows['system_settings'] if row['key'] != policy.MEMBER_PREFIX + READER]
    for key, (_, value) in list(policy._cache.items()):
        policy._cache[key] = (0, value)
    assert client.get('/api/_site-access-test', headers=auth('reader')).status_code == 403
    assert policy.CACHE_SECONDS <= 3


def test_admin_input_validation(client):
    assert client.put('/api/admin/site-access', headers=auth('admin'), json={'enabled': 'true'}).status_code == 422
    assert client.put('/api/admin/site-access/members/not-a-uuid', headers=auth('admin'), json={'allowed': True}).status_code == 422
    absent = '77777777-7777-4777-8777-777777777777'
    assert client.put('/api/admin/site-access/members/' + absent, headers=auth('admin'), json={'allowed': True}).status_code == 404


def test_preflight_and_health_remain_available(client):
    assert client.get('/health').status_code == 200
    origin = main._cors_origins[0]
    response = client.options('/api/images/_site-access-test', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == origin


def test_already_connected_stream_stops_exposing_updates_after_revocation(monkeypatch):
    import asyncio
    from fastapi_app.routers import catalog_updates
    policy.set_member(READER, True, ADMIN)
    async def updates(request):
        yield 'allowed update'
        policy.set_member(READER, False, ADMIN)
        yield 'private update after revocation'
    monkeypatch.setattr(catalog_updates, '_catalog_event_stream', updates)
    request = SimpleNamespace(state=SimpleNamespace(site_access_authorization='Bearer reader'))
    async def collect():
        return [chunk async for chunk in catalog_updates.event_stream(request)]
    assert asyncio.run(collect()) == ['allowed update']


def test_parallel_scraper_jobs_do_not_share_account_tokens(monkeypatch):
    import asyncio
    import threading
    from fastapi_app.services import truyenqq_service
    rendezvous = threading.Barrier(2)
    def discover():
        rendezvous.wait(timeout=3)
        return policy.source_authorization.get()
    monkeypatch.setattr(truyenqq_service, 'get_live', lambda: SimpleNamespace(discover=discover))
    async def job(token):
        marker = policy.source_authorization.set(token)
        try:
            return await truyenqq_service.run_live('discover')
        finally:
            policy.source_authorization.reset(marker)
    async def check():
        return await asyncio.gather(job('Bearer first-reader'), job('Bearer second-reader'))
    assert asyncio.run(check()) == ['Bearer first-reader', 'Bearer second-reader']
    assert policy.source_authorization.get() is None
