from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException

from fastapi_app.main import sanitized_http_exception_handler
from fastapi_app.services import truyenqq_service as qq


def test_blocked_qq_keeps_recovery_hints_in_a_proxy_safe_response(monkeypatch):
    request = httpx.Request("GET", "https://truyenqqko.com/doc-truyen")
    response = httpx.Response(403, request=request, headers={"x-truyenqq-block": "challenge"},
                              extensions={"truyenqq_transport": "edge-source"})
    def genres():
        raise httpx.HTTPStatusError("private source response", request=request, response=response)
    monkeypatch.setattr(qq, "get_live", lambda: SimpleNamespace(genres=genres))
    monkeypatch.setattr(qq, "cache", SimpleNamespace(get=lambda *a: None))
    app = FastAPI()
    app.add_exception_handler(HTTPException, sanitized_http_exception_handler)
    app.get("/categories")(qq.get_categories)
    with TestClient(app) as client:
        result = client.get("/categories")
    assert result.status_code == 503
    assert result.headers["X-TruyenQQ-Error"] == "http-403"
    assert result.headers["X-TruyenQQ-Source-Path"] == "/doc-truyen"
    assert result.headers["X-TruyenQQ-Block"] == "challenge"
    assert result.json().get("detail")
    assert "private source response" not in result.text
