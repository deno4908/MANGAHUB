import json
import os
import re
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


COOKIE_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$")


class GoogleState(BaseModel):
    model_config = ConfigDict(extra="allow")
    i_l: int = 0
    i_ll: int | None = None
    i_b: str | None = None
    i_e: dict[str, Any] | None = None
    i_et: int | None = None


class SourceAuth(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cookie: SecretStr = SecretStr("")
    session: SecretStr = SecretStr("")
    session_cookie_name: str = "session"
    visitor_id: str = ""
    g_state: GoogleState | None = Field(default=None, repr=False)

    @field_validator("session_cookie_name")
    @classmethod
    def valid_cookie_name(cls, value):
        if not COOKIE_NAME.fullmatch(value):
            raise ValueError("Invalid session cookie name")
        return value

    @model_validator(mode="after")
    def valid_headers(self):
        values = [self.cookie.get_secret_value(), self.session.get_secret_value(), self.visitor_id]
        if any(any(ord(c) < 32 or ord(c) > 126 for c in value) for value in values):
            raise ValueError("Cookie/session values must be printable ASCII")
        if any(c in self.session.get_secret_value() + self.visitor_id for c in ';"\\'):
            raise ValueError("Invalid individual cookie value")
        return self

    def header(self):
        # Preserve JSON g_state verbatim; SimpleCookie does not reliably parse it.
        cookies = {}
        for part in self.cookie.get_secret_value().split(";"):
            if not part.strip():
                continue
            name, sep, value = part.strip().partition("=")
            if not sep or not COOKIE_NAME.fullmatch(name):
                raise ValueError("Invalid source Cookie header")
            cookies[name] = value
        if self.session.get_secret_value():
            cookies[self.session_cookie_name] = self.session.get_secret_value()
        if self.visitor_id:
            cookies["bfang.vid"] = self.visitor_id
        if self.g_state is not None:
            cookies["g_state"] = json.dumps(self.g_state.model_dump(exclude_none=True), ensure_ascii=True, separators=(",", ":"))
        return "; ".join(f"{name}={value}" for name, value in cookies.items())


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MOE_", env_file=".env", extra="ignore")
    base_url: str = "https://truyen.moe"
    timeout: float = Field(default=25, gt=0)
    request_delay: float = Field(default=0.25, ge=0)
    cache_ttl: float = Field(default=15, ge=0)
    catalog_ttl: float = Field(default=300, ge=0)
    cache_entries: int = Field(default=128, ge=1)
    imgx_browser_channel: str = "msedge" if os.name == "nt" else "chromium"
    imgx_timeout: float = Field(default=45, gt=0, le=180)
    imgx_cache_ttl: float = Field(default=300, ge=0)
    imgx_cache_bytes: int = Field(default=64 * 1024 * 1024, ge=0)
    imgx_contexts: int = Field(default=2, ge=1, le=4)
    imgx_jpeg_quality: int = Field(default=90, ge=70, le=100)
    imgx_prefetch_pages: int = Field(default=2, ge=0, le=4)
    imgx_prestart: bool = True
    imgx_prepare_chapter: bool = True
    cookie: SecretStr = SecretStr("")
    session: SecretStr = SecretStr("")
    session_cookie_name: str = "session"
    visitor_id: str = ""
    g_state: GoogleState | None = Field(default=None, repr=False)
    api_key: SecretStr = SecretStr("")
    user_agent: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

    @field_validator("base_url")
    @classmethod
    def valid_base(cls, value):
        u = urlsplit(value)
        if u.scheme not in ("http", "https") or not u.netloc or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
            raise ValueError("base_url must be an HTTP(S) origin")
        return value.rstrip("/")

    def source_auth(self):
        return SourceAuth(**{name: getattr(self, name) for name in SourceAuth.model_fields})


Sort = Literal["updated_desc", "views_desc", "views_asc", "bookmarks_desc", "bookmarks_asc", "title_asc", "title_desc", "chapters_desc", "chapters_asc", "comments_desc", "comments_asc"]
Status = Literal["", "Còn tiếp", "Hoàn thành", "Tạm dừng"]


class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    page: int = Field(default=1, ge=1, le=100000)
    per_page: int = Field(default=24, ge=1, le=100, alias="perPage")
    q: str = Field(default="", max_length=200)
    status: Status = ""
    sort: Sort = "updated_desc"
    include: list[str] = Field(default_factory=list, max_length=60)
    exclude: list[str] = Field(default_factory=list, max_length=60)
    include_mode: Literal["all", "any"] = Field(default="all", alias="includeMode")

    @field_validator("include", "exclude")
    @classmethod
    def valid_genres(cls, values):
        if any(not v.strip() or len(v) > 100 for v in values):
            raise ValueError("Invalid genre")
        return list(dict.fromkeys(v.strip() for v in values))

    @model_validator(mode="after")
    def disjoint(self):
        if set(self.include) & set(self.exclude):
            raise ValueError("A genre cannot be both included and excluded")
        return self


class ScrapeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filters: Filters = Field(default_factory=Filters)
    auth: SourceAuth | None = None
    refresh: bool = False
