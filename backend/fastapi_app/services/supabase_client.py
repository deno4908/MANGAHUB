"""Reuse Supabase database connections without the unstable HTTP/2 route.

Keep each client's credentials, TLS verification, schema and timeouts intact.
Only PostgREST's HTTP transport changes; Auth, Storage and Realtime are intact.
"""
import httpx
from postgrest import SyncPostgrestClient
from supabase._sync.client import SyncClient


class _DatabaseClient(SyncPostgrestClient):
    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return httpx.Client(base_url=base_url, headers=headers, timeout=timeout,
                            verify=verify, proxy=proxy, follow_redirects=True, http2=False)


class _SupabaseClient(SyncClient):
    @staticmethod
    def _init_postgrest_client(rest_url, headers, schema, timeout=120, verify=True, proxy=None):
        return _DatabaseClient(rest_url, headers=headers, schema=schema, timeout=timeout,
                               verify=verify, proxy=proxy)


def create_client(url, key):
    return _SupabaseClient.create(url, key)
