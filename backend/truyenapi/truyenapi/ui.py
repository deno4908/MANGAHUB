from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def install_web(app: FastAPI):
    directory = Path(__file__).parent / "web"
    app.mount("/docs/assets", StaticFiles(directory=directory / "assets"), name="docs_assets")

    @app.get("/docs", include_in_schema=False)
    def docs_portal():
        return FileResponse(directory / "index.html", headers={
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'",
        })
