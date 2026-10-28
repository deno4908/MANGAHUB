from pathlib import Path

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def install_web(app):
    directory = Path(__file__).parent / "web"
    app.mount("/docs/assets", StaticFiles(directory=directory / "assets"), name="docs_assets")

    @app.get("/docs", include_in_schema=False)
    def portal():
        return FileResponse(directory / "index.html", headers={
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
        })
