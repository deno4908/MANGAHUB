from typing import Any, Literal
from enum import IntEnum
from pydantic import BaseModel, ConfigDict, Field

Sort = Literal["created_desc", "created_asc", "updated_desc", "updated_asc", "views_desc", "views_asc"]
Status = Literal["ongoing", "completed"]
Country = Literal["china", "vietnam", "korea", "japan", "usa"]
Period = Literal["day", "week", "month", "all"]


class MinChapters(IntEnum):
    any = 0
    fifty = 50
    hundred = 100
    two_hundred = 200
    three_hundred = 300
    four_hundred = 400
    five_hundred = 500


class ComicCard(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    slug: str
    url: str
    title: str
    cover_urls: list[str] = Field(default_factory=list)
    thumbnail_url: str | None = None
    thumbnail_fallback_urls: list[str] = Field(default_factory=list)
    latest_chapter: dict[str, Any] | None = None


class MangaCard(ComicCard):
    model_config = ConfigDict(extra="ignore")
    alternative_names: str | None = None
    description: str | None = None
    status: str | None = None
    genres: list[str] = Field(default_factory=list)
    views: int | None = None
    followers: int | None = None
    updated_at: str | None = None
    labels: list[str] = Field(default_factory=list)


class MangaCardPage(BaseModel):
    items: list[MangaCard]
    page: int
    count: int
    total: int | None = None
    total_pages: int
    has_next: bool
    has_previous: bool
    source_url: str
    collection: str
    fetched_at: str
    cache_ttl_seconds: float


class SourcePage(BaseModel):
    model_config = ConfigDict(extra="allow")
    items: list[ComicCard]
    page: int
    count: int
    total: int | None = None
    total_pages: int
    has_next: bool
    has_previous: bool
    source_url: str
    fetched_at: str | None = None
    cache_ttl_seconds: float | None = None


class UpdateCard(MangaCard):
    update_time_from: str
    update_time_to: str
    update_time_precision: str
    update_time_is_estimated: bool


class UpdatePage(MangaCardPage):
    items: list[UpdateCard]
    source_count: int
    unparsed_time_count: int
    scope: Literal["source_page"]
    time_filter_mode: Literal["range_overlap"]
    timezone: str
    filter: dict[str, Any]
    checked_at: str
    next_poll_seconds: int


class SearchResults(BaseModel):
    items: list[ComicCard]
    count: int
    q: str
    total: int | None = None
    source_limited: bool
    source_url: str


class BatchRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=10, description="Tối đa 10 ID hoặc slug-ID truyện")


class APIError(BaseModel):
    detail: str | list[Any]
    source_status: int | None = None
