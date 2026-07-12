"""
Scanlation Groups router — group management.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from fastapi_app.dependencies import (
    get_current_user,
    get_supabase,
    get_supabase_public,
    require_role,
)
from fastapi_app.utils.anti_spam import enforce_user_action_limit

router = APIRouter()
logger = logging.getLogger(__name__)
GROUP_CREATE_LIMIT_PER_HOUR = 5
GROUP_WRITE_LIMIT_PER_MINUTE = 30


def _normalize_group_name(value: str) -> str:
    return " ".join(str(value or "").split()).strip().lower()


@router.get("/")
async def get_my_groups(
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Danh sách groups mà user tham gia."""
    memberships = (
        db.table("group_members")
        .select("role, joined_at, scanlation_groups(*)")
        .eq("user_id", user["id"])
        .execute()
    )

    groups = []
    for m in memberships.data or []:
        g = m.get("scanlation_groups", {})
        if g:
            g["member_role"] = m["role"]
            g["joined_at"] = m["joined_at"]
            groups.append(g)
    return {"groups": groups}


@router.get("/{group_id}")
async def get_group(
    group_id: str,
    db=Depends(get_supabase_public),
):
    """Chi tiết group + members."""
    group = (
        db.table("scanlation_groups")
        .select("id, name, description, logo, owner_id, created_at")
        .eq("id", group_id)
        .single()
        .execute()
    )
    if not group.data:
        raise HTTPException(status_code=404, detail="Nhóm không tồn tại")

    members = (
        db.table("group_members")
        .select("role, joined_at, profiles!inner(id, username, display_name, avatar)")
        .eq("group_id", group_id)
        .execute()
    )

    member_list = []
    for m in members.data or []:
        p = m.get("profiles", {})
        member_list.append(
            {
                "user_id": p.get("id", ""),
                "username": p.get("username", ""),
                "display_name": p.get("display_name", ""),
                "avatar": p.get("avatar", ""),
                "role": m["role"],
                "joined_at": m["joined_at"],
            }
        )

    return {"group": group.data, "members": member_list}


@router.post("/")
async def create_group(
    request: Request,
    data: dict,
    user=Depends(require_role("uploader", "moderator", "admin")),
    db=Depends(get_supabase),
):
    """Tạo group mới."""
    _ = request
    enforce_user_action_limit(
        "group-create:hour",
        user["id"],
        limit=GROUP_CREATE_LIMIT_PER_HOUR,
        window_seconds=60 * 60,
        detail="Tạo nhóm quá nhiều",
    )
    name = " ".join(str(data.get("name", "")).split()).strip()
    if not name or len(name) < 3:
        raise HTTPException(status_code=400, detail="Tên nhóm phải có ít nhất 3 ký tự")

    normalized_name = _normalize_group_name(name)
    existing_groups = db.table("scanlation_groups").select("id, name").execute()
    for group in existing_groups.data or []:
        if _normalize_group_name(group.get("name", "")) == normalized_name:
            raise HTTPException(status_code=409, detail="Tên nhóm dịch đã tồn tại")

    result = (
        db.table("scanlation_groups")
        .insert(
            {
                "name": name,
                "description": data.get("description", ""),
                "logo": data.get("logo", ""),
                "owner_id": user["id"],
            }
        )
        .execute()
    )

    group = result.data[0] if result.data else None
    if group:
        db.table("group_members").insert(
            {
                "group_id": group["id"],
                "user_id": user["id"],
                "role": "owner",
            }
        ).execute()

    return {"message": "Đã tạo nhóm", "group": group}


@router.put("/{group_id}")
async def update_group(
    request: Request,
    group_id: str,
    data: dict,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Cập nhật thông tin nhóm (chỉ owner/admin)."""
    _ = request
    enforce_user_action_limit(
        "group-write:min",
        user["id"],
        limit=GROUP_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác nhóm quá nhanh",
    )
    # Check ownership
    membership = (
        db.table("group_members")
        .select("role")
        .eq("group_id", group_id)
        .eq("user_id", user["id"])
        .single()
        .execute()
    )

    member_role = (membership.data or {}).get("role", "")
    if member_role not in ("owner", "admin") and user.get("role") not in (
        "moderator",
        "admin",
    ):
        raise HTTPException(status_code=403, detail="Không có quyền chỉnh sửa nhóm")

    update_data = {}
    if "name" in data:
        name = " ".join(str(data["name"] or "").split()).strip()
        if len(name) < 3:
            raise HTTPException(
                status_code=400, detail="Tên nhóm phải có ít nhất 3 ký tự"
            )

        normalized_name = _normalize_group_name(name)
        existing_groups = db.table("scanlation_groups").select("id, name").execute()
        for group in existing_groups.data or []:
            if str(group.get("id", "")).strip() == str(group_id).strip():
                continue
            if _normalize_group_name(group.get("name", "")) == normalized_name:
                raise HTTPException(status_code=409, detail="Tên nhóm dịch đã tồn tại")

        update_data["name"] = name
    if "description" in data:
        update_data["description"] = data["description"]
    if "logo" in data:
        update_data["logo"] = data["logo"]

    if not update_data:
        raise HTTPException(status_code=400, detail="Không có dữ liệu cập nhật")

    result = (
        db.table("scanlation_groups").update(update_data).eq("id", group_id).execute()
    )
    return {
        "message": "Đã cập nhật nhóm",
        "group": result.data[0] if result.data else None,
    }


@router.delete("/{group_id}")
async def delete_group(
    request: Request,
    group_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Xóa nhóm (chỉ owner hoặc admin)."""
    _ = request
    enforce_user_action_limit(
        "group-write:min",
        user["id"],
        limit=GROUP_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác nhóm quá nhanh",
    )
    group = (
        db.table("scanlation_groups")
        .select("owner_id")
        .eq("id", group_id)
        .single()
        .execute()
    )
    if not group.data:
        raise HTTPException(status_code=404, detail="Nhóm không tồn tại")

    if group.data["owner_id"] != user["id"] and user.get("role") not in (
        "moderator",
        "admin",
    ):
        raise HTTPException(status_code=403, detail="Chỉ chủ nhóm mới có thể xóa nhóm")

    db.table("group_members").delete().eq("group_id", group_id).execute()
    db.table("scanlation_groups").delete().eq("id", group_id).execute()
    return {"message": "Đã xóa nhóm"}


@router.post("/{group_id}/members")
async def add_member(
    request: Request,
    group_id: str,
    data: dict,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Thêm thành viên vào nhóm."""
    _ = request
    enforce_user_action_limit(
        "group-write:min",
        user["id"],
        limit=GROUP_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác nhóm quá nhanh",
    )
    membership = (
        db.table("group_members")
        .select("role")
        .eq("group_id", group_id)
        .eq("user_id", user["id"])
        .single()
        .execute()
    )

    member_role = (membership.data or {}).get("role", "")
    if member_role not in ("owner", "admin") and user.get("role") not in (
        "moderator",
        "admin",
    ):
        raise HTTPException(status_code=403, detail="Không có quyền thêm thành viên")

    target_user_id = data.get("user_id")
    role = data.get("role", "member")
    if not target_user_id:
        raise HTTPException(status_code=400, detail="Thiếu user_id")
    if role not in ("member", "admin"):
        role = "member"

    try:
        db.table("group_members").insert(
            {
                "group_id": group_id,
                "user_id": target_user_id,
                "role": role,
            }
        ).execute()
        return {"message": "Đã thêm thành viên"}
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return {"message": "Đã là thành viên"}
        logger.exception("Adding scanlation group member failed")
        raise HTTPException(status_code=500, detail="Không thể thêm thành viên lúc này") from e


@router.delete("/{group_id}/members/{target_user_id}")
async def remove_member(
    request: Request,
    group_id: str,
    target_user_id: str,
    user=Depends(get_current_user),
    db=Depends(get_supabase),
):
    """Xóa thành viên khỏi nhóm."""
    _ = request
    enforce_user_action_limit(
        "group-write:min",
        user["id"],
        limit=GROUP_WRITE_LIMIT_PER_MINUTE,
        window_seconds=60,
        detail="Thao tác nhóm quá nhanh",
    )
    membership = (
        db.table("group_members")
        .select("role")
        .eq("group_id", group_id)
        .eq("user_id", user["id"])
        .single()
        .execute()
    )

    member_role = (membership.data or {}).get("role", "")
    # Can remove self, or owner/admin can remove others
    if (
        target_user_id != user["id"]
        and member_role not in ("owner", "admin")
        and user.get("role") not in ("moderator", "admin")
    ):
        raise HTTPException(status_code=403, detail="Không có quyền xóa thành viên")

    # Cannot remove owner
    group = (
        db.table("scanlation_groups")
        .select("owner_id")
        .eq("id", group_id)
        .single()
        .execute()
    )
    if group.data and group.data["owner_id"] == target_user_id:
        raise HTTPException(status_code=400, detail="Không thể xóa chủ nhóm")

    db.table("group_members").delete().eq("group_id", group_id).eq(
        "user_id", target_user_id
    ).execute()
    return {"message": "Đã xóa thành viên"}
