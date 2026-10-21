from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TRUYEN_", env_file=".env", extra="ignore")
    base_url: str = "https://truyenqqko.com"
    request_delay: float = Field(default=0.2, ge=0)
    timeout: float = Field(default=20, gt=0)
    connect_timeout: float = Field(default=5, gt=0)
    max_connections: int = Field(default=16, ge=1)
    keepalive_expiry: float = Field(default=60, gt=0)
    http2: bool = True
    retries: int = Field(default=2, ge=1, le=5)
    cache_ttl: float = Field(default=60, ge=0)
    catalog_ttl: float = Field(default=600, ge=0)
    latest_ttl: float = Field(default=15, ge=0)
    html_cache_entries: int = Field(default=32, ge=1)
    image_cache_bytes: int = Field(default=16 * 1024 * 1024, ge=0)
    image_cache_ttl: float = Field(default=60, ge=0)
    cache_max_entries: int = Field(default=128, ge=1)
    catalog_concurrency: int = Field(default=3, ge=1, le=5)
    fetch_concurrency: int = Field(default=5, ge=1, le=10)
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
