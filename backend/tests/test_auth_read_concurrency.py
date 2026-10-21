import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from gotrue.errors import AuthApiError

from fastapi_app import dependencies as auth


@pytest.fixture
def provider(monkeypatch):
    client = SimpleNamespace(auth=SimpleNamespace(get_user=Mock(return_value=SimpleNamespace(
        user=SimpleNamespace(id="reader", email="reader@example.com")))))
    monkeypatch.setattr(auth, "_init_clients", lambda: None)
    monkeypatch.setattr(auth, "_supabase_admin", client)
    monkeypatch.setattr(auth, "_auth_cache", {})
    monkeypatch.setattr(auth, "_profile_cache", {})
    monkeypatch.setattr(auth, "_fetch_auth_profile", lambda _: {"role": "reader"})
    return client.auth.get_user


def test_auth_network_wait_does_not_block_images_or_duplicate_verification(provider):
    release, started = threading.Event(), threading.Event()
    original = provider.return_value

    def slow(token):
        started.set()
        release.wait(2)
        return original

    provider.side_effect = slow

    async def check():
        jobs = [asyncio.create_task(auth.get_current_user("Bearer valid")) for _ in range(8)]
        try:
            assert await asyncio.to_thread(started.wait, 0.5)
            assert not any(job.done() for job in jobs)
        finally:
            release.set()
        assert all(user["id"] == "reader" for user in await asyncio.gather(*jobs))

    asyncio.run(check())
    provider.assert_called_once_with("valid")


@pytest.mark.parametrize("failure,status", [
    (OSError("network unavailable"), 503),
    (AuthApiError("provider unavailable", 503, "unexpected_failure"), 503),
    (AuthApiError("too many requests", 429, "over_request_rate_limit"), 503),
    (AuthApiError("invalid JWT", 401, "bad_jwt"), 401),
])
def test_auth_unavailability_is_not_reported_as_an_invalid_session(provider, failure, status):
    provider.side_effect = failure
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_current_user("Bearer invalid-or-unavailable"))
    assert error.value.status_code == status


def test_profile_database_failure_is_not_reported_as_an_invalid_token(provider, monkeypatch):
    monkeypatch.setattr(auth, "_fetch_auth_profile", Mock(side_effect=OSError("database unavailable")))
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_current_user("Bearer valid"))
    assert error.value.status_code == 503
    assert not auth._auth_cache


def test_optional_user_keeps_provider_unavailability_fail_closed(provider):
    provider.side_effect = OSError("network unavailable")
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_optional_user("Bearer valid"))
    assert error.value.status_code == 503
