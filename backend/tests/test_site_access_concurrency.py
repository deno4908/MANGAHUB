import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import site_access as policy
import pytest


@pytest.fixture(autouse=True)
def isolated_reads(monkeypatch):
    monkeypatch.setattr(policy, "_cache", {})
    monkeypatch.setattr(policy, "_read_locks", {})


def test_slow_membership_lookup_does_not_block_an_already_cached_site_policy(monkeypatch):
    started, release = threading.Event(), threading.Event()
    class Query:
        def select(self, *args): return self
        def eq(self, *args): return self
        def limit(self, *args): return self
        def execute(self):
            started.set()
            release.wait(3)
            return SimpleNamespace(data=[{"value": {"allowed": True}}])
    monkeypatch.setattr(policy, "_db", lambda: SimpleNamespace(table=lambda _: Query()))
    monkeypatch.setattr(policy, "_cache", {policy.SETTING_KEY: (time.monotonic() + 30, {"enabled": True})})
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(policy._read, policy.MEMBER_PREFIX + "reader")
        try:
            assert started.wait(1)
            cached = pool.submit(policy._read, policy.SETTING_KEY)
            assert cached.result(timeout=0.5) == {"enabled": True}
        finally:
            release.set()
        assert slow.result(timeout=1) == {"allowed": True}


def test_different_uncached_accounts_can_check_membership_in_parallel(monkeypatch):
    entered = threading.Barrier(3)
    class Query:
        def select(self, *args): return self
        def eq(self, *args): return self
        def limit(self, *args): return self
        def execute(self):
            entered.wait(timeout=2)
            return SimpleNamespace(data=[{"value": {"allowed": True}}])
    monkeypatch.setattr(policy, "_db", lambda: SimpleNamespace(table=lambda _: Query()))
    with ThreadPoolExecutor(max_workers=2) as pool:
        readers = [pool.submit(policy._read, policy.MEMBER_PREFIX + name) for name in ["first", "second"]]
        entered.wait(timeout=2)
        assert all(reader.result(timeout=1)["allowed"] for reader in readers)
    assert not policy._read_locks


def test_same_membership_lookup_still_shares_one_database_read(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    class Query:
        def select(self, *args): return self
        def eq(self, *args): return self
        def limit(self, *args): return self
        def execute(self):
            calls.append(1)
            entered.set()
            release.wait(3)
            return SimpleNamespace(data=[{"value": {"allowed": True}}])
    monkeypatch.setattr(policy, "_db", lambda: SimpleNamespace(table=lambda _: Query()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        readers = [pool.submit(policy._read, policy.MEMBER_PREFIX + "reader") for _ in range(8)]
        try:
            assert entered.wait(1)
        finally:
            release.set()
        assert all(reader.result(timeout=1)["allowed"] for reader in readers)
    assert len(calls) == 1
    assert not policy._read_locks


def test_revocation_invalidation_cannot_be_undone_by_an_earlier_database_read(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    row = [{"allowed": True}]
    reads = []
    class Query:
        def select(self, *args): return self
        def eq(self, *args): return self
        def limit(self, *args): return self
        def execute(self):
            value = dict(row[0])
            reads.append(1)
            if len(reads) == 1:
                entered.set()
                release.wait(3)
            return SimpleNamespace(data=[{"value": value}])
    monkeypatch.setattr(policy, "_db", lambda: SimpleNamespace(table=lambda _: Query()))
    key = policy.MEMBER_PREFIX + "reader"
    with ThreadPoolExecutor(max_workers=2) as pool:
        reader = pool.submit(policy._read, key)
        try:
            assert entered.wait(1)
            row[0] = {"allowed": False}
            invalidated = pool.submit(policy._invalidate, key)
            try:
                invalidated.result(timeout=0.1)
            except TimeoutError:
                pass
        finally:
            release.set()
        reader.result(timeout=1)
        invalidated.result(timeout=1)
    assert policy._read(key) == {"allowed": False}
    assert not policy._read_locks
