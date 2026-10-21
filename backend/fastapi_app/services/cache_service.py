"""
Simple cache service — uses Redis if available, falls back to in-memory dict.
"""
import json
import os
import threading
import time
import atexit
from collections import OrderedDict
from typing import Optional

try:
    import redis
    from config import config
    _redis_client = redis.from_url(config.REDIS_URL, decode_responses=True)
    # Test connection
    _redis_client.ping()
    _use_redis = True
except Exception:
    _redis_client = None
    _use_redis = False

def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except Exception:
        return default


RUNTIME_CACHE_FLUSH_INTERVAL_SECONDS = _env_int("RUNTIME_CACHE_FLUSH_INTERVAL_SECONDS", 8)
RUNTIME_CACHE_MAX_ENTRIES = _env_int("RUNTIME_CACHE_MAX_ENTRIES", 1200)
RUNTIME_CACHE_MAX_MEMORY_BYTES = _env_int("RUNTIME_CACHE_MAX_MEMORY_MB", 64) * 1024 * 1024
RUNTIME_CACHE_MAX_PERSIST_BYTES = _env_int("RUNTIME_CACHE_MAX_PERSIST_MB", 5) * 1024 * 1024
RUNTIME_CACHE_MAX_VALUE_PERSIST_BYTES = _env_int("RUNTIME_CACHE_MAX_VALUE_PERSIST_KB", 512) * 1024


class _InMemoryCache:
    """Fallback in-memory cache when Redis is not available."""

    def __init__(self):
        self._store: OrderedDict = OrderedDict()
        self._lock = threading.Lock()
        self._dirty = False
        self._stop_event = threading.Event()
        self._cache_file = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", ".runtime_cache.json")
        )
        self._load_from_disk()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._flush_thread.start()
        atexit.register(self.close)

    def _load_from_disk(self):
        if not os.path.exists(self._cache_file):
            return
        try:
            with open(self._cache_file, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                now = time.time()
                loaded = OrderedDict(
                    (k, (v[0], float(v[1])))
                    for k, v in raw.items()
                    if isinstance(v, list) and len(v) == 2 and float(v[1]) > now
                )
                self._store = loaded
                loaded_count = len(self._store)
                self._prune_locked()
                try:
                    file_size = os.path.getsize(self._cache_file)
                except OSError:
                    file_size = 0
                if len(self._store) != loaded_count or file_size > RUNTIME_CACHE_MAX_PERSIST_BYTES:
                    self._dirty = True
        except Exception:
            self._store = OrderedDict()

    def _flush_loop(self):
        while not self._stop_event.is_set():
            self._stop_event.wait(float(RUNTIME_CACHE_FLUSH_INTERVAL_SECONDS))
            self._persist_to_disk()

    @staticmethod
    def _value_size(value: object) -> int:
        if isinstance(value, str):
            return len(value.encode("utf-8", errors="ignore"))
        return len(str(value).encode("utf-8", errors="ignore"))

    def _prune_locked(self):
        now = time.time()
        expired = [key for key, (_, expires_at) in self._store.items() if expires_at <= now]
        for key in expired:
            self._store.pop(key, None)

        if len(self._store) <= RUNTIME_CACHE_MAX_ENTRIES:
            total_size = sum(self._value_size(value) for value, _ in self._store.values())
            if total_size <= RUNTIME_CACHE_MAX_MEMORY_BYTES:
                return

        # Evict least recently used entries. Expiry is not popularity: a day-old
        # cover hint must not immediately evict newly fetched one-hour metadata.
        total_size = sum(self._value_size(value) for value, _ in self._store.values())
        while self._store and (
            len(self._store) > RUNTIME_CACHE_MAX_ENTRIES or
            total_size > RUNTIME_CACHE_MAX_MEMORY_BYTES
        ):
            _key, item = self._store.popitem(last=False)
            total_size -= self._value_size(item[0])

    def _persistent_snapshot_locked(self) -> dict:
        self._prune_locked()
        candidates = []
        for key, (value, expires_at) in self._store.items():
            size = self._value_size(value)
            if size > RUNTIME_CACHE_MAX_VALUE_PERSIST_BYTES:
                continue
            candidates.append((key, value, expires_at, size))

        snapshot = {}
        total_size = 2
        for key, value, expires_at, size in reversed(candidates):
            entry_size = len(key.encode("utf-8", errors="ignore")) + size + 64
            if total_size + entry_size > RUNTIME_CACHE_MAX_PERSIST_BYTES:
                continue
            snapshot[key] = (value, expires_at)
            total_size += entry_size
        # Preserve the LRU order when the same bounded snapshot is loaded again.
        return dict(reversed(snapshot.items()))

    def _persist_to_disk(self):
        with self._lock:
            if not self._dirty:
                return
            snapshot = self._persistent_snapshot_locked()
            self._dirty = False
        os.makedirs(os.path.dirname(self._cache_file), exist_ok=True)
        payload = {k: [v[0], v[1]] for k, v in snapshot.items()}
        try:
            with open(self._cache_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception:
            with self._lock:
                self._dirty = True

    def close(self):
        self._stop_event.set()
        self._persist_to_disk()

    def get(self, key: str) -> Optional[str]:
        with self._lock:
            item = self._store.get(key)
            if item is None:
                return None
            value, expires_at = item
            if time.time() > expires_at:
                del self._store[key]
                self._dirty = True
                return None
            self._store.move_to_end(key)
            return value

    def set(self, key: str, value: str, ttl: int = 300):
        with self._lock:
            self._store[key] = (value, time.time() + ttl)
            self._store.move_to_end(key)
            self._prune_locked()
            self._dirty = True

    def delete(self, key: str):
        with self._lock:
            self._store.pop(key, None)
            self._dirty = True

    def flush_pattern(self, pattern: str):
        """Delete matching keys without invalidating unrelated cache entries."""
        self.flush_patterns([pattern])

    def flush_patterns(self, patterns):
        from fnmatch import fnmatchcase
        with self._lock:
            keys_to_delete = [k for k in self._store if any(fnmatchcase(k, pattern) for pattern in patterns)]
            for k in keys_to_delete:
                del self._store[k]
            self._dirty = True


class _RedisCache:
    """Redis-based cache."""

    def __init__(self, client):
        self._client = client

    def get(self, key: str) -> Optional[str]:
        return self._client.get(key)

    def set(self, key: str, value: str, ttl: int = 300):
        self._client.setex(key, ttl, value)

    def delete(self, key: str):
        self._client.delete(key)

    def flush_pattern(self, pattern: str):
        """Delete keys matching a pattern."""
        batch = []
        for key in self._client.scan_iter(match=pattern, count=200):
            batch.append(key)
            if len(batch) >= 200:
                self._client.delete(*batch)
                batch.clear()
        if batch:
            self._client.delete(*batch)

    def flush_patterns(self, patterns):
        """Scan each namespace once, even when hundreds of books changed."""
        from fnmatch import fnmatchcase
        groups = {}
        for pattern in patterns:
            root = pattern.split(":", 1)[0] if ":" in pattern else ""
            namespace = root + ":*" if root and not any(c in root for c in "*?[") else "*"
            groups.setdefault(namespace, []).append(pattern)
        for namespace, matchers in groups.items():
            batch = []
            for key in self._client.scan_iter(match=namespace, count=500):
                if any(fnmatchcase(key, pattern) for pattern in matchers):
                    batch.append(key)
                    if len(batch) >= 200:
                        self._client.delete(*batch)
                        batch.clear()
            if batch:
                self._client.delete(*batch)


# Export single cache instance
if _use_redis:
    cache = _RedisCache(_redis_client)
    print("[Cache] Redis connected")
else:
    cache = _InMemoryCache()
    print("[Cache] Redis not available, using local persistent cache")
