from types import SimpleNamespace
import ssl
import time

import pytest
import standby_primary as primary


@pytest.mark.parametrize("status,content_type,expected", [
    (200, "text/html; charset=utf-8", True),
    (302, "text/html", False),
    (403, "text/html", False),
    (503, "text/html", False),
    (200, "application/json", False),
])
def test_probe_requires_healthy_origin_html_without_sending_application_credentials(monkeypatch, status, content_type, expected):
    calls = []
    class Connection:
        deadline = time.monotonic() + 3
        sock = SimpleNamespace(settimeout=lambda value: None)
        def __init__(self, address):
            calls.append(("address", address))
        def request(self, method, path, headers):
            calls.append((method, path, headers))
        def getresponse(self):
            return SimpleNamespace(status=status, getheader=lambda *args: content_type)
        def close(self):
            calls.append(("close",))
    monkeypatch.setattr(primary, "_FrontendConnection", Connection)
    monkeypatch.delenv("STANDBY_PRIMARY_FRONTEND_ADDRESS", raising=False)
    assert primary.frontend_healthy() is expected
    assert calls[0] == ("address", "76.76.21.21")
    assert calls[1] == ("GET", "/", {"Accept": "text/html", "Cache-Control": "no-cache", "Connection": "close"})
    assert calls[-1] == ("close",)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "::1", "169.254.169.254", "https://other.example/", "mangahub.art"])
def test_probe_cannot_be_pointed_at_a_private_address_or_dns_loop(monkeypatch, address):
    monkeypatch.setenv("STANDBY_PRIMARY_FRONTEND_ADDRESS", address)
    monkeypatch.setattr(primary, "_FrontendConnection", lambda *args: pytest.fail("Unexpected connection"))
    assert primary.frontend_healthy() is False


def test_tls_connection_uses_public_ingress_but_verifies_real_frontend_hostname(monkeypatch):
    events = []
    raw = SimpleNamespace(settimeout=lambda value: None, close=lambda: events.append("closed"))
    monkeypatch.setattr(primary.socket, "create_connection", lambda address, timeout: events.append((address, timeout)) or raw)
    connection = primary._FrontendConnection("76.76.21.21")
    assert connection._context.verify_mode == ssl.CERT_REQUIRED
    assert connection._context.check_hostname
    connection._context = SimpleNamespace(wrap_socket=lambda sock, server_hostname: events.append(server_hostname) or raw)
    connection.connect()
    assert events == [(("76.76.21.21", 443), 1.5), "mangahub.art"]


def test_certificate_failure_closes_socket_and_reports_unhealthy(monkeypatch):
    events = []
    raw = SimpleNamespace(settimeout=lambda value: None, close=lambda: events.append("closed"))
    monkeypatch.setattr(primary.socket, "create_connection", lambda *args, **kwargs: raw)
    def reject(*args, **kwargs):
        raise ssl.SSLCertVerificationError("fixture: certificate mismatch")
    monkeypatch.setattr(primary, "_TLS", SimpleNamespace(wrap_socket=reject))
    assert primary.frontend_healthy() is False
    assert events == ["closed"]
