import hashlib
import json
from unittest.mock import Mock

import pytest
from redis.exceptions import ResponseError
from fastapi_app.services import mangadex_index_mirror as mirror

KEY = 'mh:mangadex-release-index:v1:vi:state'


@pytest.fixture
def local(monkeypatch):
    values = {}
    cache = Mock(get=Mock(side_effect=values.get), set=Mock(side_effect=lambda key, value, **kw: values.__setitem__(key, value)))
    monkeypatch.setattr(mirror, '_cache', lambda: cache)
    return cache, values


def remote(value):
    return Mock(eval=Mock(side_effect=lambda *args: hashlib.sha1(value.encode()).hexdigest() if value else None), get=Mock(return_value=value))


def test_reuses_verified_bytes_across_cold_processes_without_downloading_index_again(local):
    client = remote('public-index-payload')
    assert mirror.read_blob(client, KEY) == 'public-index-payload'
    assert mirror.read_blob(client, KEY) == 'public-index-payload'
    assert client.get.call_count == 1 and client.eval.call_count == 2


def test_shared_updates_and_expired_snapshots_never_reuse_old_mirror_data(local):
    assert mirror.read_blob(remote('old'), KEY) == 'old'
    assert mirror.read_blob(remote('new'), KEY) == 'new'
    assert mirror.read_blob(remote(None), KEY) is None


def test_a_writer_race_stores_the_digest_of_the_actual_download(local):
    client = remote('new')
    client.eval.side_effect = lambda *a: hashlib.sha1(b'old').hexdigest()
    assert mirror.read_blob(client, KEY) == 'new'
    saved = json.loads(local[1][mirror._PREFIX + 'active'])
    assert saved['digest'] == hashlib.sha1(b'new').hexdigest()


def test_corrupted_local_bytes_are_replaced_and_only_two_slots_are_used(local):
    local[1][mirror._PREFIX + 'active'] = json.dumps({'digest': hashlib.sha1(b'good').hexdigest(), 'blob': 'corrupt'})
    assert mirror.read_blob(remote('good'), KEY) == 'good'
    for n in range(5):mirror.read_blob(remote(str(n)), KEY.replace('state', f'snapshot:{n}'))
    assert set(local[1]) == {mirror._PREFIX + 'active', mirror._PREFIX + 'snapshot'}


def test_unsupported_scripting_and_non_native_hosts_keep_the_original_reader(local, monkeypatch):
    client = remote('public-index')
    client.eval.side_effect = ResponseError('scripting unavailable')
    assert mirror.read_blob(client, KEY) == 'public-index'
    monkeypatch.setattr(mirror, '_cache', lambda: None)
    client.eval.reset_mock()
    assert mirror.read_blob(client, KEY) == 'public-index'
    client.eval.assert_not_called()


def test_optional_mirror_failure_does_not_break_catalog_reads(local):
    local[0].get.side_effect = ResponseError('local cache unavailable')
    local[0].set.side_effect = ResponseError('local cache unavailable')
    assert mirror.read_blob(remote('public-index'), KEY) == 'public-index'


def test_guard_only_enables_mirror_for_native_local_redis(monkeypatch):
    from config import config
    from fastapi_app.services import cache_service
    monkeypatch.setattr(mirror, 'IS_VERCEL', True)
    assert mirror._cache() is None
    monkeypatch.setattr(mirror, 'IS_VERCEL', False)
    monkeypatch.setattr(config, 'REDIS_URL', 'rediss://cache.example:6379')
    assert mirror._cache() is None
    monkeypatch.setattr(config, 'REDIS_URL', 'redis://127.0.0.1:6379')
    assert mirror._cache() is cache_service.cache
