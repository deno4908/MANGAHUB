"""Content cache failover. Recovery work never runs in a reader's command path.

The standby records a shared outage and probe lease. Security/coordination locks
always use the configured security Redis, never the content fallback or RAM.
"""
import hashlib
import asyncio
import json
import logging
import secrets
import threading
import time

import redis
from config import config
from redis_runtime import availability_error, client_for, normalize_url, security_client

logger = logging.getLogger(__name__)
PREFIX = "mh:content-cache:v1:"


class FailoverCache:
    def __init__(self, cache_type, local_type, *, primary=None, standby=None):
        self._cache_type = cache_type
        self._local_type = local_type
        self._primary = primary
        self._standby = standby
        self._local = None
        self._mode = "primary"
        self._outage = None
        self._initialized = False
        self._guard = threading.RLock()
        self._next_check = 0.0
        self._primary_suppressed = 0.0
        self._needs_state_repair = False
        self._bootstrap_lock = threading.Lock()

    @property
    def _client(self):
        # Catalog locks must stay with authentication's single authority.
        return security_client()

    def _initialize(self):
        if self._initialized:
            return
        with self._bootstrap_lock:
            if self._initialized:
                return
            self._primary = self._primary or client_for(config.REDIS_URL)
            self._standby = self._standby or (client_for(config.REDIS_FALLBACK_URL)
                                             if config.REDIS_FALLBACK_URL else None)
            if self._standby is self._primary:
                raise ValueError("Main and fallback Redis must be different")
            # Do not include credentials in keys or logs.
            scope = normalize_url(config.REDIS_URL).split("@")[-1]
            self._state_key = "mh:cache-failover:v1:" + hashlib.sha256(scope.encode()).hexdigest()[:24]
            # No standby command at all on the healthy main path, including a
            # cold Vercel function. A standby quota outage cannot delay Aiven.
            self._initialized = True

    def _adopt(self, state):
        if not isinstance(state, dict) or state.get("mode") not in {"primary", "fallback"}:
            raise redis.RedisError("Invalid cache routing state")
        outage = state.get("outage")
        if state["mode"] == "fallback" and (not isinstance(outage, str) or len(outage) != 32):
            raise redis.RedisError("Invalid cache outage state")
        with self._guard:
            self._mode, self._outage = state["mode"], outage

    def _failover(self):
        with self._guard:
            if self._mode == "fallback":
                return
            candidate = json.dumps({"mode": "fallback", "outage": secrets.token_hex(16)})
            value = self._standby.eval("""
                local s = redis.call('GET', KEYS[1])
                if s and cjson.decode(s).mode == 'fallback' then return s end
                redis.call('SET', KEYS[1], ARGV[1]); return ARGV[1]
            """, 1, self._state_key, candidate)
            self._adopt(json.loads(value))
            self._next_check = time.monotonic() + config.REDIS_RECOVERY_CHECK_SECONDS
            logger.warning("Content cache switched to fallback")

    def _fallback_cache(self, outage):
        # Never reuse an old outage's stale content after a new incident.
        return self._cache_type(self._standby, PREFIX + outage + ":")

    def _run(self, method, *args, **kwargs):
        self._initialize()
        try:
            if self._mode == "primary" and time.monotonic() >= self._primary_suppressed:
                try:
                    return getattr(self._cache_type(self._primary, PREFIX), method)(*args, **kwargs)
                except redis.RedisError as error:
                    if not availability_error(error):
                        raise
                    self._primary_suppressed = time.monotonic() + 2.0
                    if self._standby is not None:
                        self._failover()
            with self._guard:
                mode, outage = self._mode, self._outage
            if mode == "fallback":
                return getattr(self._fallback_cache(outage), method)(*args, **kwargs)
        except redis.RedisError as error:
            if not availability_error(error):
                raise
        # Content is dispensable; a bounded local cache keeps public reads
        # usable if both stores are down. It never stores any security state.
        with self._guard:
            if self._local is None:
                self._local = self._local_type()
        return getattr(self._local, method)(*args, **kwargs)

    def get(self, key):
        return self._run("get", key)

    def set(self, key, value, ttl=300):
        return self._run("set", key, value, ttl)

    def add(self, key, value, ttl=300):
        return self._run("add", key, value, ttl)

    def delete(self, key):
        return self._run("delete", key)

    def get_many(self, keys):
        return self._run("get_many", list(dict.fromkeys(keys)))

    def set_many(self, values, ttl=300):
        return self._run("set_many", values, ttl)

    def flush_pattern(self, pattern):
        return self._run("flush_pattern", pattern)

    def flush_patterns(self, patterns):
        return self._run("flush_patterns", list(patterns))

    def recovery_due(self):
        if not self._initialized or (self._mode != "fallback" and not self._needs_state_repair):
            return False
        with self._guard:
            if time.monotonic() < self._next_check:
                return False
            self._next_check = time.monotonic() + config.REDIS_RECOVERY_CHECK_SECONDS
            return True

    def check_primary(self):
        """Called only after the response (or by the protected maintenance job)."""
        if not self._initialized or self._standby is None or (self._mode != "fallback" and not self._needs_state_repair):
            return
        try:
            try:
                state = self._standby.get(self._state_key)
            except redis.RedisError as error:
                if not availability_error(error):
                    raise
                if self._mode == "fallback":
                    self._recover_without_standby()
                return
            if not state:
                return  # Never guess a route after its control state was lost.
            decoded = json.loads(state)
            if decoded.get("mode") == "primary":
                self._adopt(decoded)
                self._needs_state_repair = False
                return
            repairing = self._mode == "primary" and self._needs_state_repair
            if not repairing:
                self._adopt(decoded)
            if not self._standby.set(self._state_key + ":probe", "1", nx=True,
                                     ex=config.REDIS_RECOVERY_CHECK_SECONDS):
                return
            # PING is insufficient: quota-exhausted servers may still answer it.
            probe = "mh:redis-probe:" + secrets.token_hex(16)
            self._primary.set(probe, "ok", ex=10)
            if self._primary.get(probe) != "ok":
                return
            self._primary.delete(probe)
            ready = json.dumps({"mode": "primary"})
            if repairing:
                changed = self._standby.eval("""
                    if redis.call('GET', KEYS[1]) == ARGV[1] then
                        redis.call('SET', KEYS[1], ARGV[2]); return 1
                    end
                    return 0
                """, 1, self._state_key, state, ready)
                if changed:
                    self._needs_state_repair = False
                return
            deadline = time.monotonic() + 3.0
            # Remove only public cache entries. Never SCAN/DELETE security keys.
            for batch in self._batches(self._primary.scan_iter(match=PREFIX + "*", count=200)):
                self._primary.delete(*batch)
                if time.monotonic() >= deadline:
                    return
            # Warm up to 400 current standby entries before returning traffic.
            prefix = PREFIX + decoded["outage"] + ":"
            warmed = 0
            for batch in self._batches(self._standby.scan_iter(match=prefix + "*", count=100), 100):
                with self._standby.pipeline(transaction=False) as pipe:
                    for key in batch:
                        pipe.get(key).pttl(key)
                    rows = pipe.execute()
                with self._primary.pipeline(transaction=False) as pipe:
                    for key, value, ttl in zip(batch, rows[::2], rows[1::2]):
                        if value is not None and ttl > 1000:
                            pipe.set(PREFIX + key[len(prefix):], value, px=max(1, ttl - 1000))
                    pipe.execute()
                warmed += len(batch)
                if warmed >= 400 or time.monotonic() >= deadline:
                    break
            changed = self._standby.eval("""
                if redis.call('GET', KEYS[1]) == ARGV[1] then
                    redis.call('SET', KEYS[1], ARGV[2]); return 1
                end
                return 0
            """, 1, self._state_key, state, ready)
            if changed:
                self._adopt(json.loads(ready))
                self._primary_suppressed = 0
                self._needs_state_repair = False
                logger.info("Content cache main recovered; fallback remains available")
        except (redis.RedisError, ValueError, KeyError):
            logger.warning("Content cache recovery check failed; keeping fallback")

    def _recover_without_standby(self):
        # Standby can exhaust its quota while the main recovers. Probe the main
        # after the response instead of staying in local RAM indefinitely.
        probe = "mh:redis-probe:" + secrets.token_hex(16)
        self._primary.set(probe, "ok", ex=10)
        if self._primary.get(probe) != "ok":
            return
        self._primary.delete(probe)
        deadline = time.monotonic() + 3
        for batch in self._batches(self._primary.scan_iter(match=PREFIX + "*", count=200)):
            self._primary.delete(*batch)
            if time.monotonic() >= deadline:
                return
        self._adopt({"mode": "primary"})
        self._primary_suppressed = 0
        self._needs_state_repair = True
        logger.info("Content cache main recovered while standby is unavailable")

    @staticmethod
    def _batches(iterator, size=200):
        batch = []
        for key in iterator:
            batch.append(key)
            if len(batch) >= size:
                yield batch
                batch = []
        if batch:
            yield batch


class RedisRecoveryMiddleware:
    """Finish the response before running a finite, tracked recovery check."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def wrapped_send(message):
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                from fastapi_app.services.cache_service import cache
                if isinstance(cache, FailoverCache) and cache.recovery_due():
                    from serverless_runtime import create_task
                    create_task(asyncio.to_thread(cache.check_primary))

        return await self.app(scope, receive, wrapped_send)
