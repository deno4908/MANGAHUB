import asyncio
import importlib

import pytest
from dotenv import dotenv_values
from fastapi.testclient import TestClient
from jwcrypto import jwk

from config import config
import serverless_runtime as runtime
from flask_app.auth import credentials
from proxy_trust import resolve_client_ip


def test_request_work_and_nested_jobs_finish_before_invocation_returns(monkeypatch):
    asyncio.run(_request_work_and_nested_jobs(monkeypatch))


async def _request_work_and_nested_jobs(monkeypatch):
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    completed = []

    async def child():
        await asyncio.sleep(0.005)
        completed.append("child")

    async def parent():
        await asyncio.sleep(0.005)
        runtime.create_task(child())
        completed.append("parent")

    async def app(scope, receive, send):
        runtime.create_task(parent())
        completed.append("response")

    await runtime.RequestTasksMiddleware(app)({"type": "http"}, None, None)
    assert completed == ["response", "parent", "child"]
    assert runtime._request_tasks.get() is None


def test_function_job_budget_cancels_pending_work(monkeypatch):
    asyncio.run(_function_job_budget(monkeypatch))


async def _function_job_budget(monkeypatch):
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    stopped = asyncio.Event()

    async def slow():
        try:
            await asyncio.sleep(10)
        finally:
            stopped.set()

    async def app(scope, receive, send):
        runtime.create_task(slow())
        await asyncio.sleep(0)

    await runtime.RequestTasksMiddleware(app, timeout_seconds=0.01)({"type": "http"}, None, None)
    assert stopped.is_set()


def test_vercel_encryption_key_is_shared_and_never_written_to_bundle(monkeypatch, tmp_path):
    key = jwk.JWK.generate(kty="RSA", size=3072)
    monkeypatch.setattr(config, "IS_VERCEL", True)
    monkeypatch.setattr(credentials, "_private_key", None)
    monkeypatch.setenv("AUTH_CREDENTIAL_PRIVATE_JWK", key.export_private())
    monkeypatch.setenv("AUTH_CREDENTIAL_KEY_FILE", str(tmp_path / "missing" / "private.json"))
    first = credentials.get_private_key().thumbprint()
    monkeypatch.setattr(credentials, "_private_key", None)
    assert credentials.get_private_key().thumbprint() == first == key.thumbprint()
    assert list(tmp_path.iterdir()) == []


def test_vercel_requires_private_key_and_rejects_weak_key(monkeypatch):
    monkeypatch.setattr(config, "IS_VERCEL", True)
    monkeypatch.setattr(credentials, "_private_key", None)
    monkeypatch.delenv("AUTH_CREDENTIAL_PRIVATE_JWK", raising=False)
    with pytest.raises(RuntimeError, match="required on Vercel"):
        credentials.get_private_key()
    monkeypatch.setenv("AUTH_CREDENTIAL_PRIVATE_JWK", jwk.JWK.generate(kty="RSA", size=2048).export_private())
    with pytest.raises(RuntimeError, match="Invalid authentication"):
        credentials.get_private_key()


def test_local_caller_cannot_enable_vercel_proxy_trust(monkeypatch):
    monkeypatch.setattr(config, "IS_VERCEL", False)
    headers = {"x-vercel-forwarded-for": "198.51.100.2", "x-forwarded-for": "198.51.100.3"}
    assert resolve_client_ip("203.0.113.2", headers) == "203.0.113.2"
    monkeypatch.setattr(config, "IS_VERCEL", True)
    assert resolve_client_ip("127.0.0.1", headers) == "198.51.100.2"
    # A list is not a valid platform IP: never accept user-prepended chains.
    assert resolve_client_ip("203.0.113.2", {"x-vercel-forwarded-for": "198.51.100.2, 198.51.100.3"}) == "203.0.113.2"


def test_vercel_paths_are_writable_tmp_paths(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime, "IS_VERCEL", True)
    monkeypatch.setattr(runtime.tempfile, "gettempdir", lambda: str(tmp_path))
    assert runtime.writable_path(".image_cache") == tmp_path / "manga-bliss" / ".image_cache"


def test_env_export_roundtrips_secrets_and_never_overwrites(monkeypatch, tmp_path, capsys):
    import prepare_vercel_env as export
    base = tmp_path / "backend"
    base.mkdir()
    monkeypatch.setattr(export, "__file__", str(base / "prepare_vercel_env.py"))
    export.prepare("https://mangahub.art")
    values = dotenv_values(base / ".env.vercel.local")
    key = jwk.JWK.from_json(values["AUTH_CREDENTIAL_PRIVATE_JWK"])
    assert key.has_private
    assert len(values["JWT_SECRET_KEY"]) == 64
    assert "REPLACE_WITH" in values["REDIS_URL"]
    assert values["AUTH_CREDENTIAL_PRIVATE_JWK"] not in capsys.readouterr().out
    with pytest.raises(SystemExit, match="already exists"):
        export.prepare("https://mangahub.art")


def test_combined_backend_keeps_auth_prefix_and_secures_cron(monkeypatch):
    monkeypatch.setattr(config, "SECURITY_REQUIRE_REDIS", False)
    monkeypatch.setattr(config, "IS_VERCEL", True)
    monkeypatch.setattr(credentials, "get_private_key", lambda: jwk.JWK.generate(kty="RSA", size=3072))
    deployment = importlib.import_module("app")
    deployment.auth_app.config["RATELIMIT_ENABLED"] = False
    client = TestClient(deployment.app)
    assert client.get("/health").json()["service"] == "fastapi-api"
    assert client.get("/auth/health").json()["service"] == "flask-gateway"
    monkeypatch.delenv("CRON_SECRET", raising=False)
    assert client.get("/internal/maintenance-tasks").status_code == 401
    monkeypatch.setenv("CRON_SECRET", "a-private-cron-secret")
    assert client.get("/internal/maintenance-tasks", headers={"Authorization": "Bearer wrong"}).status_code == 401
