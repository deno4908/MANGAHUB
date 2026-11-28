import io
import asyncio
import json
import time
import uuid
import zlib
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
import redis
from itsdangerous.encoding import base64_encode
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import Depends, Request
from fastapi.responses import Response
from fastapi.testclient import TestClient

import access_tickets as tickets
import site_access as policy
from config import config
from fastapi_app import dependencies as auth, main
from fastapi_app.services import auth_claims

READER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
ADMIN = "33333333-3333-4333-8333-333333333333"
SID = "44444444-4444-4444-8444-444444444444"
REAL_STATE = policy.get_state


class Query:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.single_row, self.change, self.remove = db, table, [], False, None, False
    def select(self, *args, **kwargs): return self
    def eq(self, key, value): self.filters.append(lambda row: row.get(key) == value); return self
    def limit(self, *args): return self
    def single(self): self.single_row = True; return self
    def update(self, data): self.change = data; return self
    def upsert(self, data, **kwargs): self.change = data; return self
    def delete(self): self.remove = True; return self
    def execute(self):
        self.db.calls.append(self.table)
        rows = self.db.rows[self.table]
        found = [row for row in rows if all(check(row) for check in self.filters)]
        if self.remove:
            rows[:] = [row for row in rows if row not in found]
        elif self.change is not None:
            if self.table == "system_settings":
                rows[:] = [row for row in rows if row.get("key") != self.change["key"]]
                rows.append(deepcopy(self.change))
            else:
                for row in found: row.update(self.change)
        return SimpleNamespace(data=deepcopy((found[0] if found else {}) if self.single_row else found))


class DB:
    def __init__(self):
        self.calls = []
        self.rows = {"profiles": [{"id": uid, "role": role, "is_banned": False}
                                   for uid, role in [(READER, "reader"), (OTHER, "reader"), (ADMIN, "admin")]],
                     "system_settings": [{"key": policy.SETTING_KEY, "value": {"enabled": True}},
                                         {"key": policy.MEMBER_PREFIX + READER, "value": {"allowed": True}}]}
        self.auth = SimpleNamespace(get_user=Mock(side_effect=AssertionError("ES256 reads must not call Auth API")))
    def table(self, name): return Query(self, name)


@main.app.get("/api/_ticket/read")
async def private_read(request: Request): return {"user": request.state.api_user}


@main.app.get("/api/images/_ticket/image")
async def private_image(): return Response(b"private-image", media_type="image/png")


@main.app.post("/api/_ticket/write")
async def private_write(user=Depends(auth.get_current_user)): return {"id": user["id"]}


@main.app.get("/api/_ticket/privileged")
async def privileged_read(user=Depends(auth.require_admin)): return {"id": user["id"]}


@pytest.fixture
def environment(monkeypatch):
    db = DB()
    private = ec.generate_private_key(ec.SECP256R1())
    public = jwt.algorithms.ECAlgorithm.to_jwk(private.public_key(), as_dict=True)
    public.update(kid="test", alg="ES256", use="sig")
    monkeypatch.setattr(jwt.jwks_client.urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [public]}).encode()))
    monkeypatch.setattr(config, "SUPABASE_URL", "https://auth-ticket.example")
    monkeypatch.setattr(config, "FRONTEND_URL", "https://mangahub.art")
    monkeypatch.setattr(auth, "_init_clients", lambda: None)
    monkeypatch.setattr(auth, "_supabase_admin", db)
    monkeypatch.setattr(auth, "_auth_cache", {})
    monkeypatch.setattr(auth, "_profile_cache", {})
    monkeypatch.setattr(policy, "_db", lambda: db)
    monkeypatch.setattr(policy, "_cache", {})
    monkeypatch.setattr(policy, "get_state", REAL_STATE)
    async def maintenance_off(): return {"enabled": False}
    monkeypatch.setattr(main, "get_maintenance_state_async", maintenance_off)
    auth_claims._key_client.cache_clear()
    def token(uid=READER, sid=SID, **changes):
        data = {"sub": uid, "session_id": sid, "role": "authenticated", "aud": "authenticated",
                "iss": "https://auth-ticket.example/auth/v1", "iat": int(time.time()) - 5,
                "amr": [{"method": "password", "timestamp": int(time.time()) - 10}],
                "exp": int(time.time()) + 3600, "email": "test@example.com"}
        data.update(changes)
        return jwt.encode(data, private, algorithm="ES256", headers={"kid": "test"})
    yield db, token
    auth_claims._key_client.cache_clear()


def client(): return TestClient(main.app, base_url="https://api.mangahub.art")
def bearer(token): return {"Authorization": "Bearer " + token}


def test_each_read_checks_every_revocation_guard_with_one_atomic_session_read(environment, monkeypatch):
    _, token = environment
    c = client(); headers = bearer(token())
    assert c.get('/api/site-access', headers=headers).status_code == 200
    saved = c.cookies.get(tickets.cookie_name())
    original = tickets._client.mget
    calls = []
    def read(keys, *args):
        calls.append(list(keys))
        return original(keys, *args)
    monkeypatch.setattr(tickets._client, 'mget', read)
    assert c.get('/api/_ticket/read', headers=headers).status_code == 200
    assert len(calls) == 1 and len(calls[0]) == 9
    calls.clear()
    assert tickets.decode(saved)['role'] == 'reader'
    assert calls == [[tickets.PREFIX + 'signing-key', tickets._session_key(READER, SID),
                      *tickets._guards(READER, SID)]]
    who = tickets.identity(jwt.decode(token(), options={'verify_signature': False}))
    tickets.revoke_sessions(who)
    with pytest.raises(tickets.Rejected): tickets.decode(saved)


@pytest.mark.parametrize('compressed', [False, True])
def test_cookie_signature_and_revocation_snapshot_need_one_redis_round_trip(environment, monkeypatch, compressed):
    _, token = environment
    c = client(); c.get('/api/site-access', headers=bearer(token()))
    signer = tickets._signer()
    payload = signer.loads(c.cookies.get(tickets.cookie_name()))
    raw = json.dumps(payload).encode()
    body = b'.' + base64_encode(zlib.compress(raw)) if compressed else base64_encode(raw)
    saved = signer.make_signer().sign(body).decode()
    execute = Mock(wraps=tickets._client.execute_command)
    monkeypatch.setattr(tickets._client, 'execute_command', execute)
    assert tickets.decode(saved)['uid'] == READER
    assert execute.call_count == 1, 'Every image still pays multiple sequential security-store round trips'
    command, *keys = execute.call_args.args
    assert command == 'MGET'
    assert keys == [tickets.PREFIX + 'signing-key', tickets._session_key(READER, SID), *tickets._guards(READER, SID)]
    execute.reset_mock()
    tickets._client.set(tickets._key('blocked-session', SID), '1')
    execute.reset_mock()
    with pytest.raises(tickets.Rejected):
        tickets.decode(saved)
    assert execute.call_count == 1, 'A new request must read revocation state again'


@pytest.mark.parametrize('payload', [
    [], {'uid': 123, 'sid': SID, 'jti': 'untrusted', 'exp': 9999999999},
    {'uid': READER, 'sid': 'not-a-session-id', 'jti': 'untrusted', 'exp': 9999999999},
    {'uid': READER, 'sid': SID, 'jti': 'untrusted', 'exp': 9999999999, 'role': 'admin'},
    {'uid': READER, 'sid': SID, 'jti': 'x' * 1_000_000, 'exp': 9999999999},
])
def test_untrusted_ticket_routing_data_is_bounded_and_cannot_trigger_security_reads(environment, monkeypatch, payload):
    body = b'.' + base64_encode(zlib.compress(json.dumps(payload).encode()))
    saved = (body + b'.untrusted-signature').decode()
    assert len(saved) <= 2048
    execute = Mock(side_effect=AssertionError('Malformed routing payload reached Redis'))
    monkeypatch.setattr(tickets._client, 'execute_command', execute)
    with pytest.raises(tickets.Rejected):
        tickets.decode(saved)
    execute.assert_not_called()


@pytest.mark.parametrize('raw', [
    b'bad-json', b'.' + base64_encode(zlib.compress(b'[' * 1000 + b']' * 1000)),
    b'.' + base64_encode(b'broken-zlib-stream'),
    b'.' + base64_encode(zlib.compress(b'{}') + b'unexpected-trailing-bytes'),
])
def test_malformed_cookie_payloads_fail_closed_before_any_redis_lookup(environment, monkeypatch, raw):
    # Plain invalid JSON and compressed invalid, deep or trailing payloads.
    body = raw if raw.startswith(b'.') else base64_encode(raw)
    saved = (body + b'.untrusted-signature').decode()
    execute = Mock(side_effect=AssertionError('Malformed routing payload reached Redis'))
    monkeypatch.setattr(tickets._client, 'execute_command', execute)
    with pytest.raises(tickets.Rejected):
        tickets.decode(saved)
    execute.assert_not_called()


def test_routing_ids_and_a_registered_ticket_id_never_replace_signature_verification(environment):
    from itsdangerous import URLSafeSerializer
    _, token = environment
    c = client(); c.get('/api/site-access', headers=bearer(token()))
    payload = tickets._signer().loads(c.cookies.get(tickets.cookie_name()))
    forged = URLSafeSerializer('attacker-key', salt='mangahub-website-session-v2',
                              signer_kwargs={'digest_method': tickets.hashlib.sha256}).dumps(payload)
    with pytest.raises(tickets.Rejected):
        tickets.decode(forged)


def test_missing_cookie_signing_key_fails_closed_without_recreating_a_secret_on_image_reads(environment, monkeypatch):
    _, token = environment
    c = client(); c.get('/api/site-access', headers=bearer(token()))
    saved = c.cookies.get(tickets.cookie_name())
    tickets._client.delete(tickets.PREFIX + 'signing-key')
    write = Mock(side_effect=AssertionError('An image read initialized a signing secret'))
    monkeypatch.setattr(tickets._client, 'set', write)
    with pytest.raises(tickets.Unavailable):
        tickets.decode(saved)
    write.assert_not_called()


def test_first_check_issues_a_host_only_http_only_ticket_and_next_reads_do_not_query_supabase(environment):
    db, token = environment
    c = client(); headers = bearer(token())
    first = c.get("/api/site-access", headers=headers)
    assert first.status_code == 200 and first.json()["allowed"]
    cookie = first.headers["set-cookie"]
    assert all(value in cookie.lower() for value in ["__host-mh_access_v2", "httponly", "secure", "samesite=lax", "path=/"])
    assert "domain=" not in cookie.lower()
    assert "eyJ" not in c.cookies.get(tickets.cookie_name())
    assert first.json()["access_expires_at"] > time.time() * 1000
    reads = len(db.calls)
    for _ in range(4):
        assert c.get("/api/_ticket/read", headers=headers).status_code == 200
        assert c.get("/api/site-access", headers=headers).status_code == 200
        assert c.get("/api/images/_ticket/image").status_code == 200
    assert len(db.calls) == reads
    db.auth.get_user.assert_not_called()


def test_nonmember_cannot_mint_a_ticket(environment):
    _, token = environment
    c = client()
    response = c.get("/api/site-access", headers=bearer(token(OTHER)))
    assert response.status_code == 200 and not response.json()["allowed"]
    assert not c.cookies.get(tickets.cookie_name())
    assert c.get("/api/_ticket/read", headers=bearer(token(OTHER))).status_code == 403


def test_ticket_is_bound_to_user_and_login_session(environment):
    _, token = environment
    c = client(); assert c.get("/api/site-access", headers=bearer(token())).status_code == 200
    assert c.get("/api/_ticket/read", headers=bearer(token(OTHER))).status_code == 403
    # A ticket never makes a malformed bearer valid, even on public read paths.
    assert c.get("/api/_ticket/read", headers=bearer("forged")).status_code == 401
    # Cookie possession alone cannot mutate data or reach admin APIs.
    assert c.post("/api/_ticket/write", json={}).status_code == 403
    assert c.get("/api/admin/not-a-route").status_code == 401


def test_fake_changed_and_even_signed_but_unregistered_tickets_are_rejected(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    original = c.cookies.get(tickets.cookie_name())
    payload = tickets._signer().loads(original)
    for cookie in ["forged-admin", original + "x", tickets._signer().dumps({**payload, "role": "admin"}),
                   tickets._signer().dumps({**payload, "jti": "attacker-generated"}),
                   tickets._signer().dumps({**payload, "sid": str(uuid.uuid4())})]:
        attacker = client(); attacker.cookies.set(tickets.cookie_name(), cookie)
        assert attacker.get("/api/images/_ticket/image").status_code == 403


def test_revocation_blocks_existing_ticket_and_fresh_issuance(environment):
    _, token = environment
    c = client(); headers = bearer(token())
    c.get("/api/site-access", headers=headers)
    saved = c.cookies.get(tickets.cookie_name())
    policy.set_member(READER, False, ADMIN)
    assert c.get("/api/images/_ticket/image").status_code == 403
    assert not c.get("/api/site-access", headers=headers).json()["allowed"]
    attacker = client(); attacker.cookies.set(tickets.cookie_name(), saved)
    assert attacker.get("/api/images/_ticket/image").status_code == 403


def test_saved_cover_bytes_are_still_blocked_before_login_and_after_revocation(environment, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi_app.routers import images, manga
    _, token = environment
    manga_id = '5272da37-6c69-4ecc-a1e0-d25db7b3e80f'
    cover = f'https://uploads.mangadex.org/covers/{manga_id}/cover.jpg.256.jpg'
    lookup = AsyncMock(return_value=cover)
    monkeypatch.setattr(manga.mangadex_service, 'get_cover_url', lookup)
    monkeypatch.setattr(images, '_host_validation_cache', {'uploads.mangadex.org': (time.time() + 300, None)})
    monkeypatch.setattr(images, '_cached_image_response', lambda *a, **kw: Response(b'private-cover', media_type='image/jpeg'))
    url = f'/api/manga/mangadex-cover/{manga_id}?size=256'
    c = client()
    assert c.get(url).status_code == 403
    lookup.assert_not_awaited()
    assert c.get('/api/site-access', headers=bearer(token())).status_code == 200
    response = c.get(url, follow_redirects=False)
    assert response.status_code == 200 and response.content == b'private-cover'
    assert response.headers['cache-control'] == 'private, no-store'
    lookup.assert_awaited_once_with(manga_id)
    policy.set_member(READER, False, ADMIN)
    assert c.get(url).status_code == 403
    lookup.assert_awaited_once()


def test_permissions_changed_during_initial_check_cannot_publish_a_ticket(environment):
    _, token = environment
    claims = jwt.decode(token(), options={"verify_signature": False})
    who = tickets.identity(claims)
    before = tickets.snapshot(who)
    with tickets.security_change(READER): pass
    with pytest.raises(tickets.Rejected):
        tickets.issue(who, {"id": READER, "role": "reader"}, {"enabled": True}, before)


def test_ban_role_change_and_pending_security_write_invalidate_ticket(environment):
    db, token = environment
    c = client(); headers = bearer(token())
    c.get("/api/site-access", headers=headers)
    with tickets.security_change(READER):
        assert c.get("/api/_ticket/read", headers=headers).status_code == 503
        db.rows["profiles"][0]["is_banned"] = True
    assert c.get("/api/images/_ticket/image").status_code == 403
    assert c.get("/api/site-access", headers=headers).status_code == 403


@pytest.mark.parametrize("scope", ["local", "global", "others"])
def test_logout_revokes_the_correct_sessions_and_cannot_reissue_using_old_bearer(environment, scope):
    _, token = environment
    c = client(); jwt_token = token(); headers = bearer(jwt_token)
    c.get("/api/site-access", headers=headers)
    saved = c.cookies.get(tickets.cookie_name())
    response = c.post("/api/site-access/logout", headers={**headers, "X-MangaHub-CSRF": "1", "Origin": config.FRONTEND_URL}, json={"scope": scope})
    assert response.status_code == 200
    attacker = client(); attacker.cookies.set(tickets.cookie_name(), saved)
    assert attacker.get("/api/images/_ticket/image").status_code == 403
    again = c.get("/api/site-access", headers=headers)
    assert again.status_code == (200 if scope == "others" else 401)


def test_cookie_logout_requires_same_origin_csrf_and_cannot_revoke_other_accounts(environment):
    _, token = environment
    c = client(); headers = bearer(token())
    c.get("/api/site-access", headers=headers)
    for supplied in [{}, {"X-MangaHub-CSRF": "1", "Origin": "https://attacker.example"}]:
        assert c.post("/api/site-access/logout", headers=supplied, json={"scope": "local"}).status_code == 403
    assert c.get("/api/images/_ticket/image").status_code == 200
    assert c.post("/api/site-access/logout", headers={"Origin": config.FRONTEND_URL, "X-MangaHub-CSRF": "1"}, json={"scope": "global"}).status_code == 401
    assert c.post("/api/site-access/logout", headers={"Origin": config.FRONTEND_URL, "X-MangaHub-CSRF": "1"}, json={"scope": "local"}).status_code == 200


def test_redis_outage_never_uses_a_cached_ticket_as_authorization(environment, monkeypatch):
    _, token = environment
    c = client(); headers = bearer(token())
    c.get("/api/site-access", headers=headers)
    monkeypatch.setattr(tickets._client, "mget", Mock(side_effect=redis.ConnectionError("unavailable")))
    assert c.get("/api/_ticket/read", headers=headers).status_code == 503
    assert c.get("/api/images/_ticket/image").status_code == 503


def test_live_roles_are_required_for_writes_even_when_a_read_ticket_exists(environment):
    db, token = environment
    c = client(); headers = bearer(token())
    c.get("/api/site-access", headers=headers)
    count = len(db.calls)
    assert c.post("/api/_ticket/write", headers=headers, json={}).status_code == 200
    assert len(db.calls) > count


def test_refreshing_supabase_jwt_does_not_require_a_new_access_ticket(environment):
    db, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    count = len(db.calls)
    assert c.get("/api/_ticket/read", headers=bearer(token(iat=int(time.time())))).status_code == 200
    assert len(db.calls) == count


@pytest.mark.parametrize("scope", ["local", "global", "others"])
def test_revocation_survives_jwt_refresh_and_preserves_only_the_selected_sessions(environment, scope):
    _, token = environment
    first, second = client(), client()
    second_sid = str(uuid.uuid4())
    first.get("/api/site-access", headers=bearer(token()))
    second.get("/api/site-access", headers=bearer(token(sid=second_sid)))
    first.post("/api/site-access/logout", headers={**bearer(token()), "X-MangaHub-CSRF": "1"}, json={"scope": scope})
    for visitor, sid, allowed in [(first, SID, scope == "others"), (second, second_sid, scope == "local")]:
        refreshed = token(sid=sid, iat=int(time.time()))
        response = visitor.get("/api/site-access", headers=bearer(refreshed))
        assert response.status_code == (200 if allowed else 401)
        if not allowed:
            assert visitor.post("/api/_ticket/write", headers=bearer(refreshed), json={}).status_code == 401
            # A revoked JWT cannot call logout-others to exempt itself from the cutoff.
            visitor.post("/api/site-access/logout", headers={**bearer(refreshed), "X-MangaHub-CSRF": "1"}, json={"scope": "others"})
            assert visitor.get("/api/site-access", headers=bearer(refreshed)).status_code == 401


def test_a_fresh_login_after_global_logout_has_its_own_grant(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    c.post("/api/site-access/logout", headers={**bearer(token()), "X-MangaHub-CSRF": "1"}, json={"scope": "global"})
    # Authentication happened after the cutoff; use a past cutoff to avoid waiting.
    key = tickets._key("cutoff", READER)
    cutoff = json.loads(tickets._client.get(key)); cutoff["at"] = int(time.time()) - 1
    tickets._client.set(key, json.dumps(cutoff))
    fresh = token(sid=str(uuid.uuid4()), iat=int(time.time()), amr=[{"method": "password", "timestamp": int(time.time())}])
    assert c.get("/api/site-access", headers=bearer(fresh)).json()["allowed"]


def test_registered_custom_token_without_amr_cannot_refresh_past_a_logout_cutoff(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token(amr=[])))
    c.post("/api/site-access/logout", headers={**bearer(token(amr=[])), "X-MangaHub-CSRF": "1"}, json={"scope": "global"})
    assert c.get("/api/site-access", headers=bearer(token(amr=[], iat=int(time.time())))).status_code == 401


def test_expired_jwt_is_not_rescued_by_a_valid_cookie_and_expired_tickets_are_rejected(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    assert c.get("/api/_ticket/read", headers=bearer(token(exp=1))).status_code == 401
    key = tickets._session_key(READER, SID)
    record = json.loads(tickets._client.get(key)); record["exp"] = 1
    tickets._client.set(key, json.dumps(record))
    assert c.get("/api/images/_ticket/image").status_code == 403


def test_another_login_for_the_same_user_does_not_inherit_the_first_session(environment):
    db, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    count = len(db.calls)
    c.get("/api/site-access", headers=bearer(token(sid=str(uuid.uuid4()))))
    assert len(db.calls) > count


def test_registered_ticket_header_is_a_read_capability_only(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    relay = client(); headers = {"Authorization": "AccessTicket " + c.cookies.get(tickets.cookie_name())}
    assert relay.get("/api/site-access", headers=headers).json()["allowed"]
    assert relay.get("/api/images/_ticket/image", headers=headers).status_code == 200
    assert relay.post("/api/_ticket/write", headers=headers, json={}).status_code == 401
    assert relay.get("/api/admin/not-a-route", headers=headers).status_code == 401


def test_enabling_whitelist_revokes_an_existing_public_grant(environment):
    _, token = environment
    policy.set_state(False, "public", ADMIN)
    c = client(); headers = bearer(token(OTHER))
    assert c.get("/api/site-access", headers=headers).json()["allowed"]
    policy.set_state(True, "restricted", ADMIN)
    assert c.get("/api/images/_ticket/image").status_code == 403
    assert not c.get("/api/site-access", headers=headers).json()["allowed"]


def test_actual_admin_ban_and_role_routes_invalidate_registered_tickets(environment, monkeypatch):
    from fastapi_app.routers import admin
    _, token = environment
    monkeypatch.setattr(admin, "_log_action", lambda *args, **kwargs: None)
    c, owner = client(), client()
    c.get("/api/site-access", headers=bearer(token()))
    owner.get("/api/site-access", headers=bearer(token(ADMIN)))
    response = owner.post("/api/admin/ban", headers=bearer(token(ADMIN)), json={"user_id": READER, "ban_reason": "test"})
    assert response.status_code == 200, response.text
    assert c.get("/api/images/_ticket/image").status_code == 403
    response = owner.post("/api/admin/change-role", headers=bearer(token(ADMIN)), json={"user_id": ADMIN, "role": "reader"})
    assert response.status_code == 200, response.text
    assert owner.get("/api/images/_ticket/image").status_code == 403
    assert owner.get("/api/admin/not-a-route", headers=bearer(token(ADMIN))).status_code == 403


def test_security_writes_do_not_run_if_revocation_store_is_unavailable(environment, monkeypatch):
    db, _ = environment
    before = deepcopy(db.rows)
    monkeypatch.setattr(tickets._client, "pipeline", Mock(side_effect=redis.ConnectionError("unavailable")))
    with pytest.raises(tickets.Unavailable):
        policy.set_member(READER, False, ADMIN)
    assert db.rows == before


def test_local_cookie_logout_still_revokes_when_bearer_expired_and_bad_bodies_fail_cleanly(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    headers = {**bearer(token(exp=1)), "Origin": config.FRONTEND_URL, "X-MangaHub-CSRF": "1"}
    for body in [[], {"scope": []}]:
        assert c.post("/api/site-access/logout", headers=headers, json=body).status_code == 400
    assert c.post("/api/site-access/logout", headers=headers, content="bad-json").status_code == 400
    saved = c.cookies.get(tickets.cookie_name())
    assert c.post("/api/site-access/logout", headers=headers, json={"scope": "local"}).status_code == 200
    replay = client(); replay.cookies.set(tickets.cookie_name(), saved)
    assert replay.get("/api/images/_ticket/image").status_code == 403


def test_session_revocation_is_available_during_maintenance(environment, monkeypatch):
    _, token = environment
    c = client(); c.get('/api/site-access', headers=bearer(token()))
    async def maintenance_on(): return {'enabled': True}
    monkeypatch.setattr(main, 'get_maintenance_state_async', maintenance_on)
    result = c.post('/api/site-access/logout', headers={**bearer(token()), 'X-MangaHub-CSRF': '1'}, json={'scope': 'local'})
    assert result.status_code == 200


def test_rotating_the_server_signing_key_invalidates_old_cookies_without_warm_instance_cache(environment):
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    tickets._client.set(tickets.PREFIX + "signing-key", "new-server-secret")
    assert c.get("/api/images/_ticket/image").status_code == 403
    assert c.get("/api/site-access", headers=bearer(token())).status_code == 200
    assert c.get("/api/images/_ticket/image").status_code == 200


def test_privileged_dependencies_require_live_roles_even_outside_admin_namespace(environment):
    db, token = environment
    c = client(); headers = bearer(token(ADMIN))
    c.get("/api/site-access", headers=headers)
    db.rows["profiles"][2]["role"] = "reader"
    assert c.get("/api/_ticket/privileged", headers=headers).status_code == 403


def test_cookie_backed_stream_works_and_stops_after_ticket_revocation(environment, monkeypatch):
    from fastapi_app.routers import catalog_updates
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    cookie = c.cookies.get(tickets.cookie_name())
    async def chunks(request):
        yield 'first'
        policy.set_member(READER, False, ADMIN)
        yield 'must not be sent'
    monkeypatch.setattr(catalog_updates, '_catalog_event_stream', chunks)
    request = SimpleNamespace(state=SimpleNamespace(site_access_authorization='AccessTicket ' + cookie))
    async def collect(): return [chunk async for chunk in catalog_updates.event_stream(request)]
    assert asyncio.run(collect()) == ['first']


def test_flask_auth_reads_reuse_registered_session_without_calling_supabase(environment, monkeypatch):
    from flask import Flask, g
    from flask_app import middleware
    _, token = environment
    c = client(); c.get("/api/site-access", headers=bearer(token()))
    monkeypatch.setattr(middleware, '_get_supabase', Mock(side_effect=AssertionError('unexpected Supabase auth read')))
    app = Flask(__name__)
    @app.get('/ping')
    @middleware.require_auth
    def ping(): return {'id': g.current_user.id}
    visitor = app.test_client()
    for _ in range(3):
        assert visitor.get('/ping', headers=bearer(token())).json == {'id': READER}
    tickets.revoke_sessions(tickets.identity(jwt.decode(token(), options={'verify_signature': False})))
    assert visitor.get('/ping', headers=bearer(token())).status_code == 401


@pytest.mark.parametrize('operation', ['reset-password', 'change-password'])
def test_password_routes_revoke_all_registered_read_sessions(environment, monkeypatch, operation):
    from flask import Flask
    from flask_app import limiter, middleware
    from flask_app.auth import routes
    db, token = environment
    c = client(); c.get('/api/site-access', headers=bearer(token()))
    second = client(); second.get('/api/site-access', headers=bearer(token(sid=str(uuid.uuid4()))))
    db.auth.get_user = Mock(return_value=SimpleNamespace(user=SimpleNamespace(id=READER, email='test@example.com')))
    db.auth.admin = SimpleNamespace(update_user_by_id=Mock(), sign_out=Mock())
    monkeypatch.setattr(middleware, '_get_supabase', lambda: db)
    monkeypatch.setattr(routes, '_get_sb_admin', lambda: db)
    monkeypatch.setattr(routes, 'open_credentials', lambda data, purpose: {'password': 'new password value', 'current_password': 'old password value'})
    monkeypatch.setattr(routes, 'derive_password', lambda value, email: 'derived-password')
    monkeypatch.setattr(routes, '_verify_current_password', lambda *args: (True, ''))
    app = Flask(__name__)
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    limiter.init_app(app)
    app.register_blueprint(routes.auth_bp, url_prefix='/auth')
    recovery = {'amr': [{'method': 'otp', 'timestamp': int(time.time()) - 10}], 'phone': ''} if operation == 'reset-password' else {}
    response = app.test_client().post('/auth/' + operation, json={}, headers={**bearer(token(**recovery)), 'X-MangaHub-CSRF': '1', 'Origin': config.FRONTEND_URL})
    assert response.status_code == 200, response.json
    db.auth.admin.update_user_by_id.assert_called_once()
    assert c.get('/api/images/_ticket/image').status_code == 403
    assert second.get('/api/images/_ticket/image').status_code == 403
    assert c.get('/api/site-access', headers=bearer(token(iat=int(time.time())))).status_code == 401


@pytest.fixture
def password_client(environment, monkeypatch):
    from flask import Flask
    from flask_app import limiter, middleware
    from flask_app.auth import credentials, routes
    from jwcrypto import jwk, jwe
    db, token = environment
    db.auth.get_user = Mock(return_value=SimpleNamespace(user=SimpleNamespace(id=READER, email='test@example.com')))
    db.auth.admin = SimpleNamespace(update_user_by_id=Mock(), sign_out=Mock())
    monkeypatch.setattr(middleware, '_get_supabase', lambda: db)
    monkeypatch.setattr(middleware, '_auth_cache', {})
    monkeypatch.setattr(middleware, '_profile_cache', {})
    monkeypatch.setattr(routes, '_get_sb_admin', lambda: db)
    monkeypatch.setattr(routes, '_get_sb', Mock(side_effect=AssertionError('unexpected provider mutation')))
    monkeypatch.setattr(credentials, 'get_private_key', lambda: key)
    # Isolate the credential nonce store as well as the access-session Redis.
    # FakeRedis without the optional Lua runtime cannot execute GETDEL scripts.
    monkeypatch.setattr(credentials, '_redis', lambda: None)
    monkeypatch.setattr(credentials, '_nonces', {})
    key = jwk.JWK.generate(kty='RSA', size=2048)
    app = Flask(__name__)
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    limiter.init_app(app)
    app.register_blueprint(routes.auth_bp, url_prefix='/auth')
    def envelope(password='violet canoe lunar orchard', purpose='reset-password'):
        challenge = credentials.issue_challenge(purpose)
        public = jwk.JWK(**challenge['public_key'])
        sealed = jwe.JWE(json.dumps({'nonce': challenge['nonce'], 'purpose': purpose,
            'fields': {'password': password, 'current_password': 'previous password value',
                       'email': 'test@example.com', 'username': 'test-reader'}}).encode(),
            protected=json.dumps({'alg': 'RSA-OAEP-256', 'enc': 'A256GCM', 'kid': public['kid']}))
        sealed.add_recipient(public)
        return {'credential': sealed.serialize(compact=True)}
    return app.test_client(), envelope, db, token


def test_encrypted_email_otp_reset_succeeds_and_cannot_be_replayed(password_client):
    visitor, envelope, db, token = password_client
    first, second = client(), client()
    first.get('/api/site-access', headers=bearer(token()))
    second.get('/api/site-access', headers=bearer(token(sid=str(uuid.uuid4()))))
    recovery = token(amr=[{'method': 'otp', 'timestamp': int(time.time()) - 5}], phone='')
    headers = {**bearer(recovery), 'X-MangaHub-CSRF': '1', 'Origin': config.FRONTEND_URL}
    body = envelope()
    result = visitor.post('/auth/reset-password', headers=headers, json=body)
    assert result.status_code == 200, result.json
    assert result.json['requires_relogin'] is True
    db.auth.admin.update_user_by_id.assert_called_once()
    update = db.auth.admin.update_user_by_id.call_args.args
    assert update[0] == READER and 'password' in update[1]
    assert update[1]['password'] != 'violet canoe lunar orchard'
    assert first.get('/api/images/_ticket/image').status_code == 403
    assert second.get('/api/images/_ticket/image').status_code == 403
    assert visitor.post('/auth/reset-password', headers=headers, json=envelope()).status_code == 401
    db.auth.admin.update_user_by_id.assert_called_once()


@pytest.mark.parametrize('amr,phone', [
    ([{'method': 'password', 'timestamp': int(time.time())}], ''),
    ([{'method': 'oauth', 'timestamp': int(time.time())}], ''),
    ([{'method': 'otp', 'timestamp': int(time.time()) - 901}, {'method': 'token_refresh', 'timestamp': int(time.time())}], ''),
    ([{'method': 'otp', 'timestamp': int(time.time())}], '+10000000000'),
])
def test_non_email_or_stale_proof_cannot_reset_even_with_a_valid_login(password_client, amr, phone):
    visitor, envelope, db, token = password_client
    headers = {**bearer(token(amr=amr, phone=phone)), 'X-MangaHub-CSRF': '1', 'Origin': config.FRONTEND_URL}
    result = visitor.post('/auth/reset-password', headers=headers, json=envelope())
    assert result.status_code == 403
    db.auth.admin.update_user_by_id.assert_not_called()


@pytest.mark.parametrize('operation', ['register', 'reset-password', 'change-password'])
def test_weak_new_password_is_rejected_before_any_provider_update(password_client, operation):
    visitor, envelope, db, token = password_client
    headers = {**bearer(token(amr=[{'method': 'otp', 'timestamp': int(time.time())}], phone='')), 'X-MangaHub-CSRF': '1', 'Origin': config.FRONTEND_URL}
    result = visitor.post('/auth/' + operation, headers=headers, json=envelope('Password123!', operation))
    assert result.status_code == 400, result.json
    assert 'dễ đoán' in result.json['error']
    db.auth.admin.update_user_by_id.assert_not_called()
