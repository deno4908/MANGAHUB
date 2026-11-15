import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from starlette.requests import Request
import source_status as status


def test_probe_authenticates_before_network_access(monkeypatch):
    probe=Mock(side_effect=AssertionError('Must not reach network'))
    monkeypatch.setattr(status,'qq_direct_status',probe)
    monkeypatch.setenv('CRON_SECRET','operator-fixture')
    for headers in [[],[(b'authorization',b'Bearer wrong')]]:
        with pytest.raises(HTTPException) as e:asyncio.run(status.source_status(Request({'type':'http','headers':headers})))
        assert e.value.status_code==401
    probe.assert_not_called()


def test_authenticated_probe_has_no_caller_url_or_credential_forwarding(monkeypatch):
    monkeypatch.setenv('CRON_SECRET','operator-fixture')
    probe=Mock(return_value={'status':200,'valid_listing':True})
    monkeypatch.setattr(status,'qq_direct_status',probe)
    value=asyncio.run(status.source_status(Request({'type':'http','headers':[(b'authorization',b'Bearer operator-fixture')],'query_string':b'url=https://private.example'})))
    assert value=={'status':200,'valid_listing':True}
    probe.assert_called_once_with()
