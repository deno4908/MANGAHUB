import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import httpx
import pytest

import flask_app
import maintenance
from config import config
from fastapi_app.services import supabase_client


def test_maintenance_uses_a_short_independent_database_timeout(monkeypatch):
    captured = []
    def create(url, key, **options):
        captured.append(options['database_timeout'])
        return SimpleNamespace()
    monkeypatch.setattr(maintenance, 'create_client', create)
    monkeypatch.setattr(maintenance, '_supabase_admin', None)
    monkeypatch.setattr(config, 'SUPABASE_URL', 'https://test.example')
    monkeypatch.setattr(config, 'SUPABASE_SERVICE_KEY', 'test-service-key')
    maintenance._get_supabase_admin()
    assert captured[0].read == 2.5
    assert captured[0].connect == 1.5
    assert captured[0].pool == 1


def test_explicit_database_timeout_does_not_replace_other_clients_timeouts(monkeypatch):
    calls = []
    monkeypatch.setattr(supabase_client._SupabaseClient, 'create', lambda u, k, options=None: calls.append(options))
    supabase_client.create_client('https://test.example', 'test-key', database_timeout=httpx.Timeout(2))
    supabase_client.create_client('https://test.example', 'test-key')
    assert calls[0].postgrest_client_timeout.read == 2
    assert calls[1] is None


def test_auth_process_health_does_not_wait_for_an_unhealthy_database(monkeypatch):
    monkeypatch.setattr(flask_app, 'ensure_security_redis_available', lambda: None)
    def blocked():
        raise AssertionError('process health cannot wait for maintenance SQL')
    monkeypatch.setattr(flask_app, 'get_maintenance_state', blocked)
    app = flask_app.create_app()
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    app.add_url_rule('/auth/health', view_func=lambda: {'status':'ok'})
    assert app.test_client().get('/auth/health').json == {'status':'ok'}
