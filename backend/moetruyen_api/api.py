import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import Filters, GoogleState, ScrapeRequest, Settings, SourceAuth, Sort, Status
from .source import Runtime, Source, SourceFailure
from .ui import install_web
from .imgx import ReaderImages


class TranslationTeam(BaseModel):
    name: str
    url: str | None = None


class Card(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    slug: str
    url: str
    title: str
    thumbnail_url: str | None
    thumbnail_fallback_urls: list[str]
    genres: list[str]
    genres_complete: bool
    adult: bool
    description: str | None = None
    description_complete: bool = False
    translation_teams: list[TranslationTeam] = Field(default_factory=list)
    cover_urls: list[str] = Field(default_factory=list)
    authors: list[str] = Field(default_factory=list)
    status: str | None = None
    latest_chapter: dict | None = None
    views: int | None = None
    followers: int | None = None
    comments_count: int | None = None


class CardPage(BaseModel):
    model_config = ConfigDict(extra="allow")
    items: list[Card]
    count: int
    total: int
    page: int
    page_size: int
    total_pages: int
    has_next: bool
    has_previous: bool
    source_url: str
    fetched_at: str
    cache_ttl_seconds: float


def create_app(settings: Settings | None = None, transport=None, imgx_renderer=None):
    settings = settings or Settings()
    settings.source_auth().header()  # Fail at startup on invalid server configuration.
    runtime = Runtime(settings)
    reader = ReaderImages(settings, imgx_renderer)
    key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

    def authorize(key: Annotated[str | None, Depends(key_header)]):
        expected = settings.api_key.get_secret_value()
        if expected and (key is None or not secrets.compare_digest(key.encode(), expected.encode())):
            raise HTTPException(401, "API key không hợp lệ.")

    @asynccontextmanager
    async def lifespan(app):
        try:
            reader.start()
            yield
        finally:
            reader.close()

    app = FastAPI(title="MoeTruyen API", version="0.3.2", docs_url="/swagger", redoc_url="/redoc", lifespan=lifespan,
                  swagger_ui_oauth2_redirect_url="/swagger/oauth2-redirect",
                  description="API JSON từ truyen.moe. /docs có thư viện và trình đọc; /swagger có Swagger. Ảnh IMGX được render bằng trình duyệt máy chủ; trình đọc dùng JPEG nhẹ và API vẫn hỗ trợ PNG. Cookie/session qua .env, X-Source-* hoặc POST /api/v1/scrape. Không database.")
    app.state.runtime = runtime
    app.state.reader = reader
    install_web(app)

    @app.middleware("http")
    async def private_response(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # Never echo a submitted Cookie header, session or g_state in validation errors.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": list(e["loc"]), "type": e["type"], "msg": "Giá trị không hợp lệ."} for e in error.errors()]})

    @app.exception_handler(SourceFailure)
    async def source_failure(request, error):
        return JSONResponse(status_code=error.status, content={"detail": str(error), "source_status": error.source_status})

    @app.exception_handler(httpx.TimeoutException)
    async def timeout(request, error):
        return JSONResponse(status_code=504, content={"detail": "Website nguồn phản hồi quá chậm."})

    @app.exception_handler(httpx.RequestError)
    async def network_error(request, error):
        return JSONResponse(status_code=502, content={"detail": "Không kết nối được website nguồn."})

    @app.exception_handler(ValueError)
    async def parse_error(request, error):
        return JSONResponse(status_code=502, content={"detail": "Không đọc được dữ liệu nguồn; cấu trúc trang có thể đã đổi hoặc cần đăng nhập."})

    def get_source(
        access: Annotated[None, Depends(authorize)] = None,
        cookie: Annotated[str | None, Header(alias="X-Source-Cookie", description="Full Cookie header; replaces server cookie configuration.")] = None,
        session: Annotated[str | None, Header(alias="X-Source-Session", description="Session cookie value; cookie name comes from MOE_SESSION_COOKIE_NAME.")] = None,
        g_state: Annotated[str | None, Header(alias="X-Source-G-State", description="JSON Google g_state cookie, not a login token.")] = None,
        visitor_id: Annotated[str | None, Header(alias="X-Source-Visitor-Id")] = None,
    ):
        try:
            if any(x is not None for x in (cookie, session, g_state, visitor_id)):
                auth = SourceAuth(cookie=cookie or "", session=session or "", visitor_id=visitor_id or "",
                                  session_cookie_name=settings.session_cookie_name,
                                  g_state=GoogleState.model_validate_json(g_state) if g_state is not None else None)
            else:
                auth = settings.source_auth()
            auth.header()
        except (ValueError, ValidationError):
            raise HTTPException(422, "Cookie, session hoặc JSON g_state không hợp lệ.") from None
        source = Source(settings, runtime, auth, transport)
        try:
            yield source
        finally:
            source.close()

    Live = Annotated[Source, Depends(get_source)]
    Slug = Annotated[str, Path(pattern=r"^[0-9]+(?:-[a-zA-Z0-9_-]+)?$", max_length=250)]
    Chapter = Annotated[str, Path(pattern=r"^(?:[0-9]+(?:[.-][0-9]+)*|oneshot)$", max_length=60)]

    def get_filters(page: int = Query(1, ge=1, le=100000), page_size: int = Query(24, ge=1, le=100),
                    q: str = Query("", max_length=200), status: Status = "", sort: Sort = "updated_desc",
                    include: list[str] = Query(default=[], max_length=60), exclude: list[str] = Query(default=[], max_length=60),
                    include_mode: Literal["all", "any"] = "all"):
        try:
            return Filters(page=page, perPage=page_size, q=q, status=status, sort=sort,
                           include=include, exclude=exclude, includeMode=include_mode)
        except ValidationError:
            raise HTTPException(422, "Bộ lọc thể loại không hợp lệ hoặc bị trùng giữa include/exclude.") from None

    FilterQuery = Annotated[Filters, Depends(get_filters)]

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/docs")

    @app.get("/health", tags=["System"], dependencies=[Depends(authorize)])
    def health():
        return {"status": "ok", "service": "MoeTruyen API", "mode": "live", "database": False, "source": settings.base_url}

    @app.get("/api/v1/comics/all", tags=["Catalogue"], summary="Toàn bộ danh mục manga từ sitemap")
    @app.get("/api/v1/manga/all", tags=["Catalogue"], summary="Toàn bộ danh mục manga từ sitemap")
    def all_comics(source: Live, q: str = Query("", max_length=200), refresh: bool = False):
        """Trả toàn bộ ID, slug, URL manga trong sitemap, không chỉ trang đầu. Sitemap không có ảnh/tên/mô tả; dùng /comics/cards hoặc /comics/{comic_id}/basic cho card. Nếu sitemap nào lỗi, API báo lỗi thay vì trả danh mục thiếu."""
        return source.catalog(q, refresh)

    @app.get("/api/v1/manga", tags=["Catalogue"], response_model=CardPage)
    @app.get("/api/v1/comics", tags=["Catalogue"], response_model=CardPage)
    @app.get("/api/v1/discover", tags=["Catalogue"], response_model=CardPage)
    def listing(source: Live, filters: FilterQuery, refresh: bool = False):
        """Một trang từ /manga/filter. include/exclude lặp lại được; nhận ID hoặc tên thể loại. page_size gửi thành perPage lên nguồn."""
        return source.listing(filters, refresh)

    @app.get("/api/v1/comics/cards", tags=["Catalogue"], response_model=CardPage)
    def cards(source: Live, page: int = Query(1, ge=1, le=100000), page_size: int = Query(24, ge=1, le=100),
              collection: Literal["latest", "completed", "ongoing", "popular", "favorites"] = "latest", refresh: bool = False):
        options = {"latest": {}, "completed": {"status": "Hoàn thành"}, "ongoing": {"status": "Còn tiếp"},
                   "popular": {"sort": "views_desc"}, "favorites": {"sort": "bookmarks_desc"}}
        return source.listing(Filters(page=page, perPage=page_size, **options[collection]), refresh)

    @app.get("/api/v1/latest", tags=["Catalogue"], response_model=CardPage)
    def latest(source: Live, page: int = Query(1, ge=1, le=100000), refresh: bool = False):
        return source.listing(Filters(page=page), refresh)

    @app.get("/api/v1/search", tags=["Catalogue"], response_model=CardPage)
    def search(source: Live, q: str = Query(..., min_length=1, max_length=200), page: int = Query(1, ge=1, le=100000),
               page_size: int = Query(24, ge=1, le=100)):
        return source.listing(Filters(q=q, page=page, perPage=page_size))

    @app.post("/api/v1/scrape", tags=["Catalogue"], response_model=CardPage)
    def scrape(payload: ScrapeRequest, source: Live):
        """Nhập filters và auth {cookie, session, session_cookie_name, visitor_id, g_state}. auth trong body thay toàn bộ cấu hình auth mặc định; không được đưa vào cache dùng chung."""
        if payload.auth is None:
            return source.listing(payload.filters, payload.refresh)
        try:
            payload.auth.header()
        except ValueError:
            raise HTTPException(422, "Cookie không hợp lệ.") from None
        own_source = Source(settings, runtime, payload.auth, transport)
        try:
            return own_source.listing(payload.filters, payload.refresh)
        finally:
            own_source.close()

    @app.get("/api/v1/options", tags=["Filters"])
    def options(source: Live):
        return source.options()

    @app.get("/api/v1/genres", tags=["Filters"])
    def genres(source: Live):
        return source.options()["genres"]

    @app.get("/api/v1/auth/session", tags=["Auth"])
    def session(source: Live):
        """Kiểm tra /auth/session như auth-core.js; trả user/hạn phiên, không trả access_token/refresh_token."""
        return source.session()

    @app.get("/api/v1/auth/me", tags=["Auth"])
    def me(source: Live):
        return source.json("/account/me")

    @app.get("/api/v1/comics/{comic_id}/basic", tags=["Comics"], response_model=Card,
             summary="Card đầy đủ cho một truyện: ảnh, tên, mô tả, tác giả và nhóm dịch")
    def basic(source: Live, comic_id: Slug):
        """Đọc một trang chi tiết để có mô tả và thể loại đầy đủ; bỏ danh sách chương khỏi response. Card trong danh sách có thể dùng tóm tắt ngắn từ nguồn, xem description_complete/genres_complete."""
        return source.basic(comic_id)

    @app.get("/api/v1/manga/{comic_id}", tags=["Comics"])
    @app.get("/api/v1/comics/{comic_id}", tags=["Comics"])
    def detail(source: Live, comic_id: Slug, chapter_page: int = Query(1, ge=1, le=100000),
               order: Literal["asc", "desc"] = "desc"):
        """ID hoặc slug như 2650-bartender-a-tokyo. Chương phân trang theo nguồn, không quét ngầm toàn truyện."""
        return source.detail(comic_id, chapter_page, order)

    @app.get("/api/v1/comics/{comic_id}/chapters", tags=["Chapters"])
    def chapters(source: Live, comic_id: Slug, page: int = Query(1, ge=1, le=100000), order: Literal["asc", "desc"] = "desc"):
        return source.chapters(comic_id, page, order)

    @app.get("/api/v1/comics/{comic_id}/chapters/all", tags=["Chapters"], summary="Toàn bộ chương truyện qua mọi trang nguồn")
    def all_chapters(source: Live, comic_id: Slug, order: Literal["asc", "desc"] = "desc"):
        """Đọc mọi trang chương, gộp danh sách; không lấy ảnh của từng chương. Lỗi giữa chừng được trả thành lỗi, không trả danh sách thiếu."""
        return source.all_chapters(comic_id, order)

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}", tags=["Chapters"])
    def chapter(source: Live, comic_id: Slug, number: Chapter, warm: bool = False):
        """Ảnh IMGX có URL API /images/{index}?format=jpeg. warm=true chuẩn bị ảnh trong cache RAM khi mở chương; trang đang xem được ưu tiên. Index bắt đầu từ 0. Endpoint ảnh nhận cùng API key và cookie nguồn; format=png giữ bản PNG."""
        return reader.describe(source, comic_id, number, warm=warm)

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}/images/{index}", tags=["Images"], response_class=Response,
             responses={200: {"content": {"image/png": {}, "image/jpeg": {}}, "description": "Trang IMGX đã render"}},
             summary="Ảnh thật của trang IMGX, render ở máy chủ")
    def chapter_image(source: Live, comic_id: Slug, number: Chapter, index: int = Path(ge=0, le=100000),
                      format: Literal["png", "jpeg"] = "png", priority: Literal["visible", "nearby"] = "visible"):
        frame = reader.image(source, comic_id, number, index, image_format=format, priority=0 if priority == "visible" else 5)
        return Response(frame.content, media_type=frame.mime, headers={
            "X-Image-Width": str(frame.width), "X-Image-Height": str(frame.height),
            "X-Image-Delivery": "imgx-browser-capture",
        })

    return app
