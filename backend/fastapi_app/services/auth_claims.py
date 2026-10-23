"""Verify asymmetric Supabase access tokens without an Auth API round trip.

Only signing keys are cached here, never a user's role, ban or session state.
Those remain database checks in dependencies.py.
"""
from functools import lru_cache
from threading import Lock
from uuid import UUID

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError

from config import config

_keys_lock = Lock()


@lru_cache(maxsize=2)
def _key_client(issuer: str):
    # Do not cache individual keys forever: removed keys must expire as well.
    return PyJWKClient(issuer + "/.well-known/jwks.json", lifespan=300,
                       timeout=5, cache_keys=False)


def verified_access_claims(token: str) -> dict | None:
    """Return verified claims, or None for the legacy symmetric Auth API path."""
    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if algorithm == "HS256":
            return None
        if algorithm not in {"ES256", "RS256"} or not isinstance(header.get("kid"), str):
            raise jwt.InvalidTokenError("Unsupported signing key")

        # The issuer/key URL comes exclusively from backend configuration. Never
        # follow jku/x5u or an issuer supplied by an unverified token.
        issuer = config.SUPABASE_URL.rstrip("/") + "/auth/v1"
        with _keys_lock:
            key = _key_client(issuer).get_signing_key(header["kid"])
        if key.algorithm_name != algorithm:
            raise jwt.InvalidTokenError("Signing algorithm mismatch")
        claims = jwt.decode(token, key.key, algorithms=[algorithm],
                            audience="authenticated", issuer=issuer,
                            options={"require": ["exp", "iat", "sub", "aud", "iss", "role"]})
        UUID(claims["sub"])
        if claims["role"] != "authenticated":
            raise jwt.InvalidTokenError("Not a user access token")
        return claims
    except PyJWKClientConnectionError as error:
        raise HTTPException(503, "Dịch vụ xác thực tạm thời không khả dụng",
                            headers={"X-MangaHub-Auth-Stage": "signing-keys", "Retry-After": "2"}) from error
    except (jwt.InvalidTokenError, PyJWKClientError, ValueError, TypeError) as error:
        raise HTTPException(401, "Token không hợp lệ hoặc đã hết hạn") from error
