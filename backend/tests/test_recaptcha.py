import json
from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException
from flask import Flask
from starlette.requests import Request

from config import config
from flask_app import limiter
from flask_app.auth import routes
from fastapi_app.utils import recaptcha


@pytest.fixture(autouse=True)
def captcha_settings(monkeypatch):
    monkeypatch.setattr(config, 'RECAPTCHA_SECRET_KEY', 'server-only-test-secret')
    monkeypatch.setattr(config, 'RECAPTCHA_REQUIRED', True)


def google_reply(monkeypatch, payload):
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = json.dumps(payload).encode()
    send = Mock(return_value=response)
    monkeypatch.setattr(routes.urllib.request, 'urlopen', send)
    return send


@pytest.mark.parametrize('path', ['login', 'register', 'forgot-password'])
@pytest.mark.parametrize('token', ['', 'invalid', 'expired'])
def test_auth_forms_cannot_reach_provider_without_valid_captcha(monkeypatch, path, token):
    app = Flask(__name__)
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    limiter.init_app(app)
    app.register_blueprint(routes.auth_bp, url_prefix='/auth')
    fields = {'email': 'reader@example.test', 'password': 'A-long-password-2026!', 'username': 'reader', 'recaptcha_token': token}
    monkeypatch.setattr(routes, 'open_credentials', lambda *_: fields)
    provider = Mock(side_effect=AssertionError('CAPTCHA must be checked before provider calls'))
    monkeypatch.setattr(routes, '_get_sb', provider)
    monkeypatch.setattr(routes, '_get_sb_admin', provider)
    derive = Mock(side_effect=AssertionError('Do not derive a password before CAPTCHA succeeds'))
    monkeypatch.setattr(routes, 'derive_password', derive)
    send = google_reply(monkeypatch, {'success': False, 'error-codes': ['timeout-or-duplicate'] if token == 'expired' else ['invalid-input-response']})
    response = app.test_client().post('/auth/' + path, json=fields, headers={'X-MangaHub-CSRF': '1'})
    assert response.status_code == 400
    assert 'error' in response.json
    provider.assert_not_called()
    derive.assert_not_called()
    assert send.call_count == bool(token)


@pytest.mark.parametrize('result', [{'success': True}, {'success': False}, [], None])
def test_flask_verification_accepts_only_google_success(monkeypatch, result):
    google_reply(monkeypatch, result)
    with Flask(__name__).test_request_context('/auth/login'):
        ok, _ = routes._verify_recaptcha_token('token')
    assert ok is (isinstance(result, dict) and result.get('success') is True)


def test_google_network_failure_and_missing_required_secret_fail_closed(monkeypatch):
    send = Mock(side_effect=TimeoutError('private transport error'))
    monkeypatch.setattr(routes.urllib.request, 'urlopen', send)
    with Flask(__name__).test_request_context('/auth/login'):
        ok, error = routes._verify_recaptcha_token('token')
        assert not ok and 'private transport' not in error
        monkeypatch.setattr(config, 'RECAPTCHA_SECRET_KEY', '')
        assert routes._verify_recaptcha_token('token')[0] is False
    assert send.call_count == 1


@pytest.mark.parametrize('status,payload', [(200, {'success': True}), (200, {'success': False}), (200, []), (503, {'success': True})])
def test_report_and_support_verifier_checks_status_and_google_result(monkeypatch, status, payload):
    import asyncio
    client = Mock()
    async def post(*args, **kwargs):
        return httpx.Response(status, json=payload, request=httpx.Request('POST', 'https://www.google.com/recaptcha/api/siteverify'))
    client.post = post
    class Context:
        async def __aenter__(self): return client
        async def __aexit__(self, *args): pass
    monkeypatch.setattr(recaptcha.httpx, 'AsyncClient', lambda **kwargs: Context())
    request = Request({'type': 'http', 'headers': [], 'client': ('127.0.0.1', 1234)})
    if status == 200 and isinstance(payload, dict) and payload.get('success') is True:
        asyncio.run(recaptcha.enforce_recaptcha(request, 'token'))
    else:
        with pytest.raises(HTTPException): asyncio.run(recaptcha.enforce_recaptcha(request, 'token'))
