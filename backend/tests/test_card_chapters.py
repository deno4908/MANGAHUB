import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from fastapi_app.routers import manga
from fastapi_app.services import card_chapters as cards, mangadex_service as mdx, truyenqq_service as qq
from truyenapi.truyenapi.client import SourceClient
from truyenapi.truyenapi.config import Settings
from truyenapi.truyenapi.service import LiveService

MDX = "16800ea3-d7cb-4a03-801e-bfbb4dc12bea"
CHAPTER = "22222222-2222-4222-8222-222222222222"
LEGACY = "vo-trong-game-cua-toi-la-idol-noi-tieng-ngoai-doi"
CANONICAL = LEGACY + "-18078"


@pytest.fixture
def memory(monkeypatch):
    store = {}
    monkeypatch.setattr(cards.cache, "get", store.get)
    monkeypatch.setattr(cards.cache, "set", lambda key, value, **kw: store.__setitem__(key, value))
    monkeypatch.setattr(cards.cache, "get_many", lambda keys: {key: store.get(key) for key in keys})
    monkeypatch.setattr(cards.cache, "set_many", lambda items, **kwargs: store.update(items))
    monkeypatch.setattr(cards, "_jobs", {})
    monkeypatch.setattr(cards, "_slots", {"mangadex": asyncio.Semaphore(2), "truyenqq": asyncio.Semaphore(2)})
    monkeypatch.setattr(mdx, "_latest_chapter_info_from_cached_catalog", lambda identifier: None)
    return store


def test_first_response_is_immediate_and_shared_jobs_finish_in_background(memory, monkeypatch):
    gate = asyncio.Event()
    async def slow(path, params):
        await gate.wait()
        assert path == "/chapter" and params["manga"] == MDX
        assert params["limit"] == 1 and "manga[]" not in params
        assert params["translatedLanguage[]"] == "vi"
        return {"data": [{"id": CHAPTER, "attributes": {"chapter": "450", "publishAt": "2026-10-20T00:00:00Z"}}]}
    request = AsyncMock(side_effect=slow)
    monkeypatch.setattr(mdx, "_request_json", request)
    async def check():
        first = await asyncio.wait_for(cards.get_many([MDX]), 0.05)
        assert first[MDX] == {"chapter": None, "pending": True}
        await asyncio.sleep(0.01)
        again = await cards.get_many([MDX, "mdx-" + MDX])
        assert again[MDX]["pending"]
        gate.set()
        await asyncio.gather(*list(cards._jobs.values()))
        ready = await cards.get_many([MDX, "mdx-" + MDX])
        assert ready[MDX]["chapter"]["chapter_name"] == "450"
        assert ready[MDX]["chapter"]["id"] == CHAPTER
        assert not ready[MDX]["pending"]
        assert ready["mdx-" + MDX] == ready[MDX]
    asyncio.run(check())
    request.assert_awaited_once()


def test_warm_qq_aliases_and_mangadex_chapters_need_no_network(memory, monkeypatch):
    qq._item({"id": "18078", "url": f"https://truyenqqko.com/truyen-tranh/{CANONICAL}", "title": "Native title",
              "chapters": [{"number": "46", "url": f"https://truyenqqko.com/truyen-tranh/{CANONICAL}-chap-46"}]})
    memory[mdx._latest_chapter_cache_key(MDX, "vi")] = json.dumps({"id": CHAPTER, "chapter_name": "450", "verified_head": True})
    source = AsyncMock(side_effect=AssertionError("No source request for warm cards"))
    monkeypatch.setattr(qq, "run_live", source)
    monkeypatch.setattr(mdx, "_request_json", source)
    old_id = "65b1234567890abcdef12345"
    result = asyncio.run(cards.get_many([LEGACY, CANONICAL, MDX, old_id]))
    assert result[LEGACY] == result[CANONICAL]
    assert result[LEGACY]["chapter"]["chapter_name"] == "46"
    assert result[MDX]["chapter"]["chapter_name"] == "450"
    assert result[old_id]["state"] == "unavailable"
    assert not cards._jobs
    source.assert_not_awaited()


def test_source_concurrency_is_bounded_even_for_a_whole_page(memory, monkeypatch):
    active, maximum = 0, 0
    gate = asyncio.Event()
    async def slow(*args, **kwargs):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await gate.wait()
        active -= 1
        return {}
    monkeypatch.setattr(mdx, "_get_latest_vi_chapter_for_manga", slow)
    async def check():
        ids = [f"11111111-1111-4111-8111-{number:012d}" for number in range(24)]
        await cards.get_many(ids)
        await asyncio.sleep(0.01)
        assert maximum == 2
        gate.set()
        await asyncio.gather(*list(cards._jobs.values()))
    asyncio.run(check())


def test_incomplete_search_card_does_not_hide_real_qq_latest_chapter():
    url = "https://truyenqqko.com/truyen-tranh/book-123"
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, text='''<div class="book_info"><h1>Book</h1></div><input id="book_id" value="123">
          <div class="works-chapter-list"><div class="works-chapter-item"><a href="/truyen-tranh/book-123-chap-46">Chapter 46</a></div></div>''')
    settings = Settings(base_url="https://truyenqqko.com", request_delay=0, retries=1)
    client = SourceClient(settings)
    client.http.close()
    client.http = httpx.Client(transport=httpx.MockTransport(handler))
    service = LiveService(settings, client=client)
    service.remember_cards([{"id": "123", "slug": "book", "url": url, "title": "Book", "latest_chapter": None}])
    try:
        assert service.basic("book-123")["latest_chapter"] is None
        result = service.basic_latest("book-123")
        assert result["latest_chapter"]["number"] == "46"
        assert "chapters" not in result and "comments" not in result
        assert service.basic_latest("book-123")["latest_chapter"]["number"] == "46"
        assert len(calls) == 1
    finally:
        service.close()


def test_time_ago_text_is_never_fabricated_as_a_chapter_number():
    assert qq._chapter({"title": "3 giờ trước"}, "book-123")["chapter_api_data"] == ""
    assert qq._chapter({"title": "Chapter 45.5"}, "book-123")["chapter_name"] == "45.5"


def test_recent_update_fragment_is_verified_against_real_highest_chapter(memory, monkeypatch):
    memory[mdx._latest_chapter_cache_key(MDX, "vi")] = json.dumps({"id": CHAPTER, "chapter_name": "37"})
    source = AsyncMock(return_value={"data": [{"id": CHAPTER, "attributes": {"chapter": "44"}}]})
    monkeypatch.setattr(mdx, "_request_json", source)
    async def check():
        preview = await cards.get_many([MDX])
        assert preview[MDX]["pending"] and preview[MDX]["chapter"]["chapter_name"] == "37"
        await asyncio.gather(*list(cards._jobs.values()))
        latest = await cards.get_many([MDX])
        assert latest[MDX]["chapter"]["chapter_name"] == "44" and not latest[MDX]["pending"]
    asyncio.run(check())
    source.assert_awaited_once()


def test_oneshot_keeps_real_title_and_is_not_invented_as_chapter_zero(memory, monkeypatch):
    source = AsyncMock(return_value={"data": [{"id": CHAPTER, "attributes": {"chapter": None, "title": "Oneshot"}}]})
    monkeypatch.setattr(mdx, "_request_json", source)
    async def check():
        await cards.get_many([MDX])
        await asyncio.gather(*list(cards._jobs.values()))
        latest = (await cards.get_many([MDX]))[MDX]["chapter"]
        assert latest["chapter_name"] == "" and latest["chapter_title"] == "Oneshot"
        assert latest["id"] == CHAPTER
    asyncio.run(check())


def test_endpoint_masks_hidden_canonical_qq_alias(memory, monkeypatch):
    app = FastAPI()
    app.include_router(manga.router, prefix="/api/manga")
    app.dependency_overrides[manga.get_supabase_public] = lambda: object()
    monkeypatch.setattr(manga, "_get_hidden_slugs", AsyncMock(return_value={CANONICAL: "hidden"}))
    qq._item({"id": "18078", "url": f"https://truyenqqko.com/truyen-tranh/{CANONICAL}", "title": "Book",
              "latest_chapter": {"number": "46"}})
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/manga/chapters/latest/batch", json={"identifiers": [LEGACY]})
            assert response.json() == {"items": {LEGACY: {"chapter": None, "pending": False}}}
    asyncio.run(check())


def test_transient_failure_retries_but_a_missing_qq_book_is_explicit(memory, monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(qq, "run_live", AsyncMock(side_effect=HTTPException(404, "Not found")))
    async def missing():
        await cards.get_many([LEGACY])
        await asyncio.gather(*list(cards._jobs.values()))
        result = (await cards.get_many([LEGACY]))[LEGACY]
        assert result == {"chapter": None, "pending": False, "state": "unavailable"}
    asyncio.run(missing())
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(side_effect=RuntimeError("Temporary outage")))
    async def failure():
        await cards.get_many([MDX])
        await asyncio.gather(*list(cards._jobs.values()))
        result = (await cards.get_many([MDX]))[MDX]
        assert result["state"] == "retry" and result["retry_after"] == 30_000
    asyncio.run(failure())


def test_slow_qq_card_hydration_cannot_occupy_reader_workers(monkeypatch):
    gate = threading.Event()
    entered = threading.Event()
    active = 0
    lock = threading.Lock()
    def slow(identifier):
        nonlocal active
        with lock:
            active += 1
            if active == 2:
                entered.set()
        gate.wait(2)
        return {}
    live = SimpleNamespace(basic_latest=slow, chapter=lambda: threading.current_thread().name)
    monkeypatch.setattr(qq, "get_live", lambda: live)
    with ThreadPoolExecutor(2, thread_name_prefix="test-cards") as card_pool, ThreadPoolExecutor(1, thread_name_prefix="test-reader") as reader_pool:
        monkeypatch.setattr(qq, "_card_executor", card_pool)
        monkeypatch.setattr(qq, "_reader_executor", reader_pool)
        async def check():
            tasks = [asyncio.create_task(qq.run_live("basic_latest", str(index))) for index in range(2)]
            try:
                await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
                reader = await asyncio.wait_for(qq.run_live("chapter"), 0.2)
                assert reader.startswith("test-reader")
                assert not any(task.done() for task in tasks)
            finally:
                gate.set()
                await asyncio.gather(*tasks)
        asyncio.run(check())
