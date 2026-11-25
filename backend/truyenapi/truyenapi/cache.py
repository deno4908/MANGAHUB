import threading
import time
from collections import OrderedDict
from concurrent.futures import Future


class MemoryCache:
    """Bounded RAM cache. Concurrent readers share both results and failures."""

    def __init__(self, max_entries=128, *, max_bytes=None, sizeof=None, loading_scope=None):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.sizeof = sizeof or (lambda value: 0)
        self.total_bytes = 0
        self.values = OrderedDict()
        self.loading = {}
        self.lock = threading.RLock()
        self.loading_scope = loading_scope

    def _remove(self, key):
        entry = self.values.pop(key, None)
        if entry is not None:
            self.total_bytes -= entry[2]

    def _peek(self, key):
        entry = self.values.get(key)
        if entry and entry[0] > time.monotonic():
            self.values.move_to_end(key)
            return entry[1]
        self._remove(key)
        return None

    def peek(self, key):
        with self.lock:
            return self._peek(key)

    def remaining(self, key):
        with self.lock:
            entry = self.values.get(key)
            if entry is None:
                return 0.0
            remaining = entry[0] - time.monotonic()
            if remaining <= 0:
                self._remove(key)
                return 0.0
            return remaining

    def invalidate(self, key):
        with self.lock:
            self._remove(key)
            for loading_key in list(self.loading):
                source_key = loading_key[0] if self.loading_scope else loading_key
                if source_key == key:
                    self.loading.pop(loading_key, None)

    def invalidate_matching(self, predicate):
        with self.lock:
            keys = set(self.values) | {key[0] if self.loading_scope else key for key in self.loading}
            for key in keys:
                if predicate(key):
                    self.invalidate(key)

    def put(self, key, ttl, value):
        if ttl <= 0:
            return
        size = self.sizeof(value)
        if self.max_bytes is not None and size > self.max_bytes:
            return
        with self.lock:
            self._remove(key)
            self.values[key] = (time.monotonic() + ttl, value, size)
            self.total_bytes += size
            while len(self.values) > self.max_entries or self.max_bytes is not None and self.total_bytes > self.max_bytes:
                self._remove(next(iter(self.values)))

    def get(self, key, ttl, loader, *, refresh=False):
        # Successful source data remains public/cacheable. In-flight failures
        # from an anonymous warmup must not be shared with an approved reader.
        loading_key = (key, self.loading_scope()) if self.loading_scope else key
        with self.lock:
            if refresh:
                self._remove(key)
            else:
                value = self._peek(key)
                if value is not None:
                    return value
            future = self.loading.get(loading_key)
            owner = future is None
            if owner:
                future = Future()
                self.loading[loading_key] = future
        if not owner:
            return future.result()
        try:
            value = loader()
            with self.lock:
                if self.loading.get(loading_key) is future:
                    self.put(key, ttl() if callable(ttl) else ttl, value)
            future.set_result(value)
            return value
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self.lock:
                if self.loading.get(loading_key) is future:
                    self.loading.pop(loading_key, None)
