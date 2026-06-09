"""
Google reCAPTCHA v2 verification helpers.
"""
from __future__ import annotations

import httpx
from fastapi import HTTPException, Request

from config import config


def _client_ip(request: Request) -> str:
    forwarded = str(request.headers.get("x-forwarded-for", "") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if request.client and request.client.host:
        return request.client.host
    return ""


async def enforce_recaptcha(request: Request, token: str | None) -> None:
    secret = str(getattr(config, "RECAPTCHA_SECRET_KEY", "") or "").strip()
    required = bool(getattr(config, "RECAPTCHA_REQUIRED", False))

    if not secret:
        if required:
            raise HTTPException(
                status_code=503,
                detail="reCAPTCHA chưa được cấu hình trên máy chủ",
            )
        return

    response_token = str(token or "").strip()
    if not response_token:
        raise HTTPException(status_code=400, detail="Vui lòng xác minh reCAPTCHA")

    payload = {
        "secret": secret,
        "response": response_token,
    }
    remote_ip = _client_ip(request)
    if remote_ip:
        payload["remoteip"] = remote_ip

    try:
        timeout = max(1, int(getattr(config, "RECAPTCHA_TIMEOUT_SECONDS", 5) or 5))
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                str(getattr(config, "RECAPTCHA_VERIFY_URL", "") or "https://www.google.com/recaptcha/api/siteverify"),
                data=payload,
            )
            result = response.json()
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Không thể xác minh reCAPTCHA, vui lòng thử lại",
        )

    if result.get("success") is True:
        return

    error_codes = result.get("error-codes") or []
    if "timeout-or-duplicate" in error_codes:
        raise HTTPException(
            status_code=400,
            detail="reCAPTCHA đã hết hạn, vui lòng xác minh lại",
        )
    raise HTTPException(status_code=400, detail="Xác minh reCAPTCHA thất bại")
