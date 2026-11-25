"""Browser HTTP transport for QQ on serverless hosts, retaining httpx semantics."""
import os
import threading
import time

import httpx
from curl_cffi.requests import Session
from curl_cffi.requests.exceptions import RequestException, Timeout
from site_access import source_authorization
import site_access


def _relay_failure_kind(result):
    if result.status_code not in {401, 403, 429, 503} or result.headers.get('x-truyenqq-relay') == '1':
        return None
    content = result.content[:12000].lower()
    if result.headers.get('x-site-access-error') == 'edge-challenge':
        return 'edge-challenge'
    if b'whitelist_required' in content:
        denial = result.headers.get('x-site-access-denial')
        if denial in {'country', 'ticket', 'whitelist', 'authentication'}:
            return 'denied-' + denial
        reason = result.headers.get('x-site-access-error')
        return reason if reason in {'http-401', 'http-403', 'policy-authenticated', 'policy-anonymous'} else 'access-denied'
    if any(marker in content for marker in [b'cf-chl-', b'challenge-platform', b'just a moment']):
        return 'edge-challenge'
    if b'1027' in content or b'daily requests limit' in content:
        return 'worker-quota'
    return 'gateway-error'


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
        self._direct_denied_until = {}
        # Cold Vercel instances otherwise repeat a slow direct request before
        # discovering that their datacenter must use the existing owned relay.
        self._prefer_edge = os.getenv("TRUYENQQ_PREFER_EDGE", os.getenv("VERCEL", "0")).lower() in {"1", "true", "yes"}

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

        def fetch(*, relay=False, max_read_seconds=None):
            if relay and not source_authorization.get():
                # Background warmups have no reader identity. In whitelist
                # mode the relay would reject every one, after invoking both
                # the source Worker and its access router. Make that same
                # denial locally; an approved reader never takes this branch.
                try:
                    restricted = site_access.get_state()['enabled']
                except site_access.AccessUnavailable:
                    return httpx.Response(503, json={'error': 'Access policy unavailable'},
                        headers={'Cache-Control': 'no-store', 'X-Site-Access-Error': 'policy-unavailable'})
                if restricted:
                    return httpx.Response(403, json={'code': 'WHITELIST_REQUIRED'},
                        headers={'Cache-Control': 'no-store'})
            url = self._edge_url + request.url.raw_path.decode("ascii") if relay else str(request.url)
            # No application/source credentials or original Host header should
            # cross to the relay. The worker itself uses a fixed QQ origin.
            outgoing = {k: v for k, v in headers.items() if k in {
                "accept", "accept-language", "referer", "content-type",
            }} if relay else headers
            # Only the owned relay receives this request's verified website
            # token. It is never added to the QQ origin or image CDN requests.
            if relay and source_authorization.get():
                outgoing["Authorization"] = source_authorization.get()
            return self._session().request(
                request.method, url, headers=outgoing,
                data=body, allow_redirects=False,
                timeout=(min(timeout.get("connect") or 5, 3) if max_read_seconds else timeout.get("connect") or 5,
                         min(timeout.get("read") or 20, max_read_seconds) if max_read_seconds else timeout.get("read") or 20),
            )

        try:
            relay = relay_allowed and (self._prefer_edge or time.monotonic() < self._edge_until)
            result = fetch(relay=relay)
            if result.status_code == 403 and relay_allowed and not relay:
                self._edge_until = time.monotonic() + 300
                relay = True
                result = fetch(relay=relay)
            elif relay and result.status_code == 403 and result.headers.get("x-truyenqq-relay") == "1":
                # The owned worker has authorized this read and the QQ origin
                # rejected its egress. The direct egress can still be healthy.
                # Gateway/whitelist denials never carry this source marker and
                # must not be retried around their access check.
                direct = None
                kind = request.method == 'POST'
                if time.monotonic() >= self._direct_denied_until.get(kind, 0):
                    try:
                        direct = fetch(max_read_seconds=5)
                    except RequestException:
                        pass
                    if direct is not None and direct.status_code == 403 and any(
                        marker in direct.content[:12000].lower() for marker in
                        (b'cf-chl-', b'challenge-platform', b'just a moment')):
                        self._direct_denied_until[kind] = time.monotonic() + 300
                if direct is not None and direct.status_code == 200:
                    result = direct
                    relay = False
                # Keep the original source error if both routes fail, including
                # the hints a browser can use to warm the shared source cache.
        except Timeout as error:
            raise httpx.ReadTimeout("TruyenQQ browser request timed out", request=request) from error
        except RequestException as error:
            raise httpx.ConnectError("TruyenQQ browser connection failed", request=request) from error
        # curl already decompresses the body. httpx must not decode it twice.
        response_headers = [(k, v) for k, v in result.headers.multi_items()
                            if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}]
        return httpx.Response(result.status_code, headers=response_headers,
                              content=result.content, request=request, extensions={
                                  "truyenqq_gateway": _relay_failure_kind(result) if relay else None,
                                  "truyenqq_transport": "edge-source" if relay and result.headers.get("x-truyenqq-relay") == "1"
                                  else "edge-gateway" if relay else "direct",
                              })

    def close(self):
        with self._lock:
            sessions, self._sessions = self._sessions, []
        for session in sessions:
            session.close()
