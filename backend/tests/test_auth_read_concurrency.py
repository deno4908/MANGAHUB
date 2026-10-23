import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import httpx
from fastapi import HTTPException
from gotrue.errors import AuthApiError, AuthRetryableError
from postgrest.exceptions import APIError

from fastapi_app import dependencies as auth

PROFILE_READER = auth._fetch_auth_profile


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


@pytest.mark.parametrize("failure", [
    httpx.RemoteProtocolError("connection interrupted"),
    AuthRetryableError("temporary failure", 503),
    AuthApiError("temporary failure", 503, "unexpected_failure"),
])
def test_a_transient_provider_read_recovers_once_without_requiring_another_login(provider, failure):
    valid = provider.return_value
    provider.side_effect = [failure, valid]
    user = asyncio.run(auth.get_current_user("Bearer valid"))
    assert user == {"id": "reader", "email": "reader@example.com", "role": "reader"}
    assert provider.call_count == 2


@pytest.mark.parametrize("status", [401, 403, 429])
def test_invalid_tokens_and_rate_limits_are_not_retried(provider, status):
    provider.side_effect = AuthApiError("rejected", status, "bad_jwt")
    with pytest.raises(HTTPException):
        asyncio.run(auth.get_current_user("Bearer rejected"))
    provider.assert_called_once()


def test_retries_remain_bounded_and_do_not_create_an_authorization_grant(provider):
    provider.side_effect = AuthApiError("temporary failure", 503, "unexpected_failure")
    with pytest.raises(HTTPException) as error:
        asyncio.run(auth.get_current_user("Bearer unavailable"))
    assert error.value.status_code == 503
    assert provider.call_count == 2
    assert not auth._auth_cache


def test_slow_successful_verification_starts_its_cache_lifetime_after_the_read(provider, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(auth, "time", lambda: clock[0])
    result = provider.return_value
    def slow(token):
        clock[0] += 4
        return result
    provider.side_effect = slow
    async def run():
        return await auth.get_current_user("Bearer valid"), await auth.get_current_user("Bearer valid")
    first, second = asyncio.run(run())
    assert first == second
    provider.assert_called_once()
    assert auth._auth_cache["valid"][0] == 107.0


def test_profile_that_expires_during_a_slow_auth_read_is_rechecked(provider, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(auth, "time", lambda: clock[0])
    auth._profile_cache["reader"] = (102.0, {"role": "admin"})
    result = provider.return_value
    def slow(token):
        clock[0] += 4
        return result
    provider.side_effect = slow
    profile = Mock(return_value={"role": "reader"})
    monkeypatch.setattr(auth, "_fetch_auth_profile", profile)
    assert asyncio.run(auth.get_current_user("Bearer valid"))["role"] == "reader"
    profile.assert_called_once_with("reader")


def test_profile_network_retry_keeps_the_revocation_columns(provider, monkeypatch):
    query = Mock()
    for method in ("select", "eq", "single"):
        getattr(query, method).return_value = query
    query.execute.side_effect = [httpx.ConnectError("connection reset"), SimpleNamespace(data={"role": "reader"})]
    auth._supabase_admin.table = Mock(return_value=query)
    monkeypatch.setattr(auth, "_fetch_auth_profile", PROFILE_READER)
    assert asyncio.run(auth.get_current_user("Bearer valid"))["role"] == "reader"
    assert query.select.call_count == 2
    assert all("session_revoked_at" in call.args[0] for call in query.select.call_args_list)


def test_only_a_missing_schema_column_uses_the_legacy_profile_query(provider, monkeypatch):
    query = Mock()
    for method in ("select", "eq", "single"):
        getattr(query, method).return_value = query
    query.execute.side_effect = [APIError({"code": "42703", "message": "column missing"}), SimpleNamespace(data={"role": "reader"})]
    auth._supabase_admin.table = Mock(return_value=query)
    monkeypatch.setattr(auth, "_fetch_auth_profile", PROFILE_READER)
    assert asyncio.run(auth.get_current_user("Bearer valid"))["role"] == "reader"
    assert query.select.call_args_list[1].args == ("role, is_banned",)
