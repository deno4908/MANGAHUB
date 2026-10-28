"""Standalone protected Moe renderer, for hosts that can run Chromium."""
from fastapi import FastAPI
from moetruyen_api.api import create_app
from moetruyen_api.config import Settings

settings = Settings(_env_file=None)
if len(settings.api_key.get_secret_value()) < 32:
    raise RuntimeError("Set MOE_API_KEY to a random secret of at least 32 characters.")

source_app = create_app(settings)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None,
              lifespan=source_app.router.lifespan_context)


@app.get('/health')
def health():
    return {'status': 'ok', 'service': 'moe-reader'}


app.mount('/', source_app)
