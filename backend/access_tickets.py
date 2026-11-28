"""Server-issued, revocable website access sessions.

A signature alone never grants access: the random ticket must also match the
session registered in Redis after a fresh authorization check. No Supabase
credentials or user-controlled roles are stored in the cookie.
"""
import hashlib
import hmac
import json
import math
import secrets
import time
import zlib
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

import redis
from itsdangerous import BadData, URLSafeSerializer
from itsdangerous.encoding import base64_decode
from config import config

PREFIX = "mh:access:v2:"
COOKIE = "__Host-mh_access_v2"
LIFETIME = 24 * 60 * 60
REVOCATION_TTL = 32 * 24 * 60 * 60
_client = None
current_record = ContextVar("website_access_record", default=None)
refresh_required = ContextVar("website_access_refresh_required", default=False)
live_auth = ContextVar("website_live_auth", default=False)


class Unavailable(RuntimeError):
    pass


class Rejected(ValueError):
    pass


class Changed(Rejected):
    pass


def _db():
    global _client
    if _client is None:
        from redis_runtime import security_client
        _client = security_client()
    return _client


def _key(kind, value):
    return PREFIX + kind + ":" + hashlib.sha256(str(value).encode()).hexdigest()


def _session_key(uid, sid):
    return _key("session", str(uid) + ":" + str(sid))


def identity(claims):
    """Only call with claims whose signature and lifetime were verified."""
    try:
        issued = float(claims["iat"])
        starts = [float(entry["timestamp"]) for entry in claims.get("amr", [])
                  if isinstance(entry, dict) and entry.get("method") != "token_refresh"
                  and isinstance(entry.get("timestamp"), (int, float))
                  and 0 < entry["timestamp"] <= issued]
        if not math.isfinite(issued):
            return None
        return {"uid": str(UUID(claims["sub"])), "sid": str(UUID(claims["session_id"])),
                "iat": min(starts) if starts else issued, "started": bool(starts), "email": claims.get("email")}
    except (KeyError, ValueError, TypeError, AttributeError):
        return None  # Older tokens without a session ID keep live verification.


def _guards(uid, sid):
    return [PREFIX + "epoch", _key("epoch", uid), _key("epoch-session", sid),
            PREFIX + "busy", _key("busy", uid), _key("blocked-session", sid),
            _key("cutoff", uid), _key("first-seen", str(uid) + ":" + str(sid))]


def _read_guards(client, who):
    return _check_guards(client.mget(_guards(who["uid"], who["sid"])), who)


def _check_guards(values, who):
    from redis_runtime import security_cutover
    cutoff = security_cutover()
    if cutoff is not None and (not who.get("started") or who["iat"] <= cutoff):
        raise Rejected("Login predates security store migration")
    if any(values[3:5]):
        raise Unavailable("Quyền truy cập đang được cập nhật. Vui lòng thử lại.")
    if values[5]:
        raise Rejected("Access session was revoked")
    if values[6]:
        cutoff = json.loads(values[6])
        if who["sid"] != cutoff.get("except"):
            # JWT iat advances on refresh. Keep the original login's age so a
            # renewed JWT cannot resurrect a revoked session. Custom tokens
            # lacking AMR need a previously registered session to establish age.
            started = min(who["iat"], float(values[7])) if values[7] else who["iat"]
            if (not values[7] and not who.get("started")) or started <= cutoff["at"]:
                raise Rejected("Login session was revoked")
    return tuple(str(value or "0") for value in values[:3])


def snapshot(who):
    try:
        return _read_guards(_db(), who)
    except redis.RedisError as error:
        raise Unavailable("Không thể kiểm tra phiên truy cập. Vui lòng thử lại.") from error


def _payload(record):
    return {key: record[key] for key in ("uid", "sid", "jti", "exp")}


def _signer_for(client):
    # A dedicated key, generated server-side and shared by Vercel instances.
    # It is independent of the Flask/application secrets and never sent out.
    key = client.get(PREFIX + "signing-key")
    if not key:
        client.set(PREFIX + "signing-key", secrets.token_urlsafe(48), nx=True)
        key = client.get(PREFIX + "signing-key")
    if not key:
        raise Unavailable("Không thể cấp phiên truy cập. Vui lòng thử lại.")
    return _signer_with_key(key)


def _signer_with_key(key):
    return URLSafeSerializer(key, salt="mangahub-website-session-v2",
                             signer_kwargs={"digest_method": hashlib.sha256})


def _signer():
    return _signer_for(_db())


def _registered_session(client, who, *, ticket=False):
    # Read the session and every revocation guard in one atomic Redis MGET.
    # There is still a fresh revocation check on EVERY request.
    values = client.mget([_session_key(who["uid"], who["sid"]), *_guards(who["uid"], who["sid"])])
    return _checked_session_snapshot(values, who, ticket=ticket)


def _checked_session_snapshot(values, who, *, ticket=False):
    raw = values[0]
    if ticket and not raw:
        raise Rejected("Unregistered access ticket")
    record = json.loads(raw) if raw else None
    if record and ticket:
        who = {**who, "iat": record["auth_iat"], "started": record.get("started", False)}
    epochs = _check_guards(values[1:], who)
    if not record:
        return None
    if record["uid"] != who["uid"] or record["sid"] != who["sid"]:
        raise Rejected("Session identity mismatch")
    if record["exp"] <= time.time():
        return None
    if tuple(record["epochs"]) != epochs:
        raise Changed("Permissions changed")
    return record


def read_session(who):
    """Read a registered session using an already verified Supabase identity."""
    try:
        client = _db()
        return _registered_session(client, who)
    except redis.RedisError as error:
        raise Unavailable("Không thể kiểm tra phiên truy cập. Vui lòng thử lại.") from error


def user(record):
    return {"id": record["uid"], "email": record.get("email"), "role": record["role"]}


def encode(record):
    try:
        return _signer().dumps(_payload(record))
    except redis.RedisError as error:
        raise Unavailable("Không thể cấp phiên truy cập. Vui lòng thử lại.") from error


def _ticket_routing_identity(value):
    """Read bounded, UNTRUSTED IDs only to address the atomic Redis snapshot.

    Neither these IDs nor any other unsigned claim authorize access. The
    original cookie must still verify against the freshly read signing key
    before any session, role or permission in that snapshot can be accepted.
    """
    body, signature = value.rsplit(".", 1)
    if not body or not signature:
        raise Rejected("Invalid access ticket")
    compressed = body.startswith(".")
    raw = base64_decode((body[1:] if compressed else body).encode("ascii"))
    if compressed:
        inflater = zlib.decompressobj()
        # Check before deserializing: a tiny unsigned cookie must not expand
        # into an unbounded JSON document while choosing lookup keys.
        raw = inflater.decompress(raw, 2049)
        if len(raw) > 2048 or not inflater.eof or inflater.unused_data:
            raise Rejected("Invalid access ticket")
    elif len(raw) > 2048:
        raise Rejected("Invalid access ticket")
    payload = json.loads(raw)
    if (not isinstance(payload, dict) or set(payload) != {"uid", "sid", "jti", "exp"}
            or not isinstance(payload["uid"], str) or not isinstance(payload["sid"], str)):
        raise Rejected("Invalid access ticket")
    return {"uid": str(UUID(payload["uid"])), "sid": str(UUID(payload["sid"])), "iat": float("inf")}


def decode(value):
    if not value or not isinstance(value, str) or len(value) > 2048:
        raise Rejected("Missing access ticket")
    try:
        who = _ticket_routing_identity(value)
        client = _db()
        # One fresh, atomic read for the key, registered session and ALL
        # revocation guards. No completed verdict or signing key is cached.
        values = client.mget([PREFIX + "signing-key", _session_key(who["uid"], who["sid"]),
                              *_guards(who["uid"], who["sid"])])
        if not values[0]:
            raise Unavailable("Access signing key unavailable")
        payload = _signer_with_key(values[0]).loads(value)
        if not isinstance(payload, dict) or set(payload) != {"uid", "sid", "jti", "exp"}:
            raise Rejected("Invalid access ticket")
        verified_who = {"uid": str(UUID(payload["uid"])), "sid": str(UUID(payload["sid"])), "iat": float("inf")}
        if verified_who != who:
            raise Rejected("Session identity mismatch")
        # The registered record supplies the original verified issuance time;
        # never accept an iat, role or revocation exception from the cookie.
        record = _checked_session_snapshot(values[1:], verified_who, ticket=True)
        if not record or not hmac.compare_digest(str(record["jti"]), str(payload["jti"])) or _payload(record) != payload:
            raise Rejected("Expired, changed or revoked access ticket")
        return record
    except redis.RedisError as error:
        raise Unavailable("Không thể kiểm tra phiên truy cập. Vui lòng thử lại.") from error
    except (BadData, KeyError, TypeError, ValueError, zlib.error, RecursionError) as error:
        raise Rejected("Invalid access ticket") from error


def issue(who, current_user, state, before):
    """Register only after fresh DB authentication AND a whitelist check."""
    if current_user["id"] != who["uid"] or current_user.get("role") not in {"reader", "uploader", "moderator", "admin"}:
        raise Rejected("Invalid access identity")
    record = {**who, "role": current_user["role"], "enabled": state["enabled"],
              "message": state.get("message", ""), "jti": secrets.token_urlsafe(32),
              "exp": int(time.time()) + LIFETIME, "auth_iat": who["iat"], "epochs": list(before)}
    try:
        with _db().pipeline() as pipe:
            pipe.watch(*_guards(who["uid"], who["sid"]))
            if _read_guards(pipe, who) != before:
                raise Rejected("Permissions changed during verification; retry")
            pipe.multi()
            pipe.set(_session_key(who["uid"], who["sid"]), json.dumps(record), ex=LIFETIME)
            pipe.set(_key("first-seen", who["uid"] + ":" + who["sid"]), who["iat"], nx=True, ex=REVOCATION_TTL)
            pipe.execute()
        return record
    except redis.WatchError as error:
        raise Rejected("Permissions changed during verification; retry") from error
    except redis.RedisError as error:
        raise Unavailable("Không thể cấp phiên truy cập. Vui lòng thử lại.") from error


def cookie_name():
    return COOKIE if config.FRONTEND_URL.startswith("https://") else "mh_access_v2"


def set_cookie(response, record):
    secure = config.FRONTEND_URL.startswith("https://")
    if record:
        response.set_cookie(cookie_name(), encode(record), httponly=True, secure=secure,
                            samesite="lax", path="/", max_age=max(1, int(record["exp"] - time.time())))
    else:
        response.delete_cookie(cookie_name(), httponly=True, secure=secure, samesite="lax", path="/")


@contextmanager
def security_change(uid=None):
    """Invalidate before a security write, and prevent grants racing that write.

    The lock outlives Vercel's five-minute invocation limit. If the process or
    Redis connection fails, existing tickets stay invalid and reads fail closed.
    """
    epoch = _key("epoch", uid) if uid else PREFIX + "epoch"
    busy = _key("busy", uid) if uid else PREFIX + "busy"
    owner = secrets.token_urlsafe(24)
    try:
        with _db().pipeline() as pipe:
            pipe.watch(busy)
            if pipe.get(busy):
                raise Unavailable("Quyền truy cập đang được cập nhật. Vui lòng thử lại.")
            pipe.multi()
            pipe.set(busy, owner, ex=600)
            pipe.incr(epoch)
            pipe.execute()
        try:
            yield
        finally:
            with _db().pipeline() as pipe:
                pipe.watch(busy)
                if pipe.get(busy) == owner:
                    pipe.multi()
                    pipe.incr(epoch)
                    pipe.delete(busy)
                    pipe.execute()
    except redis.RedisError as error:
        raise Unavailable("Không thể cập nhật phiên truy cập. Vui lòng thử lại.") from error


def revoke_sessions(who, scope="local", *, check_session=True):
    if scope not in {"local", "global", "others"}:
        raise ValueError("Invalid revocation scope")
    try:
        with _db().pipeline(transaction=True) as pipe:
            if check_session and scope != "local":
                pipe.watch(*_guards(who["uid"], who["sid"]))
                try:
                    _read_guards(pipe, who)
                except Rejected:
                    return  # Idempotent; never grant an exception to a revoked SID.
                pipe.multi()
            if scope == "local":
                pipe.set(_key("blocked-session", who["sid"]), "1", ex=REVOCATION_TTL)
                pipe.incr(_key("epoch-session", who["sid"]))
            else:
                pipe.set(_key("cutoff", who["uid"]), json.dumps({
                    "at": time.time(), "except": who["sid"] if scope == "others" else None,
                }), ex=REVOCATION_TTL)
                pipe.incr(_key("epoch", who["uid"]))
            pipe.execute()
    except redis.RedisError as error:
        raise Unavailable("Không thể thu hồi phiên truy cập. Vui lòng thử lại.") from error
