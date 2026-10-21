"""Browser HTTP transport for QQ on serverless hosts, retaining httpx semantics."""
import threading

import httpx
from curl_cffi.requests import Session
from curl_cffi.requests.exceptions import RequestException, Timeout


class TruyenQQTransport(httpx.BaseTransport):
    def __init__(self):
        self._local = threading.local()
        self._sessions = []
        self._lock = threading.Lock()

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
        try:
            result = self._session().request(
                request.method, str(request.url), headers=headers,
                data=request.read(), allow_redirects=False,
                timeout=(timeout.get("connect") or 5, timeout.get("read") or 20),
            )
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
