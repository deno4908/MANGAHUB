import asyncio
import copy
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, Mock

import fakeredis
import pytest
from redis_runtime import client_for

from fastapi_app.services import mangadex_release_index as index
from fastapi_app.services import mangadex_service as mdx, cache_service


def mid(n):
    return f"{n:08x}-1111-4111-8111-111111111111"


def chapter(n, book=None, **attrs):
    stamp = (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=n)).isoformat()
    return {"id": mid(100000 + n), "attributes": {"createdAt": stamp, "updatedAt": stamp,
        "publishAt": stamp, "readableAt": stamp, "chapter": str(n), "translatedLanguage": "vi", **attrs},
        "relationships": [{"type": "manga", "id": mid(book or n), "attributes": {
            "title": {"en": f"Book {book or n}"}, "status": "ongoing", "contentRating": "safe",
            "tags": [{"id": "action-id", "attributes": {"name": {"en": "Action"}}}],
        }}]}


def state(rows):
    return {"schema": 1, "language": "vi", "rows": {index.manga_relation(row)["id"]: row for row in rows},
            "ready": True, "watermark": "2026-01-01T00:00:00", "version": uuid.uuid4().hex,
            "last_checked": time.time(), "last_full_sync": time.time()}


@pytest.fixture
def store(monkeypatch):
    client = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(index, "_client", lambda: client)
    monkeypatch.setattr(index, "_seed", lambda: None)
    monkeypatch.setattr(index, "REFRESH_PAUSE_SECONDS", 0)
    monkeypatch.setattr(mdx, "cache", Mock(get=Mock(return_value=None)))
    monkeypatch.setattr(cache_service, "cache", Mock(get=Mock(return_value=None)))
    monkeypatch.setattr(mdx, "_get_mangadex_tag_id_by_slug", AsyncMock(return_value={"action": "action-id"}))
    monkeypatch.setattr(mdx, "_fetch_cover_urls_for_manga_ids", AsyncMock(return_value={}))
    index._local.clear()
    yield client
    index._local.clear()


def put(client, value):
    client.set(index.PREFIX + "state", index._pack(value))


def ids(result):
    return [item["slug"] for item in result["data"]["items"]]


def test_full_pages_are_unique_and_never_rescan_chapters_on_deep_links(store, monkeypatch):
    put(store, state([chapter(n) for n in range(1, 2001)]))
    source = AsyncMock(side_effect=AssertionError("index pages must not crawl upstream chapter history"))
    monkeypatch.setattr(mdx, "_request_json", source)

    async def check():
        first = await mdx.get_latest_vi_chapter_feed(limit=24)
        second = await mdx.get_latest_vi_chapter_feed(page=2, limit=24, feed_snapshot=first["data"]["feed_snapshot"])
        deep = await mdx.get_latest_vi_chapter_feed(page=70, limit=24)
        return first, second, deep

    first, second, deep = asyncio.run(check())
    assert len(ids(first)) == len(set(ids(first))) == 24
    assert len(ids(second)) == len(ids(deep)) == 24
    assert not set(ids(first)) & set(ids(second))
    assert ids(deep) == [mid(n) for n in range(344, 320, -1)]
    assert deep["data"]["params"]["pagination"]["unit"] == "manga"
    source.assert_not_called()


def test_hidden_mature_genre_and_status_filters_are_applied_before_slicing(store):
    rows = [chapter(n) for n in range(1, 101)]
    for row in rows[70:]:
        index.manga_relation(row)["attributes"]["contentRating"] = "erotica"
    index.manga_relation(rows[69])["attributes"]["status"] = "completed"
    index.manga_relation(rows[68])["attributes"]["tags"] = []
    put(store, state(rows))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24, excluded_manga_ids=[mid(68)],
        included_tag_slugs=["action"], statuses=["ongoing"]))
    assert ids(result) == [mid(n) for n in range(67, 43, -1)]
    assert len(ids(result)) == 24
    assert result["data"]["params"]["pagination"]["totalItems"] == 67


def test_last_page_is_the_only_short_page_and_totals_count_titles(store):
    put(store, state([chapter(n) for n in range(1, 51)]))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(page=3, limit=24))
    assert ids(result) == [mid(2), mid(1)]
    assert result["data"]["params"]["pagination"]["totalItems"] == 50


def test_keyword_filter_stays_on_the_vietnamese_index(store, monkeypatch):
    put(store, state([chapter(n) for n in range(1, 61)]))
    source = AsyncMock(side_effect=AssertionError("must not substitute an all-language title search"))
    monkeypatch.setattr(mdx, "search_manga", source)
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24, keyword="Book 1"))
    assert len(ids(result)) == 11
    assert all("Book 1" in item["name"] for item in result["data"]["items"])
    source.assert_not_called()


def test_snapshot_keeps_page_boundaries_when_another_title_gets_a_new_release(store):
    old = state([chapter(n) for n in range(1, 51)])
    put(store, old)
    first = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    newer = state([*old["rows"].values(), chapter(500, book=1)])
    put(store, newer)
    index._local.clear()
    second = asyncio.run(mdx.get_latest_vi_chapter_feed(page=2, limit=24, feed_snapshot=first["data"]["feed_snapshot"]))
    assert ids(second) == [mid(n) for n in range(26, 2, -1)]
    assert not set(ids(first)) & set(ids(second))


def test_shared_live_probe_updates_first_page_without_changing_old_snapshots(store, monkeypatch):
    put(store, state([chapter(n) for n in range(1, 51)]))
    first = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    newer = chapter(500, book=1, chapter="2")
    english = chapter(600, book=2, translatedLanguage="en")
    probe = {"data": [newer, english, chapter(100, book=1)]}
    monkeypatch.setattr(cache_service.cache, "get", Mock(return_value=json.dumps(probe)))
    index.invalidate_active()
    latest = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    assert ids(latest)[0] == mid(1)
    assert latest["data"]["items"][0]["chaptersLatest"][0]["chapter_name"] == "2"
    assert latest["data"]["feed_snapshot"] != first["data"]["feed_snapshot"]
    second = asyncio.run(mdx.get_latest_vi_chapter_feed(page=2, limit=24, feed_snapshot=first["data"]["feed_snapshot"]))
    assert ids(second) == [mid(n) for n in range(26, 2, -1)]
    assert not set(ids(first)) & set(ids(second))


def test_bootstrap_cursor_crosses_ten_thousand_rows_and_mass_uploads_still_give_full_pages(store, monkeypatch):
    rows = [chapter(n, book=1) for n in range(1, 10101)]
    rows.extend(chapter(n, book=n - 10099) for n in range(10101, 10149))
    calls = []

    async def source(path, params):
        calls.append(params)
        assert path == "/chapter" and params["translatedLanguage[]"] == "vi"
        assert params["offset"] + params["limit"] <= 10000
        since = params.get("createdAtSince", "")
        matching = [row for row in rows if row["attributes"]["createdAt"][:19] >= since]
        offset = params["offset"]
        return {"data": matching[offset:offset + params["limit"]], "total": len(matching)}

    monkeypatch.setattr(mdx, "_request_json", source)
    asyncio.run(index.refresh_step(budget=20))
    ready = index._unpack(store.get(index.PREFIX + "state"))
    assert ready["ready"] and len(ready["rows"]) == 49
    assert len(calls) > 100
    first = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    second = asyncio.run(mdx.get_latest_vi_chapter_feed(page=2, limit=24))
    assert len(ids(first)) == len(ids(second)) == 24
    assert not set(ids(first)) & set(ids(second))


def test_incremental_refresh_uses_vietnamese_readable_time_not_chapter_number_or_other_languages(store, monkeypatch):
    old = state([chapter(1, chapter="99"), chapter(2)])
    old["last_checked"] = 0
    put(store, old)
    new = chapter(100, book=1, chapter="2")
    english = chapter(200, book=2, translatedLanguage="en")
    source = AsyncMock(return_value={"data": [new, english]})
    monkeypatch.setattr(mdx, "_request_json", source)
    asyncio.run(index.refresh_step())
    assert source.call_args.args[1]["updatedAtSince"] == old["watermark"]
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    assert ids(result)[0] == mid(1)
    assert result["data"]["items"][0]["chaptersLatest"][0]["chapter_name"] == "2"
    assert result["data"]["items"][0]["chaptersLatest"][0]["translated_language"] == "vi"
    assert index._unpack(store.get(index.PREFIX + "state"))["rows"][mid(2)]["id"] != english["id"]


def test_refresh_failure_and_lost_lease_do_not_replace_the_active_index(store, monkeypatch):
    old = state([chapter(1)])
    old["last_checked"] = 0
    put(store, old)
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(side_effect=RuntimeError("source unavailable")))
    with pytest.raises(RuntimeError):
        asyncio.run(index.refresh_step())
    assert index._unpack(store.get(index.PREFIX + "state"))["version"] == old["version"]

    async def lost(*args):
        store.set(index.PREFIX + "lease", "new-owner")
        return {"data": [chapter(100)]}
    monkeypatch.setattr(mdx, "_request_json", lost)
    asyncio.run(index.refresh_step())
    assert store.get(index.PREFIX + "lease") == "new-owner"
    assert index._unpack(store.get(index.PREFIX + "state"))["version"] == old["version"]


def test_refresh_runs_only_after_the_response_body(monkeypatch):
    import serverless_runtime
    events = []

    async def app(scope, receive, send):
        index.request_refresh()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ready"})

    async def refresh():
        await asyncio.sleep(0)
        events.append("refresh")
    async def send(message):
        events.append(message["type"])
    monkeypatch.setattr(index, "refresh_step", refresh)
    monkeypatch.setattr(serverless_runtime, "IS_VERCEL", True)
    wrapped = serverless_runtime.RequestTasksMiddleware(index.ReleaseIndexMiddleware(app))
    asyncio.run(wrapped({"type": "http"}, None, send))
    assert events == ["http.response.start", "http.response.body", "refresh"]


def test_compaction_never_persists_uploader_profiles():
    row = chapter(1)
    row["relationships"].append({"type": "user", "id": "uploader", "attributes": {"username": "not-needed"}})
    assert all(rel["type"] != "user" for rel in index.compact(row)["relationships"])


def test_large_index_io_uses_a_separate_pool_from_authentication():
    url = "rediss://default:unused@example.invalid:6379/0"
    auth = client_for(url)
    catalog = client_for(url, socket_timeout_seconds=3)
    assert catalog is not auth
    assert catalog.connection_pool is not auth.connection_pool
    assert catalog.connection_pool.connection_kwargs["socket_timeout"] == 3
    assert catalog.connection_pool.connection_kwargs["ssl_cert_reqs"] == "required"


def test_content_text_filters_are_applied_before_filling_safe_pages(store):
    rows = [chapter(n) for n in range(1, 51)]
    index.manga_relation(rows[-1])["attributes"]["title"] = {"en": "Adult-only title"}
    put(store, state(rows))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=24))
    assert len(ids(result)) == 24
    assert mid(50) not in ids(result)
    assert result["data"]["params"]["pagination"]["totalItems"] == 49


def test_empty_full_rebuild_cannot_erase_the_known_catalog(store, monkeypatch):
    old = state([chapter(1)])
    old.update(last_checked=0, last_full_sync=0)
    put(store, old)
    monkeypatch.setattr(mdx, "_request_json", AsyncMock(return_value={"data": [], "total": 0}))
    with pytest.raises(RuntimeError):
        asyncio.run(index.refresh_step())
    assert index._unpack(store.get(index.PREFIX + "state"))["version"] == old["version"]
