import time
import threading
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from urllib.parse import urlsplit
import httpx
from .config import Settings


class SourceClient:
    def __init__(self, settings: Settings, *, transport=None):
        self.settings = settings
        self.rate_lock = threading.Lock()
        self.rate_states = {}
        self.http = httpx.Client(http2=settings.http2, transport=transport,
                                 timeout=httpx.Timeout(settings.timeout, connect=settings.connect_timeout, pool=settings.connect_timeout),
                                 limits=httpx.Limits(max_connections=settings.max_connections,
                                                    max_keepalive_connections=settings.max_connections,
                                                    keepalive_expiry=settings.keepalive_expiry),
                                 follow_redirects=False,
                                 headers={"User-Agent": "TruyenAPI/0.5 (Python; live API)",
                                          "Accept-Language": "vi,en;q=0.7"})

    def close(self):
        self.http.close()

    def request(self, url, *, data=None, referer=None, follow_redirects=False, image=False):
        parsed = urlsplit(url)
        if parsed.scheme not in ("https", "http"):
            raise ValueError("Only HTTP(S) source URLs are supported")
        with self.rate_lock:
            state = self.rate_states.setdefault(parsed.netloc, {"lock": threading.Lock(), "last": 0.0})
        attempts = 1 if image else self.settings.retries
        for attempt in range(attempts):
            if not image:
                with state["lock"]:
                    time.sleep(max(0, self.settings.request_delay - (time.monotonic() - state["last"])))
                    state["last"] = time.monotonic()
            try:
                response = self.http.request("POST" if data is not None else "GET", url, data=data,
                                             headers={"Referer": referer or self.settings.base_url + "/"},
                                             follow_redirects=follow_redirects,
                                             **({"timeout": httpx.Timeout(8, connect=3)} if image else {}))
                if response.is_redirect:
                    # Domain moves must be configured explicitly instead of losing or mixing identities.
                    raise ValueError(f"Source redirected to {response.headers.get('location')}; update TRUYEN_BASE_URL if domain moved")
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in (408, 429, 500, 502, 503, 504) or attempt + 1 == attempts:
                    raise
                delay = 2 ** (attempt + 1)
                retry = error.response.headers.get("retry-after", "")
                if retry:
                    try:
                        delay = max(delay, float(retry))
                    except ValueError:
                        try:
                            delay = max(delay, (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds())
                        except (ValueError, TypeError):
                            pass
                time.sleep(min(delay, 300))
            except httpx.TransportError:
                if attempt + 1 == attempts:
                    raise
                time.sleep(2 ** (attempt + 1))
        raise RuntimeError("Request exhausted retries")
