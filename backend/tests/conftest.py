import pytest
import site_access
import fakeredis
import access_tickets


@pytest.fixture(autouse=True)
def public_site_access_mode(monkeypatch):
    """Existing endpoint suites run in public mode, without a live policy DB.

    test_site_access replaces this default with the real policy and its test DB.
    """
    monkeypatch.setattr(site_access, "get_state", lambda **kwargs: {"enabled": False, "message": site_access.DEFAULT_MESSAGE})


@pytest.fixture(autouse=True)
def isolated_access_ticket_store(monkeypatch):
    monkeypatch.setattr(access_tickets, "_client", fakeredis.FakeRedis(decode_responses=True))
    access_tickets.current_record.set(None)
    access_tickets.refresh_required.set(False)
    access_tickets.live_auth.set(False)
