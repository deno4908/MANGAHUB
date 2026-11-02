import asyncio
import json
import threading
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fastapi_app.routers import truyenqq
from fastapi_app.services import truyenqq_service as qq
from truyenapi.truyenapi.client import SourceClient
from truyenapi.truyenapi.config import Settings
from truyenapi.truyenapi.service import LiveService

SLUG = "truyen-thu-123"
COMIC = '''<div class="book_info"><h1>Truyện thử</h1></div>
<div class="book_avatar"><img src="https://img.example/cover.jpg"></div>
<div class="works-chapter-list"><div class="works-chapter-item">
<a href="/truyen-tranh/truyen-thu-123-chap-45-5">Chapter 45.5</a></div>
<div class="works-chapter-item"><a href="/truyen-tranh/truyen-thu-123-chap-1">Chapter 1</a></div></div>
<input id="book_id" value="123">'''
CHAPTER = '''<div class="chapter_content"><div id="page_0">
<img data-original="https://img.example/1.jpg" data-cdn="https://cdn.example/1.jpg"></div></div>
<input id="book_id" value="123">'''
LISTING = '''<div class="list_grid"><li><div class="book_avatar"><img src="https://img.example/cover.jpg"></div>
<div class="book_name"><a href="/truyen-tranh/truyen-thu-123">Truyện thử</a></div>
<div class="last_chapter"><a href="/truyen-tranh/truyen-thu-123-chap-45-5">Chapter 45.5</a></div>
</li></div><a href="/truyen-moi-cap-nhat/trang-444">444</a>'''


@pytest.fixture
def live(monkeypatch, tmp_path):
    calls = []
    def source(request):
        calls.append(request)
        assert "otruyen" not in request.url.host
        path = request.url.path
        if request.url.host == "img.example" and path == "/1.jpg":
            return httpx.Response(403)
        if request.url.host in {"img.example", "cdn.example"}:
            return httpx.Response(200, content=b"image-bytes", headers={"content-type": "image/jpeg"})
        if "-chap-" in path:
            comic_id = path.rsplit("-chap-", 1)[0].rsplit("-", 1)[1]
            return httpx.Response(200, text=CHAPTER.replace('value="123"', f'value="{comic_id}"'))
        if path.startswith("/truyen-tranh/"):
            return httpx.Response(200, text=COMIC)
        if path == "/doc-truyen":
            return httpx.Response(200, text='<a href="/the-loai/action-26">Action</a><a href="/the-loai/fantasy-30">Fantasy</a>')
        return httpx.Response(200, text=LISTING)

    settings = Settings(request_delay=0, retries=1)
    client = SourceClient(settings)
    client.http.close()
    client.http = httpx.Client(transport=httpx.MockTransport(source))
    service = LiveService(settings, client)
    monkeypatch.setattr(qq, "_live", service)
    monkeypatch.setattr(qq, "cache", Mock())
    qq.cache.get_many.side_effect = lambda keys: {key: qq.cache.get(key) for key in keys}
    monkeypatch.setattr(truyenqq, "IMAGE_CACHE_DIR", tmp_path)
    yield service, calls
    service.close()


def test_list_pagination_and_genres_do_not_fetch_each_detail(live):
    async def check():
        page = await qq.get_list(page=2)
        item = page["data"]["items"][0]
        assert item["slug"] == SLUG
        assert item["source"] == "truyenqq"
        assert item["chaptersLatest"][0]["chapter_name"] == "45.5"
        pagination = page["data"]["params"]["pagination"]
        assert pagination["totalPages"] == 444
        assert pagination["totalItems"] is None
        assert len(live[1]) == 1
        genres = await qq.get_categories()
        assert genres["data"]["items"][0]["slug"] == "action"
    asyncio.run(check())


def test_detail_to_chapter_roundtrip_preserves_source_number(live):
    async def check():
        detail = await qq.get_manga_detail(SLUG)
        chapters = detail["data"]["item"]["chapters"][0]["server_data"]
        token = chapters[0]["chapter_api_data"].rsplit("/", 1)[-1]
        assert token == "qq--truyen-thu-123--45-5"
        pages = await qq.get_chapter(token)
        assert pages["data"]["item"]["comic_slug"] == SLUG
        assert pages["data"]["item"]["chapter_image"][0]["image_file"].endswith(f"/{SLUG}/45-5/1")
        assert all("sitemap" not in request.url.path for request in live[1])
    asyncio.run(check())


def test_qq_image_uses_referer_and_fallback_cdn(live):
    app = FastAPI()
    app.include_router(truyenqq.router, prefix="/api/manga")
    with TestClient(app) as api:
        response = api.get(f"/api/manga/truyenqq/image/{SLUG}/45-5/1")
        assert response.status_code == 200
        assert response.content == b"image-bytes"
        assert response.headers["content-type"] == "image/jpeg"
        assert api.get(f"/api/manga/truyenqq/image/{SLUG}/45-5/0").status_code == 422
        assert api.get(f"/api/manga/truyenqq/image/{SLUG}/45-5/2").status_code == 404
        assert api.get(f"/api/manga/truyenqq/cover/{SLUG}").content == b"image-bytes"
    image_call = next(r for r in live[1] if r.url.host == "cdn.example")
    assert image_call.headers["referer"].endswith(f"/{SLUG}-chap-45-5")


def test_qq_cover_reuses_listing_hint_and_disk_cache(live, monkeypatch):
    store = {}
    qq.cache.get.side_effect = store.get
    qq.cache.set.side_effect = lambda key, value, *args, **kwargs: store.__setitem__(key, value)
    qq.cache.set_many.side_effect = lambda values, **kwargs: store.update(values)
    asyncio.run(qq.get_list())
    before = len(live[1])
    app = FastAPI()
    app.include_router(truyenqq.router, prefix="/api/manga")
    with TestClient(app) as api:
        first = api.get(f"/api/manga/truyenqq/cover/{SLUG}")
        assert first.status_code == 200
        assert first.headers["x-cache"] == "MISS"
        assert "s-maxage=3600" in first.headers["Vercel-CDN-Cache-Control"]
        assert len(live[1]) == before + 1  # image only; no comic HTML request
        async def offline(*args, **kwargs):
            raise AssertionError("Disk cache must work without contacting the source")
        store.clear()
        monkeypatch.setattr(qq, "run_live", offline)
        second = api.get(f"/api/manga/truyenqq/cover/{SLUG}")
        assert second.content == first.content
        assert second.headers["x-cache"] == "HIT"
        assert api.get(f"/api/manga/truyenqq/cover/{SLUG}", headers={"If-None-Match": second.headers["etag"]}).status_code == 304


def test_qq_adapter_discards_source_views(live):
    item = qq._item({"id": "123", "slug": "truyen-thu", "url": "https://truyenqqko.com/truyen-tranh/truyen-thu-123", "title": "Test", "views": 90000000})
    assert item["view_count"] == item["local_view_count"] == 0


def test_qq_latest_chapter_inherits_the_source_update_label(live):
    value = {"id": "123", "url": f"https://truyenqqko.com/truyen-tranh/{SLUG}", "title": "Test",
             "updated_at": "5 Phút Trước", "latest_chapter": {
                 "number": "45", "title": "Chapter 45", "url": f"https://truyenqqko.com/truyen-tranh/{SLUG}-chap-45"}}
    item = qq._item(value, "2026-10-23T12:00:00+00:00")
    assert item["chaptersLatest"][0]["updatedAt"] == item["updatedAt"] == "2026-10-23T11:54:00+00:00"
    value["latest_chapter"]["updated_at"] = "2026-10-20"
    item = qq._item(value, "2026-10-23T12:00:00+00:00")
    assert item["chaptersLatest"][0]["updatedAt"].startswith("2026-10-20")
    value.pop("updated_at")
    value["latest_chapter"].pop("updated_at")
    assert qq._item(value)["chaptersLatest"][0]["updatedAt"] == ""


def test_qq_uses_fast_cdn_without_waiting_for_slow_original(live, monkeypatch):
    release = threading.Event()
    def request(url, **kwargs):
        if url == 'https://img.example/slow.jpg':
            release.wait(2)
        return httpx.Response(200, content=b'valid-image', headers={'content-type': 'image/jpeg'})
    monkeypatch.setattr(live[0].client, 'request', request)
    async def check():
        try:
            value = await asyncio.wait_for(asyncio.to_thread(live[0].image,
                ['https://img.example/slow.jpg', 'https://cdn.example/fast.jpg'], 'https://truyenqqko.com'), 0.8)
            assert value == (b'valid-image', 'image/jpeg')
        finally:
            release.set()
    asyncio.run(check())


def test_qq_cached_filter_is_immediate_and_receives_new_chapters(live, monkeypatch):
    store = {}
    qq.cache.get.side_effect = store.get
    qq.cache.set.side_effect = lambda key, value, *args, **kwargs: store.__setitem__(key, value)
    async def check():
        first = await qq.get_filtered(genres=["action"])
        first["data"]["items"][0]["views"] = 90000000
        snapshot_key = next(key for key in store if key.startswith("truyenqq:page-snapshot:"))
        snapshot = json.loads(store[snapshot_key])
        snapshot["fresh_until"] = 0
        store[snapshot_key] = json.dumps(snapshot)
        updated = json.loads(json.dumps(snapshot["payload"]))
        updated["data"]["items"][0]["chaptersLatest"][0].update(
            chapter_name="99", chapter_api_data="/api/manga/chapter/qq--truyen-thu-123--99")
        store["truyenqq:list:truyen-moi:1"] = json.dumps(updated)
        release = asyncio.Event()
        async def slow(*args, **kwargs):
            await release.wait()
            return {"items": [], "page": 1}
        monkeypatch.setattr(qq, "run_live", slow)
        try:
            result = await asyncio.wait_for(qq.get_filtered(genres=["action"]), 0.1)
            assert result["data"]["items"][0]["chaptersLatest"][0]["chapter_name"] == "99"
            assert result["data"]["items"][0]["views"] == 0
        finally:
            release.set()
            await asyncio.sleep(0.01)
    asyncio.run(check())


def test_qq_live_overlay_keeps_selected_genres_and_status(live):
    qq.cache.get.return_value = json.dumps({"data": {"items": [
        {"slug": "wrong-1", "status": "ongoing", "category": [{"slug": "action"}], "updatedAt": "2026-10-21"},
        {"slug": "match-2", "status": "completed", "category": [{"slug": "fantasy"}], "updatedAt": "2026-10-20"},
        {"slug": "wrong-3", "status": "ongoing", "category": [{"slug": "fantasy"}], "updatedAt": "2026-10-22"},
    ]}})
    payload = {"data": {"items": [], "params": {"pagination": {"totalItemsPerPage": 24}}}}
    result = qq._overlay_latest(payload, genres=["fantasy"], status="completed", latest_order=True)
    assert [item["slug"] for item in result["data"]["items"]] == ["match-2"]


def test_source_filters_are_sent_in_one_listing_request(live):
    asyncio.run(qq.get_filtered(genres=["action", "fantasy"], page=3, status="completed", sort="views_desc"))
    request = live[1][-1]
    assert request.url.path == "/tim-kiem-nang-cao/trang-3"
    assert request.url.params["category"] == "26,30"
    assert "status" in request.url.params
    assert len(live[1]) == 2  # one genre page, one filtered source page


def test_old_chapter_ids_are_rejected_without_contacting_old_api(live):
    with pytest.raises(HTTPException) as error:
        asyncio.run(qq.get_chapter("507f1f77bcf86cd799439011"))
    assert error.value.status_code == 404
    assert not live[1]


def test_chapter_token_supports_real_source_slugs_with_consecutive_hyphens(live):
    slug = "chung-chi-thoi-ma-su--ender-geister-17757"
    assert qq.parse_chapter_token(qq.chapter_token(slug, "45-5")) == (slug, "45-5")
    assert live[0].resolve(slug).endswith("/truyen-tranh/" + slug)
    chapter = asyncio.run(qq.get_chapter(qq.chapter_token(slug, "45-5")))
    assert chapter["data"]["item"]["chapter_image"][0]["image_file"].endswith(f"/{slug}/45-5/1")


def test_admin_preserves_source_page_count_without_guessing_total(live):
    from types import SimpleNamespace
    from fastapi_app.routers.admin import admin_manga_list

    class EmptyDB:
        def __getattr__(self, name):
            if name == "execute":
                return lambda: SimpleNamespace(data=[], count=0)
            return lambda *args, **kwargs: self

    result = asyncio.run(admin_manga_list(page=2, limit=30, search=None,
        source="truyenqq", filter_hidden=None, admin={"role": "admin"}, db=EmptyDB()))
    assert result["total"] is None
    assert result["total_pages"] == 444
    assert result["page"] == 2
    assert result["manga"][0]["source"] == "truyenqq"
