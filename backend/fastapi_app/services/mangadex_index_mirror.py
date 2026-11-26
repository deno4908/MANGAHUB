"""Reuse public release-index bytes on a native host with a local Redis cache.

Every read still checks the exact shared bytes' digest. Only the two most recent
blobs are retained locally; filtering and authorization stay in the caller.
"""
import hashlib
import json
from urllib.parse import urlsplit

from redis.exceptions import RedisError
from serverless_runtime import IS_VERCEL

_DIGEST = "local v=redis.call('get',KEYS[1]); if not v then return false end; return redis.sha1hex(v)"
_PREFIX = 'mangadex:index-mirror:v1:'
_MAX_BYTES = 4 * 1024 * 1024


def _cache():
    from config import config
    if IS_VERCEL or urlsplit(config.REDIS_URL or '').hostname not in {'localhost', '127.0.0.1', '::1'}:
        return None
    from fastapi_app.services.cache_service import cache
    return cache


def read_blob(client, key):
    mirror = _cache()
    if mirror is None:
        return client.get(key)
    try:
        digest = client.eval(_DIGEST, 1, key)
    except RedisError:
        # Older/limited Redis services can keep the original read path.
        return client.get(key)
    if not digest:
        return None
    if isinstance(digest, bytes):
        digest = digest.decode('ascii')
    slot = _PREFIX + ('active' if key.endswith(':state') else 'snapshot')
    try:
        saved = json.loads(mirror.get(slot) or '{}')
        raw = saved.get('blob')
        if saved.get('digest') == digest and isinstance(raw, str) and len(raw) <= _MAX_BYTES and hashlib.sha1(raw.encode()).hexdigest() == digest:
            return raw
    except (RedisError, OSError, ValueError, TypeError, AttributeError):
        pass
    raw = client.get(key)
    if isinstance(raw, bytes):
        raw = raw.decode('utf-8')
    if isinstance(raw, str) and len(raw) <= _MAX_BYTES:
        try:
            # The shared writer may have published a new index between EVAL
            # and GET. Store under the bytes actually read, never the old digest.
            mirror.set(slot, json.dumps({'digest': hashlib.sha1(raw.encode()).hexdigest(), 'blob': raw}), ttl=900)
        except (RedisError, OSError, ValueError, TypeError):
            pass
    return raw
