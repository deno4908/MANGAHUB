from __future__ import annotations

import base64
import json
import os
import re
import shutil
import threading
import tempfile
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import easyocr  # type: ignore
except Exception:  # pragma: no cover
    easyocr = None

try:
    import torch  # type: ignore
except Exception:  # pragma: no cover
    torch = None

try:
    from openai import AsyncOpenAI  # type: ignore
except Exception:  # pragma: no cover
    AsyncOpenAI = None

_FONT_EXTENSIONS = (".ttf", ".otf", ".ttc")
_DEFAULT_FONT_NAMES = [
    "Comic Sans MS",
    "Segoe UI",
    "Arial",
    "Tahoma",
    "Verdana",
    "Times New Roman",
]
_GEMINI_DEFAULT_MODEL = "unspecified"
_GEMINI_PREFERRED_MODELS = [
    "unspecified",
    "gemini-3-flash",
    "gemini-3-pro",
    "gemini-3-flash-thinking",
    "gemini-3-pro-plus",
    "gemini-3-flash-plus",
    "gemini-3-flash-thinking-plus",
    "gemini-3-pro-advanced",
    "gemini-3-flash-advanced",
    "gemini-3-flash-thinking-advanced",
]

_easyocr_reader: Any = None
_easyocr_lock = threading.Lock()
_opencl_lock = threading.Lock()
_opencl_enabled: bool | None = None


class EditorProcessingError(RuntimeError):
    pass


def _normalize_spaces(text: str) -> str:
    return " ".join(str(text or "").split()).strip()


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        parsed = float(raw)
    except Exception:
        return default
    return max(minimum, min(maximum, parsed))


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        parsed = int(float(raw))
    except Exception:
        return default
    return max(minimum, min(maximum, parsed))


def _provider_image_max_bytes() -> int:
    return _env_int("EDITOR_PROVIDER_IMAGE_MAX_MB", 24, 1, 64) * 1024 * 1024


def _detect_image_content_type(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _header_content_length(headers: Any) -> int | None:
    try:
        raw = headers.get("content-length")
        if raw:
            return int(raw)
    except Exception:
        return None
    return None


def _normalize_image_content_type(value: str | None) -> str:
    content_type = str(value or "").split(";", 1)[0].strip().lower()
    if content_type == "image/jpg":
        return "image/jpeg"
    return content_type


async def _download_curl_image_limited(
    session: Any,
    url: str,
    *,
    headers: dict[str, str],
    timeout: float,
) -> tuple[bytes, str] | None:
    max_bytes = _provider_image_max_bytes()
    async with session.stream(
        "GET",
        url,
        headers=headers,
        allow_redirects=True,
        timeout=timeout,
    ) as response:
        if response.status_code >= 400:
            return None
        if (length := _header_content_length(response.headers)) and length > max_bytes:
            return None

        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_content():
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                return None
            chunks.append(chunk)

    data = b"".join(chunks)
    if len(data) <= 1000:
        return None
    detected_type = _detect_image_content_type(data)
    if not detected_type:
        return None
    declared_type = _normalize_image_content_type(response.headers.get("content-type"))
    if declared_type and not declared_type.startswith("image/"):
        return None
    return data, detected_type


def _parse_json_list(raw: str | None, field_name: str) -> list[dict[str, Any]]:
    source = str(raw or "[]").strip() or "[]"
    try:
        parsed = json.loads(source)
    except Exception as error:
        raise EditorProcessingError(f"{field_name} không đúng định dạng JSON") from error
    if not isinstance(parsed, list):
        raise EditorProcessingError(f"{field_name} phải là danh sách")
    result: list[dict[str, Any]] = []
    for item in parsed:
        if isinstance(item, dict):
            result.append(item)
    return result


def _parse_json_dict(raw: str | None, field_name: str) -> dict[str, Any]:
    source = str(raw or "{}").strip() or "{}"
    try:
        parsed = json.loads(source)
    except Exception as error:
        raise EditorProcessingError(f"{field_name} không đúng định dạng JSON") from error
    if not isinstance(parsed, dict):
        raise EditorProcessingError(f"{field_name} phải là object")
    return parsed


def _decode_image(image_bytes: bytes) -> np.ndarray:
    if not image_bytes:
        raise EditorProcessingError("Ảnh đầu vào rỗng")
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise EditorProcessingError("Không đọc được ảnh đầu vào")
    return image


def _to_data_url(image_bgr: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", image_bgr)
    if not ok:
        raise EditorProcessingError("Không mã hóa được ảnh kết quả")
    b64 = base64.b64encode(encoded.tobytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _to_pil(image_bgr: np.ndarray) -> Image.Image:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)


def _from_pil(image: Image.Image) -> np.ndarray:
    rgb = np.array(image.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _sanitize_region(region: dict[str, Any], width: int, height: int) -> dict[str, int] | None:
    try:
        x = int(float(region.get("x", 0)))
        y = int(float(region.get("y", 0)))
        w = int(float(region.get("w", 0)))
        h = int(float(region.get("h", 0)))
    except Exception:
        return None

    if w <= 1 or h <= 1:
        return None

    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    w = max(1, min(w, width - x))
    h = max(1, min(h, height - y))
    if w < 2 or h < 2:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def _region_iou(a: dict[str, int], b: dict[str, int]) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["w"], ay1 + a["h"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["w"], by1 + b["h"]

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h
    if inter_area <= 0:
        return 0.0

    a_area = a["w"] * a["h"]
    b_area = b["w"] * b["h"]
    union = max(1, a_area + b_area - inter_area)
    return float(inter_area / union)


def _regions_should_merge(a: dict[str, int], b: dict[str, int]) -> bool:
    if _region_iou(a, b) >= 0.24:
        return True

    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["w"], ay1 + a["h"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["w"], by1 + b["h"]

    gap_x = max(0, max(ax1 - bx2, bx1 - ax2))
    gap_y = max(0, max(ay1 - by2, by1 - ay2))
    allow_x = max(4, int(min(a["w"], b["w"]) * 0.14))
    allow_y = max(4, int(min(a["h"], b["h"]) * 0.2))
    return gap_x <= allow_x and gap_y <= allow_y


def _merge_two_regions(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    x1 = min(a["x"], b["x"])
    y1 = min(a["y"], b["y"])
    x2 = max(a["x"] + a["w"], b["x"] + b["w"])
    y2 = max(a["y"] + a["h"], b["y"] + b["h"])
    return {
        "x": x1,
        "y": y1,
        "w": max(1, x2 - x1),
        "h": max(1, y2 - y1),
    }


def _merge_regions(regions: list[dict[str, int]]) -> list[dict[str, int]]:
    merged: list[dict[str, int]] = []
    for region in regions:
        candidate = {
            "x": int(region["x"]),
            "y": int(region["y"]),
            "w": int(region["w"]),
            "h": int(region["h"]),
        }
        changed = True
        while changed:
            changed = False
            next_merged: list[dict[str, int]] = []
            for existing in merged:
                if _regions_should_merge(existing, candidate):
                    candidate = _merge_two_regions(existing, candidate)
                    changed = True
                else:
                    next_merged.append(existing)
            merged = next_merged
        merged.append(candidate)

    merged.sort(key=lambda item: (item["y"], item["x"]))
    return merged


def _expand_region(
    region: dict[str, int],
    width: int,
    height: int,
    pad_x_ratio: float = 0.14,
    pad_y_ratio: float = 0.22,
    min_pad: int = 2,
) -> dict[str, int] | None:
    x = int(region["x"])
    y = int(region["y"])
    w = int(region["w"])
    h = int(region["h"])

    pad_x = max(min_pad, int(w * pad_x_ratio))
    pad_y = max(min_pad, int(h * pad_y_ratio))
    return _sanitize_region(
        {
            "x": x - pad_x,
            "y": y - pad_y,
            "w": w + (pad_x * 2),
            "h": h + (pad_y * 2),
        },
        width,
        height,
    )


def _build_mask(shape: tuple[int, int, int], regions: list[dict[str, int]], pad_ratio: float = 0.08) -> np.ndarray:
    mask = np.zeros(shape[:2], dtype=np.uint8)
    for region in regions:
        x = int(region["x"])
        y = int(region["y"])
        w = int(region["w"])
        h = int(region["h"])
        # Larger padding for manga — text often has tight bounds
        pad = max(2, min(16, int(min(w, h) * pad_ratio)))
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(shape[1] - 1, x + w + pad)
        y2 = min(shape[0] - 1, y + h + pad)
        cv2.rectangle(mask, (x1, y1), (x2, y2), 255, thickness=-1)
    return mask


def _region_area(region: dict[str, int]) -> int:
    return int(region["w"]) * int(region["h"])


def _filter_detected_regions(
    regions: list[dict[str, int]],
    width: int,
    height: int,
    max_area_ratio: float,
) -> list[dict[str, int]]:
    image_area = max(1, width * height)
    max_area = int(image_area * max_area_ratio)
    filtered: list[dict[str, int]] = []

    for region in regions:
        x = int(region["x"])
        y = int(region["y"])
        w = int(region["w"])
        h = int(region["h"])
        area = w * h
        if area < 40:
            continue
        if area > max_area:
            continue

        aspect = w / max(1, h)
        if aspect < 0.16 or aspect > 22.0:
            continue

        touches_border = x <= 2 or y <= 2 or (x + w) >= (width - 2) or (y + h) >= (height - 2)
        if touches_border and area >= int(image_area * 0.004):
            continue

        filtered.append({"x": x, "y": y, "w": w, "h": h})

    deduped: list[dict[str, int]] = []
    for region in sorted(filtered, key=_region_area):
        duplicated = any(_region_iou(region, existing) >= 0.86 for existing in deduped)
        if duplicated:
            continue
        deduped.append(region)
    return deduped


def _compute_mask_coverage(shape: tuple[int, int, int], regions: list[dict[str, int]]) -> float:
    if not regions:
        return 0.0
    mask = _build_mask(shape, regions)
    active = int(cv2.countNonZero(mask))
    return float(active / max(1, shape[0] * shape[1]))


def _limit_regions_by_coverage(
    shape: tuple[int, int, int],
    regions: list[dict[str, int]],
    max_coverage: float,
    max_regions: int,
) -> list[dict[str, int]]:
    trimmed = list(regions[: max(1, max_regions)])
    if not trimmed:
        return []
    if _compute_mask_coverage(shape, trimmed) <= max_coverage:
        return trimmed

    ranked = sorted(trimmed, key=_region_area)
    kept: list[dict[str, int]] = []
    for region in ranked:
        single_coverage = _compute_mask_coverage(shape, [region])
        if single_coverage > (max_coverage * 0.72):
            continue

        trial = kept + [region]
        if _compute_mask_coverage(shape, trial) <= max_coverage:
            kept = trial

    if kept:
        kept.sort(key=lambda item: (item["y"], item["x"]))
        return kept

    smallest = ranked[0]
    return [smallest]


def _is_manga_style(image_bgr: np.ndarray) -> bool:
    """Detect if the image is manga-style: mostly monochrome with high contrast."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    # Check if mostly black/white (manga screentone pattern)
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    white_ratio = float(cv2.countNonZero(binary)) / max(1, gray.shape[0] * gray.shape[1])
    # Check saturation — manga is nearly grayscale
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    mean_sat = float(np.mean(hsv[:, :, 1]))
    # Manga: high white ratio (lots of white paper), low saturation
    return white_ratio > 0.25 and mean_sat < 35


def _ensure_odd(value: int, minimum: int = 3, maximum: int = 41) -> int:
    safe = max(minimum, min(maximum, int(value)))
    if safe % 2 == 0:
        safe += 1
    if safe > maximum:
        safe = maximum if maximum % 2 == 1 else max(minimum, maximum - 1)
    return safe


def _sample_region_background_color(roi_bgr: np.ndarray, prefer_light: bool) -> np.ndarray:
    if roi_bgr.size == 0:
        return np.array([255, 255, 255], dtype=np.uint8)

    h, w = roi_bgr.shape[:2]
    border_w = max(2, min(8, w // 9))
    border_h = max(2, min(8, h // 9))

    strips: list[np.ndarray] = []
    if h > border_h * 2:
        strips.append(roi_bgr[:border_h, :, :].reshape(-1, 3))
        strips.append(roi_bgr[-border_h:, :, :].reshape(-1, 3))
    if w > border_w * 2:
        strips.append(roi_bgr[:, :border_w, :].reshape(-1, 3))
        strips.append(roi_bgr[:, -border_w:, :].reshape(-1, 3))

    if strips:
        border_pixels = np.concatenate(strips, axis=0)
    else:
        border_pixels = roi_bgr.reshape(-1, 3)

    selected = border_pixels
    if prefer_light and len(border_pixels) > 10:
        luminance = (
            (border_pixels[:, 0].astype(np.float32) * 0.114)
            + (border_pixels[:, 1].astype(np.float32) * 0.587)
            + (border_pixels[:, 2].astype(np.float32) * 0.299)
        )
        threshold = float(np.percentile(luminance, 60))
        light_pixels = border_pixels[luminance >= threshold]
        if len(light_pixels) >= 8:
            selected = light_pixels

    if len(selected) == 0:
        selected = border_pixels

    return np.median(selected, axis=0).astype(np.uint8)


def _filter_text_components(mask: np.ndarray, prefer_manga: bool) -> np.ndarray:
    if mask.size == 0:
        return mask

    roi_area = max(1, int(mask.shape[0] * mask.shape[1]))
    min_area = max(6, int(roi_area * (0.00018 if prefer_manga else 0.00024)))
    max_area = max(36, int(roi_area * (0.24 if prefer_manga else 0.30)))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask

    output = np.zeros_like(mask)
    for idx in range(1, count):
        area = int(stats[idx, cv2.CC_STAT_AREA])
        if area < min_area or area > max_area:
            continue

        bw = int(stats[idx, cv2.CC_STAT_WIDTH])
        bh = int(stats[idx, cv2.CC_STAT_HEIGHT])
        if bw < 2 or bh < 2:
            continue

        aspect = bw / max(1, bh)
        if aspect < 0.08 or aspect > 28.0:
            continue

        output[labels == idx] = 255

    return output


def _build_text_like_mask(roi_bgr: np.ndarray, prefer_manga: bool) -> np.ndarray:
    if roi_bgr.size == 0:
        return np.zeros((1, 1), dtype=np.uint8)

    h, w = roi_bgr.shape[:2]
    roi_area = max(1, h * w)

    gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(
        clipLimit=2.0 if prefer_manga else 2.6,
        tileGridSize=(8, 8),
    )
    enhanced = clahe.apply(gray)

    hat_size = _ensure_odd(max(5, int(min(h, w) * 0.16)), minimum=5, maximum=21)
    hat_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (hat_size, hat_size))
    blackhat = cv2.morphologyEx(enhanced, cv2.MORPH_BLACKHAT, hat_kernel)
    tophat = cv2.morphologyEx(enhanced, cv2.MORPH_TOPHAT, hat_kernel)

    _, dark_hat_mask = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, bright_hat_mask = cv2.threshold(tophat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    adapt_block = _ensure_odd(max(15, int(min(h, w) * 0.18)), minimum=15, maximum=51)
    adapt_dark = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        adapt_block,
        10 if prefer_manga else 8,
    )
    adapt_bright = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        adapt_block,
        -6 if prefer_manga else -4,
    )

    laplacian = cv2.Laplacian(enhanced, cv2.CV_16S, ksize=3)
    edge_strength = cv2.convertScaleAbs(laplacian)
    _, edge_mask = cv2.threshold(edge_strength, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edge_mask = cv2.dilate(edge_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)

    candidate = cv2.bitwise_or(dark_hat_mask, bright_hat_mask)
    candidate = cv2.bitwise_or(candidate, cv2.bitwise_and(adapt_dark, edge_mask))
    candidate = cv2.bitwise_or(candidate, cv2.bitwise_and(adapt_bright, edge_mask))

    if prefer_manga:
        candidate = cv2.bitwise_or(candidate, adapt_dark)

    open_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, open_kernel, iterations=1)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, close_kernel, iterations=1)
    candidate = _filter_text_components(candidate, prefer_manga)

    coverage = float(cv2.countNonZero(candidate)) / roi_area
    if coverage < 0.006:
        fallback = cv2.bitwise_or(adapt_dark, cv2.bitwise_and(adapt_bright, edge_mask))
        fallback = cv2.morphologyEx(fallback, cv2.MORPH_OPEN, open_kernel, iterations=1)
        fallback = cv2.morphologyEx(fallback, cv2.MORPH_CLOSE, close_kernel, iterations=1)
        fallback = _filter_text_components(fallback, prefer_manga)
        if cv2.countNonZero(fallback) > cv2.countNonZero(candidate):
            candidate = fallback

    if float(cv2.countNonZero(candidate)) / roi_area > 0.58:
        constrained = cv2.bitwise_and(candidate, cv2.dilate(edge_mask, open_kernel, iterations=1))
        if cv2.countNonZero(constrained) > int(roi_area * 0.004):
            candidate = constrained

    if cv2.countNonZero(candidate) > 0:
        dilate_size = 5 if prefer_manga else 3
        dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_size, dilate_size))
        candidate = cv2.dilate(candidate, dilate_kernel, iterations=1)

    return candidate


def _blend_with_mask(base: np.ndarray, candidate: np.ndarray, mask: np.ndarray, feather_sigma: float) -> np.ndarray:
    if base.shape != candidate.shape:
        return candidate
    if mask.size == 0 or cv2.countNonZero(mask) <= 0:
        return base

    sigma = max(0.8, float(feather_sigma))
    feather = cv2.GaussianBlur(mask, (0, 0), sigmaX=sigma, sigmaY=sigma)
    alpha = feather.astype(np.float32) / 255.0
    alpha_3ch = np.repeat(alpha[:, :, None], 3, axis=2)

    blended = (
        (base.astype(np.float32) * (1.0 - alpha_3ch))
        + (candidate.astype(np.float32) * alpha_3ch)
    )
    return np.clip(blended, 0, 255).astype(np.uint8)


def _composite_inpaint_result(
    base: np.ndarray,
    candidate: np.ndarray,
    mask: np.ndarray,
    feather_sigma: float,
    hard_fill_core: bool,
) -> np.ndarray:
    if base.shape != candidate.shape:
        return candidate
    if mask.size == 0 or cv2.countNonZero(mask) <= 0:
        return base

    if not hard_fill_core:
        return _blend_with_mask(base, candidate, mask, feather_sigma)

    mask_bin = np.where(mask > 0, 255, 0).astype(np.uint8)
    output = base.copy()
    output[mask_bin > 0] = candidate[mask_bin > 0]

    edge_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    outer_ring = cv2.subtract(cv2.dilate(mask_bin, edge_kernel, iterations=1), mask_bin)
    if cv2.countNonZero(outer_ring) > 0:
        output = _blend_with_mask(
            output,
            candidate,
            outer_ring,
            feather_sigma=max(0.8, float(feather_sigma) * 0.8),
        )

    return output


def _opencl_inpaint_enabled() -> bool:
    global _opencl_enabled
    if _opencl_enabled is not None:
        return _opencl_enabled

    with _opencl_lock:
        if _opencl_enabled is not None:
            return _opencl_enabled

        enabled = str(os.getenv("EDITOR_INPAINT_OPENCL", "1")).strip().lower()
        if enabled in {"0", "false", "no", "off"}:
            _opencl_enabled = False
            return _opencl_enabled

        has_ocl = bool(hasattr(cv2, "ocl") and cv2.ocl.haveOpenCL())
        if not has_ocl:
            _opencl_enabled = False
            return _opencl_enabled

        try:
            cv2.ocl.setUseOpenCL(True)
            _opencl_enabled = bool(cv2.ocl.useOpenCL())
        except Exception:
            _opencl_enabled = False
        return _opencl_enabled


def _run_single_inpaint(
    image_bgr: np.ndarray,
    mask: np.ndarray,
    radius: int,
    method: int,
    use_opencl: bool,
) -> np.ndarray | None:
    safe_radius = max(1, int(radius))

    if use_opencl:
        try:
            src_u = cv2.UMat(image_bgr)
            mask_u = cv2.UMat(mask)
            out_u = cv2.inpaint(src_u, mask_u, safe_radius, method)
            out = out_u.get() if hasattr(out_u, "get") else out_u
            if isinstance(out, np.ndarray) and out.shape == image_bgr.shape:
                return out
        except Exception:
            pass

    try:
        out = cv2.inpaint(image_bgr, mask, safe_radius, method)
    except Exception:
        return None
    if isinstance(out, np.ndarray) and out.shape == image_bgr.shape:
        return out
    return None


def _run_xphoto_inpaint(image_bgr: np.ndarray, mask: np.ndarray, prefer_quality: bool) -> np.ndarray | None:
    xphoto = getattr(cv2, "xphoto", None)
    if xphoto is None or not hasattr(xphoto, "inpaint"):
        return None

    algo = None
    if prefer_quality and hasattr(xphoto, "INPAINT_FSR_BEST"):
        algo = int(getattr(xphoto, "INPAINT_FSR_BEST"))
    elif hasattr(xphoto, "INPAINT_FSR_FAST"):
        algo = int(getattr(xphoto, "INPAINT_FSR_FAST"))
    elif hasattr(xphoto, "INPAINT_SHIFTMAP"):
        algo = int(getattr(xphoto, "INPAINT_SHIFTMAP"))

    if algo is None:
        return None

    dst = np.zeros_like(image_bgr)
    try:
        xphoto.inpaint(image_bgr, mask, dst, algo)
    except Exception:
        return None

    if isinstance(dst, np.ndarray) and dst.shape == image_bgr.shape:
        return dst
    return None


def _score_inpaint_candidate(
    base_image: np.ndarray,
    candidate: np.ndarray,
    mask: np.ndarray,
    prefer_smooth: bool,
) -> float:
    if candidate.shape != base_image.shape or mask.size == 0 or cv2.countNonZero(mask) <= 0:
        return float("inf")

    mask_bin = np.where(mask > 0, 255, 0).astype(np.uint8)
    if cv2.countNonZero(mask_bin) < 12:
        diff = cv2.absdiff(base_image, candidate)
        return float(np.mean(diff))

    ring_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    outer_ring = cv2.subtract(cv2.dilate(mask_bin, ring_kernel, iterations=1), mask_bin)
    inner_ring = cv2.subtract(mask_bin, cv2.erode(mask_bin, ring_kernel, iterations=1))

    if cv2.countNonZero(outer_ring) <= 0:
        outer_ring = cv2.subtract(cv2.dilate(mask_bin, ring_kernel, iterations=2), mask_bin)
    if cv2.countNonZero(inner_ring) <= 0:
        inner_ring = mask_bin

    base_lab = cv2.cvtColor(base_image, cv2.COLOR_BGR2LAB)
    cand_lab = cv2.cvtColor(candidate, cv2.COLOR_BGR2LAB)

    outer_pixels = base_lab[outer_ring > 0]
    inner_pixels = cand_lab[inner_ring > 0]
    if outer_pixels.size == 0 or inner_pixels.size == 0:
        diff = cv2.absdiff(base_image, candidate)
        return float(np.mean(diff))

    outer_mean = np.mean(outer_pixels, axis=0)
    inner_mean = np.mean(inner_pixels, axis=0)
    color_delta = float(np.linalg.norm(inner_mean - outer_mean))

    cand_gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY).astype(np.float32)
    inside_vals = cand_gray[mask_bin > 0]
    outer_vals = cand_gray[outer_ring > 0]
    if outer_vals.size == 0:
        outer_vals = cand_gray[mask_bin == 0]

    inside_var = float(np.var(inside_vals) + 1.0)
    outer_var = float(np.var(outer_vals) + 1.0)
    texture_delta = abs(float(np.log(inside_var / max(1.0, outer_var))))

    inside_p10 = float(np.percentile(inside_vals, 10))
    inside_p90 = float(np.percentile(inside_vals, 90))
    outer_p10 = float(np.percentile(outer_vals, 10))
    outer_p90 = float(np.percentile(outer_vals, 90))
    inside_contrast = max(1.0, inside_p90 - inside_p10)
    outer_contrast = max(1.0, outer_p90 - outer_p10)
    contrast_delta = abs(float(np.log(inside_contrast / outer_contrast)))

    lap = cv2.Laplacian(cand_gray, cv2.CV_32F, ksize=3)
    lap_abs = np.abs(lap)
    inner_edge = float(np.mean(lap_abs[inner_ring > 0])) if cv2.countNonZero(inner_ring) > 0 else 0.0
    outer_edge = float(np.mean(lap_abs[outer_ring > 0])) if cv2.countNonZero(outer_ring) > 0 else inner_edge
    seam_delta = abs(inner_edge - outer_edge)

    inside_edge = float(np.mean(lap_abs[mask_bin > 0]))

    score = color_delta + (12.0 * texture_delta) + (2.2 * seam_delta) + (4.0 * contrast_delta)
    score += (0.42 if prefer_smooth else 0.18) * inside_edge
    return score


def _pick_best_inpaint_candidate(
    base_image: np.ndarray,
    mask: np.ndarray,
    candidates: list[tuple[str, np.ndarray]],
    prefer_smooth: bool,
) -> tuple[str, np.ndarray]:
    if not candidates:
        return "none", base_image.copy()
    if len(candidates) == 1:
        return candidates[0]

    best_name, best_img = candidates[0]
    best_score = _score_inpaint_candidate(base_image, best_img, mask, prefer_smooth)

    for name, image in candidates[1:]:
        score = _score_inpaint_candidate(base_image, image, mask, prefer_smooth)
        if score < best_score:
            best_name = name
            best_img = image
            best_score = score

    return best_name, best_img


def _hybrid_inpaint(
    image_bgr: np.ndarray,
    mask: np.ndarray,
    base_radius: int,
    is_manga: bool,
    is_color_heavy: bool,
    prefer_smooth: bool,
) -> tuple[np.ndarray, str, str]:
    if mask.size == 0 or cv2.countNonZero(mask) <= 0:
        return image_bgr.copy(), "none", "cpu"

    safe_radius = max(2, min(24, int(base_radius)))
    use_opencl = _opencl_inpaint_enabled()

    telea_weight = 0.64 if is_manga else 0.48
    if is_color_heavy:
        telea_weight = 0.40

    radii = sorted(set([
        max(2, safe_radius - 1),
        safe_radius,
        min(26, safe_radius + 2),
        min(28, safe_radius + 4),
    ]))

    candidates: list[tuple[str, np.ndarray]] = []
    for radius in radii:
        telea_img = _run_single_inpaint(image_bgr, mask, radius, cv2.INPAINT_TELEA, use_opencl)
        ns_img = _run_single_inpaint(image_bgr, mask, radius + 2, cv2.INPAINT_NS, use_opencl)

        if telea_img is not None:
            candidates.append((f"telea_r{radius}", telea_img))
        if ns_img is not None:
            candidates.append((f"ns_r{radius + 2}", ns_img))
        if telea_img is not None and ns_img is not None:
            mixed = cv2.addWeighted(telea_img, telea_weight, ns_img, 1.0 - telea_weight, 0.0)
            candidates.append((f"hybrid_r{radius}", mixed))

    xphoto_img = _run_xphoto_inpaint(image_bgr, mask, prefer_quality=(is_color_heavy or not is_manga))
    if xphoto_img is not None:
        candidates.append(("xphoto_fsr", xphoto_img))

    if not candidates:
        fallback = cv2.inpaint(image_bgr, mask, safe_radius, cv2.INPAINT_TELEA)
        return fallback, "telea_fallback", "cpu"

    solver_name, selected = _pick_best_inpaint_candidate(
        base_image=image_bgr,
        mask=mask,
        candidates=candidates,
        prefer_smooth=prefer_smooth,
    )

    if is_color_heavy:
        smooth = cv2.bilateralFilter(selected, d=7, sigmaColor=52, sigmaSpace=35)
        selected = _blend_with_mask(selected, smooth, mask, feather_sigma=0.9)

    acceleration = "opencl" if use_opencl else "cpu"
    return selected, solver_name, acceleration


def _inpaint_from_mask(
    image_bgr: np.ndarray,
    raw_mask: np.ndarray,
    respect_user_regions: bool,
) -> tuple[np.ndarray, np.ndarray, int, str, str]:
    if raw_mask.size == 0:
        return image_bgr.copy(), raw_mask, 0, "none", "cpu"

    mask = np.where(raw_mask > 0, 255, 0).astype(np.uint8)
    if cv2.countNonZero(mask) <= 0:
        return image_bgr.copy(), mask, 0, "none", "cpu"

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
    if not respect_user_regions:
        mask = cv2.morphologyEx(
            mask,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        )
    mask = cv2.medianBlur(mask, 3)

    masked_pixels = int(cv2.countNonZero(mask))
    if masked_pixels <= 0:
        return image_bgr.copy(), mask, 0, "none", "cpu"

    is_manga = _is_manga_style(image_bgr)
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    is_color_heavy = float(np.mean(hsv[:, :, 1])) >= 42.0

    count, _labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    spans: list[int] = []
    for idx in range(1, count):
        area = int(stats[idx, cv2.CC_STAT_AREA])
        if area < 8:
            continue
        bw = int(stats[idx, cv2.CC_STAT_WIDTH])
        bh = int(stats[idx, cv2.CC_STAT_HEIGHT])
        spans.append(max(2, min(bw, bh)))

    median_span = int(np.median(spans)) if spans else 12
    inpaint_radius = max(3, min(16, int(median_span * (0.18 if is_manga else 0.22))))
    if is_color_heavy:
        inpaint_radius = max(4, min(18, int(inpaint_radius * 1.18)))

    hybrid, solver_name, acceleration = _hybrid_inpaint(
        image_bgr=image_bgr,
        mask=mask,
        base_radius=inpaint_radius,
        is_manga=is_manga,
        is_color_heavy=is_color_heavy,
        prefer_smooth=(respect_user_regions or is_color_heavy),
    )

    hard_fill_core = bool(respect_user_regions or (is_manga and not is_color_heavy))
    feather_sigma = max(0.9, inpaint_radius * (0.30 if hard_fill_core else 0.42))

    result = _composite_inpaint_result(
        image_bgr,
        hybrid,
        mask,
        feather_sigma=feather_sigma,
        hard_fill_core=hard_fill_core,
    )

    if is_manga and (not is_color_heavy):
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        ring_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        for idx in range(1, count):
            area = int(stats[idx, cv2.CC_STAT_AREA])
            if area < 12:
                continue

            comp = np.where(labels == idx, 255, 0).astype(np.uint8)
            ring = cv2.subtract(cv2.dilate(comp, ring_kernel, iterations=1), comp)
            if cv2.countNonZero(ring) < 12:
                continue

            ring_pixels = image_bgr[ring > 0]
            if ring_pixels.size == 0:
                continue

            ring_luma = (
                (ring_pixels[:, 0].astype(np.float32) * 0.114)
                + (ring_pixels[:, 1].astype(np.float32) * 0.587)
                + (ring_pixels[:, 2].astype(np.float32) * 0.299)
            )
            mean_luma = float(np.mean(ring_luma))
            std_luma = float(np.std(ring_luma))

            # For bright-ish backgrounds on monochrome manga, fill directly to remove ghost text.
            if mean_luma < (110.0 if respect_user_regions else 120.0) or std_luma > 95.0:
                continue

            fill_color = np.percentile(ring_pixels, 95 if respect_user_regions else 92, axis=0).astype(np.uint8)
            result[comp > 0] = fill_color

    if respect_user_regions:
        result_gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
        source_gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

        residual_hat = cv2.morphologyEx(
            result_gray,
            cv2.MORPH_BLACKHAT,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
        )
        _, residual_hat = cv2.threshold(residual_hat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        dark_cut = 148 if is_manga else 130
        residual_dark = cv2.inRange(result_gray, 0, dark_cut)

        diff = cv2.absdiff(source_gray, result_gray)
        _, residual_diff = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
        residual = cv2.bitwise_and(mask, cv2.bitwise_or(residual_hat, residual_dark))
        residual = cv2.bitwise_and(
            residual,
            cv2.dilate(
                residual_diff,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
                iterations=1,
            ),
        )
        residual = cv2.morphologyEx(
            residual,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        )
        residual = cv2.morphologyEx(
            residual,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
            iterations=1,
        )

        residual_pixels = int(cv2.countNonZero(residual))
        if residual_pixels >= max(20, int(masked_pixels * 0.01)):
            pass_radius = max(3, min(18, inpaint_radius + 1))
            pass_img, pass_solver, pass_acc = _hybrid_inpaint(
                image_bgr=result,
                mask=residual,
                base_radius=pass_radius,
                is_manga=is_manga,
                is_color_heavy=is_color_heavy,
                prefer_smooth=True,
            )
            result = _composite_inpaint_result(
                result,
                pass_img,
                residual,
                feather_sigma=max(0.9, pass_radius * 0.28),
                hard_fill_core=True,
            )
            solver_name = f"{solver_name}+{pass_solver}"
            acceleration = pass_acc if pass_acc else acceleration

    return result, mask, inpaint_radius, solver_name, acceleration


def _inpaint(
    image_bgr: np.ndarray,
    regions: list[dict[str, int]],
    respect_user_regions: bool = False,
) -> np.ndarray:
    if not regions:
        return image_bgr.copy()

    is_manga = _is_manga_style(image_bgr)
    hsv_image = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    global_sat = float(np.mean(hsv_image[:, :, 1]))
    is_color_heavy = global_sat >= 42.0

    result = image_bgr.copy()
    residual_mask = np.zeros(image_bgr.shape[:2], dtype=np.uint8)

    for region in regions:
        x = int(region["x"])
        y = int(region["y"])
        w = int(region["w"])
        h = int(region["h"])

        pad = max(2, min(18, int(min(w, h) * (0.10 if is_manga else 0.07))))
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(image_bgr.shape[1], x + w + pad)
        y2 = min(image_bgr.shape[0], y + h + pad)

        roi_original = image_bgr[y1:y2, x1:x2]
        roi_current = result[y1:y2, x1:x2]
        if roi_original.size == 0 or roi_current.size == 0:
            continue

        roi_h, roi_w = roi_original.shape[:2]
        roi_area = max(1, roi_h * roi_w)

        core_mask = np.zeros((roi_h, roi_w), dtype=np.uint8)
        core_x1 = max(0, x - x1)
        core_y1 = max(0, y - y1)
        core_x2 = min(roi_w, core_x1 + w)
        core_y2 = min(roi_h, core_y1 + h)
        cv2.rectangle(core_mask, (core_x1, core_y1), (core_x2, core_y2), 255, thickness=-1)

        if respect_user_regions:
            # Manual mask mode: always honor user-marked region (same expectation as old behavior).
            local_mask = core_mask.copy()
            edge_expand = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE,
                (_ensure_odd(max(3, int(min(w, h) * 0.02)), minimum=3, maximum=5),) * 2,
            )
            local_mask = cv2.dilate(local_mask, edge_expand, iterations=1)
        else:
            local_mask = _build_text_like_mask(roi_original, prefer_manga=is_manga)
            local_coverage = float(cv2.countNonZero(local_mask)) / roi_area
            if local_coverage < 0.008:
                local_mask = core_mask

        local_coverage = float(cv2.countNonZero(local_mask)) / roi_area

        if cv2.countNonZero(local_mask) <= 0:
            continue

        roi_gray = cv2.cvtColor(roi_original, cv2.COLOR_BGR2GRAY)
        roi_hsv = cv2.cvtColor(roi_original, cv2.COLOR_BGR2HSV)
        mean_luma = float(np.mean(roi_gray))
        mean_sat = float(np.mean(roi_hsv[:, :, 1]))
        white_ratio = float(cv2.countNonZero(cv2.threshold(roi_gray, 205, 255, cv2.THRESH_BINARY)[1])) / roi_area
        edge_density = float(cv2.countNonZero(cv2.Canny(roi_gray, 65, 150))) / roi_area

        bubble_like = (
            mean_luma > (160 if is_manga else 170)
            and mean_sat < (38 if is_manga else 30)
            and white_ratio > (0.40 if is_manga else 0.47)
            and edge_density < 0.30
            and local_coverage < 0.62
        )

        if bubble_like and not respect_user_regions:
            bg_color = _sample_region_background_color(roi_original, prefer_light=True)
            fill = np.full_like(roi_current, bg_color)
            text_mask_3ch = cv2.merge([local_mask, local_mask, local_mask])
            filled_roi = np.where(text_mask_3ch > 0, fill, roi_current)
            result[y1:y2, x1:x2] = _blend_with_mask(roi_current, filled_roi, local_mask, feather_sigma=1.3)
            continue

        current_slice = residual_mask[y1:y2, x1:x2]
        residual_mask[y1:y2, x1:x2] = cv2.bitwise_or(current_slice, local_mask)

    if cv2.countNonZero(residual_mask) <= 0:
        return result

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    residual_mask = cv2.morphologyEx(residual_mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
    if not respect_user_regions:
        residual_mask = cv2.morphologyEx(
            residual_mask,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        )
    residual_mask = cv2.medianBlur(residual_mask, 3)

    if cv2.countNonZero(residual_mask) <= 0:
        return result

    inpainted, _final_mask, _radius, _solver, _acc = _inpaint_from_mask(
        image_bgr=result,
        raw_mask=residual_mask,
        respect_user_regions=respect_user_regions,
    )
    return inpainted


def _decode_mask_data_url(mask_data_url: str) -> np.ndarray:
    raw = str(mask_data_url or "").strip()
    if not raw:
        raise EditorProcessingError("Thiếu brush mask")

    if raw.startswith("data:"):
        if "," not in raw:
            raise EditorProcessingError("brush mask không hợp lệ")
        raw = raw.split(",", 1)[1]

    try:
        decoded = base64.b64decode(raw, validate=False)
    except Exception as error:
        raise EditorProcessingError("Không giải mã được brush mask") from error

    arr = np.frombuffer(decoded, dtype=np.uint8)
    mask_image = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if mask_image is None:
        raise EditorProcessingError("Không đọc được brush mask")

    if len(mask_image.shape) == 2:
        gray = mask_image
    elif mask_image.shape[2] == 4:
        gray = mask_image[:, :, 3]
    else:
        gray = cv2.cvtColor(mask_image, cv2.COLOR_BGR2GRAY)

    _, binary = cv2.threshold(gray, 10, 255, cv2.THRESH_BINARY)
    return binary


def _get_easyocr_reader() -> Any:
    global _easyocr_reader
    if easyocr is None:
        return None
    if _easyocr_reader is not None:
        return _easyocr_reader

    with _easyocr_lock:
        if _easyocr_reader is not None:
            return _easyocr_reader
        use_gpu = bool(torch and hasattr(torch, "cuda") and torch.cuda.is_available())
        _easyocr_reader = easyocr.Reader(["vi", "en"], gpu=use_gpu)
        return _easyocr_reader


def _detect_regions_easyocr(image_bgr: np.ndarray) -> list[dict[str, Any]]:
    reader = _get_easyocr_reader()
    if reader is None:
        return []

    detections: list[dict[str, Any]] = []
    try:
        result = reader.readtext(image_bgr, detail=1, paragraph=False)
    except Exception:
        return []

    for row in result or []:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        points = row[0]
        text = str(row[1] or "").strip()
        confidence = float(row[2] or 0)
        if not points or len(points) < 4:
            continue
        xs = [int(float(p[0])) for p in points]
        ys = [int(float(p[1])) for p in points]
        x = max(0, min(xs))
        y = max(0, min(ys))
        w = max(1, max(xs) - x)
        h = max(1, max(ys) - y)
        if w < 8 or h < 8:
            continue
        detections.append({
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "text": text,
            "confidence": confidence,
        })

    return detections


# ---------------------------------------------------------------------------
# Public: OCR text extraction from a selected region
# ---------------------------------------------------------------------------
_ocr_readers: dict[str, Any] = {}
_ocr_readers_lock = threading.Lock()


def _get_ocr_reader_for_languages(languages: list[str]) -> Any:
    """Get or create an EasyOCR reader for the given language list (GPU-accelerated when available)."""
    global _ocr_readers
    if easyocr is None:
        return None

    key = ",".join(sorted(set(languages)))
    if key in _ocr_readers:
        return _ocr_readers[key]

    with _ocr_readers_lock:
        if key in _ocr_readers:
            return _ocr_readers[key]

        use_gpu = bool(torch and hasattr(torch, "cuda") and torch.cuda.is_available())
        reader = easyocr.Reader(languages, gpu=use_gpu)
        _ocr_readers[key] = reader
        return reader


def _preprocess_for_ocr(crop_bgr: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """
    Generate multiple preprocessed variants of the crop for multi-pass OCR.
    Returns list of (label, image_bgr) tuples.
    """
    variants: list[tuple[str, np.ndarray]] = []
    h, w = crop_bgr.shape[:2]

    # --- 1. Upscale small images (critical for diacritics) ---
    MIN_DIM = 800
    scale = 1.0
    if min(h, w) < MIN_DIM:
        scale = max(2.0, MIN_DIM / min(h, w))
        scale = min(scale, 4.0)  # cap at 4x
    if scale > 1.0:
        upscaled = cv2.resize(
            crop_bgr, None, fx=scale, fy=scale,
            interpolation=cv2.INTER_CUBIC,
        )
    else:
        upscaled = crop_bgr.copy()

    # Original (possibly upscaled)
    variants.append(("original", upscaled))

    # --- 2. CLAHE contrast enhancement ---
    lab = cv2.cvtColor(upscaled, cv2.COLOR_BGR2LAB)
    l_ch, a_ch, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_ch)
    enhanced = cv2.merge([l_enhanced, a_ch, b_ch])
    enhanced_bgr = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)
    variants.append(("clahe", enhanced_bgr))

    # --- 3. Denoise + sharpen (good for noisy manga scans) ---
    denoised = cv2.bilateralFilter(upscaled, d=9, sigmaColor=75, sigmaSpace=75)
    # Unsharp mask
    gaussian = cv2.GaussianBlur(denoised, (0, 0), 3.0)
    sharpened = cv2.addWeighted(denoised, 1.5, gaussian, -0.5, 0)
    variants.append(("sharp", sharpened))

    # --- 4. Adaptive binarization (best for high-contrast text bubbles) ---
    gray = cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)
    # Otsu threshold
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binarized_bgr = cv2.cvtColor(otsu, cv2.COLOR_GRAY2BGR)
    variants.append(("binarize", binarized_bgr))

    return variants


def _run_ocr_pass(
    reader: Any,
    image_bgr: np.ndarray,
    low_text: float = 0.3,
) -> list[dict[str, Any]]:
    """Run a single OCR pass with tuned parameters and return parsed lines."""
    try:
        result = reader.readtext(
            image_bgr,
            detail=1,
            paragraph=False,
            # Key accuracy params:
            text_threshold=0.5,     # confidence to consider as text
            low_text=low_text,       # lower = catch more diacritics/small chars
            link_threshold=0.3,     # link nearby characters
            canvas_size=2560,       # higher resolution processing
            mag_ratio=1.5,          # magnification for small text
            slope_ths=0.3,          # tolerate slight rotation
            width_ths=0.7,          # merge nearby horizontal boxes
            contrast_ths=0.05,      # lower = detect low-contrast text
        )
    except TypeError:
        # Older EasyOCR versions may not support all params — fallback
        try:
            result = reader.readtext(image_bgr, detail=1, paragraph=False)
        except Exception:
            return []
    except Exception:
        return []

    lines: list[dict[str, Any]] = []
    for row in result or []:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        raw_text = row[1]
        text = str(raw_text).strip() if raw_text is not None else ""
        confidence = float(row[2]) if row[2] is not None else 0.0
        if not text or text.lower() == "none" or len(text.strip()) == 0:
            continue
        # Filter out obvious garbage (single punctuation, pure whitespace)
        clean = text.replace(" ", "").replace("\n", "")
        if len(clean) < 1:
            continue

        points = row[0]
        xs = [int(float(p[0])) for p in points] if points and len(points) >= 4 else []
        ys = [int(float(p[1])) for p in points] if points and len(points) >= 4 else []
        line_data: dict[str, Any] = {
            "text": text,
            "confidence": round(confidence, 4),
        }
        if xs and ys:
            line_data["bbox"] = {
                "x": max(0, min(xs)),
                "y": max(0, min(ys)),
                "w": max(1, max(xs) - min(xs)),
                "h": max(1, max(ys) - min(ys)),
            }
        lines.append(line_data)
    return lines


def _merge_ocr_results(all_results: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """
    Merge OCR results from multiple passes.
    Uses BOTH text similarity AND spatial (bbox) overlap to eliminate duplicates.
    Keeps the highest-confidence detection for each unique text region.
    """
    if not all_results:
        return []

    # Flatten and sort by confidence descending
    flat: list[dict[str, Any]] = []
    for result_list in all_results:
        flat.extend(result_list)

    if not flat:
        return []

    flat.sort(key=lambda x: x.get("confidence", 0), reverse=True)

    def _bbox_overlap_ratio(a: dict, b: dict) -> float:
        """Calculate IoU-like overlap ratio between two bboxes."""
        if not a or not b:
            return 0.0
        ax1, ay1 = a.get("x", 0), a.get("y", 0)
        ax2, ay2 = ax1 + a.get("w", 0), ay1 + a.get("h", 0)
        bx1, by1 = b.get("x", 0), b.get("y", 0)
        bx2, by2 = bx1 + b.get("w", 0), by1 + b.get("h", 0)

        inter_x1 = max(ax1, bx1)
        inter_y1 = max(ay1, by1)
        inter_x2 = min(ax2, bx2)
        inter_y2 = min(ay2, by2)

        if inter_x1 >= inter_x2 or inter_y1 >= inter_y2:
            return 0.0

        inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
        area_a = max(1, a.get("w", 1) * a.get("h", 1))
        area_b = max(1, b.get("w", 1) * b.get("h", 1))
        min_area = min(area_a, area_b)
        return inter_area / min_area if min_area > 0 else 0.0

    def _text_similar(a: str, b: str) -> bool:
        """Check if two text strings are similar enough to be considered duplicates."""
        na = a.lower().replace(" ", "").replace("\n", "")
        nb = b.lower().replace(" ", "").replace("\n", "")
        if not na or not nb:
            return False
        # Exact match
        if na == nb:
            return True
        # One contains the other
        if na in nb or nb in na:
            return True
        # High character overlap (>70% shared chars)
        if len(na) > 2 and len(nb) > 2:
            shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
            match_count = sum(1 for c in shorter if c in longer)
            if match_count / len(shorter) > 0.7:
                return True
        return False

    merged: list[dict[str, Any]] = []

    for item in flat:
        text = item["text"].strip()
        bbox = item.get("bbox", {})
        is_dup = False

        for existing in merged:
            existing_bbox = existing.get("bbox", {})
            # Check spatial overlap (bbox covers same area)
            if bbox and existing_bbox and _bbox_overlap_ratio(bbox, existing_bbox) > 0.4:
                is_dup = True
                break
            # Check text similarity
            if _text_similar(text, existing["text"]):
                is_dup = True
                break

        if not is_dup:
            merged.append(item)

    # Sort by vertical position (top to bottom), then left to right
    def sort_key(item: dict[str, Any]) -> tuple[int, int]:
        bbox = item.get("bbox", {})
        return (bbox.get("y", 0), bbox.get("x", 0))

    merged.sort(key=sort_key)
    return merged


def ocr_extract_text(
    image_bytes: bytes,
    region_json: str,
    languages_csv: str = "",
) -> dict[str, Any]:
    """
    Extract text from a selected region of an image using EasyOCR.
    Auto-detects language. Uses multi-pass preprocessing for high accuracy,
    especially for languages with diacritics (Vietnamese, Thai, etc.).

    Pipeline:
      1. Crop region → upscale if small
      2. Generate 4 preprocessed variants (original, CLAHE, sharp, binarize)
      3. Run OCR on each variant with tuned params
      4. Merge results, dedup, keep highest confidence
      5. If ja+en fails, try vi+en and ko+en readers
      6. Auto-detect source language from Unicode analysis
    """
    image_bgr = _decode_image(image_bytes)
    h, w = image_bgr.shape[:2]

    # Parse region JSON
    try:
        region = json.loads(region_json) if isinstance(region_json, str) else region_json
    except (json.JSONDecodeError, TypeError):
        raise EditorProcessingError("Dữ liệu vùng chọn không hợp lệ (JSON lỗi)")

    if not isinstance(region, dict):
        raise EditorProcessingError("Vùng chọn phải là object {x, y, w, h}")

    # Validate and clamp region
    try:
        rx = max(0, int(float(region.get("x", 0))))
        ry = max(0, int(float(region.get("y", 0))))
        rw = int(float(region.get("w", 0)))
        rh = int(float(region.get("h", 0)))
    except (ValueError, TypeError):
        raise EditorProcessingError("Tọa độ vùng chọn không hợp lệ")

    if rw < 6 or rh < 6:
        raise EditorProcessingError("Vùng chọn quá nhỏ (tối thiểu 6×6 pixel)")

    rx = min(rx, w - 1)
    ry = min(ry, h - 1)
    rw = min(rw, w - rx)
    rh = min(rh, h - ry)

    if rw < 4 or rh < 4:
        raise EditorProcessingError("Vùng chọn nằm ngoài ảnh")

    crop_bgr = image_bgr[ry:ry + rh, rx:rx + rw]
    if crop_bgr.size == 0:
        raise EditorProcessingError("Vùng cắt rỗng")

    use_gpu = bool(torch and hasattr(torch, "cuda") and torch.cuda.is_available())

    # Generate preprocessed variants
    variants = _preprocess_for_ocr(crop_bgr)

    # --- Pass 1: Japanese + English (most common manga) ---
    reader_ja = _get_ocr_reader_for_languages(["ja", "en"])
    all_pass_results: list[list[dict[str, Any]]] = []

    if reader_ja is not None:
        for label, variant_img in variants:
            pass_lines = _run_ocr_pass(reader_ja, variant_img)
            if pass_lines:
                all_pass_results.append(pass_lines)

    lines = _merge_ocr_results(all_pass_results)

    # --- Pass 2: If low confidence or no results, try Vietnamese + English ---
    avg_conf = (sum(l["confidence"] for l in lines) / len(lines)) if lines else 0.0
    if not lines or avg_conf < 0.5:
        reader_vi = _get_ocr_reader_for_languages(["vi", "en"])
        if reader_vi is not None:
            vi_results: list[list[dict[str, Any]]] = []
            for label, variant_img in variants[:2]:  # original + clahe only (speed)
                pass_lines = _run_ocr_pass(reader_vi, variant_img, low_text=0.25)
                if pass_lines:
                    vi_results.append(pass_lines)
            vi_lines = _merge_ocr_results(vi_results)
            vi_avg = (sum(l["confidence"] for l in vi_lines) / len(vi_lines)) if vi_lines else 0.0
            if vi_avg > avg_conf and vi_lines:
                lines = vi_lines

    # --- Pass 3: If still low, try Korean + English ---
    avg_conf = (sum(l["confidence"] for l in lines) / len(lines)) if lines else 0.0
    if not lines or avg_conf < 0.4:
        reader_ko = _get_ocr_reader_for_languages(["ko", "en"])
        if reader_ko is not None:
            ko_results: list[list[dict[str, Any]]] = []
            for label, variant_img in variants[:2]:
                pass_lines = _run_ocr_pass(reader_ko, variant_img)
                if pass_lines:
                    ko_results.append(pass_lines)
            ko_lines = _merge_ocr_results(ko_results)
            ko_avg = (sum(l["confidence"] for l in ko_lines) / len(ko_lines)) if ko_lines else 0.0
            if ko_avg > avg_conf and ko_lines:
                lines = ko_lines

    if not lines:
        raise EditorProcessingError(
            "Không phát hiện được chữ nào trong vùng chọn. "
            "Hãy thử chọn vùng khác có chứa text rõ ràng hơn."
        )

    combined_text = "\n".join(line["text"] for line in lines)

    # Detect likely source language from text characters
    detected_lang = "ja"
    has_hangul = any("\uac00" <= ch <= "\ud7a3" for ch in combined_text)
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in combined_text)
    has_hiragana = any("\u3040" <= ch <= "\u309f" for ch in combined_text)
    has_katakana = any("\u30a0" <= ch <= "\u30ff" for ch in combined_text)
    has_latin = any("a" <= ch.lower() <= "z" for ch in combined_text)
    has_viet_diacritics = bool(re.search(r"[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]", combined_text, re.IGNORECASE))
    has_thai = any("\u0e01" <= ch <= "\u0e5b" for ch in combined_text)

    if has_thai:
        detected_lang = "th"
    elif has_viet_diacritics:
        detected_lang = "vi"
    elif has_hangul:
        detected_lang = "ko"
    elif has_hiragana or has_katakana:
        detected_lang = "ja"
    elif has_cjk and not has_hiragana and not has_katakana:
        detected_lang = "zh"
    elif has_latin and not has_cjk and not has_hangul:
        detected_lang = "en"

    avg_confidence = round(sum(l["confidence"] for l in lines) / len(lines), 4) if lines else 0.0

    return {
        "text": combined_text,
        "lines": lines,
        "region": {"x": rx, "y": ry, "w": rw, "h": rh},
        "detected_language": detected_lang,
        "gpu_used": use_gpu,
        "detections_count": len(lines),
        "avg_confidence": avg_confidence,
    }



# ---------------------------------------------------------------------------
# Public: Translate text via OpenRouter API
# ---------------------------------------------------------------------------

_LANG_NAMES: dict[str, str] = {
    "vi": "Vietnamese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "th": "Thai",
    "id": "Indonesian",
    "ms": "Malay",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "pt": "Portuguese",
    "ru": "Russian",
}


async def translate_text_openrouter(
    text: str,
    source_language: str = "ja",
    target_language: str = "vi",
) -> dict[str, Any]:
    """
    Translate text using OpenRouter API.
    - Auto-retries up to 3 times if model returns empty.
    - Falls back to alternative free models if primary fails.
    - Strips <think> reasoning tags from reasoning models.
    """
    from config import config

    api_key = str(config.OPENROUTER_API_KEY or "").strip()
    if not api_key:
        raise EditorProcessingError(
            "Chưa cấu hình OPENROUTER_API_KEY trong file .env. "
            "Vui lòng thêm API key từ openrouter.ai để sử dụng chức năng dịch."
        )

    clean_text = str(text or "").strip()
    if not clean_text:
        raise EditorProcessingError("Không có văn bản để dịch")

    src_name = _LANG_NAMES.get(source_language, source_language)
    tgt_name = _LANG_NAMES.get(target_language, target_language)

    # Build a detailed, high-quality translation prompt
    # Vietnamese-specific rules are added when target is Vietnamese
    is_target_vi = target_language == "vi"

    base_rules = (
        f"You are an expert manga/manhwa/manhua translator with 10+ years of experience. "
        f"Your task: translate the text below from {src_name} to {tgt_name}.\n\n"
        f"## CRITICAL OUTPUT RULES\n"
        f"- Return ONLY the translated text. No explanations, notes, tags, or quotes.\n"
        f"- Do NOT include <think>, reasoning, or meta-commentary.\n"
        f"- Do NOT return 'None', empty string, or placeholder text.\n"
        f"- Preserve original line breaks exactly.\n\n"
        f"## TRANSLATION QUALITY RULES\n"
        f"- Translate meaning, NOT word-by-word. Produce natural {tgt_name} that sounds like a native speaker wrote it.\n"
        f"- Match the emotional tone: angry speech → angry translation, shy speech → shy translation.\n"
        f"- Maintain character personality through word choice and speech patterns.\n"
        f"- Dialogue must sound like real people talking, not a textbook.\n"
        f"- Short exclamations stay short: 「えっ」→ brief equivalent, not a full sentence.\n"
        f"- Rhetorical questions remain rhetorical.\n"
        f"- Sarcasm and humor must be preserved, adapted culturally if needed.\n\n"
        f"## SOUND EFFECTS & SPECIAL TEXT\n"
        f"- Onomatopoeia: translate to natural {tgt_name} equivalents (e.g., ドキドキ → thump thump / tim đập thình thịch).\n"
        f"- If no good equivalent exists, transliterate phonetically.\n"
        f"- Action sounds (ガシャン, 바삭): use vivid {tgt_name} sound words.\n"
        f"- Ellipsis (...) and trailing speech: keep the hesitation feel.\n\n"
        f"## CONTEXT AWARENESS\n"
        f"- This is manga dialogue. Characters may be fighting, confessing love, joking, or in daily life.\n"
        f"- Adapt formality level: battle shout ≠ polite greeting ≠ intimate whisper.\n"
        f"- Keep honorific nuance if the target language supports it.\n\n"
        f"## RELATIONSHIP & CHARACTER CONTEXT\n"
        f"- Pay close attention to character relationships shown in the artwork:\n"
        f"  + Couple/lovers: intimate, warm, sometimes teasing tone\n"
        f"  + Rivals/enemies: aggressive, taunting, or cold tone\n"
        f"  + Senpai/kouhai: respectful but friendly hierarchy\n"
        f"  + Parent/child: protective, caring, or stern\n"
        f"  + Strangers: formal, cautious, polite\n"
        f"  + Close friends: casual, playful, use nicknames\n"
        f"- CONSISTENCY: maintain the same pronoun/address style for the same character pair throughout.\n"
        f"- Detect gender from art context (hair, body, clothing, expressions) to choose correct pronouns.\n"
        f"- Age hierarchy matters: younger characters speak more politely to older ones unless they're close friends.\n\n"
        f"## GENRE-SPECIFIC REGISTER\n"
        f"- Romance: soft, emotional, use tender expressions. Confessions should feel heartfelt.\n"
        f"- Action/Battle: sharp, intense, commanding. War cries should be powerful.\n"
        f"- Comedy/Slice-of-life: light, witty, natural daily speech.\n"
        f"- Horror/Thriller: tense, ominous, unsettling word choices.\n"
        f"- Fantasy/Isekai: can mix archaic and modern speech depending on character.\n"
    )

    vi_rules = ""
    if is_target_vi:
        vi_rules = (
            f"\n## VIETNAMESE-SPECIFIC RULES (RẤT QUAN TRỌNG)\n"
            f"- Xưng hô theo MỐI QUAN HỆ trong truyện:\n"
            f"  + Cặp đôi yêu nhau: anh/em (nam nói), em/anh (nữ nói), hoặc tên riêng\n"
            f"  + Bạn bè thân: tớ/cậu, mình/bạn, tao/mày (nếu thân lắm)\n"
            f"  + Bạn bè ngang hàng bình thường: tôi/cậu, mình/bạn\n"
            f"  + Senpai/kouhai: em/anh, em/chị (kouhai nói), cậu/em (senpai nói)\n"
            f"  + Thầy trò: con/thầy, con/sư phụ, đệ tử/sư tôn\n"
            f"  + Cha mẹ - con cái: con/bố, con/mẹ, con/cha\n"
            f"  + Anh chị em ruột: em/anh, em/chị, hoặc tên riêng\n"
            f"  + Đối thủ/kẻ thù: ta/ngươi, tao/mày, tôi/anh-chị (lạnh lùng)\n"
            f"  + Vua/thần/quý tộc: ta/ngươi, bệ hạ, điện hạ, thần/bệ hạ\n"
            f"  + Lịch sự / người lớn: tôi/anh, tôi/chị\n"
            f"  + Cổ trang / fantasy: ta/ngươi, huynh/đệ, tỷ/muội\n"
            f"  + CHỈ dùng tao/mày khi nhân vật thực sự tức giận, gây hấn, thân thiết kiểu bad boy, hoặc ngữ cảnh rõ ràng là thô tục.\n"
            f"- NHẤT QUÁN xưng hô: cùng một cặp nhân vật phải dùng cùng kiểu xưng hô xuyên suốt.\n"
            f"- Phân biệt giọng theo giới tính và tính cách:\n"
            f"  + Nam mạnh mẽ: tôi/ta, giọng dứt khoát\n"
            f"  + Nam hiền: tớ/mình, giọng nhẹ nhàng\n"
            f"  + Nữ dịu dàng: em/mình, giọng mềm mại\n"
            f"  + Nữ mạnh: tôi/ta, giọng quyết đoán\n"
            f"  + Trẻ con: con, cháu, giọng ngây thơ\n"
            f"- Câu cảm thán tự nhiên: 'Chết rồi!', 'Trời ơi!', 'Khoan đã!', 'Sao cơ?!' thay vì dịch sát.\n"
            f"- Thêm ngữ khí từ cho tự nhiên: à, ư, nhỉ, nhé, đấy, sao, chứ, hả, vậy, nha, hen, cơ, mà.\n"
            f"- Tình cảm lãng mạn dịch cho ngọt ngào: 好き→'thích cậu/anh/em', 愛してる→'yêu anh/em'.\n"
            f"- VD đúng: 守ってやる → 'Để tớ bảo vệ cậu' / 'Anh sẽ bảo vệ em' tùy ngữ cảnh.\n"
            f"- Câu ngắn giữ ngắn: うん → 'Ừ', いいよ → 'Được thôi', ダメ → 'Không được đâu!'.\n"
            f"- Giữ nhịp đọc manga: câu gọn, dễ hiểu, có cảm xúc, đọc lên thấy tự nhiên.\n"
            f"- KHÔNG dùng văn phong quá trang trọng hay sách vở cho hội thoại thường ngày.\n"
        )

    system_prompt = base_rules + vi_rules

    # Models to try in order (primary + fallbacks)
    models_to_try = [
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "meta-llama/llama-3.3-8b-instruct:free",
        "qwen/qwen3-8b:free",
    ]

    last_error = ""
    used_model = models_to_try[0]

    for model_idx, model in enumerate(models_to_try):
        # Each model gets up to 2 attempts
        max_attempts = 2 if model_idx == 0 else 1
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(timeout=45.0) as client:
                    response = await client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                            "HTTP-Referer": "https://manga-bliss.app",
                            "X-Title": "Manga-Bliss Editor",
                        },
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": clean_text},
                            ],
                            "temperature": 0.3,
                            "max_tokens": 2048,
                        },
                    )
            except httpx.TimeoutException:
                last_error = f"Timeout với model {model}"
                continue
            except Exception as exc:
                last_error = f"Lỗi kết nối: {exc}"
                continue

            if response.status_code == 401:
                raise EditorProcessingError("OPENROUTER_API_KEY không hợp lệ. Vui lòng kiểm tra lại API key.")
            if response.status_code == 429:
                last_error = "Rate limit"
                continue  # try next model
            if response.status_code != 200:
                try:
                    body = response.json()
                    last_error = str(body.get("error", {}).get("message", f"HTTP {response.status_code}"))
                except Exception:
                    last_error = response.text[:200]
                continue

            try:
                body = response.json()
            except Exception:
                last_error = "Response JSON lỗi"
                continue

            choices = body.get("choices", [])
            if not choices:
                last_error = "Không có choices"
                continue

            raw_content = choices[0].get("message", {}).get("content")
            if raw_content is None:
                last_error = "Content là None"
                continue

            translated = str(raw_content).strip()

            # Strip <think>...</think> reasoning tags
            translated = re.sub(r"<think>.*?</think>", "", translated, flags=re.DOTALL).strip()

            # Strip reasoning artifacts
            translated = re.sub(r"^(Translation|Translated|Result|Output|Answer):\s*", "", translated, flags=re.IGNORECASE).strip()

            # Remove wrapping quotes
            if len(translated) >= 2 and translated[0] == translated[-1] and translated[0] in "\"'":
                translated = translated[1:-1].strip()

            # Reject garbage
            if not translated or translated.lower() in ("none", "null", "undefined", "n/a", ""):
                last_error = f"Model trả về rỗng (attempt {attempt + 1})"
                continue

            # Success!
            used_model = model
            return {
                "original_text": clean_text,
                "translated_text": translated,
                "source_language": source_language,
                "target_language": target_language,
                "model": used_model,
            }

    # All attempts exhausted
    raise EditorProcessingError(
        f"Không thể dịch sau nhiều lần thử. Lỗi cuối: {last_error}. "
        f"Vui lòng thử lại sau hoặc chọn vùng text rõ ràng hơn."
    )


def _filter_mask_components_global(
    mask: np.ndarray,
    image_shape: tuple[int, int],
    max_height_ratio: float,
) -> np.ndarray:
    if mask.size == 0:
        return mask

    h, w = image_shape
    image_area = max(1, h * w)
    min_area = max(8, int(image_area * 0.000005))
    max_area = max(180, int(image_area * 0.020))
    max_height = max(8, int(h * max_height_ratio))

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return mask

    output = np.zeros_like(mask)
    for idx in range(1, count):
        area = int(stats[idx, cv2.CC_STAT_AREA])
        if area < min_area or area > max_area:
            continue

        bw = int(stats[idx, cv2.CC_STAT_WIDTH])
        bh = int(stats[idx, cv2.CC_STAT_HEIGHT])
        if bw < 2 or bh < 2 or bh > max_height:
            continue

        aspect = float(bw) / float(max(1, bh))
        if aspect < 0.05 or aspect > 22.0:
            continue

        fill_ratio = float(area) / float(max(1, bw * bh))
        if fill_ratio < 0.03 or fill_ratio > 0.98:
            continue

        output[labels == idx] = 255

    return output


def _detect_ocr_guided_text_mask(image_bgr: np.ndarray) -> np.ndarray:
    h, w = image_bgr.shape[:2]
    image_area = max(1, h * w)
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    mask = np.zeros((h, w), dtype=np.uint8)

    detections = _detect_regions_easyocr(image_bgr)
    if not detections:
        return mask

    for row in detections:
        confidence = float(row.get("confidence") or 0.0)
        text = str(row.get("text") or "").strip()
        if confidence < 0.18 and len(text) < 2:
            continue

        parsed = _sanitize_region(row, w, h)
        if not parsed:
            continue

        x = int(parsed["x"])
        y = int(parsed["y"])
        bw = int(parsed["w"])
        bh = int(parsed["h"])
        if bw < 4 or bh < 4:
            continue

        pad_x = max(1, int(bw * 0.10))
        pad_y = max(1, int(bh * 0.12))
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(w, x + bw + pad_x)
        y2 = min(h, y + bh + pad_y)

        roi = gray[y1:y2, x1:x2]
        if roi.size == 0:
            continue

        block = _ensure_odd(max(11, int(min(roi.shape[:2]) * 0.40)), minimum=11, maximum=41)
        adapt = cv2.adaptiveThreshold(
            roi,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            block,
            7,
        )

        blackhat = cv2.morphologyEx(
            roi,
            cv2.MORPH_BLACKHAT,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
        )
        _, blackhat_mask = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        edges = cv2.Canny(roi, 55, 145)
        edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)

        local = cv2.bitwise_or(adapt, blackhat_mask)
        local = cv2.bitwise_and(local, cv2.bitwise_or(edges, cv2.inRange(roi, 0, 170)))
        local = cv2.morphologyEx(
            local,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        )
        local = cv2.dilate(
            local,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
            iterations=1,
        )

        if cv2.countNonZero(local) < max(6, int(bw * bh * 0.02)):
            continue

        current = mask[y1:y2, x1:x2]
        mask[y1:y2, x1:x2] = cv2.bitwise_or(current, local)

    if cv2.countNonZero(mask) <= 0:
        return mask

    mask = _filter_mask_components_global(mask, (h, w), max_height_ratio=0.20)
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )
    mask = cv2.dilate(
        mask,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
        iterations=1,
    )

    coverage = float(cv2.countNonZero(mask)) / float(image_area)
    if coverage > 0.28:
        gray_edges = cv2.Canny(gray, 50, 140)
        gray_edges = cv2.dilate(gray_edges, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)
        constrained = cv2.bitwise_and(mask, gray_edges)
        if cv2.countNonZero(constrained) > int(image_area * 0.010):
            mask = constrained

    return mask


def _detect_regions_morph(image_bgr: np.ndarray) -> list[dict[str, Any]]:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    thresh = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        21,
        15,
    )

    # Use both horizontal and vertical kernels to catch
    # both horizontal English text and vertical Japanese text in manga
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 15))
    merged_h = cv2.dilate(thresh, kernel_h, iterations=1)
    merged_v = cv2.dilate(thresh, kernel_v, iterations=1)
    merged = cv2.bitwise_or(merged_h, merged_v)

    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    h, w = gray.shape[:2]
    regions: list[dict[str, Any]] = []
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        area = bw * bh
        if area < 300:
            continue
        if bw < 12 or bh < 12:
            continue
        if bw > int(w * 0.95) and bh > int(h * 0.95):
            continue
        regions.append({
            "x": int(x),
            "y": int(y),
            "w": int(bw),
            "h": int(bh),
            "text": "",
            "confidence": 0.0,
        })

    regions.sort(key=lambda item: (item["y"], item["x"]))
    return regions


def detect_text_regions(image_bgr: np.ndarray) -> list[dict[str, Any]]:
    h, w = image_bgr.shape[:2]
    easy = _detect_regions_easyocr(image_bgr)
    morph = _detect_regions_morph(image_bgr)

    easy_regions: list[dict[str, int]] = []
    for row in easy:
        parsed = _sanitize_region(row, w, h)
        if parsed:
            expanded = _expand_region(parsed, w, h, pad_x_ratio=0.04, pad_y_ratio=0.08, min_pad=1)
            easy_regions.append(expanded or parsed)

    easy_regions = _filter_detected_regions(easy_regions, w, h, max_area_ratio=0.05)

    seeded_regions: list[dict[str, int]] = list(easy_regions)

    for row in morph:
        parsed = _sanitize_region(row, w, h)
        if not parsed:
            continue
        if seeded_regions:
            overlaps = any(_region_iou(existing, parsed) >= 0.35 for existing in seeded_regions)
            if overlaps:
                continue
        expanded = _expand_region(parsed, w, h, pad_x_ratio=0.05, pad_y_ratio=0.09, min_pad=1)
        seeded_regions.append(expanded or parsed)

    merged = _merge_regions(seeded_regions)
    merged = _filter_detected_regions(merged, w, h, max_area_ratio=0.05)
    limited = _limit_regions_by_coverage(image_bgr.shape, merged, max_coverage=0.14, max_regions=70)

    if not limited and easy_regions:
        limited = _limit_regions_by_coverage(image_bgr.shape, easy_regions, max_coverage=0.12, max_regions=60)

    return [
        {
            "x": row["x"],
            "y": row["y"],
            "w": row["w"],
            "h": row["h"],
            "text": "",
            "confidence": 0.0,
        }
        for row in limited
    ]


def _color_from_hex(value: str) -> tuple[int, int, int]:
    raw = str(value or "#000000").strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6:
        raw = "000000"
    try:
        r = int(raw[0:2], 16)
        g = int(raw[2:4], 16)
        b = int(raw[4:6], 16)
    except Exception:
        r, g, b = 0, 0, 0
    return r, g, b


def _font_search_paths() -> list[tuple[str, str]]:
    options: list[tuple[str, str]] = []

    custom_dir = os.getenv(
        "EDITOR_FONT_DIR",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "fonts")),
    )
    if os.path.isdir(custom_dir):
        for file_name in sorted(os.listdir(custom_dir)):
            path = os.path.join(custom_dir, file_name)
            if not os.path.isfile(path):
                continue
            ext = os.path.splitext(file_name)[1].lower()
            if ext not in _FONT_EXTENSIONS:
                continue
            label = os.path.splitext(file_name)[0]
            options.append((label, path))

    windows_font_dir = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
    windows_candidates = {
        "Comic Sans MS": "comic.ttf",
        "Segoe UI": "segoeui.ttf",
        "Arial": "arial.ttf",
        "Tahoma": "tahoma.ttf",
        "Verdana": "verdana.ttf",
        "Times New Roman": "times.ttf",
    }
    for label, file_name in windows_candidates.items():
        path = os.path.join(windows_font_dir, file_name)
        if os.path.isfile(path):
            options.append((label, path))

    return options


def list_available_fonts() -> list[dict[str, str]]:
    seen = set()
    output: list[dict[str, str]] = []
    for label, path in _font_search_paths():
        key = label.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        output.append({"name": label, "path": path})

    if not output:
        for name in _DEFAULT_FONT_NAMES:
            output.append({"name": name, "path": ""})

    return output


def _font_path_by_name(font_name: str) -> str:
    normalized = str(font_name or "").strip().lower()
    for item in list_available_fonts():
        name = str(item.get("name") or "").strip().lower()
        if name == normalized:
            return str(item.get("path") or "")
    first = list_available_fonts()[0]
    return str(first.get("path") or "")


def _load_font(font_name: str, size: int) -> ImageFont.ImageFont:
    safe_size = max(10, min(160, int(size or 28)))
    path = _font_path_by_name(font_name)
    if path:
        try:
            return ImageFont.truetype(path, size=safe_size)
        except Exception:
            pass
    # Fallback: try common Unicode fonts that support Vietnamese diacritics
    unicode_font_candidates = [
        "arial.ttf",
        "segoeui.ttf",
        "tahoma.ttf",
        "verdana.ttf",
        "times.ttf",
        "NotoSansCJK-Regular.ttc",
        "NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    ]
    windows_font_dir = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
    for candidate in unicode_font_candidates:
        try:
            # Try absolute path first, then Windows font dir
            if os.path.isabs(candidate) and os.path.isfile(candidate):
                return ImageFont.truetype(candidate, size=safe_size)
            win_path = os.path.join(windows_font_dir, candidate)
            if os.path.isfile(win_path):
                return ImageFont.truetype(win_path, size=safe_size)
            # Try raw name (PIL will search system paths)
            return ImageFont.truetype(candidate, size=safe_size)
        except Exception:
            continue
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    cleaned = _normalize_spaces(text)
    if not cleaned:
        return [""]

    words = cleaned.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        width = draw.textbbox((0, 0), candidate, font=font)[2]
        if width <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    return lines or [cleaned]


def _render_text_overlays(image_bgr: np.ndarray, overlays: list[dict[str, Any]]) -> np.ndarray:
    pil = _to_pil(image_bgr)
    draw = ImageDraw.Draw(pil)

    for overlay in overlays:
        text = str(overlay.get("text") or "").strip()
        if not text:
            continue

        x = int(float(overlay.get("x", 0)))
        y = int(float(overlay.get("y", 0)))
        w = int(float(overlay.get("w", 200)))
        h = int(float(overlay.get("h", 100)))
        if w < 10 or h < 10:
            continue

        font_name = str(overlay.get("font_name") or "Comic Sans MS")
        font_size = int(float(overlay.get("font_size", 32)))
        color = _color_from_hex(str(overlay.get("color") or "#111111"))
        align = str(overlay.get("align") or "center").strip().lower()
        stroke_width = int(float(overlay.get("stroke_width", 2)))

        font = _load_font(font_name, font_size)
        lines = _wrap_text(draw, text, font, max_width=max(20, w - 12))

        line_heights: list[int] = []
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font)
            line_heights.append(max(12, bbox[3] - bbox[1]))

        total_text_height = sum(line_heights) + max(0, len(lines) - 1) * 4
        while total_text_height > h - 8 and font_size > 12:
            font_size -= 2
            font = _load_font(font_name, font_size)
            lines = _wrap_text(draw, text, font, max_width=max(20, w - 12))
            line_heights = []
            for line in lines:
                bbox = draw.textbbox((0, 0), line, font=font)
                line_heights.append(max(12, bbox[3] - bbox[1]))
            total_text_height = sum(line_heights) + max(0, len(lines) - 1) * 4

        text_y = y + max(4, int((h - total_text_height) / 2))
        for idx, line in enumerate(lines):
            bbox = draw.textbbox((0, 0), line, font=font)
            text_w = bbox[2] - bbox[0]

            if align == "left":
                text_x = x + 4
            elif align == "right":
                text_x = x + max(4, w - text_w - 4)
            else:
                text_x = x + max(4, int((w - text_w) / 2))

            draw.text(
                (text_x, text_y),
                line,
                font=font,
                fill=color,
                stroke_width=max(0, stroke_width),
                stroke_fill=(255, 255, 255),
            )
            text_y += line_heights[idx] + 4

    return _from_pil(pil)


def _extract_ocr_text_from_crop(crop_bgr: np.ndarray) -> str:
    rows = _detect_regions_easyocr(crop_bgr)
    text_parts = [str(row.get("text") or "").strip() for row in rows if str(row.get("text") or "").strip()]
    if text_parts:
        return " ".join(text_parts)
    return ""


def _render_sample_text(width: int, height: int, text: str, font_name: str) -> np.ndarray:
    canvas = Image.new("RGB", (max(40, width), max(30, height)), color=(255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    font = _load_font(font_name, max(14, int(min(width, height) * 0.45)))
    text = _normalize_spaces(text) or "Aa"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = max(2, int((canvas.width - text_w) / 2))
    y = max(2, int((canvas.height - text_h) / 2))
    draw.text((x, y), text, font=font, fill=(0, 0, 0))
    arr = np.array(canvas.convert("L"))
    return cv2.threshold(arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]


def detect_font_for_region(
    image_bgr: np.ndarray,
    region: dict[str, Any],
    sample_text: str | None = None,
) -> dict[str, Any]:
    h, w = image_bgr.shape[:2]
    sanitized = _sanitize_region(region, w, h)
    if not sanitized:
        raise EditorProcessingError("Vùng nhận diện font không hợp lệ")

    x = sanitized["x"]
    y = sanitized["y"]
    rw = sanitized["w"]
    rh = sanitized["h"]

    crop = image_bgr[y : y + rh, x : x + rw]
    if crop.size == 0:
        raise EditorProcessingError("Không cắt được vùng ảnh để nhận diện font")

    inferred_text = _normalize_spaces(sample_text or "")
    if not inferred_text:
        inferred_text = _extract_ocr_text_from_crop(crop)
    if not inferred_text:
        inferred_text = "Aa"

    crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    crop_bin = cv2.threshold(crop_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

    candidates = [item.get("name", "") for item in list_available_fonts() if item.get("name")]
    scored: list[tuple[str, float]] = []
    for font_name in candidates:
        rendered = _render_sample_text(rw, rh, inferred_text, font_name)
        if rendered.shape != crop_bin.shape:
            rendered = cv2.resize(rendered, (crop_bin.shape[1], crop_bin.shape[0]))
        diff = np.mean(np.abs(crop_bin.astype(np.float32) - rendered.astype(np.float32)))
        scored.append((str(font_name), float(diff)))

    scored.sort(key=lambda item: item[1])
    if not scored:
        return {
            "font_name": "Comic Sans MS",
            "confidence": 0.0,
            "sample_text": inferred_text,
            "candidates": [],
        }

    best_name, best_score = scored[0]
    worst = scored[-1][1] if scored[-1][1] > 0 else 1.0
    confidence = max(0.0, min(1.0, 1.0 - (best_score / worst)))

    return {
        "font_name": best_name,
        "confidence": confidence,
        "sample_text": inferred_text,
        "candidates": [
            {"font_name": name, "score": score}
            for name, score in scored[:5]
        ],
    }


def _guess_mime_type(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"GIF87a") or image_bytes.startswith(b"GIF89a"):
        return "image/gif"
    if image_bytes.startswith(b"RIFF") and b"WEBP" in image_bytes[:16]:
        return "image/webp"
    return "image/png"


def _extension_from_mime(mime: str) -> str:
    normalized = str(mime or "").strip().lower()
    if normalized == "image/jpeg":
        return "jpg"
    if normalized == "image/png":
        return "png"
    if normalized == "image/webp":
        return "webp"
    if normalized == "image/gif":
        return "gif"
    return "png"


def _language_label(code: str) -> str:
    normalized = str(code or "").strip().lower()
    mapping = {
        "vi": "Vietnamese",
        "en": "English",
        "ja": "Japanese",
        "ko": "Korean",
        "zh": "Chinese",
        "th": "Thai",
        "id": "Indonesian",
    }
    return mapping.get(normalized, normalized or "target language")


def _normalize_ai_provider(ai_provider: str | None, gemini_cookies: str | None) -> str:
    normalized = str(ai_provider or "").strip().lower()
    if normalized in {
        "gemini",
        "gemini-cookie",
        "gemini_cookies",
        "cookie",
        "cookies",
    }:
        return "gemini-cookie"
    if normalized in {
        "openai",
        "openai-compatible",
        "openai_compatible",
        "compatible",
        "other",
        "custom",
    }:
        return "openai-compatible"

    if str(gemini_cookies or "").strip():
        return "gemini-cookie"
    return "gemini-cookie"


def _normalize_model_name(value: str | None) -> str:
    return str(value or "").strip().lower()


def _resolve_requested_gemini_model(model_override: str | None) -> str:
    requested = str(model_override or os.getenv("GEMINI_WEB_MODEL", _GEMINI_DEFAULT_MODEL)).strip()
    if not requested:
        return _GEMINI_DEFAULT_MODEL

    # Old default kept for backward compatibility, map it to valid Gemini 3 model.
    if _normalize_model_name(requested) == "nano-banana":
        return _GEMINI_DEFAULT_MODEL
    return requested


def _extract_available_gemini_models_from_error(error_message: str) -> list[str]:
    message = str(error_message or "")
    if not message:
        return []

    match = re.search(r"Available\s+models\s*:\s*(.+)", message, flags=re.IGNORECASE)
    if not match:
        return []

    raw_part = match.group(1)
    models: list[str] = []
    for chunk in raw_part.split(","):
        model = chunk.strip()
        if model:
            models.append(model)
    return models


def _choose_fallback_gemini_model(current_model: str, available_models: list[str]) -> str | None:
    current_norm = _normalize_model_name(current_model)

    if available_models:
        available_map = {
            _normalize_model_name(model): model
            for model in available_models
            if str(model or "").strip()
        }
        for preferred in _GEMINI_PREFERRED_MODELS:
            preferred_norm = _normalize_model_name(preferred)
            if preferred_norm in available_map and preferred_norm != current_norm:
                return available_map[preferred_norm]

        for model in available_models:
            if _normalize_model_name(model) != current_norm:
                return model
        return None

    if current_norm != _normalize_model_name(_GEMINI_DEFAULT_MODEL):
        return _GEMINI_DEFAULT_MODEL
    return None


def _is_retryable_gemini_error(error_message: str) -> bool:
    text = str(error_message or "").lower()
    if not text:
        return False
    retry_signals = [
        "silently aborted",
        "stream suspended",
        "failed to parse response body",
        "incomplete frame",
        "timed out",
        "temporary error",
        "connection reset",
        "network",
    ]
    return any(signal in text for signal in retry_signals)


def _normalize_cookie_name(name: str) -> str:
    return str(name or "").strip().lower()


def _parse_cookie_header(raw: str) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for chunk in str(raw or "").split(";"):
        token = chunk.strip()
        if not token or "=" not in token:
            continue
        key, value = token.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            pairs[key] = value
    return pairs


def _extract_gemini_cookie_values(raw: str | None) -> tuple[str, str]:
    source = str(raw or "").strip()
    if not source:
        raise EditorProcessingError("Vui lòng nhập cookie Gemini (__Secure-1PSID)")

    cookie_map: dict[str, str] = {}

    # Support cookie header format: "a=b; __Secure-1PSID=...; __Secure-1PSIDTS=..."
    cookie_map.update(_parse_cookie_header(source))

    # Support JSON formats from cookie export extensions.
    try:
        parsed = json.loads(source)
    except Exception:
        parsed = None

    if isinstance(parsed, dict):
        for key, value in parsed.items():
            if isinstance(value, (str, int, float)):
                cookie_map[str(key)] = str(value)

        nested = parsed.get("cookies")
        if isinstance(nested, list):
            for row in nested:
                if not isinstance(row, dict):
                    continue
                name = str(row.get("name") or row.get("Name") or "").strip()
                value = str(row.get("value") or row.get("Value") or "").strip()
                if name and value:
                    cookie_map[name] = value

    elif isinstance(parsed, list):
        for row in parsed:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or row.get("Name") or "").strip()
            value = str(row.get("value") or row.get("Value") or "").strip()
            if name and value:
                cookie_map[name] = value

    # Last resort regex for pasted raw curl scripts.
    if "__Secure-1PSID" not in cookie_map:
        match_1psid = re.search(r"__Secure-1PSID=([^;\s\"]+)", source, flags=re.IGNORECASE)
        if match_1psid:
            cookie_map["__Secure-1PSID"] = match_1psid.group(1)
    if "__Secure-1PSIDTS" not in cookie_map:
        match_1psidts = re.search(r"__Secure-1PSIDTS=([^;\s\"]+)", source, flags=re.IGNORECASE)
        if match_1psidts:
            cookie_map["__Secure-1PSIDTS"] = match_1psidts.group(1)

    secure_1psid = ""
    secure_1psidts = ""
    for key, value in cookie_map.items():
        normalized = _normalize_cookie_name(key)
        if normalized == "__secure-1psid":
            secure_1psid = str(value or "").strip()
        elif normalized == "__secure-1psidts":
            secure_1psidts = str(value or "").strip()

    if not secure_1psid:
        raise EditorProcessingError("Không tìm thấy __Secure-1PSID trong cookie Gemini bạn nhập")
    return secure_1psid, secure_1psidts


async def _download_curl_image_limited(
    session,
    url: str,
    headers: dict | None = None,
    timeout: float = 30,
    max_bytes: int = 50 * 1024 * 1024,
) -> tuple[bytes, str] | None:
    """Download image from URL using curl_cffi session with size/type validation."""
    try:
        resp = await session.get(
            url,
            headers=headers or {},
            timeout=timeout,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            return None

        data = resp.content
        if not data or len(data) < 100:
            return None
        if len(data) > max_bytes:
            return None

        content_type = _normalize_image_content_type(
            resp.headers.get("content-type")
        )
        if not content_type:
            content_type = _detect_image_content_type(data) or "image/png"

        return data, content_type
    except Exception:
        return None


async def _gemini_edit_manga_page(
    image_bytes: bytes,
    target_language: str,
    gemini_cookies_raw: str | None,
    model_override: str | None = None,
    remove_only: bool = False,
) -> tuple[str, str]:
    """Direct Gemini web API using curl_cffi for browser TLS impersonation."""

    import hashlib
    import random
    import uuid
    import urllib.parse
    import asyncio
    from curl_cffi.requests import AsyncSession

    secure_1psid, secure_1psidts = _extract_gemini_cookie_values(gemini_cookies_raw)
    model = _resolve_requested_gemini_model(model_override)
    proxy = str(os.getenv("GEMINI_WEB_PROXY", "")).strip() or None
    gemini_request_timeout = _env_float("GEMINI_WEB_REQUEST_TIMEOUT_SEC", 180.0, 30.0, 600.0)
    gemini_attempts_per_model = _env_int("GEMINI_WEB_ATTEMPTS_PER_MODEL", 1, 1, 3)
    target_label = _language_label(target_language)

    if remove_only:
        prompt = (
            "Edit this manga page exactly. "
            "Remove all text (dialogue, sound effects, titles, credits) from every speech bubble, text box, and panel. "
            "Fill the erased areas with clean background matching the surrounding area (white for bubbles, appropriate tone for other areas). "
            "Do NOT insert any new text. Keep all bubble frames, panels, character art, and background details completely untouched. "
            "Keep monochrome manga style and original composition."
        )
    else:
        prompt = (
            "Edit this manga page exactly. "
            "Remove all source text only, preserve bubble frames/panels/character anatomy/background details. "
            f"Insert natural {target_label} translation back into corresponding bubbles with good spacing. "
            "Keep monochrome manga style and original composition."
        )

    source_mime = _guess_mime_type(image_bytes)

    # --- build cookies dict for curl_cffi ---
    cookies_dict: dict[str, str] = {"__Secure-1PSID": secure_1psid}
    if secure_1psidts:
        cookies_dict["__Secure-1PSIDTS"] = secure_1psidts
    try:
        extra_cookies = _parse_cookie_header(str(gemini_cookies_raw or ""))
        for ck_name, ck_val in extra_cookies.items():
            if ck_name not in cookies_dict and ck_val:
                cookies_dict[ck_name] = ck_val
    except Exception:
        pass

    gemini_headers = {
        "Origin": "https://gemini.google.com",
        "Referer": "https://gemini.google.com/",
        "X-Same-Domain": "1",
        "x-goog-ext-73010989-jspb": "[0]",
        "x-goog-ext-73010990-jspb": "[0,0,0]",
    }

    async def _fetch_snlm0e_and_bl(session: AsyncSession) -> tuple[str, str, str, str, str | None, str]:
        """Fetch SNlM0e token, bl (build label), f.sid, source-path, and stream RPC ID from Gemini homepage."""
        resp = await session.get(
            "https://gemini.google.com/app",
            headers=gemini_headers,
            allow_redirects=True,
        )
        if resp.status_code >= 400:
            raise EditorProcessingError(
                f"Không truy cập được Gemini web ({resp.status_code}). Cookie có thể đã hết hạn."
            )
        body = resp.text

        snlm0e_match = re.search(r'"SNlM0e":\s*"(.*?)"', body)
        if not snlm0e_match:
            raise EditorProcessingError(
                "Không lấy được token SNlM0e. Cookie Gemini có thể đã hết hạn hoặc tài khoản chưa được bật."
            )
        at_token = snlm0e_match.group(1)

        bl_match = re.search(r'"cfb2h":\s*"(.*?)"', body)
        bl_value = bl_match.group(1) if bl_match else "boq_assistant-bard-web-server_20260408.07_p0"

        # Extract f.sid (FdrFJe session ID) for batchexecute
        sid_match = re.search(r'"FdrFJe":\s*"(\d+)"', body)
        f_sid = sid_match.group(1) if sid_match else ""

        # Extract source-path from page content (conversation URL path)
        source_path_match = re.search(r'"(/app/[a-f0-9]+)"', body)
        source_path = source_path_match.group(1) if source_path_match else "/app"

        # Try to find the RPC ID for StreamGenerate from page JS bundle
        stream_rpc_match = re.search(
            r'\["([A-Za-z0-9_]+)"[^\]]*"StreamGenerate"',
            body,
        )
        stream_rpc_id = stream_rpc_match.group(1) if stream_rpc_match else None

        # Extract page session ID (appears in WIZ data, used in x-goog-ext headers)
        page_sid_match = re.search(r'"([a-f0-9]{16})"', body[body.find('"FdrFJe"'):body.find('"FdrFJe"') + 2000] if '"FdrFJe"' in body else '')
        if not page_sid_match:
            # Generate a random 16-char hex as fallback
            import secrets
            page_session_id = secrets.token_hex(8)
        else:
            page_session_id = page_sid_match.group(1)

        return at_token, bl_value, f_sid, source_path, stream_rpc_id, page_session_id

    async def _upload_image(session: AsyncSession) -> tuple[str, str]:
        """Upload image via resumable protocol to push.clients6.google.com."""
        file_hash = hashlib.md5(image_bytes).hexdigest()[:16]
        source_ext = _extension_from_mime(source_mime)
        filename = f"image_{file_hash}.{source_ext}"
        file_size = len(image_bytes)

        upload_base = "https://push.clients6.google.com/upload/"

        # Step 1: initiate resumable upload
        init_headers = {
            **gemini_headers,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Header-Content-Length": str(file_size),
            "X-Goog-Upload-Header-Content-Type": source_mime,
            "X-Tenant-Id": "bard-storage",
            "Push-ID": "feeds/mcudyrk2a4khkz",
        }
        init_resp = await session.post(
            upload_base,
            headers=init_headers,
            data=f"File name: {filename}",
            allow_redirects=True,
        )
        if init_resp.status_code >= 400:
            raise EditorProcessingError(
                f"Upload init thất bại ({init_resp.status_code}). Cookie có thể đã hết hạn."
            )

        upload_url = init_resp.headers.get("x-goog-upload-url", "").strip()
        if not upload_url:
            raise EditorProcessingError("Không lấy được upload URL từ Google.")

        # Step 2: upload actual image bytes
        data_headers = {
            **gemini_headers,
            "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": "0",
            "X-Tenant-Id": "bard-storage",
            "Push-ID": "feeds/mcudyrk2a4khkz",
        }
        data_resp = await session.post(
            upload_url,
            headers=data_headers,
            data=image_bytes,
            allow_redirects=True,
        )
        if data_resp.status_code >= 400:
            raise EditorProcessingError(f"Upload ảnh thất bại ({data_resp.status_code})")

        upload_ref = data_resp.text.strip()
        if not upload_ref:
            raise EditorProcessingError("Không lấy được tham chiếu ảnh đã upload")

        return upload_ref, filename

    async def _stream_generate(
        session: AsyncSession,
        at_token: str,
        bl_value: str,
        image_ref: str,
        filename: str,
        f_sid: str = "",
        source_path: str = "/app",
        stream_rpc_id: str | None = None,
        page_session_id: str = "",
    ) -> bytes:
        """Call Gemini API (StreamGenerate or batchexecute) and parse the streaming response for generated images."""
        reqid = random.randint(100000, 9999999)

        # Generate a unique request UUID
        request_uuid = str(uuid.uuid4()).upper()

        inner_payload = json.dumps([
            [                                  # [0] message
                prompt,
                0,
                None,
                [
                    [
                        [image_ref, 1, None, source_mime],
                        filename,
                    ]
                ],
                None,
                None,
                0,
            ],
            ["vi"],                             # [1] language
            ["", "", "", None, None, None, None, None, None, ""],  # [2] session info
            None,                              # [3] conversation token (null for new)
            None,                              # [4] response ID hash (null for new)
            None,                              # [5]
            [1],                               # [6] configuration
            1,                                 # [7]
            None,                              # [8]
            None,                              # [9]
            1,                                 # [10]
            0,                                 # [11]
            None,                              # [12]
            None,                              # [13]
            None,                              # [14]
            None,                              # [15]
            None,                              # [16]
            [[0]],                             # [17]
            0,                                 # [18]
            None,                              # [19]
            None,                              # [20]
            None,                              # [21]
            None,                              # [22]
            None,                              # [23]
            None,                              # [24]
            None,                              # [25]
            None,                              # [26]
            1,                                 # [27]
            None,                              # [28]
            None,                              # [29]
            [4],                               # [30]
            None,                              # [31]
            None,                              # [32]
            None,                              # [33]
            None,                              # [34]
            None,                              # [35]
            None,                              # [36]
            None,                              # [37]
            None,                              # [38]
            None,                              # [39]
            None,                              # [40]
            [1],                               # [41]
            None,                              # [42]
            None,                              # [43]
            None,                              # [44]
            None,                              # [45]
            None,                              # [46]
            None,                              # [47]
            None,                              # [48]
            14,                                # [49]
            None,                              # [50]
            None,                              # [51]
            None,                              # [52]
            0,                                 # [53]
            None,                              # [54]
            None,                              # [55]
            None,                              # [56]
            None,                              # [57]
            None,                              # [58]
            request_uuid,                      # [59] unique request UUID
            None,                              # [60]
            [],                                # [61]
            None,                              # [62]
            None,                              # [63]
            None,                              # [64]
            None,                              # [65]
            None,                              # [66]
            0,                                 # [67]
            2,                                 # [68]
            None,                              # [69]
            None,                              # [70]
            None,                              # [71]
            None,                              # [72]
            None,                              # [73]
            None,                              # [74]
            None,                              # [75]
            None,                              # [76]
            None,                              # [77]
            None,                              # [78]
            1,                                 # [79]
            1,                                 # [80]
            None,                              # [81]
            None,                              # [82]
            None,                              # [83]
            None,                              # [84]
            None,                              # [85]
            None,                              # [86]
            None,                              # [87]
            None,                              # [88]
            None,                              # [89]
            None,                              # [90]
            0,                                 # [91]
        ])

        request_headers = {
            **gemini_headers,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1",
            "x-goog-ext-525001261-jspb": json.dumps(
                [1, None, None, None, page_session_id, None, None, 0,
                 [4, 5, 6, 8], None, None, 2, None, None, 1, 1, request_uuid]
            ),
            "x-goog-ext-525005358-jspb": json.dumps([request_uuid, 1]),
        }

        # Build common URL query params
        sid_param = f"&f.sid={urllib.parse.quote(f_sid)}" if f_sid else ""

        resp = None

        # Strategy 1: Try StreamGenerate direct endpoint first
        stream_url = (
            f"https://gemini.google.com/_/BardChatUi/data/"
            f"assistant.lamda.BardFrontendService/StreamGenerate"
            f"?bl={urllib.parse.quote(bl_value)}"
            f"{sid_param}"
            f"&hl=vi&_reqid={reqid}&rt=c"
        )
        stream_data = f"f.req={urllib.parse.quote(json.dumps([None, inner_payload]))}&at={urllib.parse.quote(at_token)}&"

        try:
            resp = await session.post(
                stream_url,
                headers=request_headers,
                data=stream_data,
                timeout=gemini_request_timeout,
            )
            if resp.status_code in (404, 405, 501):
                resp = None  # Endpoint not available, try batchexecute
        except Exception:
            resp = None

        # Strategy 2: Fallback to batchexecute RPC wrapper
        if resp is None or resp.status_code >= 400:
            rpc_id = stream_rpc_id or "StreamGenerate"
            batch_payload = json.dumps([[[rpc_id, inner_payload, None, "generic"]]])
            batch_data = f"f.req={urllib.parse.quote(batch_payload)}&at={urllib.parse.quote(at_token)}&"
            batch_url = (
                f"https://gemini.google.com/_/BardChatUi/data/batchexecute"
                f"?rpcids={urllib.parse.quote(rpc_id)}"
                f"&source-path={urllib.parse.quote(source_path)}"
                f"&bl={urllib.parse.quote(bl_value)}"
                f"{sid_param}"
                f"&hl=vi&_reqid={reqid}&rt=c"
            )
            resp = await session.post(
                batch_url,
                headers=request_headers,
                data=batch_data,
                timeout=gemini_request_timeout,
            )

        if resp.status_code >= 400:
            raise EditorProcessingError(
                f"Gemini API thất bại ({resp.status_code}): {resp.text[:300]}"
            )

        response_text = resp.text
        image_entries: list[tuple[str, str, str]] = []  

        
        import logging
        logger = logging.getLogger("gemini_editor")
        logger.info(f"StreamGenerate response: {len(response_text)} chars")

      
        entry_pattern = re.compile(
            r'\[null,1,'
            r'"([^"]+)",'
            r'"(https://lh3\.googleusercontent\.com/[^"\\]+)"'
            r'.*?"(image/(?:png|jpeg|webp))"',
            re.DOTALL,
        )
        for m in entry_pattern.finditer(response_text):
            fname, url, mime = m.group(1), m.group(2), m.group(3)
            image_entries.append((url, mime, fname))

       
        if not image_entries:
            all_lh3_urls = re.findall(
                r'https://lh3\.googleusercontent\.com/[A-Za-z0-9_\-/+=.?&%]+',
                response_text,
            )
            for url in all_lh3_urls:
                url = url.rstrip('\\').rstrip('"').rstrip("'")
                if len(url) > 60:  # real URLs are long
                    image_entries.append((url, "unknown", ""))

       
        if not image_entries:
            d_urls = re.findall(
                r'https://[a-z0-9.]*googleusercontent\.com/d/[A-Za-z0-9_\-/+=.?&%]+',
                response_text,
            )
            for url in d_urls:
                url = url.rstrip('\\').rstrip('"')
                if len(url) > 40:
                    image_entries.append((url, "unknown", ""))

       
        if not image_entries:
            google_img_urls = re.findall(
                r'https://[a-z0-9.\-]+google[a-z]*\.com/[^"\\,\s\]]{30,}',
                response_text,
            )
            for url in google_img_urls:
                if any(kw in url for kw in ["/gg-dl/", "/image", "/photo", "/d/"]):
                    image_entries.append((url.rstrip('\\'), "unknown", ""))

       
        seen_urls: set[str] = set()
        unique_entries: list[tuple[str, str, str]] = []
        for entry in image_entries:
            clean_url = entry[0].split("\\")[0]  # remove escape sequences
            if clean_url not in seen_urls and len(clean_url) > 40:
                seen_urls.add(clean_url)
                unique_entries.append((clean_url, entry[1], entry[2]))

        
        unique_entries.sort(key=lambda e: (0 if "png" in e[1] else 1, e[2]))

        logger.info(f"Found {len(unique_entries)} image URLs in response")

        if not unique_entries:
            
            snippet = response_text[:500].replace("\n", " ")
            logger.warning(f"No image URLs in initial response. Response snippet: {snippet}")
            if "SNlM0e" in response_text or "login" in response_text.lower():
                raise EditorProcessingError(
                    "Gemini yêu cầu đăng nhập lại. Cookie có thể đã hết hạn."
                )

            # ----- Polling: StreamGenerate returned only status, poll for image -----
            # Extract conv_id and resp_id from the initial response
            poll_conv = re.search(r'"(c_[a-f0-9]{12,})"', response_text)
            poll_resp = re.search(r'"(r_[a-f0-9]{12,})"', response_text)

            if not poll_conv or not poll_resp:
                raise EditorProcessingError(
                    "Gemini không trả ảnh kết quả và không có conversation ID để poll. Hãy kiểm tra cookie."
                )

            poll_conv_id = poll_conv.group(1)
            poll_resp_id = poll_resp.group(1)
            poll_source_path = f"/app/{poll_conv_id[2:]}"  # strip "c_" prefix

            logger.info(f"Image generation async: conv={poll_conv_id}, resp={poll_resp_id}. Starting poll...")

            import time as _time
            poll_start = _time.monotonic()
            poll_max_seconds = min(gemini_request_timeout - 30, 150)  # leave 30s margin
            poll_interval = 3  # seconds between polls
            poll_reqid = reqid + 200000

            while _time.monotonic() - poll_start < poll_max_seconds:
                await asyncio.sleep(poll_interval)
                poll_reqid += 100000

                # Poll with PCck7e (check if response is ready)
                pcck7e_inner = json.dumps([poll_resp_id])
                pcck7e_batch = json.dumps([[["PCck7e", pcck7e_inner, None, "generic"]]])
                pcck7e_data = f"f.req={urllib.parse.quote(pcck7e_batch)}&at={urllib.parse.quote(at_token)}&"
                pcck7e_url = (
                    f"https://gemini.google.com/_/BardChatUi/data/batchexecute"
                    f"?rpcids=PCck7e"
                    f"&source-path={urllib.parse.quote(poll_source_path)}"
                    f"&bl={urllib.parse.quote(bl_value)}"
                    f"{sid_param}"
                    f"&hl=vi&_reqid={poll_reqid}&rt=c"
                )
                try:
                    pcck_resp = await session.post(
                        pcck7e_url,
                        headers=request_headers,
                        data=pcck7e_data,
                        timeout=30,
                    )
                    pcck_text = pcck_resp.text
                    # Check if image URLs or generation content appeared
                    if "lh3.googleusercontent.com" in pcck_text or "image_generation_content" in pcck_text:
                        response_text = pcck_text
                        logger.info("Got image data from PCck7e poll")
                        break
                except Exception as poll_err:
                    logger.debug(f"PCck7e poll error: {poll_err}")

                # Also try VxUbXb (conversation update subscription)
                poll_reqid += 100000
                vxubxb_inner = json.dumps([])
                vxubxb_batch = json.dumps([[["VxUbXb", vxubxb_inner, None, "generic"]]])
                vxubxb_data = f"f.req={urllib.parse.quote(vxubxb_batch)}&at={urllib.parse.quote(at_token)}&"
                vxubxb_url = (
                    f"https://gemini.google.com/_/BardChatUi/data/batchexecute"
                    f"?rpcids=VxUbXb"
                    f"&source-path={urllib.parse.quote(poll_source_path)}"
                    f"&bl={urllib.parse.quote(bl_value)}"
                    f"{sid_param}"
                    f"&hl=vi&_reqid={poll_reqid}&rt=c"
                )
                try:
                    vx_resp = await session.post(
                        vxubxb_url,
                        headers=request_headers,
                        data=vxubxb_data,
                        timeout=30,
                    )
                    vx_text = vx_resp.text
                    if "lh3.googleusercontent.com" in vx_text or "image_generation_content" in vx_text:
                        response_text = vx_text
                        logger.info("Got image data from VxUbXb poll")
                        break
                except Exception as poll_err:
                    logger.debug(f"VxUbXb poll error: {poll_err}")

                elapsed = int(_time.monotonic() - poll_start)
                logger.info(f"Polling for image... {elapsed}s elapsed")

            # Re-parse after polling
            for m in entry_pattern.finditer(response_text):
                fname, url, mime = m.group(1), m.group(2), m.group(3)
                unique_entries.append((url, mime, fname))

            if not unique_entries:
                all_lh3_urls = re.findall(
                    r'https://lh3\.googleusercontent\.com/[A-Za-z0-9_\-/+=.?&%]+',
                    response_text,
                )
                for url in all_lh3_urls:
                    url = url.rstrip('\\').rstrip('"').rstrip("'")
                    if len(url) > 60:
                        unique_entries.append((url, "image/png", "polled"))

            # Also check for escaped URLs in batchexecute double-serialized responses
            if not unique_entries:
                escaped_urls = re.findall(
                    r'https://lh3\\.googleusercontent\\.com/[A-Za-z0-9_\-/+=.?&%]+',
                    response_text,
                )
                for url in escaped_urls:
                    clean = url.replace('\\', '')
                    if len(clean) > 60:
                        unique_entries.append((clean, "image/png", "polled_escaped"))

            if not unique_entries:
                raise EditorProcessingError(
                    "Gemini không trả ảnh kết quả. Hãy kiểm tra cookie còn hạn hoặc thử lại."
                )

       
        full_quality_url: str | None = None
        try:
            # Extract image download token (starts with $)
            token_match = re.search(
                r'"\$([A-Za-z0-9_/+=\-]{20,}={0,2})"',
                response_text,
            )
            if not token_match:
                token_match = re.search(
                    r'\\"\$([A-Za-z0-9_/+=\-]{20,}={0,2})\\"',
                    response_text,
                )

            # Extract conversation/response/candidate IDs
            conv_match = re.search(r'"(c_[a-f0-9]{12,})"', response_text)
            resp_match = re.search(r'"(r_[a-f0-9]{12,})"', response_text)
            cand_match = re.search(r'"(rc_[a-f0-9]{12,})"', response_text)

            if token_match:
                img_token = "$" + token_match.group(1)
                conv_id = conv_match.group(1) if conv_match else ""
                resp_id = resp_match.group(1) if resp_match else ""
                cand_id = cand_match.group(1) if cand_match else ""

                # Build c8o8Fe request payload
                c8o8fe_inner = json.dumps([
                    [
                        None, None, None,
                        [None, None, None, None, None, img_token],
                    ],
                    ["http://googleusercontent.com/image_generation_content/0", 0],
                    None,
                    [20, None],
                    [resp_id, cand_id, conv_id, None, None],
                    1, 0, 1,
                ])
                c8o8fe_payload = urllib.parse.quote(
                    json.dumps([[["c8o8Fe", c8o8fe_inner, None, "generic"]]])
                )
                c8o8fe_data = f"f.req={c8o8fe_payload}&at={urllib.parse.quote(at_token)}&"

                c8o8fe_url = (
                    f"https://gemini.google.com/_/BardChatUi/data/batchexecute"
                    f"?rpcids=c8o8Fe"
                    f"&bl={urllib.parse.quote(bl_value)}"
                    f"&hl=vi&_reqid={reqid + 100000}&rt=c"
                )

                dl_resp = await session.post(
                    c8o8fe_url,
                    headers={
                        **gemini_headers,
                        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    },
                    data=c8o8fe_data,
                    timeout=30,
                )
                if dl_resp.status_code < 400:
                    dl_text = dl_resp.text
                    fq_match = re.search(
                        r'https://lh3\.googleusercontent\.com/[A-Za-z0-9_\-/+=.?&%]+',
                        dl_text,
                    )
                    if fq_match:
                        full_quality_url = fq_match.group(0).rstrip('\\').rstrip('"')
                        logger.info(f"Got full-quality URL from c8o8Fe")
        except Exception as e:
            logger.debug(f"c8o8Fe failed (non-critical): {e}")

        # Helper: ensure URL requests max resolution
        def _full_res_url(url: str) -> str:
            """Append =s0 to Google image URL for original/full resolution."""
            if "?" in url or url.endswith("=s0"):
                return url
            return url + "=s0"

        # Build final download list: full-quality URL first, then StreamGenerate URLs
        download_urls: list[tuple[str, str, str]] = []
        if full_quality_url:
            download_urls.append((_full_res_url(full_quality_url), "image/png", "full_quality"))
            download_urls.append((full_quality_url, "image/png", "full_quality_raw"))
        for img_url, mime, fname in unique_entries:
            download_urls.append((_full_res_url(img_url), mime, fname))
            # Also try without =s0 as fallback (for signed /gg-dl/ URLs)
            download_urls.append((img_url, mime, fname + "_raw"))

        # Download images – try full quality first, then PNG
        # Use simple headers for image CDN (Origin/Referer from Gemini may be rejected)
        img_download_headers = {
            "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        }
        downloaded: list[tuple[bytes, str]] = []
        for img_url, mime, _fname in download_urls[:6]:  # Try up to 6 URLs
            try:
                logger.info(f"Downloading image: {img_url[:100]}... tag={_fname}")
                downloaded_image = await _download_curl_image_limited(
                    session,
                    img_url,
                    headers=img_download_headers,
                    timeout=30,
                )
                if downloaded_image:
                    image_data, detected_mime = downloaded_image
                    downloaded.append((image_data, detected_mime or mime))
                    logger.info(f"Downloaded image: {len(image_data)} bytes, tag={_fname}")
                    # If this is from c8o8Fe (first entry) or PNG, use it immediately
                    if _fname == "full_quality" or "png" in (detected_mime or mime):
                        return downloaded[-1][0]
                else:
                    logger.warning(f"Download returned None for tag={_fname}")
            except Exception as dl_err:
                logger.warning(f"Download failed for tag={_fname}: {dl_err}")
                continue

        if downloaded:
            downloaded.sort(key=lambda d: len(d[0]), reverse=True)
            return downloaded[0][0]

        raise EditorProcessingError(
            "Không tải được ảnh kết quả từ Gemini. Hãy thử lại."
        )

    # --- Main execution with retry logic ---
    edited_bytes = b""
    last_error: Exception | None = None

    model_candidates: list[str] = []
    seen_model_names: set[str] = set()

    def push_candidate(candidate: str | None, front: bool = False) -> None:
        normalized = _normalize_model_name(candidate)
        if not normalized or normalized in seen_model_names:
            return
        seen_model_names.add(normalized)
        if front:
            model_candidates.insert(0, str(candidate).strip())
        else:
            model_candidates.append(str(candidate).strip())

    push_candidate(model)
    push_candidate(_GEMINI_DEFAULT_MODEL)
    for preferred_model in _GEMINI_PREFERRED_MODELS:
        push_candidate(preferred_model)

    try:
        async with AsyncSession(
            impersonate="chrome",
            timeout=gemini_request_timeout,
            proxies={"https": proxy, "http": proxy} if proxy else None,
        ) as session:
            # Set cookies on the session
            for ck_name, ck_val in cookies_dict.items():
                session.cookies.set(ck_name, ck_val, domain=".google.com")

            # Step 1: Get auth token
            at_token, bl_value, f_sid, source_path, stream_rpc_id, page_session_id = await _fetch_snlm0e_and_bl(session)

            # Step 2: Upload image
            image_ref, filename = await _upload_image(session)

            # Step 3: Generate with retry
            max_attempts = gemini_attempts_per_model
            for attempt in range(max_attempts):
                try:
                    edited_bytes = await _stream_generate(
                        session, at_token, bl_value, image_ref, filename,
                        f_sid=f_sid, source_path=source_path,
                        stream_rpc_id=stream_rpc_id,
                        page_session_id=page_session_id,
                    )
                    break
                except Exception as error:
                    last_error = error
                    error_message = str(error)

                    should_retry = _is_retryable_gemini_error(error_message)
                    if should_retry and attempt + 1 < max_attempts:
                        await asyncio.sleep(2 + attempt * 2)
                        continue
                    break

        if not edited_bytes:
            if last_error is None:
                raise EditorProcessingError("Gemini web xử lý thất bại: không có kết quả")
            raise EditorProcessingError(f"Gemini web xử lý thất bại: {last_error}")
    except EditorProcessingError:
        raise
    except Exception as error:
        raise EditorProcessingError(f"Gemini web xử lý thất bại: {error}") from error

    edited_mime = _guess_mime_type(edited_bytes)
    edited_b64 = base64.b64encode(edited_bytes).decode("ascii")
    return f"data:{edited_mime};base64,{edited_b64}", model


def _extract_openai_image_output(response: Any) -> tuple[str, str]:
    payload: Any = None
    if isinstance(response, dict):
        payload = response
    else:
        model_dump = getattr(response, "model_dump", None)
        if callable(model_dump):
            try:
                payload = model_dump()
            except Exception:
                payload = None

        if payload is None:
            data_attr = getattr(response, "data", None)
            if data_attr is not None:
                payload = {"data": data_attr}

    data_rows = (payload or {}).get("data") if isinstance(payload, dict) else None
    if not isinstance(data_rows, list):
        return "", ""

    for row in data_rows:
        if isinstance(row, dict):
            b64_value = str(row.get("b64_json") or row.get("b64") or "").strip()
            url_value = str(row.get("url") or "").strip()
        else:
            b64_value = str(getattr(row, "b64_json", "") or getattr(row, "b64", "") or "").strip()
            url_value = str(getattr(row, "url", "") or "").strip()

        if b64_value:
            return b64_value, ""
        if url_value:
            return "", url_value

    return "", ""


async def _openai_edit_manga_page(
    image_bytes: bytes,
    target_language: str,
    api_key_raw: str | None,
    model_raw: str | None,
    base_url_raw: str | None,
) -> tuple[str, str]:
    if AsyncOpenAI is None:
        raise EditorProcessingError(
            "Thiếu package openai. Hãy cài dependencies backend để dùng chuẩn OpenAI SDK."
        )

    api_key = str(api_key_raw or os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise EditorProcessingError("Thiếu API key cho provider chuẩn OpenAI")

    model = str(model_raw or os.getenv("OPENAI_IMAGE_MODEL") or "gpt-image-1").strip() or "gpt-image-1"
    base_url = str(base_url_raw or os.getenv("OPENAI_BASE_URL") or "").strip()
    openai_request_timeout = _env_float("OPENAI_IMAGE_TIMEOUT_SEC", 420.0, 30.0, 1800.0)
    openai_download_timeout = _env_float("OPENAI_IMAGE_DOWNLOAD_TIMEOUT_SEC", 300.0, 30.0, 1800.0)

    client_kwargs: dict[str, Any] = {
        "api_key": api_key,
        "timeout": openai_request_timeout,
    }
    if base_url:
        client_kwargs["base_url"] = base_url.rstrip("/")

    client = AsyncOpenAI(**client_kwargs)
    target_label = _language_label(target_language)
    prompt = (
        "Edit this manga page exactly. "
        "Remove all source text only, preserve bubble frames/panels/character anatomy/background details. "
        f"Insert natural {target_label} translation back into corresponding bubbles with good spacing. "
        "Keep monochrome manga style and original composition."
    )

    source_mime = _guess_mime_type(image_bytes)
    source_ext = _extension_from_mime(source_mime)
    tmp_dir = Path(tempfile.mkdtemp(prefix="openai-image-edit-"))
    input_path = tmp_dir / f"source.{source_ext}"
    input_path.write_bytes(image_bytes)

    edited_bytes = b""
    try:
        with input_path.open("rb") as image_file:
            response = await client.images.edit(
                model=model,
                image=image_file,
                prompt=prompt,
            )

        b64_output, url_output = _extract_openai_image_output(response)
        if b64_output:
            try:
                edited_bytes = base64.b64decode(b64_output)
            except Exception as error:
                raise EditorProcessingError(f"Không giải mã được ảnh OpenAI trả về: {error}") from error
        elif url_output:
            async with httpx.AsyncClient(timeout=openai_download_timeout) as http_client:
                download = await http_client.get(url_output)
            if download.status_code >= 400:
                raise EditorProcessingError(
                    f"Không tải được ảnh kết quả từ provider chuẩn OpenAI ({download.status_code})"
                )
            edited_bytes = bytes(download.content or b"")

        if not edited_bytes:
            raise EditorProcessingError("Provider chuẩn OpenAI không trả về ảnh kết quả")
    except EditorProcessingError:
        raise
    except Exception as error:
        raise EditorProcessingError(f"OpenAI-compatible xử lý thất bại: {error}") from error
    finally:
        close_fn = getattr(client, "close", None)
        if callable(close_fn):
            try:
                close_result = close_fn()
                if hasattr(close_result, "__await__"):
                    await close_result
            except Exception:
                pass
        shutil.rmtree(tmp_dir, ignore_errors=True)

    edited_mime = _guess_mime_type(edited_bytes)
    edited_b64 = base64.b64encode(edited_bytes).decode("ascii")
    return f"data:{edited_mime};base64,{edited_b64}", model


def inpaint_with_regions(image_bytes: bytes, regions_json: str) -> dict[str, Any]:
    image_bgr = _decode_image(image_bytes)
    h, w = image_bgr.shape[:2]
    raw_regions = _parse_json_list(regions_json, "regions")
    regions = []
    for row in raw_regions:
        parsed = _sanitize_region(row, w, h)
        if parsed:
            regions.append(parsed)

    raw_mask = np.zeros((h, w), dtype=np.uint8)
    span_values: list[int] = []
    for region in regions:
        x = int(region["x"])
        y = int(region["y"])
        rw = int(region["w"])
        rh = int(region["h"])
        x2 = min(w - 1, x + rw)
        y2 = min(h - 1, y + rh)
        cv2.rectangle(raw_mask, (x, y), (x2, y2), 255, thickness=-1)
        span_values.append(max(2, min(rw, rh)))

    if span_values:
        expand_size = _ensure_odd(max(3, int(np.median(span_values) * 0.08)), minimum=3, maximum=11)
        raw_mask = cv2.dilate(
            raw_mask,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (expand_size, expand_size)),
            iterations=1,
        )

    result, final_mask, inpaint_radius, solver_name, acceleration = _inpaint_from_mask(
        image_bgr=image_bgr,
        raw_mask=raw_mask,
        respect_user_regions=True,
    )
    final_coverage = float(cv2.countNonZero(final_mask)) / float(max(1, h * w))
    return {
        "image_data_url": _to_data_url(result),
        "regions": regions,
        "count": len(regions),
        "mask_coverage": final_coverage,
        "inpaint_radius": inpaint_radius,
        "solver": solver_name,
        "acceleration": acceleration,
    }


def inpaint_all_text(image_bytes: bytes) -> dict[str, Any]:
    image_bgr = _decode_image(image_bytes)
    h, w = image_bgr.shape[:2]
    image_area = float(max(1, h * w))
    detected = detect_text_regions(image_bgr)

    regions: list[dict[str, int]] = []
    for row in detected:
        parsed = _sanitize_region(row, w, h)
        if parsed:
            regions.append(parsed)

    regions = _merge_regions(regions)
    # Manga title blocks can be large — allow up to 8% of image area per region
    # and up to 18% total coverage for text-heavy pages
    regions = _filter_detected_regions(regions, w, h, max_area_ratio=0.08)
    regions = _limit_regions_by_coverage(image_bgr.shape, regions, max_coverage=0.18, max_regions=90)

    region_coverage = _compute_mask_coverage(image_bgr.shape, regions)

    ocr_mask = _detect_ocr_guided_text_mask(image_bgr)
    ocr_coverage = float(cv2.countNonZero(ocr_mask)) / image_area

    if ocr_coverage >= 0.006:
        combined_mask = ocr_mask
        if regions:
            region_mask = _build_mask(image_bgr.shape, regions, pad_ratio=0.05)
            guided_region_mask = cv2.bitwise_and(
                region_mask,
                cv2.dilate(
                    ocr_mask,
                    cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)),
                    iterations=1,
                ),
            )
            combined_mask = cv2.bitwise_or(ocr_mask, guided_region_mask)

        result, final_mask, _inpaint_radius, _solver_name, _acceleration = _inpaint_from_mask(
            image_bgr=image_bgr,
            raw_mask=combined_mask,
            respect_user_regions=False,
        )
        final_coverage = float(cv2.countNonZero(final_mask)) / image_area
        return {
            "image_data_url": _to_data_url(result),
            "regions": regions,
            "detected": len(regions),
            "mask_coverage": final_coverage,
            "region_coverage": region_coverage,
            "ocr_mask_coverage": ocr_coverage,
            "mask_mode": "ocr-guided",
        }

    result = _inpaint(image_bgr, regions, respect_user_regions=False)
    return {
        "image_data_url": _to_data_url(result),
        "regions": regions,
        "detected": len(regions),
        "mask_coverage": region_coverage,
        "region_coverage": region_coverage,
        "ocr_mask_coverage": ocr_coverage,
        "mask_mode": "region",
    }


def inpaint_with_brush(
    image_bytes: bytes,
    mask_data_url: str,
    brush_radius: int | float | None = None,
    mask_width: int | float | None = None,
    mask_height: int | float | None = None,
) -> dict[str, Any]:
    image_bgr = _decode_image(image_bytes)
    image_h, image_w = image_bgr.shape[:2]

    mask = _decode_mask_data_url(mask_data_url)

    # Frontend paints on displayed size, backend inpaints on original size.
    # Resize mask to source image dimensions so brush deletion maps correctly.
    if mask.shape[1] != image_w or mask.shape[0] != image_h:
        mask = cv2.resize(mask, (image_w, image_h), interpolation=cv2.INTER_NEAREST)
        _, mask = cv2.threshold(mask, 10, 255, cv2.THRESH_BINARY)

    safe_brush = int(float(brush_radius if brush_radius is not None else 14))
    safe_brush = max(2, min(72, safe_brush))

    if safe_brush > 2:
        kernel_size = _ensure_odd(max(3, int(safe_brush * 0.72)), minimum=3, maximum=41)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
        mask = cv2.dilate(mask, kernel, iterations=1)

    clean_size = _ensure_odd(max(3, int(safe_brush * 0.28)), minimum=3, maximum=13)
    clean_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (clean_size, clean_size))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, clean_kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1)
    if safe_brush >= 6:
        blurred = cv2.GaussianBlur(mask, (0, 0), sigmaX=max(0.8, safe_brush * 0.06), sigmaY=max(0.8, safe_brush * 0.06))
        _, mask = cv2.threshold(blurred, 96, 255, cv2.THRESH_BINARY)

    masked_pixels = int(cv2.countNonZero(mask))
    if masked_pixels <= 0:
        raise EditorProcessingError("Chưa có vùng tô để xóa raw")

    is_manga = _is_manga_style(image_bgr)
    is_color_heavy = float(np.mean(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)[:, :, 1])) >= 42.0

    approx_radius = max(3, min(22, int(safe_brush * 0.70)))
    result, final_mask, inpaint_radius, solver_name, acceleration = _inpaint_from_mask(
        image_bgr=image_bgr,
        raw_mask=mask,
        respect_user_regions=True,
    )
    # Keep brush responsiveness: if estimated brush radius is much larger than auto radius,
    # run a second focused pass to better clear thick strokes.
    if approx_radius >= inpaint_radius + 3:
        pass_img, pass_solver, pass_acc = _hybrid_inpaint(
            image_bgr=result,
            mask=final_mask,
            base_radius=approx_radius,
            is_manga=is_manga,
            is_color_heavy=is_color_heavy,
            prefer_smooth=True,
        )
        result = _composite_inpaint_result(
            result,
            pass_img,
            final_mask,
            feather_sigma=max(0.9, approx_radius * 0.24),
            hard_fill_core=True,
        )
        solver_name = f"{solver_name}+{pass_solver}"
        acceleration = pass_acc if pass_acc else acceleration
        inpaint_radius = max(inpaint_radius, approx_radius)

    masked_pixels = int(cv2.countNonZero(final_mask))

    return {
        "image_data_url": _to_data_url(result),
        "masked_pixels": masked_pixels,
        "brush_radius": safe_brush,
        "inpaint_radius": inpaint_radius,
        "manga_style": is_manga,
        "solver": solver_name,
        "acceleration": acceleration,
        "mask_size": {
            "width": int(float(mask_width or mask.shape[1])),
            "height": int(float(mask_height or mask.shape[0])),
        },
    }


def add_text_overlays(image_bytes: bytes, overlays_json: str) -> dict[str, Any]:
    image_bgr = _decode_image(image_bytes)
    overlays = _parse_json_list(overlays_json, "overlays")
    result = _render_text_overlays(image_bgr, overlays)
    return {
        "image_data_url": _to_data_url(result),
        "overlays": overlays,
        "count": len(overlays),
    }


def detect_font(image_bytes: bytes, region_json: str, sample_text: str | None = None) -> dict[str, Any]:
    image_bgr = _decode_image(image_bytes)
    region = _parse_json_dict(region_json, "region")
    return detect_font_for_region(image_bgr, region, sample_text=sample_text)


async def ai_translate_redraw(
    image_bytes: bytes,
    target_language: str,
    font_name: str,
    regions_json: str | None = None,
    gemini_cookies: str | None = None,
    ai_provider: str | None = None,
    ai_model: str | None = None,
    ai_api_key: str | None = None,
    ai_base_url: str | None = None,
    mode: str | None = None,
) -> dict[str, Any]:
    normalized_language = str(target_language or "vi").strip().lower() or "vi"
    normalized_mode = str(mode or "translate").strip().lower()
    is_remove_only = normalized_mode == "remove_only"

    provider_mode = _normalize_ai_provider(ai_provider, gemini_cookies)
    provider_name = "gemini"
    response_mode = "gemini-web-cookie"

    if provider_mode == "openai-compatible":
        edited_data_url, used_model = await _openai_edit_manga_page(
            image_bytes=image_bytes,
            target_language="" if is_remove_only else normalized_language,
            api_key_raw=ai_api_key,
            model_raw=ai_model,
            base_url_raw=ai_base_url,
        )
        provider_name = "openai-compatible"
        response_mode = "openai-sdk"
    else:
        edited_data_url, used_model = await _gemini_edit_manga_page(
            image_bytes=image_bytes,
            target_language="" if is_remove_only else normalized_language,
            gemini_cookies_raw=gemini_cookies,
            model_override=ai_model,
            remove_only=is_remove_only,
        )

    return {
        "image_data_url": edited_data_url,
        "regions": [],
        "translations": [],
        "font_name": font_name,
        "provider": provider_name,
        "model": used_model,
        "target_language": normalized_language,
        "mode": "remove_only" if is_remove_only else response_mode,
    }
