"""
Simple cache service — uses Redis if available, falls back to in-memory dict.
"""
import json
import os
import threading
import time
import atexit
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
        self._store: dict = {}
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
                loaded = {
                    k: (v[0], float(v[1]))
                    for k, v in raw.items()
                    if isinstance(v, list) and len(v) == 2 and float(v[1]) > now
                }
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
            self._store = {}

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

        # Drop entries expiring soonest first. This keeps hot long-lived catalog
        # snapshots around while preventing the local fallback cache from growing
        # until JSON persistence starts stuttering the dev server.
        ordered_keys = [
            key
            for key, _value in sorted(
                self._store.items(),
                key=lambda item: (float(item[1][1]), len(str(item[1][0]))),
            )
        ]
        total_size = sum(self._value_size(value) for value, _ in self._store.values())
        while ordered_keys and (
            len(self._store) > RUNTIME_CACHE_MAX_ENTRIES or
            total_size > RUNTIME_CACHE_MAX_MEMORY_BYTES
        ):
            key = ordered_keys.pop(0)
            item = self._store.pop(key, None)
            if item is None:
                continue
            total_size -= self._value_size(item[0])

    def _persistent_snapshot_locked(self) -> dict:
        self._prune_locked()
        candidates = []
        for key, (value, expires_at) in self._store.items():
            size = self._value_size(value)
            if size > RUNTIME_CACHE_MAX_VALUE_PERSIST_BYTES:
                continue
            candidates.append((key, value, expires_at, size))

        candidates.sort(key=lambda item: item[2], reverse=True)
        snapshot = {}
        total_size = 2
        for key, value, expires_at, size in candidates:
            entry_size = len(key.encode("utf-8", errors="ignore")) + size + 64
            if total_size + entry_size > RUNTIME_CACHE_MAX_PERSIST_BYTES:
                continue
            snapshot[key] = (value, expires_at)
            total_size += entry_size
        return snapshot

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
            return value

    def set(self, key: str, value: str, ttl: int = 300):
        with self._lock:
            self._store[key] = (value, time.time() + ttl)
            self._prune_locked()
            self._dirty = True

    def delete(self, key: str):
        with self._lock:
            self._store.pop(key, None)
            self._dirty = True

    def flush_pattern(self, pattern: str):
        """Delete keys matching a simple prefix pattern (e.g. 'otruyen:*')."""
        with self._lock:
            prefix = pattern.rstrip("*")
            keys_to_delete = [k for k in self._store if k.startswith(prefix)]
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
        keys = self._client.keys(pattern)
        if keys:
            self._client.delete(*keys)


# Export single cache instance
if _use_redis:
    cache = _RedisCache(_redis_client)
    print("[Cache] Redis connected")
else:
    cache = _InMemoryCache()
    print("[Cache] Redis not available, using local persistent cache")
