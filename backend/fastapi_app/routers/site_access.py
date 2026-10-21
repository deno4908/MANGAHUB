import asyncio
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, StrictBool
from fastapi_app.dependencies import require_admin
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
    try:
        state = await asyncio.to_thread(policy.get_state)
        allowed = await asyncio.to_thread(policy.is_allowed, state, user)
    except policy.AccessUnavailable as error:
        if not user or user.get("role") != "admin":
            raise HTTPException(503, str(error), headers={"Cache-Control": "no-store"}) from error
        # The gateway has verified the token and current database role. Match its
        # admin recovery rule without opening access for any other account.
        state = {"enabled": True, "message": policy.DEFAULT_MESSAGE}
        allowed = True
    authorization = request.headers.get("authorization", "")
    policy.set_asset_cookie(response, authorization[7:] if state["enabled"] and allowed and user else None)
    response.headers["Cache-Control"] = "private, no-store"
    return {**state, "allowed": allowed, "authenticated": user is not None,
            "is_admin": bool(user and user.get("role") == "admin")}


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
