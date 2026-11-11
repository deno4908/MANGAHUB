import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from config import config
from flask_app.auth import credentials

HOSTS = ("mangahub.art", "api.mangahub.art", "auth.mangahub.art")


@pytest.fixture
def standby(monkeypatch, tmp_path):
    app = FastAPI()
    @app.get("/api/plain")
    def normal():
        return {"normal": True}
    monkeypatch.setitem(sys.modules, "app", SimpleNamespace(app=app))
    monkeypatch.setattr(credentials, "get_private_key", lambda: object())
    monkeypatch.setattr(config, "REDIS_SECURITY_URL", "rediss://shared.example:6379")
    monkeypatch.setenv("AUTH_CREDENTIAL_PRIVATE_JWK", "test-only")
    monkeypatch.setenv("STANDBY_ORIGIN_SECRET", "test-origin-secret")
    monkeypatch.setenv("STANDBY_STATE_FILE", str(tmp_path / "state.json"))
    spec = importlib.util.spec_from_file_location("standby_test_module", Path(__file__).parents[1] / "standby_app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, TestClient(app)


def test_control_is_private_while_normal_app_requests_keep_working(standby):
    module, client = standby
    assert client.get("/api/plain").json() == {"normal": True}
    for path in ("/internal/standby-control", "/internal/standby-health", "/internal/standby-drill-health"):
        assert client.get(path).status_code == 404
        assert client.get(path, headers={"x-mangahub-origin-secret": "wrong"}).status_code == 404
    assert not module.STATE_FILE.exists()


def test_failed_primary_switches_and_recovery_requires_three_good_probes(standby):
    module, client = standby
    headers = {"x-mangahub-origin-secret": "test-origin-secret"}
    failed = dict.fromkeys(HOSTS, True)
    failed[HOSTS[1]] = False
    response = client.post("/internal/standby-control", headers=headers, json={"health": failed})
    assert response.status_code == 200
    assert response.json()["modes"] == {HOSTS[0]: "primary", HOSTS[1]: "backup", HOSTS[2]: "primary"}
    assert module.STATE_FILE.exists()
    for index in range(3):
        response = client.post("/internal/standby-control", headers=headers, json={"health": dict.fromkeys(HOSTS, True)})
        assert response.json()["modes"][HOSTS[1]] == ("primary" if index == 2 else "backup")
    assert not module.STATE_FILE.with_suffix(".tmp").exists()


def test_control_rejects_partial_or_nonboolean_probes_without_changing_state(standby):
    module, client = standby
    for payload in [{}, {"health": {}}, {"health": dict.fromkeys(HOSTS, "true")}, {"health": []}]:
        assert client.post("/internal/standby-control", headers={"x-mangahub-origin-secret": "test-origin-secret"}, json=payload).status_code == 400
    assert not module.STATE_FILE.exists()


def test_unconfigured_standby_never_advertises_readiness(standby, monkeypatch):
    module, client = standby
    monkeypatch.delenv("STANDBY_READY", raising=False)
    response = client.get("/internal/standby-health", headers={"x-mangahub-origin-secret": "test-origin-secret"})
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}


def test_readiness_checks_both_redis_stores_and_redacts_failure(standby, monkeypatch):
    module, client = standby
    monkeypatch.setenv("STANDBY_READY", "true")
    writes = []
    def store():
        values = {}
        return SimpleNamespace(set=lambda key, value, **kw: (writes.append(key), values.update({key: value})),
                               get=lambda key: values.get(key), delete=lambda key: values.pop(key))
    monkeypatch.setattr(module, "security_client", store)
    monkeypatch.setattr(module, "client_for", lambda url: store())
    headers = {"x-mangahub-origin-secret": "test-origin-secret"}
    assert client.get("/internal/standby-health", headers=headers).json() == {"status": "ready"}
    assert len(writes) == 2
    def broken():
        raise RuntimeError("private redis credentials")
    monkeypatch.setattr(module, "security_client", broken)
    response = client.get("/internal/standby-health", headers=headers)
    assert response.status_code == 503 and "private" not in response.text


def test_private_drill_can_verify_config_and_stores_without_enabling_global_failover(standby, monkeypatch):
    module, client = standby
    monkeypatch.setenv("STANDBY_READY", "false")
    monkeypatch.setattr(config, "RECAPTCHA_SECRET_KEY", "test-only")
    monkeypatch.setattr(config, "RECAPTCHA_REQUIRED", True)
    writes = []
    values = {}
    store = SimpleNamespace(set=lambda key, value, **kw: (writes.append(key), values.update({key: value})),
                            get=lambda key: values.get(key), delete=lambda key: values.pop(key))
    monkeypatch.setattr(module, "security_client", lambda: store)
    monkeypatch.setattr(module, "client_for", lambda url: store)
    headers = {"x-mangahub-origin-secret": "test-origin-secret"}
    assert client.get("/internal/standby-drill-health", headers=headers).json() == {"status": "ready"}
    assert len(writes) == 2 and not values
    assert client.get("/internal/standby-health", headers=headers).status_code == 503
    monkeypatch.setattr(config, "RECAPTCHA_SECRET_KEY", "")
    assert client.get("/internal/standby-drill-health", headers=headers).status_code == 503
