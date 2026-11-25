import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fastapi_app.routers import manga
from fastapi_app.services import truyenqq_service as qq

LEGACY = "toi-tro-thanh-nguoi-duoc-nu-phan-dien-yeu-thich-nhat"
CANONICAL = LEGACY + "-23163"
URL = "https://truyenqqko.com/truyen-tranh/" + CANONICAL


@pytest.fixture
def cached(monkeypatch):
    values = {}
    monkeypatch.setattr(qq.cache, "get", values.get)
    monkeypatch.setattr(qq.cache, "get_many", lambda keys: {key: values.get(key) for key in keys})
    monkeypatch.setattr(qq.cache, "set", lambda key, value, *args, **kwargs: values.__setitem__(key, value))
    monkeypatch.setattr(qq.cache, "set_many", lambda items, **kwargs: values.update(items))
    return values


def native():
    return {"id": "23163", "url": URL, "title": "Legacy comic", "cover_urls": ["https://img.example/cover.jpg"],
            "chapters": [{"number": "49", "url": URL + "-chap-49"}]}


def test_legacy_detail_uses_shared_qq_reference_and_keeps_local_identity(cached, monkeypatch):
    cached["truyenqq:cover-hint:" + LEGACY] = json.dumps({"url": URL})

    async def source(method, identifier):
        assert (method, identifier) == ("comic", CANONICAL)  # no sitemap crawl
        return native()

    fetch = AsyncMock(side_effect=source)
    monkeypatch.setattr(qq, "run_live", fetch)

    async def check():
        results = await asyncio.gather(qq.get_manga_detail(LEGACY), qq.get_manga_detail(LEGACY))
        item = results[0]["data"]["item"]
        assert item["slug"] == item["id"] == LEGACY
        assert item["source_slug"] == CANONICAL
        assert item["chapters"][0]["server_data"][0]["chapter_api_data"].endswith(f"qq--{CANONICAL}--49")
        item["name"] = "Request-local change"
        assert (await qq.get_manga_detail(LEGACY))["data"]["item"]["name"] == "Legacy comic"

    asyncio.run(check())
    fetch.assert_awaited_once()


def test_native_qq_detail_keeps_native_id_and_ignores_unrelated_reference(cached, monkeypatch):
    cached["truyenqq:cover-hint:" + CANONICAL] = json.dumps({"url": "https://truyenqqko.com/truyen-tranh/other-9"})
    fetch = AsyncMock(return_value=native())
    monkeypatch.setattr(qq, "run_live", fetch)
    item = asyncio.run(qq.get_manga_detail(CANONICAL))["data"]["item"]
    assert item["slug"] == CANONICAL
    fetch.assert_awaited_once_with("comic", CANONICAL)


def test_verified_alternative_title_survives_another_function_cold_start(cached, monkeypatch):
    alias = "saved-alternative-title"
    cached["catalog:card-metadata:v1:" + alias] = json.dumps({
        "id": CANONICAL, "slug": CANONICAL, "source": "truyenqq", "title": "A different source name"})
    source = AsyncMock(return_value=native())
    monkeypatch.setattr(qq, "run_live", source)
    async def run():
        item = (await qq.get_manga_detail(alias))["data"]["item"]
        assert item["slug"] == item["id"] == alias
        assert item["source_slug"] == CANONICAL
        await qq.get_cover_info(alias)
    asyncio.run(run())
    # The detail read just stored verified cover hints. Reuse them instead of
    # spending a second source request merely to recover the same cover.
    source.assert_awaited_once_with("comic", CANONICAL)


def test_legacy_route_cannot_bypass_a_hidden_native_qq_comic(cached, monkeypatch):
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={CANONICAL: "blocked"}))
    monkeypatch.setattr(manga, "_safe_query", lambda query: None)
    monkeypatch.setattr(qq, "get_manga_detail", AsyncMock(return_value={"data": {"item": {
        "slug": LEGACY, "source_slug": CANONICAL}}}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(manga.manga_detail(LEGACY, db=object()))
    assert error.value.status_code == 451


def test_detail_reads_existing_views_using_the_legacy_database_key(cached, monkeypatch):
    lookups = []

    class Query:
        def __init__(self, table):
            self.table = table

        def __getattr__(self, method):
            if method == "execute":
                return lambda: SimpleNamespace(data={"views": 83}) if self.table == "manga_views" else None
            def chain(*args, **kwargs):
                if self.table == "manga_views" and method == "eq":
                    lookups.append(args)
                return self
            return chain

    db = SimpleNamespace(table=lambda name: Query(name))
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(manga, "_fetch_override_rows_by_slugs", AsyncMock(return_value={}))
    monkeypatch.setattr(qq, "get_manga_detail", AsyncMock(return_value={"data": {"item": {
        "slug": LEGACY, "id": LEGACY, "source_slug": CANONICAL, "chapters": []}}}))
    item = asyncio.run(manga.manga_detail(LEGACY, db=db))["data"]["item"]
    assert item["slug"] == LEGACY
    assert item["view_count"] == item["local_view_count"] == item["views"] == 83
    assert lookups == [("manga_slug", LEGACY)]


def test_search_reuses_shared_results_without_repeating_a_source_request(cached, monkeypatch):
    fetch = AsyncMock(return_value={"items": [native()]})
    monkeypatch.setattr(qq, "run_live", fetch)

    async def check():
        first, duplicate = await asyncio.gather(qq.search_manga("Legacy"), qq.search_manga("Legacy"))
        first["data"]["items"].clear()
        assert duplicate["data"]["items"][0]["slug"] == CANONICAL
        assert (await qq.search_manga("legacy"))["data"]["items"][0]["slug"] == CANONICAL

    asyncio.run(check())
    fetch.assert_awaited_once_with("search", "Legacy")
