from unittest.mock import Mock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config import config
from fastapi_app.dependencies import require_uploader
from fastapi_app.routers import editor
from fastapi_app.services import image_editor_service as service


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(config, "OCR_ENABLED", False)
    app = FastAPI()
    app.include_router(editor.router, prefix="/api/editor")
    app.dependency_overrides[require_uploader] = lambda: {"id": "uploader"}
    return TestClient(app)


def test_disabled_ocr_never_imports_models(monkeypatch):
    monkeypatch.setattr(config, "OCR_ENABLED", False)
    with patch.object(service.importlib, "import_module") as load:
        assert service._load_ocr_dependencies() is False
        assert service.ocr_available() is False
        assert service._get_easyocr_reader() is None
        assert service._get_ocr_reader_for_languages(["ja", "en"]) is None
        load.assert_not_called()


@pytest.mark.parametrize("path,data", [
    ("ocr-region", {}), ("inpaint", {"mode": "all"}),
])
def test_disabled_endpoints_reject_before_image_processing(client, monkeypatch, path, data):
    read = Mock(side_effect=AssertionError("Image must not be processed"))
    monkeypatch.setattr(editor, "_read_editor_image", read)
    response = client.post("/api/editor/" + path, data=data,
                           files={"image": ("page.png", b"not-an-image", "image/png")})
    assert response.status_code == 503
    assert "tạm khóa" in response.json()["detail"]
    read.assert_not_called()


def test_fonts_and_manual_editing_remain_available(client, monkeypatch):
    monkeypatch.setattr(service, "list_available_fonts", lambda: [{"name": "Arial"}])
    assert client.get("/api/editor/fonts").json() == {"fonts": [{"name": "Arial"}], "ocr_enabled": False}

    async def read_image(_image):
        return b"validated-image"

    monkeypatch.setattr(editor, "_read_editor_image", read_image)
    process = Mock(return_value={"image_data_url": "data:image/png;base64,example"})
    monkeypatch.setattr(service, "inpaint_with_regions", process)
    result = client.post("/api/editor/inpaint", data={"mode": "region", "regions": "[]"},
                         files={"image": ("page.png", b"image", "image/png")})
    assert result.status_code == 200
    process.assert_called_once_with(b"validated-image", "[]")


def test_service_cannot_bypass_disabled_ocr(monkeypatch):
    monkeypatch.setattr(config, "OCR_ENABLED", False)
    for operation in (lambda: service.ocr_extract_text(b"invalid", "{}"),
                      lambda: service.inpaint_all_text(b"invalid")):
        with pytest.raises(service.EditorProcessingError, match="tạm khóa"):
            operation()
