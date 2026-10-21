import pytest
import site_access


@pytest.fixture(autouse=True)
def public_site_access_mode(monkeypatch):
    """Existing endpoint suites run in public mode, without a live policy DB.

    test_site_access replaces this default with the real policy and its test DB.
    """
    monkeypatch.setattr(site_access, "get_state", lambda **kwargs: {"enabled": False, "message": site_access.DEFAULT_MESSAGE})
