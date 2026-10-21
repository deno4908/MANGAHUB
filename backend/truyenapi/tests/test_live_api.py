import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from truyenapi.api import create_app
from truyenapi.cache import MemoryCache
from truyenapi.client import SourceClient
from truyenapi.config import Settings
from truyenapi.parsers import parse_chapter
from truyenapi.service import LiveService


BASE = "https://truyenqqko.com"
SLUG = "truyen-thu-123"
URL = BASE + "/truyen-tranh/" + SLUG
COMIC = '''<div class="book_info"><h1>Truyện thử</h1></div>
<ul class="list-info"><li><p class="name">Tên khác</p><p>Tên phụ</p></li></ul>
<div class="works-chapter-list"><div class="works-chapter-item">
<a href="/truyen-tranh/truyen-thu-123-chap-1.5">Chương 1.5</a></div></div>
<input id="book_id" value="123"><input id="total_page" value="2">'''
CHAPTER = '''<div class="chapter_content"><img src="https://ads.example/ad.jpg">
<div id="page_0"><img src="data:image/gif;base64,x" data-original="//img.example/0.jpg" data-cdn="//cdn.example/0.jpg"></div>
<div id="page_1"><img src="//img.example/1.jpg"></div></div>
<input id="book_id" value="123"><input id="episode_id" value="9001"><input id="total_page" value="2">'''
COMMENT = '''<article class="info-comment child_12 parent_0"><strong class="level">Bạn đọc</strong>
<div class="content-comment">Hay</div><a href="javascript:loadReply(12)">2 phản hồi</a></article>'''
LISTING = '''<div class="list_grid"><li><div class="book_avatar"><img src="//img.example/cover.jpg"></div>
<div class="book_name"><a href="/truyen-tranh/truyen-thu-123">Truyện thử</a></div></li></div>
<a href="/truyen-moi-cap-nhat/trang-10">10</a>'''


def xml(kind, urls):
    tag = "sitemap" if kind == "sitemapindex" else "url"
    return f'<{kind} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join(f'<{tag}><loc>{u}</loc></{tag}>' for u in urls) + f'</{kind}>'


def setup_service(handler=None, **kwargs):
    calls = []
    config = Settings(request_delay=0, retries=1, **kwargs)
    def source(request):
        calls.append(request)
        if handler:
            custom = handler(request)
            if custom is not None:
                return custom
        path = request.url.path
        if path == "/sitemap.xml":
            body = xml("sitemapindex", [BASE + "/sitemap-comic-1.xml", BASE + "/sitemap-comic-new.xml", BASE + "/sitemap-chapter-2026-01.xml"])
        elif path.startswith("/sitemap-comic"):
            body = xml("urlset", [URL, BASE + "/truyen-tranh/truyen-khac-456"])
        elif path == "/frontend/comment/list":
            body = COMMENT
        elif "-chap-" in path:
            body = CHAPTER
        elif path.startswith("/truyen-tranh/"):
            body = COMIC
        elif path.startswith("/truyen-moi-cap-nhat/"):
            body = LISTING
        elif path == "/doc-truyen":
            body = '<a href="/the-loai/action-26">Action</a>'
        else:
            return httpx.Response(404)
        return httpx.Response(200, text=body)
    client = SourceClient(config)
    client.http.close()
    client.http = httpx.Client(transport=httpx.MockTransport(source))
    return LiveService(config, client), calls


def test_images_reuse_fast_source_host_without_waiting_for_slow_losers():
    release, loser_done = threading.Event(), threading.Event()

    def handler(request):
        if request.url.host == "slow.example":
            release.wait(3)
            loser_done.set()
        return httpx.Response(200, content=b"image", headers={"content-type": "image/jpeg"})

    service, calls = setup_service(handler)
    try:
        urls = ["https://slow.example/one.jpg", "https://fast.example/one.jpg"]
        assert service.image(urls, BASE) == (b"image", "image/jpeg")
        assert service.image_preferred_host[0] == "fast.example"
        release.set()
        assert loser_done.wait(1)
        service.image_pool.shutdown(wait=True)
        assert service.image_preferred_host[0] == "fast.example"
        # Reordering must not change the cache key for the same original input.
        previous = len(calls)
        assert service.image(urls, BASE) == (b"image", "image/jpeg")
        assert len(calls) == previous
        # A different cover should start with the successful source-provided host.
        service.image_pool = ThreadPoolExecutor(max_workers=24)
        assert service.image([url.replace("one", "two") for url in urls], BASE)[0] == b"image"
        assert [request.url.host for request in calls[previous:]] == ["fast.example"]
    finally:
        release.set()
        service.close()


def test_image_preference_expires_and_falls_back_without_inventing_urls():
    def handler(request):
        if request.url.host == "fast.example":
            return httpx.Response(200, text="not an image")
        return httpx.Response(200, content=b"image", headers={"content-type": "image/jpeg"})

    service, calls = setup_service(handler)
    try:
        service.image_preferred_host = ("fast.example", time.monotonic() + 60)
        urls = ["https://original.example/one.jpg", "https://fast.example/one.jpg"]
        assert service.image(urls, BASE)[0] == b"image"
        assert [request.url.host for request in calls] == ["fast.example", "original.example"]
        service.image_preferred_host = ("fast.example", time.monotonic() - 1)
        previous = len(calls)
        assert service.image([url.replace("one", "two") for url in urls], BASE)[0] == b"image"
        assert [request.url.host for request in calls[previous:]] == ["original.example"]
        service.image_preferred_host = ("unlisted.example", time.monotonic() + 60)
        previous = len(calls)
        assert service.image(["https://original.example/three.jpg"], BASE)[0] == b"image"
        assert [request.url.host for request in calls[previous:]] == ["original.example"]
    finally:
        service.close()


def test_docs_portal_and_swagger_have_separate_routes_and_local_assets():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        portal = api.get("/docs")
        assert portal.status_code == 200
        assert portal.headers["content-type"].startswith("text/html")
        assert portal.headers["cache-control"] == "no-cache"
        assert "script-src 'self'" in portal.headers["content-security-policy"]
        for asset in ("app.js", "styles.css"):
            response = api.get("/docs/assets/" + asset)
            assert response.status_code == 200
            assert len(response.content) > 1000
        swagger = api.get("/swagger")
        assert swagger.status_code == 200
        assert "SwaggerUIBundle" in swagger.text
        assert "/swagger/oauth2-redirect" in swagger.text
        schema = api.get("/openapi.json").json()
        assert "/docs" not in schema["paths"]
        assert "/swagger" not in schema["paths"]
        assert "/api/v1/comics/cards" in schema["paths"]
        assert not calls  # Opening the UI must not crawl source pages on the server.


def test_all_catalog_deduplicates_and_ignores_chapter_maps():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        data = api.get("/api/v1/comics/all").json()
        assert data["total"] == 2
        assert set(data["items"][0]) == {"id", "slug", "url"}
        assert all("sitemap-chapter" not in str(r.url) for r in calls)
        count = len(calls)
        assert api.get("/api/v1/comics/all").json()["total"] == 2
        assert len(calls) == count
        assert api.get("/api/v1/comics?q=truyện%20thử").json()["total"] == 1
        assert len(api.get("/api/v1/comics?page_size=1").json()["items"]) == 1


def test_details_and_chapters_are_live_without_sitemap_for_full_slug(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        comic = api.get("/api/v1/comics/" + SLUG).json()
        assert comic["title"] == "Truyện thử"
        assert len(calls) == 1
        assert calls[0].url.path == "/truyen-tranh/" + SLUG
        chapter = api.get(f"/api/v1/comics/{SLUG}/chapters/1.5").json()
        assert len(chapter["images"]) == 2
        assert chapter["images"][0]["fallback_urls"] == ["https://cdn.example/0.jpg"]
        assert "crawl_status" not in chapter
        assert api.get("/health").json()["database"] is False
        assert api.get("/api/v1/jobs").status_code == 404
    assert list(tmp_path.iterdir()) == []


def test_comments_ajax_uses_chapter_context():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        data = api.get(f"/api/v1/comics/{SLUG}/comments?chapter=1&page=2").json()
        assert data["items"][0]["has_replies"]
        assert data["episode_id"] == "9001"
        ajax = calls[-1]
        assert ajax.method == "POST"
        assert parse_qs(ajax.content.decode())["episode_id"] == ["9001"]
        assert ajax.headers["referer"] == URL + "-chap-1"


def test_latest_genres_id_resolution_and_validation():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/comics/123").json()["title"] == "Truyện thử"
        latest = api.get("/api/v1/latest").json()
        assert latest["items"][0]["title"] == "Truyện thử"
        assert latest["total_pages"] == 10
        assert api.get("/api/v1/genres").json()[0]["name"] == "Action"
        assert api.get("/api/v1/comics?page=0").status_code == 422
        assert api.get("/api/v1/comics/9999999").status_code == 404
        assert api.get(f"/api/v1/comics/{SLUG}/chapters/bad%3Fpath").status_code == 422


@pytest.mark.parametrize("kind,expected", [("blocked", 502), ("timeout", 504), ("invalid", 502)])
def test_incomplete_sitemaps_never_return_partial_success(kind, expected):
    def handler(request):
        if request.url.path == "/sitemap-comic-new.xml":
            if kind == "timeout":
                raise httpx.ReadTimeout("timeout", request=request)
            return httpx.Response(403) if kind == "blocked" else httpx.Response(200, text="not xml")
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        response = api.get("/api/v1/comics/all")
        assert response.status_code == expected
        assert "items" not in response.json()


def test_cache_single_flight_and_expiration():
    cache = MemoryCache(max_entries=2)
    count = 0
    lock = threading.Lock()
    def load():
        nonlocal count
        with lock:
            count += 1
        time.sleep(0.03)
        return count
    with ThreadPoolExecutor(max_workers=5) as pool:
        values = list(pool.map(lambda _: cache.get("same", 0.1, load), range(5)))
    assert values == [1] * 5
    time.sleep(0.11)
    assert cache.get("same", 0.1, load) == 2
    cache.get("second", 60, lambda: 2)
    cache.get("third", 60, lambda: 3)
    assert len(cache.values) == 2


def test_missing_reader_images_are_reported_as_failure():
    with pytest.raises(ValueError, match="No reader images"):
        parse_chapter("<html>Blocked</html>", URL + "-chap-1")


def test_collections_rankings_and_reserved_paths_do_not_resolve_as_comic_ids():
    paths = []
    def handler(request):
        path = request.url.path
        if any(path.startswith("/" + prefix) for prefix in
               ["top-", "truyen-tranh-moi", "truyen-hoan-thanh", "truyen-yeu-thich", "truyen-dich-qq", "tim-kiem-nang-cao"]):
            paths.append(path)
            return httpx.Response(200, text=LISTING)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        for endpoint in ["new", "completed", "ongoing", "popular", "favorites", "exclusive"]:
            result = api.get("/api/v1/comics/" + endpoint)
            assert result.status_code == 200, result.text
            assert result.json()["count"] == 1
            assert result.json()["total"] is None
            assert result.json()["has_next"]
        for period in ["day", "week", "month", "all"]:
            assert api.get("/api/v1/rankings?period=" + period).status_code == 200
        assert api.get("/api/v1/rankings?period=year").status_code == 422
        assert not any("sitemap" in str(r.url) for r in calls)
    assert "/top-ngay/trang-1" in paths


def test_discovery_combines_filters_and_validates_conflicts():
    def handler(request):
        if request.url.path == "/tim-kiem-nang-cao/trang-2":
            return httpx.Response(200, text=LISTING)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        result = api.get("/api/v1/discover", params={"genres": "action", "status": "completed", "country": "japan",
                                                   "sort": "views_desc", "min_chapters": 100, "page": 2})
        assert result.status_code == 200, result.text
        params = dict(calls[-1].url.params)
        assert params == {"category": "26", "status": "2", "country": "4", "sort": "4", "minchapter": "100"}
        assert api.get("/api/v1/discover?genres=26&exclude_genres=action").status_code == 422
        assert api.get("/api/v1/discover?genres=not-found").status_code == 404
        assert api.get("/api/v1/discover?sort=broken").status_code == 422
        assert api.get("/api/v1/discover?min_chapters=17").status_code == 422


def test_genre_and_author_metadata_and_source_pagination():
    def handler(request):
        if request.url.path.startswith("/the-loai/"):
            return httpx.Response(200, text="<h1>Truyện Action</h1>" + LISTING)
        if request.url.path.startswith("/tac-gia/"):
            return httpx.Response(200, text="<h1>Tác giả thử</h1>" + LISTING)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/genres/action").json()["id"] == "26"
        genre = api.get("/api/v1/genres/26/comics?status=ongoing&sort=created_desc&page=2").json()
        assert genre["genre"]["id"] == "26"
        assert dict(calls[-1].url.params) == {"status": "0", "sort": "0"}
        author = api.get("/api/v1/authors/tac-gia-thu-9").json()
        assert author["author"]["name"] == "Tác giả thử"
        assert api.get("/api/v1/authors/9").status_code == 422
        assert api.get("/api/v1/authors/tac-gia-thu-9/comics?page=11").status_code == 404


def test_search_aliases_empty_and_limited_source_results():
    search_html = '''<li><a href="/truyen-tranh/truyen-thu-123"><div class="search_avatar"><img src="//img.example/cover.jpg"></div>
    <div class="search_info"><p class="name">Truyện thử</p><p class="name_other">Tên phụ</p><p>Chương 1.5</p></div></a></li>'''
    def handler(request):
        if request.url.path == "/frontend/search/search":
            return httpx.Response(200, text='<li><div class="no_result">Không thấy</div></li>' if b"none" in request.content else search_html)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        data = api.get("/api/v1/search?q=Tên%20phụ").json()
        assert data["items"][0]["alternative_names"] == "Tên phụ"
        assert data["source_limited"] and data["total"] is None
        assert api.get("/api/v1/search/suggestions?q=none").json()["items"] == []
        assert api.get("/api/v1/search?q=%20%20").status_code == 422
        assert api.get("/api/v1/search").status_code == 422


def test_chapter_sorting_edges_filters_and_navigation():
    chapters = ''.join(f'<a href="/truyen-tranh/{SLUG}-chap-{n}">Chương {n.replace("-", ".")}</a>' for n in ["10", "1.5", "2", "1", "5-5"])
    def handler(request):
        if "-chap-" in request.url.path:
            return httpx.Response(200, text=CHAPTER + f'<a class="link-next-chap" href="/truyen-tranh/{SLUG}-chap-2">Next</a>')
        if request.url.path == "/truyen-tranh/" + SLUG:
            return httpx.Response(200, text=f'<div class="book_info"><h1>Truyện thử</h1></div><div class="works-chapter-list">{chapters}</div>')
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        prefix = f"/api/v1/comics/{SLUG}/chapters"
        result = api.get(prefix + "?order=asc&page_size=2").json()
        assert [c["number"] for c in result["items"]] == ["1", "1.5"]
        assert result["total_pages"] == 3
        assert api.get(prefix + "/first").json()["number"] == "1"
        assert api.get(prefix + "/latest").json()["number"] == "10"
        assert api.get(prefix + "?q=1.5").json()["total"] == 1
        navigation = api.get(prefix + "/1/navigation").json()
        assert navigation["previous"] is None and navigation["next"]["number"] == "2"


def test_image_proxy_uses_referer_and_fallback_without_open_url_parameter(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    def handler(request):
        if request.url.host == "img.example":
            return httpx.Response(200, headers={"content-type": "text/html"}, content=b"blocked")
        if request.url.host == "cdn.example":
            assert request.headers["referer"] == URL + "-chap-1"
            return httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNGexample")
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        prefix = f"/api/v1/comics/{SLUG}/chapters/1/images"
        data = api.get(prefix).json()
        assert data["count"] == 2
        response = api.get(data["items"][0]["proxy_url"])
        assert response.status_code == 200 and response.headers["content-type"] == "image/png"
        assert api.get(prefix + "/0").status_code == 422
        assert api.get(prefix + "/99").status_code == 404
        assert api.get(prefix + "/1?server=original").status_code == 502
    assert list(tmp_path.iterdir()) == []


def test_batch_partial_failures_and_input_limit():
    def handler(request):
        if request.url.path.endswith("/missing-999"):
            return httpx.Response(404)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        result = api.post("/api/v1/comics/batch", json={"ids": [SLUG, "missing-999"]}).json()
        assert result["partial"] and result["count"] == 2
        assert result["items"][0]["data"]["title"] == "Truyện thử"
        assert result["items"][1]["error"]["status"] == 404
        assert api.post("/api/v1/comics/batch", json={"ids": [SLUG] * 11}).status_code == 422
        assert api.post("/api/v1/comics/batch", json={"ids": []}).status_code == 422


def test_swagger_and_cors_for_browser_frontends():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        schema = api.get("/openapi.json").json()
        assert schema["info"]["version"] == "0.7.0"
        assert "SourcePage" in schema["components"]["schemas"]
        assert len(schema["paths"]) >= 30
        response = api.options("/api/v1/comics/batch", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "*"


def test_home_sections_and_related_references():
    def handler(request):
        if request.url.path == "/doc-truyen":
            return httpx.Response(200, text="<h2>Truyện hay</h2>" + LISTING)
        if request.url.path == "/truyen-tranh/" + SLUG:
            return httpx.Response(200, text=COMIC + '<a href="/truyen-tranh/truyen-lien-quan-55">Khác</a>')
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        home = api.get("/api/v1/home").json()
        assert home["sections"][0]["key"] == "featured"
        assert home["sections"][0]["items"][0]["id"] == "123"
        related = api.get(f"/api/v1/comics/{SLUG}/related").json()
        assert related["items"][0]["id"] == "55"


def test_comment_page_limits_and_reply_routes():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        assert api.get(f"/api/v1/comics/{SLUG}/comments?page=3").status_code == 404
        response = api.get(f"/api/v1/comics/{SLUG}/comments/12/replies?chapter=1")
        assert response.status_code == 200
        assert parse_qs(calls[-1].content.decode())["parent_id"] == ["12"]
        assert api.get(f"/api/v1/comics/{SLUG}/chapters/1/comments").json()["episode_id"] == "9001"


def test_source_author_uses_page_urls_and_blank_comment_count_uses_pager():
    def handler(request):
        if request.url.path.startswith("/tac-gia/"):
            assert request.url.path in ["/tac-gia/author-9", "/tac-gia/author-9/page-2"]
            return httpx.Response(200, text=LISTING.replace("trang-10", "page-346"))
        if request.url.path == "/truyen-tranh/" + SLUG:
            return httpx.Response(200, text=COMIC.replace('value="2"', 'value=""') + '<p onclick="loadComment(5)">5</p>')
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/authors/author-9").json()["total_pages"] == 346
        assert api.get("/api/v1/authors/author-9/comics?page=2").status_code == 200
        assert api.get(f"/api/v1/comics/{SLUG}/comments?page=2").status_code == 200


CARD_HTML = f'''<div class="list_grid"><li>
<div class="book_avatar"><img src="data:image/gif;base64,x" data-src="//img.example/thumb.jpg" data-fb="//backup.example/thumb.jpg"></div>
<div class="book_name"><a href="/truyen-tranh/{SLUG}">Truyện thử</a></div>
<span class="time-ago">5 Phút Trước</span><span class="type-label hot">Hot</span>
<div class="last_chapter"><a href="/truyen-tranh/{SLUG}-chap-45-5">Chapter 45.5</a></div>
<div class="more-info"><div class="title-more-other">Tên khác: Tên phụ</div>
<p class="info">Tình trạng: Đang Cập Nhật</p><p class="info">Lượt xem: 2,068,395</p><p class="info">Lượt theo dõi: 8,053</p>
<div class="list-tags"><p class="blue">Action</p><p class="blue">Fantasy</p></div>
<div class="excerpt">Mô tả ngắn trên trang danh sách.</div></div></li></div>
<div class="page_redirect"><a href="/truyen-moi-cap-nhat/trang-10">10</a></div>'''


def test_manga_cards_fetch_one_listing_page_and_reuse_it_for_single_basic(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    def handler(request):
        if request.url.path.startswith("/truyen-moi-cap-nhat/"):
            return httpx.Response(200, text=CARD_HTML)
        if request.url.host == "img.example":
            assert request.headers["referer"] == URL
            return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=b"jpeg-example")
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        response = api.get("/api/v1/comics/cards?page=1")
        assert response.status_code == 200, response.text
        value = response.json()
        card = value["items"][0]
        assert len(calls) == 1
        assert calls[0].url.path == "/truyen-moi-cap-nhat/trang-1"
        assert card["title"] == "Truyện thử"
        assert card["thumbnail_url"] == "https://img.example/thumb.jpg"
        assert card["thumbnail_fallback_urls"] == ["https://backup.example/thumb.jpg"]
        assert card["latest_chapter"]["number"] == "45-5"
        assert card["views"] == 2068395 and card["followers"] == 8053
        assert card["genres"] == ["Action", "Fantasy"] and card["labels"] == ["Hot"]
        assert card["status"] == "Đang Cập Nhật" and card["alternative_names"] == "Tên phụ"
        assert card["description"] == "Mô tả ngắn trên trang danh sách."
        assert value["has_next"] and value["collection"] == "latest"
        assert api.get("/api/v1/comics/123/basic").json() == card
        assert api.get(f"/api/v1/comics/{SLUG}/basic").json() == card
        assert len(calls) == 1
        assert api.get("/api/v1/comics/123/cover").content == b"jpeg-example"
        assert len(calls) == 2
        assert api.get("/api/v1/comics/cards?collection=invalid").status_code == 422
    assert list(tmp_path.iterdir()) == []


def test_basic_cold_fetch_is_compact_and_existing_detail_cache_is_reused():
    basic_html = COMIC + '''<div class="book_avatar"><img src="//img.example/basic.jpg"></div>
    <div class="story-detail-info"><p>Mô tả của truyện.</p><p>Đoạn bổ sung.</p></div>'''
    def handler(request):
        if request.url.path == "/truyen-tranh/" + SLUG:
            return httpx.Response(200, text=basic_html)
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        card = api.get(f"/api/v1/comics/{SLUG}/basic").json()
        assert len(calls) == 1 and card["thumbnail_url"] == "https://img.example/basic.jpg"
        assert card["description"] == "Mô tả của truyện."
        assert not {"chapters", "comments", "meta", "structured_data", "context"} & set(card)
        assert card["views"] is None and card["status"] is None
        # The other direction: full detail already fetched, no extra source request for basic.
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        assert api.get(f"/api/v1/comics/{SLUG}").status_code == 200
        assert api.get(f"/api/v1/comics/{SLUG}/basic").json()["description"] == "Mô tả của truyện."
        assert len(calls) == 1


def test_sparse_cards_keep_unknown_values_null_and_existing_listings_include_thumbnails():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        card = api.get("/api/v1/comics/cards").json()["items"][0]
        assert card["thumbnail_url"] == "https://img.example/cover.jpg"
        assert card["views"] is None and card["followers"] is None
        assert card["description"] is None and card["status"] is None
        assert card["latest_chapter"] is None
        assert api.get("/api/v1/latest").json()["items"][0]["thumbnail_url"] == card["thumbnail_url"]
        assert len(calls) == 1


def test_card_cache_expiration_eviction_and_disabled_cache(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("truyenapi.cache.time.monotonic", lambda: clock[0])
    cache = MemoryCache(max_entries=2)
    cache.put("old", 1, {"id": 1})
    cache.put("second", 60, {"id": 2})
    assert cache.peek("old") == {"id": 1}
    clock[0] = 102.0
    assert cache.peek("old") is None
    cache.put("third", 60, {"id": 3})
    cache.put("fourth", 60, {"id": 4})
    assert cache.peek("second") is None
    cache.put("disabled", 0, {"id": 5})
    assert cache.peek("disabled") is None
    assert len(cache.values) == 2


def test_numeric_id_learned_from_listing_avoids_catalog_for_detail_and_reader():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/latest").status_code == 200
        assert api.get("/api/v1/comics/123").status_code == 200
        assert api.get("/api/v1/comics/123/chapters/1").status_code == 200
        assert len(calls) == 3
        assert not any("sitemap" in str(r.url) for r in calls)


def test_basic_and_detail_concurrently_share_one_source_html_fetch():
    def handler(request):
        if request.url.path == "/truyen-tranh/" + SLUG:
            time.sleep(0.03)
            return httpx.Response(200, text=COMIC)
    service, calls = setup_service(handler)
    try:
        with ThreadPoolExecutor(2) as pool:
            basic_future = pool.submit(service.basic, SLUG)
            full_future = pool.submit(service.comic, SLUG)
            assert basic_future.result()["title"] == "Truyện thử"
            assert full_future.result()["chapters"][0]["number"] == "1.5"
        assert len(calls) == 1
    finally:
        service.close()


def test_latest_refresh_bypasses_both_caches_and_updates_basic_cards():
    revision = ["Truyện thử"]
    def handler(request):
        if request.url.path.startswith("/truyen-moi-cap-nhat/"):
            return httpx.Response(200, text=CARD_HTML.replace("Truyện thử", revision[0]))
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        first = api.get("/api/v1/latest").json()
        assert first["cache_ttl_seconds"] == 15 and first["fetched_at"]
        revision[0] = "Tên mới từ nguồn"
        cached = api.get("/api/v1/comics/cards").json()
        assert cached["items"][0]["title"] == "Truyện thử" and len(calls) == 1
        refreshed = api.get("/api/v1/latest?refresh=true").json()
        assert refreshed["items"][0]["title"] == "Tên mới từ nguồn" and len(calls) == 2
        assert api.get("/api/v1/comics/123/basic").json()["title"] == "Tên mới từ nguồn"
        assert len(calls) == 2


def test_updates_filter_reuses_latest_and_refreshes_when_requested():
    revision = ["5 Phút Trước"]
    def handler(request):
        if request.url.path.startswith("/truyen-moi-cap-nhat/"):
            return httpx.Response(200, text=CARD_HTML.replace("5 Phút Trước", revision[0]))
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        result = api.get("/api/v1/updates?within_minutes=15").json()
        assert result["count"] == result["source_count"] == 1
        assert result["next_poll_seconds"] == 60
        assert result["items"][0]["update_time_is_estimated"]
        assert result["scope"] == "source_page" and result["has_next"]
        assert result["total"] is None and result["timezone"] == "Asia/Ho_Chi_Minh"
        assert api.get("/api/v1/updates?within_minutes=1").json()["count"] == 0
        assert api.get("/api/v1/updates").json()["filter"]["within_minutes"] == 60
        assert len(calls) == 1
        revision[0] = "2 Giờ Trước"
        assert api.get("/api/v1/updates?within_minutes=15&refresh=true").json()["count"] == 0
        assert len(calls) == 2
        second = api.get("/api/v1/updates?page=2&within_minutes=180").json()
        assert second["page"] == 2 and second["count"] == 1
        assert calls[-1].url.path.endswith("trang-2")
        assert not any("sitemap" in str(r.url) for r in calls)


@pytest.mark.parametrize("query", ["within_minutes=0", "within_minutes=10081", "date=bad-date",
                                    "date=2026-10-20&within_minutes=60", "page=0"])
def test_invalid_update_filters_do_not_fetch_source(query):
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/updates?" + query).status_code == 422
        assert calls == []


def test_latest_ttl_expiry_reloads_source_without_serving_stale_data(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("truyenapi.cache.time.monotonic", lambda: clock[0])
    service, calls = setup_service(latest_ttl=1)
    try:
        service.latest(1)
        clock[0] += 0.5
        service.latest(1)
        assert len(calls) == 1
        clock[0] += 0.6
        service.latest(1)
        assert len(calls) == 2
    finally:
        service.close()


def test_concurrent_failed_cache_load_is_shared_and_failure_is_not_retained():
    cache = MemoryCache()
    start = threading.Barrier(5)
    release = threading.Event()
    entered = threading.Event()
    loads = []
    def loader():
        loads.append(1)
        entered.set()
        assert release.wait(timeout=2)
        raise ValueError("Source failed")
    def read():
        start.wait(timeout=2)
        try:
            cache.get("same", 60, loader)
        except ValueError as error:
            return str(error)
    with ThreadPoolExecutor(5) as pool:
        futures = [pool.submit(read) for _ in range(5)]
        assert entered.wait(timeout=2)
        time.sleep(0.05)
        release.set()
        assert [f.result() for f in futures] == ["Source failed"] * 5
    assert len(loads) == 1
    assert cache.get("same", 60, lambda: "Recovered") == "Recovered"


def test_byte_cache_evicts_large_values_and_skips_oversized_images():
    cache = MemoryCache(max_entries=5, max_bytes=5, sizeof=len)
    cache.put("a", 60, b"123")
    cache.put("b", 60, b"456")
    assert cache.peek("a") is None and cache.total_bytes == 3
    assert cache.get("oversized", 60, lambda: b"123456") == b"123456"
    assert cache.peek("oversized") is None and cache.total_bytes == 3
    cache.invalidate("b")
    assert cache.total_bytes == 0


def test_repeated_proxy_image_requests_reuse_bounded_ram_cache():
    def handler(request):
        if request.url.host == "img.example":
            return httpx.Response(200, headers={"content-type": "image/png"}, content=b"example-image")
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        path = f"/api/v1/comics/{SLUG}/chapters/1/images/1"
        assert api.get(path).content == b"example-image"
        assert api.get(path).content == b"example-image"
        assert len([r for r in calls if r.url.host == "img.example"]) == 1
        assert service.image_cache.total_bytes == len(b"example-image")


@pytest.mark.parametrize("endpoint", ["", "/basic", "/chapters/1"])
def test_wrong_source_comic_id_never_returns_a_successful_wrong_book(endpoint):
    def handler(request):
        body = CHAPTER if "-chap-" in request.url.path else COMIC
        return httpx.Response(200, text=body.replace('id="book_id" value="123"', 'id="book_id" value="999"'))
    service, calls = setup_service(handler)
    with TestClient(create_app(service=service)) as api:
        response = api.get(f"/api/v1/comics/{SLUG}" + endpoint)
        assert response.status_code == 502 and "ID" in response.json()["detail"]


def test_catalog_search_non_latin_text_is_not_treated_as_an_empty_query():
    service, calls = setup_service()
    with TestClient(create_app(service=service)) as api:
        assert api.get("/api/v1/comics?q=全球").json()["total"] == 0
        assert api.get("/api/v1/comics?q=truyện%20thử").json()["total"] == 1


def test_source_rate_limit_does_not_serialize_unrelated_cdn_hosts(monkeypatch):
    clock = [100.0]
    sleeps = []
    monkeypatch.setattr("truyenapi.client.time.monotonic", lambda: clock[0])
    def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay
    monkeypatch.setattr("truyenapi.client.time.sleep", sleep)
    client = SourceClient(Settings(request_delay=0.2, retries=1))
    client.http.close()
    client.http = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, text="ok")))
    try:
        client.request(BASE + "/a")
        client.request("https://img.example/image.jpg")
        client.request(BASE + "/b")
        assert len([delay for delay in sleeps if delay > 0]) == 1
        assert sum(sleeps) == pytest.approx(0.2)
    finally:
        client.close()


def test_reusing_an_older_html_snapshot_does_not_extend_detail_freshness(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("truyenapi.cache.time.monotonic", lambda: clock[0])
    service, calls = setup_service(cache_ttl=60)
    try:
        service.basic(SLUG)
        clock[0] = 159.0
        service.comic(SLUG)
        assert len(calls) == 1
        clock[0] = 161.0
        service.comic(SLUG)
        assert len(calls) == 2
    finally:
        service.close()


def test_latest_cards_share_the_same_freshness_deadline(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("truyenapi.cache.time.monotonic", lambda: clock[0])
    service, calls = setup_service(cache_ttl=60, latest_ttl=15)
    try:
        service.cards()
        assert service.card_cache.peek("123") is not None
        clock[0] = 116.0
        assert service.card_cache.peek("123") is None
    finally:
        service.close()
