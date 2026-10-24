import asyncio
import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, StrictBool
from fastapi_app.dependencies import require_admin
from fastapi_app import dependencies
from fastapi_app.services.auth_claims import verified_access_claims
from config import config
import access_tickets
import jwt
import time
import site_access as policy

router = APIRouter()


class AccessMode(BaseModel):
    enabled: StrictBool
    message: str = Field(default=policy.DEFAULT_MESSAGE, max_length=1000)


class AccessMember(BaseModel):
    allowed: StrictBool


@router.get("/site-access")
async def access_status(request: Request, response: Response):
    user = getattr(request.state, "api_user", None)
    record = getattr(request.state, "access_ticket", None)
    authorization = request.headers.get("authorization", "")
    if record and (record["exp"] - time.time() > 60 or not authorization.startswith("Bearer ")):
        await asyncio.to_thread(access_tickets.set_cookie, response, record)
        response.headers["Cache-Control"] = "private, no-store"
        return {"enabled": record["enabled"], "allowed": True, "authenticated": True,
                "is_admin": record["role"] == "admin", "message": record["message"],
                "access_expires_at": record["exp"] * 1000}
    who, before = None, None
    try:
        if user and authorization.startswith("Bearer "):
            # The middleware already verified this exact bearer. Unsigned
            # decoding here only obtains its session ID, never authorizes it.
            try:
                claims = jwt.decode(authorization[7:], options={"verify_signature": False})
            except jwt.PyJWTError:
                claims = {}
            who = access_tickets.identity(claims)
            if who and who["uid"] == user["id"]:
                before = await asyncio.to_thread(access_tickets.snapshot, who)
                user = await dependencies._live_user_read(authorization, True)
            else:
                who = None
        state = await asyncio.to_thread(policy.get_state, force=who is not None)
        allowed = await asyncio.to_thread(policy.is_allowed, state, user, force=who is not None)
        if allowed and who:
            record = await asyncio.to_thread(access_tickets.issue, who, user, state, before)
            await asyncio.to_thread(access_tickets.set_cookie, response, record)
    except access_tickets.Rejected as error:
        raise HTTPException(401, "Phiên đăng nhập đã hết hạn hoặc bị thu hồi") from error
    except access_tickets.Unavailable as error:
        raise HTTPException(503, str(error), headers={"Cache-Control": "no-store"}) from error
    except policy.AccessUnavailable as error:
        if not user or user.get("role") != "admin":
            raise HTTPException(503, str(error), headers={"Cache-Control": "no-store"}) from error
        # The gateway has verified the token and current database role. Match its
        # admin recovery rule without opening access for any other account.
        state = {"enabled": True, "message": policy.DEFAULT_MESSAGE}
        allowed = True
    if not record:
        access_tickets.set_cookie(response, None)
    # Retain v1 only for legacy login tokens without a session identifier.
    policy.set_asset_cookie(response, authorization[7:] if not record and state["enabled"] and allowed and user else None)
    response.headers["Cache-Control"] = "private, no-store"
    return {**state, "allowed": allowed, "authenticated": user is not None,
            "is_admin": bool(user and user.get("role") == "admin"),
            **({"access_expires_at": record["exp"] * 1000} if record else {})}


@router.post("/site-access/logout")
async def end_access_session(request: Request, response: Response):
    origin = request.headers.get("origin")
    if request.headers.get("x-mangahub-csrf") != "1" or (origin and origin != config.FRONTEND_URL.rstrip("/")):
        raise HTTPException(403, "Yêu cầu đăng xuất không hợp lệ")
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(400, "Dữ liệu đăng xuất không hợp lệ") from error
    if not isinstance(payload, dict):
        raise HTTPException(400, "Dữ liệu đăng xuất không hợp lệ")
    scope = payload.get("scope", "local")
    if not isinstance(scope, str) or scope not in {"local", "global", "others"}:
        raise HTTPException(400, "Phạm vi đăng xuất không hợp lệ")
    authorization = request.headers.get("authorization", "")
    who = None
    if authorization.startswith("Bearer "):
        try:
            who = access_tickets.identity(await asyncio.to_thread(verified_access_claims, authorization[7:]))
        except HTTPException:
            if scope != "local":
                raise
    try:
        if not who and scope == "local" and origin:
            try:
                record = await asyncio.to_thread(access_tickets.decode, request.cookies.get(access_tickets.cookie_name()))
                who = {"uid": record["uid"], "sid": record["sid"], "iat": record["auth_iat"]}
            except access_tickets.Rejected:
                pass
        if who:
            await asyncio.to_thread(access_tickets.revoke_sessions, who, scope)
        elif scope != "local":
            raise HTTPException(401, "Token đăng nhập là bắt buộc")
    except access_tickets.Unavailable as error:
        raise HTTPException(503, str(error), headers={"Cache-Control": "no-store"}) from error
    access_tickets.set_cookie(response, None)
    policy.set_asset_cookie(response, None)
    response.headers["Cache-Control"] = "private, no-store"
    return {"ok": True}


@router.get("/admin/site-access")
async def admin_access_status(admin=Depends(require_admin)):
    state, members = await asyncio.gather(asyncio.to_thread(policy.get_state, force=True), asyncio.to_thread(policy.list_members))
    return {**state, "members": members}


@router.put("/admin/site-access")
async def update_access(payload: AccessMode, admin=Depends(require_admin)):
    return await asyncio.to_thread(policy.set_state, payload.enabled, payload.message, admin["id"])


@router.put("/admin/site-access/members/{user_id}")
async def update_member(user_id: UUID, payload: AccessMember, admin=Depends(require_admin)):
    try:
        await asyncio.to_thread(policy.set_member, str(user_id), payload.allowed, admin["id"])
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    return {"user_id": str(user_id), "allowed": payload.allowed}
