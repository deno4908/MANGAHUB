"""Optional Cloudflare Access boundary for the combined app:app deployment.

This layer does not replace Supabase authentication, roles, or site whitelist.
All HTTP paths (including auth, health and cron) require Access when enabled.
"""
from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from functools import lru_cache

import jwt
from starlette.responses import PlainTextResponse


PRIVATE_HEADERS = {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
}


def access_settings():
    required = os.getenv("CF_ACCESS_REQUIRED", "").strip().lower()
    if required in {"", "0", "false", "off", "no"}:
        return None
    if required not in {"1", "true", "on", "yes"}:
        raise ValueError("Invalid Access configuration")
    host = os.getenv("CF_ACCESS_TEAM_DOMAIN", "").strip().removeprefix("https://").removesuffix("/")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com", host):
        raise ValueError("Invalid Access configuration")
    audience = [value.strip() for value in os.getenv("CF_ACCESS_AUD", "").split(",")]
    if len(audience) > 8 or any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,256}", value) for value in audience):
        raise ValueError("Invalid Access configuration")
    return "https://" + host, audience


@lru_cache(maxsize=8)
def _key_client(issuer):
    return _AccessKeys(issuer)


class _AccessKeys:
    """Coalesce key refreshes and bound unknown-kid requests to one per 30s."""
    def __init__(self, issuer):
        self.client = jwt.PyJWKClient(issuer + "/cdn-cgi/access/certs", timeout=3)
        self.lock = threading.Lock()
        self.keys = {}
        self.fetched_at = float("-inf")
        self.attempted_at = float("-inf")

    def get_signing_key_from_jwt(self, token):
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str) or not 0 < len(kid) <= 256:
            raise jwt.InvalidTokenError("Invalid Access header")
        with self.lock:
            now = time.monotonic()
            if now - self.fetched_at < 300 and kid in self.keys:
                return self.keys[kid]
            if now - self.attempted_at < 30:
                raise jwt.InvalidTokenError("Access keys unavailable")
            self.attempted_at = now
            key_set = self.client.get_jwk_set(refresh=True)
            self.keys = {key.key_id: key for key in key_set.keys if key.key_id
                         and key.algorithm_name == "RS256" and key.public_key_use in {None, "sig"}}
            self.fetched_at = time.monotonic()
            if kid not in self.keys:
                raise jwt.InvalidTokenError("Access key unavailable")
            return self.keys[kid]


def verify_access_token(token, settings):
    issuer, audience = settings
    key = _key_client(issuer).get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, key, algorithms=["RS256"], issuer=issuer, audience=audience,
                        options={"require": ["exp", "iat", "iss", "aud"]}, leeway=0)
    if not isinstance(claims["iat"], (int, float)) or claims["exp"] <= claims["iat"]:
        raise jwt.InvalidTokenError("Invalid Access lifetime")
    return claims


class CloudflareAccessMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        status = 403
        try:
            settings = access_settings()
        except ValueError:
            settings, status = True, 503
        if settings is None:
            return await self.app(scope, receive, send)
        tokens = [value.decode("latin1") for name, value in scope.get("headers", [])
                  if name.lower() == b"cf-access-jwt-assertion"]
        allowed = False
        if status != 503 and len(tokens) == 1 and 0 < len(tokens[0]) <= 16_384 and "," not in tokens[0]:
            try:
                await asyncio.to_thread(verify_access_token, tokens[0], settings)
                allowed = True
            except Exception:
                # No JWT contents, credentials or provider error text in output.
                pass
        if not allowed:
            if scope["type"] == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            response = PlainTextResponse("" if scope["method"] == "HEAD" else "Unavailable",
                                         status_code=status, headers=PRIVATE_HEADERS)
            return await response(scope, receive, send)

        async def private_send(message):
            if message["type"] == "http.response.start":
                overrides = {key.lower().encode(): value.encode() for key, value in PRIVATE_HEADERS.items()}
                message = {**message, "headers": [
                    (key, value) for key, value in message.get("headers", []) if key.lower() not in overrides
                ] + list(overrides.items())}
            await send(message)

        return await self.app(scope, receive, private_send)
