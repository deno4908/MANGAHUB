from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from fastapi_app.dependencies import require_uploader
from fastapi_app.services import image_editor_service
from fastapi_app.utils.upload_security import read_upload_limited

router = APIRouter()
EDITOR_MAX_IMAGE_SIZE = 20 * 1024 * 1024
EDITOR_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


async def _read_editor_image(image: UploadFile) -> bytes:
    image_bytes, _content_type = await read_upload_limited(
        image,
        max_size=EDITOR_MAX_IMAGE_SIZE,
        allowed_types=EDITOR_ALLOWED_IMAGE_TYPES,
        label="Ảnh",
    )
    return image_bytes


@router.get("/fonts")
async def editor_fonts(_user=Depends(require_uploader)):
    return {
        "fonts": image_editor_service.list_available_fonts(),
    }


@router.post("/inpaint")
async def editor_inpaint(
    image: UploadFile = File(...),
    mode: str = Form("region"),
    regions: str = Form("[]"),
    brush_mask: str = Form(""),
    brush_radius: float = Form(14),
    mask_width: float = Form(0),
    mask_height: float = Form(0),
    _user=Depends(require_uploader),
):
    image_bytes = await _read_editor_image(image)
    normalized_mode = str(mode or "region").strip().lower()

    try:
        if normalized_mode == "all":
            return await asyncio.to_thread(image_editor_service.inpaint_all_text, image_bytes)
        if normalized_mode == "brush":
            return await asyncio.to_thread(
                image_editor_service.inpaint_with_brush,
                image_bytes,
                brush_mask,
                brush_radius,
                mask_width,
                mask_height,
            )
        return await asyncio.to_thread(
            image_editor_service.inpaint_with_regions,
            image_bytes,
            regions,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Xử lý ảnh thất bại: {error}") from error


@router.post("/add-text")
async def editor_add_text(
    image: UploadFile = File(...),
    overlays: str = Form("[]"),
    _user=Depends(require_uploader),
):
    image_bytes = await _read_editor_image(image)
    try:
        return await asyncio.to_thread(
            image_editor_service.add_text_overlays,
            image_bytes,
            overlays,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Chèn chữ thất bại: {error}") from error


@router.post("/detect-font")
async def editor_detect_font(
    image: UploadFile = File(...),
    region: str = Form("{}"),
    sample_text: str = Form(""),
    _user=Depends(require_uploader),
):
    image_bytes = await _read_editor_image(image)
    try:
        return await asyncio.to_thread(
            image_editor_service.detect_font,
            image_bytes,
            region,
            sample_text,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Nhận diện font thất bại: {error}") from error


@router.post("/ai-translate")
async def editor_ai_translate(
    image: UploadFile = File(...),
    target_language: str = Form("vi"),
    font_name: str = Form("Comic Sans MS"),
    regions: str = Form("[]"),
    gemini_cookies: str = Form(""),
    ai_provider: str = Form("gemini"),
    ai_model: str = Form(""),
    ai_api_key: str = Form(""),
    ai_base_url: str = Form(""),
    mode: str = Form("translate"),
    _user=Depends(require_uploader),
):
    image_bytes = await _read_editor_image(image)
    try:
        return await image_editor_service.ai_translate_redraw(
            image_bytes=image_bytes,
            target_language=target_language,
            font_name=font_name,
            regions_json=regions,
            gemini_cookies=gemini_cookies,
            ai_provider=ai_provider,
            ai_model=ai_model,
            ai_api_key=ai_api_key,
            ai_base_url=ai_base_url,
            mode=mode,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"AI dịch/chèn chữ thất bại: {error}") from error


@router.post("/ocr-region")
async def editor_ocr_region(
    image: UploadFile = File(...),
    region: str = Form("{}"),
    languages: str = Form("ja,en"),
    _user=Depends(require_uploader),
):
    """OCR text from a selected region of the image using EasyOCR (GPU-accelerated)."""
    image_bytes = await _read_editor_image(image)
    try:
        return await asyncio.to_thread(
            image_editor_service.ocr_extract_text,
            image_bytes,
            region,
            languages,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"OCR thất bại: {error}") from error


@router.post("/translate-text")
async def editor_translate_text(
    text: str = Form(...),
    source_language: str = Form("ja"),
    target_language: str = Form("vi"),
    _user=Depends(require_uploader),
):
    """Translate text using OpenRouter API (nvidia/nemotron model)."""
    try:
        return await image_editor_service.translate_text_openrouter(
            text=text,
            source_language=source_language,
            target_language=target_language,
        )
    except image_editor_service.EditorProcessingError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Dịch văn bản thất bại: {error}") from error

