"""Browser HTTP transport for QQ on serverless hosts, retaining httpx semantics."""
import os
import threading
import time

import httpx
from curl_cffi.requests import Session
from curl_cffi.requests.exceptions import RequestException, Timeout


class TruyenQQTransport(httpx.BaseTransport):
    def __init__(self, *, edge_url=None):
        self._local = threading.local()
        self._sessions = []
        self._lock = threading.Lock()
        self._edge_url = (edge_url if edge_url is not None else os.getenv(
            "TRUYENQQ_EDGE_URL",
            "https://mangahub-mangadex-edge.vinhytb3010.workers.dev/api/truyenqq-edge",
        )).rstrip("/")
        self._edge_until = 0.0

    def _session(self):
        if not hasattr(self._local, "session"):
            session = Session(impersonate="chrome131")
            self._local.session = session
            with self._lock:
                self._sessions.append(session)
        return self._local.session

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        # Let curl supply Chrome's UA and compression headers. Preserve the
        # source Referer and encoded form body, including search POST requests.
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in {"user-agent", "accept-encoding", "connection"}}
        timeout = request.extensions.get("timeout", {})
        body = request.read()
        relay_allowed = bool(self._edge_url) and request.url.scheme == "https" and request.url.host == "truyenqqko.com" and (
            request.method == "GET" or (request.method == "POST" and request.url.path == "/frontend/search/search")
        )

        def fetch(*, relay=False):
            url = self._edge_url + request.url.raw_path.decode("ascii") if relay else str(request.url)
            # No application/source credentials or original Host header should
            # cross to the relay. The worker itself uses a fixed QQ origin.
            outgoing = {k: v for k, v in headers.items() if k in {
                "accept", "accept-language", "referer", "content-type",
            }} if relay else headers
            return self._session().request(
                request.method, url, headers=outgoing,
                data=body, allow_redirects=False,
                timeout=(timeout.get("connect") or 5, timeout.get("read") or 20),
            )

        try:
            relay = relay_allowed and time.monotonic() < self._edge_until
            result = fetch(relay=relay)
            if result.status_code == 403 and relay_allowed and not relay:
                self._edge_until = time.monotonic() + 300
                result = fetch(relay=True)
        except Timeout as error:
            raise httpx.ReadTimeout("TruyenQQ browser request timed out", request=request) from error
        except RequestException as error:
            raise httpx.ConnectError("TruyenQQ browser connection failed", request=request) from error
        # curl already decompresses the body. httpx must not decode it twice.
        response_headers = [(k, v) for k, v in result.headers.multi_items()
                            if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}]
        return httpx.Response(result.status_code, headers=response_headers,
                              content=result.content, request=request)

    def close(self):
        with self._lock:
            sessions, self._sessions = self._sessions, []
        for session in sessions:
            session.close()
