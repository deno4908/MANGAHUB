from contextlib import asynccontextmanager
from datetime import date as Date
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .config import Settings
from .service import LiveService
from .parsers import identity
from .options import COUNTRIES, SORTS, STATUSES
from .ui import install_web
from .schemas import APIError, BatchRequest, Country, MangaCard, MangaCardPage, MinChapters, Period, SearchResults, Sort, SourcePage, Status, UpdatePage


def create_app(settings: Settings | None = None, service: LiveService | None = None) -> FastAPI:
    settings = settings or Settings()
    live = service or LiveService(settings)

    @asynccontextmanager
    async def lifespan(app):
        yield
        live.close()

    app = FastAPI(title="TruyenAPI — Live", version="0.7.0", lifespan=lifespan,
                  docs_url="/swagger", swagger_ui_oauth2_redirect_url="/swagger/oauth2-redirect",
                  description="API đọc truyện trực tiếp: trang chủ, khám phá, tìm kiếm, thể loại, tác giả, bảng xếp hạng, chương, ảnh và bình luận. Không database; cache tạm trong RAM.",
                  responses={code: {"model": APIError, "description": description} for code, description in
                             [(404, "Không tìm thấy"), (502, "Lỗi website hoặc CDN nguồn"),
                              (503, "Nguồn giới hạn tốc độ"), (504, "Nguồn timeout")]})
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.live = live
    install_web(app)

    @app.exception_handler(httpx.TimeoutException)
    async def timeout(request: Request, error):
        return JSONResponse(status_code=504, content={"detail": "Website nguồn phản hồi quá chậm; thử lại sau."})

    @app.exception_handler(httpx.HTTPStatusError)
    async def source_http_error(request: Request, error):
        source_status = error.response.status_code
        status = 404 if source_status == 404 else 503 if source_status == 429 else 502
        return JSONResponse(status_code=status, content={"detail": "Website nguồn trả lỗi", "source_status": source_status})

    @app.exception_handler(httpx.RequestError)
    async def source_network_error(request: Request, error):
        return JSONResponse(status_code=502, content={"detail": "Không kết nối được website nguồn."})

    @app.exception_handler(ValueError)
    async def source_parse_error(request: Request, error):
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.get("/", tags=["System"])
    def root():
        return {"service": "TruyenAPI", "mode": "live", "database": False, "docs": "/docs"}

    @app.get("/health", tags=["System"])
    def health():
        return {"status": "ok", "mode": "live", "database": False}

    @app.get("/api/v1/comics/all", tags=["Catalog"], summary="Toàn bộ danh sách truyện từ sitemap")
    def all_comics(q: str = Query("", max_length=200)):
        """Trả mọi ID, slug, URL trong các sitemap truyện. Không đọc chi tiết từng truyện."""
        return live.catalog_items(q)

    @app.get("/api/v1/comics", tags=["Catalog"], summary="Danh sách truyện phân trang, tìm theo slug hoặc ID")
    def comics(q: str = Query("", max_length=200), page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=1000)):
        catalog = live.catalog_items(q)
        start = (page - 1) * page_size
        return {**catalog, "items": catalog["items"][start:start + page_size], "page": page, "page_size": page_size,
                "total_pages": (catalog["total"] + page_size - 1) // page_size}

    @app.get("/api/v1/comics/cards", tags=["Manga Cards"], response_model=MangaCardPage,
             summary="Danh sách manga card: tên, thumbnail, chương mới và tóm tắt")
    def cards(collection: Literal["latest", "new", "completed", "ongoing", "popular", "favorites", "exclusive"] = "latest",
              page: int = Query(1, ge=1, le=100000), refresh: bool = False):
        """Lấy một trang danh sách nguồn, thường 42 card; không tải trang chi tiết từng truyện. Trường nguồn không có trả null hoặc danh sách rỗng."""
        return live.cards(collection, page, refresh)

    @app.get("/api/v1/latest", tags=["Collections"], response_model=SourcePage, summary="Truyện mới cập nhật, có tên và ảnh bìa")
    def latest(page: int = Query(1, ge=1, le=100000), refresh: bool = False):
        """Giữ thứ tự mới cập nhật của nguồn; refresh=true lấy lại từ website, bỏ qua cache."""
        return live.latest(page, refresh)

    @app.get("/api/v1/updates", tags=["Updates"], response_model=UpdatePage,
             summary="Truyện cập nhật trong N phút hoặc một ngày cụ thể")
    def updates(page: int = Query(1, ge=1, le=100000),
                within_minutes: int | None = Query(None, ge=1, le=10080, description="Số phút gần đây (tối đa 7 ngày); mặc định 60 khi không có date."),
                date: Date | None = Query(None, description="Ngày YYYY-MM-DD theo múi giờ Việt Nam; không dùng cùng within_minutes."),
                refresh: bool = False):
        """Lọc trên một trang danh sách mới cập nhật; page/has_next/total_pages vẫn theo nguồn.

        Thời gian tương đối được quy thành khoảng ước tính tại fetched_at, lọc theo khoảng giao nhau.
        Nhãn không đọc được bị loại và được đếm trong unparsed_time_count. Không phải lịch sử lưu trữ;
        muốn xem thêm kết quả cần gọi các trang tiếp theo, kể cả khi trang hiện tại có count=0.
        Client có thể gọi lại mỗi next_poll_seconds=60; refresh=true bỏ cache nguồn.
        """
        if date is not None and within_minutes is not None:
            raise HTTPException(422, "Chỉ dùng date hoặc within_minutes, không dùng đồng thời.")
        return live.updates(page, within_minutes, date, refresh)

    @app.get("/api/v1/genres", tags=["Genres"])
    def genres():
        return live.genres()

    @app.get("/api/v1/home", tags=["Home"], summary="Các nhóm truyện trên trang chủ")
    def home():
        return live.home()

    @app.get("/api/v1/options", tags=["Discovery"], summary="Các giá trị bộ lọc hợp lệ")
    def options():
        return {"sorts": list(SORTS), "statuses": list(STATUSES), "countries": list(COUNTRIES),
                "min_chapters": [0, 50, 100, 200, 300, 400, 500], "ranking_periods": ["day", "week", "month", "all"],
                "pagination": {"source_lists": "Số mục/trang theo nguồn; total là null nếu nguồn không cung cấp", "catalog": "Hỗ trợ page và page_size"}}

    @app.get("/api/v1/search", tags=["Search"], response_model=SearchResults, summary="Tìm theo tên truyện và tên khác qua AJAX nguồn")
    def search(q: str = Query(..., min_length=1, max_length=200)):
        """Kết quả giới hạn theo endpoint AJAX của nguồn; không khẳng định là toàn bộ kết quả."""
        return live.search(q)

    @app.get("/api/v1/search/suggestions", tags=["Search"], response_model=SearchResults)
    def suggestions(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(8, ge=1, le=20)):
        return live.search(q, limit)

    @app.get("/api/v1/discover", tags=["Discovery"], response_model=SourcePage, summary="Lọc truyện theo nhiều tiêu chí")
    def discover(page: int = Query(1, ge=1, le=100000), genres: list[str] = Query(default=[]),
                 exclude_genres: list[str] = Query(default=[]), sort: Sort = "updated_desc", status: Status | None = None,
                 country: Country | None = None, min_chapters: MinChapters = MinChapters.any):
        """Lặp genres=26&genres=49 để chọn nhiều thể loại; nhận ID, slug hoặc tên không dấu. Các bộ lọc được gửi cùng nhau lên nguồn."""
        return live.discover(page, genres, exclude_genres, sort, status, country, min_chapters)

    @app.get("/api/v1/rankings", tags=["Collections"], response_model=SourcePage)
    def rankings(period: Period = "month", page: int = Query(1, ge=1, le=100000)):
        return live.rankings(period, page)

    @app.get("/api/v1/comics/new", tags=["Collections"], response_model=SourcePage)
    def new_comics(page: int = Query(1, ge=1, le=100000), refresh: bool = False):
        return live.collection("new", page, refresh)

    @app.get("/api/v1/comics/completed", tags=["Collections"], response_model=SourcePage)
    def completed(page: int = Query(1, ge=1, le=100000)):
        return live.collection("completed", page)

    @app.get("/api/v1/comics/ongoing", tags=["Collections"], response_model=SourcePage)
    def ongoing(page: int = Query(1, ge=1, le=100000)):
        return live.collection("ongoing", page)

    @app.get("/api/v1/comics/popular", tags=["Collections"], response_model=SourcePage)
    def popular(page: int = Query(1, ge=1, le=100000)):
        return live.collection("popular", page)

    @app.get("/api/v1/comics/favorites", tags=["Collections"], response_model=SourcePage)
    def favorites(page: int = Query(1, ge=1, le=100000)):
        """Danh sách yêu thích chung của nguồn."""
        return live.collection("favorites", page)

    @app.get("/api/v1/comics/exclusive", tags=["Collections"], response_model=SourcePage)
    def exclusive(page: int = Query(1, ge=1, le=100000)):
        return live.collection("exclusive", page)

    @app.get("/api/v1/comics/random", tags=["Comics"])
    def random_comic():
        return live.random_comic()

    @app.post("/api/v1/comics/batch", tags=["Comics"], summary="Đọc chi tiết tối đa 10 truyện trong một request")
    def batch(payload: BatchRequest):
        return live.batch(payload.ids)

    @app.get("/api/v1/genres/{genre_id}", tags=["Genres"])
    def genre(genre_id: str):
        return live.genre(genre_id)

    @app.get("/api/v1/genres/{genre_id}/comics", tags=["Genres"], response_model=SourcePage)
    def genre_comics(genre_id: str, page: int = Query(1, ge=1, le=100000), sort: Sort = "updated_desc",
                     status: Status | None = None, country: Country | None = None):
        return live.genre_comics(genre_id, page, sort, status, country)

    @app.get("/api/v1/authors/{author_slug}", tags=["Authors"], summary="Tác giả và trang truyện đầu tiên")
    def author(author_slug: str):
        return live.author(author_slug)

    @app.get("/api/v1/authors/{author_slug}/comics", tags=["Authors"], response_model=SourcePage)
    def author_comics(author_slug: str, page: int = Query(1, ge=1, le=100000)):
        return live.author(author_slug, page)

    @app.get("/api/v1/comics/{comic_id}", tags=["Comics"], summary="Lấy ngay chi tiết truyện từ nguồn")
    def comic(comic_id: str):
        """Nhận ID như 3230 hoặc slug-ID đầy đủ. Slug-ID bỏ qua bước tra sitemap."""
        return live.comic(comic_id)

    @app.get("/api/v1/comics/{comic_id}/basic", tags=["Manga Cards"], response_model=MangaCard,
             summary="Thông tin gọn cho một manga card")
    def basic(comic_id: str):
        """Ưu tiên card đã có trong cache danh sách. Khi chưa có, đọc một trang truyện và chỉ trích thông tin cơ bản; không trả danh sách chương, bình luận hoặc meta."""
        return live.basic(comic_id)

    @app.get("/api/v1/comics/{comic_id}/chapters", tags=["Chapters"])
    def chapters(comic_id: str, page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=2000),
                 order: str = Query("desc", pattern="^(asc|desc)$"), q: str = Query("", max_length=100)):
        value = live.chapters(comic_id, order, q)
        start = (page - 1) * page_size
        return {"items": value["items"][start:start + page_size], "total": len(value["items"]),
                "page": page, "page_size": page_size, "source_url": value["source_url"], "order": order,
                "total_pages": (len(value["items"]) + page_size - 1) // page_size}

    @app.get("/api/v1/comics/{comic_id}/chapters/first", tags=["Chapters"])
    def first_chapter(comic_id: str):
        return live.chapter_edge(comic_id, "first")

    @app.get("/api/v1/comics/{comic_id}/chapters/latest", tags=["Chapters"])
    def latest_chapter(comic_id: str):
        return live.chapter_edge(comic_id, "latest")

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}", tags=["Chapters"], summary="Lấy ngay URL ảnh của chương")
    def chapter(comic_id: str, number: str):
        return live.chapter(comic_id, number)

    @app.get("/api/v1/comics/{comic_id}/related", tags=["Comics"])
    def related(comic_id: str):
        """Các URL truyện khác mà trang nguồn liên kết; không tự suy đoán đề xuất."""
        return live.related(comic_id)

    def image_response(result):
        content, mime = result
        return Response(content, media_type=mime, headers={"Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff"})

    @app.get("/api/v1/comics/{comic_id}/cover", tags=["Images"], response_class=Response,
             responses={200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}})
    def cover(comic_id: str):
        value = live.basic(comic_id)
        return image_response(live.image(value["cover_urls"], value["url"]))

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}/images", tags=["Images"])
    def images(comic_id: str, number: str):
        value = live.chapter(comic_id, number)
        return {"items": [{**image, "proxy_url": f'/api/v1/comics/{comic_id}/chapters/{number}/images/{image["index"]}'} for image in value["images"]],
                "count": len(value["images"]), "referer": value["url"]}

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}/images/{index}", tags=["Images"], response_class=Response,
             responses={200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}})
    def image(comic_id: str, number: str, index: int = Path(..., ge=1), server: str = Query("auto", pattern="^(auto|original|cdn)$")):
        """Đọc ảnh qua API với Referer nguồn. server=auto thử các CDN dự phòng."""
        return image_response(live.chapter_image(comic_id, number, index, server))

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}/navigation", tags=["Chapters"])
    def navigation(comic_id: str, number: str):
        value = live.chapter(comic_id, number)
        def reference(url):
            if not url:
                return None
            _, cid, chapter_number = identity(url)
            return {"comic_id": cid, "number": chapter_number, "url": url}
        return {"current": {"comic_id": value["comic_id"], "number": value["number"], "url": value["url"]},
                "previous": reference(value["previous_url"]), "next": reference(value["next_url"])}

    @app.get("/api/v1/comics/{comic_id}/comments", tags=["Comments"])
    def comments(comic_id: str, page: int = Query(1, ge=1), parent_id: str = Query("0", pattern=r"^\d+$"),
                 chapter: str | None = None):
        """Thêm chapter=1 để lấy bình luận chương; parent_id để đọc phản hồi qua AJAX."""
        return live.comments(comic_id, page=page, parent_id=parent_id, chapter=chapter)

    @app.get("/api/v1/comics/{comic_id}/chapters/{number}/comments", tags=["Comments"])
    def chapter_comments(comic_id: str, number: str, page: int = Query(1, ge=1)):
        return live.comments(comic_id, page=page, chapter=number)

    @app.get("/api/v1/comics/{comic_id}/comments/{comment_id}/replies", tags=["Comments"])
    def replies(comic_id: str, comment_id: str = Path(..., pattern=r"^[1-9]\d*$"),
                page: int = Query(1, ge=1), chapter: str | None = None):
        return live.comments(comic_id, page=page, parent_id=comment_id, chapter=chapter)

    return app
