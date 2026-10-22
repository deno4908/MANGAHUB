import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import pytest

from fastapi_app.services import cache_service as module


@pytest.fixture
def local_cache(monkeypatch):
    # Exercise real eviction/persistence policy without a background writer or
    # reading/writing the running application's persistent cache.
    cache = module._InMemoryCache.__new__(module._InMemoryCache)
    cache._store = OrderedDict()
    cache._lock = threading.Lock()
    cache._dirty = False
    monkeypatch.setattr(module, "RUNTIME_CACHE_MAX_ENTRIES", 3)
    monkeypatch.setattr(module, "RUNTIME_CACHE_MAX_MEMORY_BYTES", 4096)
    return cache


def test_new_metadata_survives_full_cache_of_long_lived_cover_hints(local_cache):
    for number in range(3):
        local_cache.set(f"cover-{number}", "cover", ttl=86400)
    local_cache.set("card-title", "Authoritative title", ttl=3600)
    assert local_cache.get("card-title") == "Authoritative title"
    assert local_cache.get("cover-0") is None
    local_cache.get("cover-1")
    local_cache.set("fresh-catalog", "page", ttl=30)
    assert local_cache.get("card-title") == "Authoritative title"
    assert local_cache.get("cover-2") is None
    assert len(local_cache._store) == 3


def test_eviction_respects_byte_limit_and_expired_values(local_cache, monkeypatch):
    monkeypatch.setattr(module, "RUNTIME_CACHE_MAX_MEMORY_BYTES", 12)
    local_cache.set("old-cover", "12345678", ttl=86400)
    local_cache.set("new-title", "12345678", ttl=3600)
    assert local_cache.get("old-cover") is None
    assert local_cache.get("new-title") == "12345678"
    local_cache._store["expired"] = ("bad title", time.time() - 1)
    assert local_cache.get("expired") is None


def test_bounded_disk_snapshot_prefers_recent_metadata_and_retains_lru_order(local_cache, monkeypatch):
    monkeypatch.setattr(module, "RUNTIME_CACHE_MAX_PERSIST_BYTES", 175)
    local_cache.set("cover", "long expiry", ttl=86400)
    local_cache.set("title", "new title", ttl=3600)
    local_cache.set("page", "catalog", ttl=30)
    snapshot = local_cache._persistent_snapshot_locked()
    assert list(snapshot) == ["title", "page"]
    restored = OrderedDict(snapshot)
    assert restored.popitem(last=False)[0] == "title"


def test_snapshot_creation_keeps_one_winner_until_expiry(local_cache):
    def write(number):
        return number, local_cache.add("ranking", str(number), ttl=90)
    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(write, range(32)))
    winners = [number for number, won in results if won]
    assert len(winners) == 1
    assert local_cache.get("ranking") == str(winners[0])
    local_cache._store["ranking"] = (str(winners[0]), time.time() - 1)
    assert local_cache.add("ranking", "refreshed", ttl=90)
    assert local_cache.get("ranking") == "refreshed"
