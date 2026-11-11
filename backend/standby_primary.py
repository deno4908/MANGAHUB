"""Private origin monitoring without the public Cloudflare challenge layer."""
import http.client
import ipaddress
import os
import socket
import ssl
import time


FRONTEND_HOST = "mangahub.art"
# Vercel's public shared ingress, verified against this project's production TLS
# certificate and SPA. Override only if Vercel changes this project's ingress.
DEFAULT_ADDRESS = "76.76.21.21"
_TLS = ssl.create_default_context()


class _FrontendConnection(http.client.HTTPSConnection):
    def __init__(self, address):
        super().__init__(FRONTEND_HOST, timeout=1.5, context=_TLS)
        self.address = address
        self.deadline = time.monotonic() + 3

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=1.5)
        try:
            raw.settimeout(max(0.05, self.deadline - time.monotonic()))
            self.sock = self._context.wrap_socket(raw, server_hostname=FRONTEND_HOST)
            self.sock.settimeout(max(0.05, self.deadline - time.monotonic()))
        except BaseException:
            raw.close()
            raise


def frontend_healthy():
    """A bounded, credential-free GET of the actual primary frontend origin.

    The hostname/path are fixed. Never accept a URL, cookie, token or secret
    from an incoming request, and never follow redirects to an authentication
    page. This is a health probe, not an alternate user-traffic proxy.
    """
    connection = None
    try:
        address = ipaddress.ip_address(os.getenv("STANDBY_PRIMARY_FRONTEND_ADDRESS", DEFAULT_ADDRESS))
        if not address.is_global:
            return False
        connection = _FrontendConnection(str(address))
        connection.request("GET", "/", headers={
            "Accept": "text/html", "Cache-Control": "no-cache", "Connection": "close",
        })
        connection.sock.settimeout(max(0.05, connection.deadline - time.monotonic()))
        response = connection.getresponse()
        return response.status == 200 and response.getheader("Content-Type", "").lower().startswith("text/html")
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        if connection is not None:
            connection.close()
