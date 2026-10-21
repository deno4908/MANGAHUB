import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from fastapi_app.routers import manga
from fastapi_app.services import card_metadata as cards, mangadex_service as mdx, truyenqq_service as qq


MDX_ID = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
MDX_ID_2 = "5272da37-6c69-4ecc-a1e0-d25db7b3e80f"
LEGACY = "vo-trong-game-cua-toi-la-idol-noi-tieng-ngoai-doi"
TITLE = "Vợ Trong Game Của Tôi Là Idol Nổi Tiếng Ngoài Đời"


@pytest.fixture
def memory(monkeypatch):
    values = {}
    monkeypatch.setattr(cards.cache, "get", lambda key: values.get(key))
    monkeypatch.setattr(cards.cache, "set", lambda key, value, **kwargs: values.__setitem__(key, value))
    monkeypatch.setattr(cards.cache, "get_many", lambda keys: {key: values.get(key) for key in keys})
    monkeypatch.setattr(cards.cache, "set_many", lambda items, **kwargs: values.update(items))
    monkeypatch.setattr(cards, "_qq_slots", asyncio.Semaphore(3))
    return values


def native_qq():
    return {"id": "18078", "url": f"https://truyenqqno.com/truyen-tranh/{LEGACY}-18078",
            "title": TITLE, "genres": ["Romance"], "cover_urls": ["https://example.com/cover.jpg"],
            "view_count": 90000000}


def test_native_qq_card_warms_legacy_alias_without_chapter_crawl(memory, monkeypatch):
    native = qq._item(native_qq())
    source = AsyncMock(side_effect=AssertionError("Cached cards must not crawl source"))
    monkeypatch.setattr(qq, "run_live", source)
    result = asyncio.run(cards.get_many([LEGACY, native["slug"]]))
    assert result[LEGACY] == result[native["slug"]]
    assert result[LEGACY]["title"] == TITLE
    assert result[LEGACY]["slug"] == LEGACY + "-18078"
    assert "views" not in result[LEGACY]
    assert "view_count" not in result[LEGACY]
    source.assert_not_awaited()


def test_uncached_legacy_qq_uses_basic_and_reuses_authoritative_title(memory, monkeypatch):
    source = AsyncMock(return_value=native_qq())
    monkeypatch.setattr(qq, "run_live", source)
    async def check():
        first, second = await asyncio.gather(cards.get_many([LEGACY]), cards.get_many([LEGACY]))
        assert first[LEGACY]["title"] == second[LEGACY]["title"] == TITLE
        assert (await cards.get_many([LEGACY]))[LEGACY]["title"] == TITLE
    asyncio.run(check())
    source.assert_awaited_once_with("basic", LEGACY)


def test_mangadex_repairs_many_ids_in_one_metadata_request(memory, monkeypatch):
    def raw(identifier):
        return {"id": identifier, "attributes": {"title": {"en": "Original title"},
                "altTitles": [{"vi": "Vợ tôi là quỷ vương"}], "status": "completed", "contentRating": "safe"},
                "relationships": [{"type": "cover_art", "attributes": {"fileName": "cover.jpg"}}]}
    source = AsyncMock(return_value={"data": [raw(MDX_ID), raw(MDX_ID_2)]})
    monkeypatch.setattr(mdx, "_request_json", source)
    async def check():
        result = await cards.get_many([MDX_ID, "mdx-" + MDX_ID, MDX_ID_2, MDX_ID])
        assert set(result) == {MDX_ID, "mdx-" + MDX_ID, MDX_ID_2}
        assert result[MDX_ID]["title"] == "Vợ tôi là quỷ vương"
        assert result["mdx-" + MDX_ID] == result[MDX_ID]
        assert (await cards.get_many([MDX_ID]))[MDX_ID]["title"] == "Vợ tôi là quỷ vương"
        repaired = manga._filter_trending_items([{"slug": MDX_ID, "title": "MangaDex 16800ea3", "views": 106}])[0]
        assert repaired["title"] == "Vợ tôi là quỷ vương" and repaired["views"] == 106
    asyncio.run(check())
    assert source.await_count == 1
    path, params = source.call_args.args
    assert path == "/manga"  # no per-card detail/feed/chapter requests
    assert set(params["ids[]"]) == {MDX_ID, MDX_ID_2}
    assert "cover_art" in params["includes[]"]


def test_trending_cached_title_repair_keeps_identity_and_local_statistics(memory):
    qq._item(native_qq())
    item = {"slug": LEGACY, "title": "Vo Trong Game Cua Toi La Idol Noi", "views": 50,
            "rating": 4.5, "rating_count": 3, "thumb": "old.jpg"}
    repaired = manga._filter_trending_items([item])[0]
    assert repaired["title"] == TITLE
    assert repaired["views"] == 50
    assert repaired["rating"] == 4.5 and repaired["rating_count"] == 3
    assert repaired["slug"] == LEGACY
    assert item["title"] == "Vo Trong Game Cua Toi La Idol Noi"
    assert manga._filter_trending_items([item], hidden={LEGACY + "-18078": "hidden"}) == []


def test_slow_source_does_not_hold_ready_titles_and_finishes_shared_cache(memory, monkeypatch):
    monkeypatch.setattr(cards, "_BATCH_WAIT_SECONDS", 0.02)
    gate = asyncio.Event()
    async def slow_basic(*args):
        await gate.wait()
        return native_qq()
    source = AsyncMock(side_effect=slow_basic)
    monkeypatch.setattr(qq, "run_live", source)
    memory[f"catalog:card-metadata:v1:{MDX_ID}"] = json.dumps({"id": MDX_ID, "title": "Vợ tôi là quỷ vương"})
    async def check():
        first = await asyncio.wait_for(cards.get_many([MDX_ID, LEGACY]), 0.2)
        assert first == {MDX_ID: {"id": MDX_ID, "title": "Vợ tôi là quỷ vương"}}
        gate.set()
        second = await cards.get_many([MDX_ID, LEGACY])
        assert second[LEGACY]["title"] == TITLE
        assert LEGACY not in first  # returned snapshot is not mutated later
    asyncio.run(check())
    source.assert_awaited_once_with("basic", LEGACY)


def test_unavailable_book_never_guesses_another_title(memory, monkeypatch):
    source = AsyncMock(side_effect=httpx.ReadTimeout("Temporary failure"))
    # run_live converts source errors to HTTPException; exercise that contract here.
    from fastapi import HTTPException
    source.side_effect = HTTPException(502, "Temporary source failure")
    monkeypatch.setattr(qq, "run_live", source)
    async def check():
        result = await cards.get_many(["65b1234567890abcdef12345", LEGACY])
        assert result == {"65b1234567890abcdef12345": None}
    asyncio.run(check())


def test_metadata_endpoint_validates_input_and_filters_hidden_aliases(memory, monkeypatch):
    app = FastAPI()
    app.include_router(manga.router, prefix="/api/manga")
    app.dependency_overrides[manga.get_supabase_public] = lambda: object()
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={LEGACY + "-18078": "hidden"}))
    qq._item(native_qq())
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/manga/metadata/batch", json={"identifiers": [LEGACY]})
            assert response.status_code == 200
            assert response.json() == {"items": {LEGACY: None}}
            for ids in (["https://example.com/title"], ["x"] * 49, ["x" * 201]):
                response = await client.post("/api/manga/metadata/batch", json={"identifiers": ids})
                assert response.status_code == 422
    asyncio.run(check())
