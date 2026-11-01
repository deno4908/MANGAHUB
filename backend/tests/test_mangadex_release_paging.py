"""Release ordering must be applied before filtering/deduplicating title pages."""
import asyncio
import copy
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, Mock

import pytest

from fastapi_app.services import mangadex_service as mdx


def identifier(number):
    return f"{number:08x}-1111-4111-8111-111111111111"


def release(number, *, manga=None, chapter="1", tags=("action-id",), status="ongoing", language="vi"):
    stamp = (datetime(2026, 10, 27, tzinfo=timezone.utc) - timedelta(minutes=number)).isoformat()
    return {"id": identifier(10000 + number), "attributes": {
        "chapter": chapter, "translatedLanguage": language, "readableAt": stamp,
        # Import/publication timestamps can predate the actual readable release.
        "publishAt": "2020-01-01T00:00:00Z", "updatedAt": "2021-01-01T00:00:00Z",
    }, "relationships": [{"type": "manga", "id": identifier(manga or number), "attributes": {
        "title": {"en": f"Title {manga or number}"}, "status": status,
        "contentRating": "safe", "tags": [{"id": tag} for tag in tags],
    }}]}


@pytest.fixture
def source(monkeypatch):
    store, calls, rows = {}, [], []
    fake_cache = Mock()
    fake_cache.get.side_effect = store.get
    fake_cache.set.side_effect = lambda key, value, **kw: store.__setitem__(key, value)

    def add(key, value, **kw):
        if key in store:
            return False
        store[key] = value
        return True

    fake_cache.add.side_effect = add
    fake_cache.delete.side_effect = lambda key: store.pop(key, None)
    monkeypatch.setattr(mdx, "cache", fake_cache)
    monkeypatch.setattr(mdx, "_live_revision", lambda: "test")
    monkeypatch.setattr(mdx, "LATEST_FEED_CHAPTER_PAGE_SIZE", 24)
    monkeypatch.setattr(mdx, "_get_mangadex_tag_id_by_slug", AsyncMock(return_value={"action": "action-id"}))
    monkeypatch.setattr(mdx, "_fetch_cover_urls_for_manga_ids", AsyncMock(return_value={}))

    async def request(path, params=None):
        calls.append((path, copy.deepcopy(params)))
        if path == "/manga":
            return {"total": 48, "data": []}
        start = params["offset"]
        return {"total": len(rows), "data": copy.deepcopy(rows[start:start + params["limit"]])}

    monkeypatch.setattr(mdx, "_request_json", request)
    return rows, calls, store


def ids(result):
    return [item["slug"] for item in result["data"]["items"]]


def test_genre_status_title_and_language_are_applied_before_unique_paging(source):
    rows, calls, _ = source
    # Interleave nonmatching genres/statuses with one matching title per 4 rows.
    for number in range(1, 145):
        rows.append(release(number, tags=("action-id",) if number % 4 == 0 else ("romance-id",),
                            status="ongoing" if number % 8 == 0 else "completed"))
    rows.insert(0, release(0, manga=999, language="en"))
    options = dict(limit=3, included_tag_slugs=["action"], statuses=["ongoing"], keyword="Title")

    async def check():
        first = await mdx.get_latest_vi_chapter_feed(**options)
        second = await mdx.get_latest_vi_chapter_feed(page=2, feed_snapshot=first["data"]["feed_snapshot"], **options)
        return first, second

    first, second = asyncio.run(check())
    assert ids(first) == [identifier(n) for n in (8, 16, 24)]
    assert ids(second) == [identifier(n) for n in (32, 40, 48)]
    assert not set(ids(first)) & set(ids(second))
    assert first["data"]["params"]["pagination"]["totalItems"] == 48
    count_params = next(params for path, params in calls if path == "/manga")
    assert count_params["includedTags[]"] == ["action-id"]
    assert count_params["includedTagsMode"] == "AND"
    assert count_params["status[]"] == ["ongoing"]
    assert count_params["title"] == "Title"
    for path, params in calls:
        if path == "/chapter":
            assert params["translatedLanguage[]"] == "vi"
            assert params["order[readableAt]"] == "desc"


def test_release_date_wins_over_chapter_number_and_metadata_date(source):
    rows, _, store = source
    rows.extend([release(1, manga=1, chapter="2"), release(2), release(3, manga=1, chapter="99")])
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=2))
    assert ids(result) == [identifier(1), identifier(2)]
    chapter = result["data"]["items"][0]["chaptersLatest"][0]
    assert chapter["chapter_name"] == "2"
    assert chapter["publish_at"] == rows[0]["attributes"]["readableAt"]
    assert chapter["updated_at"] == chapter["publish_at"]
    # Release cards must not overwrite highest-number chapter caches used elsewhere.
    assert not any("latest-chapter" in key for key in store)


def test_unnumbered_release_keeps_its_native_chapter_and_timestamp(source):
    rows, _, _ = source
    rows.append(release(1, chapter=""))
    rows[0]["attributes"]["title"] = "One shot"
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=1))
    chapter = result["data"]["items"][0]["chaptersLatest"][0]
    assert chapter["chapter_name"] == ""
    assert chapter["chapter_title"] == "One shot"
    assert chapter["chapter_api_data"] == rows[0]["id"]
    assert chapter["publish_at"] == rows[0]["attributes"]["readableAt"]


def test_hidden_titles_removed_before_slice_and_mass_upload_deduplicated(source):
    rows, _, _ = source
    rows.extend([release(n, manga=1) for n in range(1, 31)])
    rows.extend(release(n, manga=n) for n in range(31, 60))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=2, excluded_manga_ids=[identifier(31)], included_tag_slugs=["action"]))
    assert ids(result) == [identifier(1), identifier(32)]


def test_frozen_chunks_survive_new_head_release_and_clock_minute_change(source, monkeypatch):
    rows, calls, _ = source
    rows.extend(release(n) for n in range(1, 90))
    now = 1_800_000_000
    monkeypatch.setattr(mdx.time, "time", lambda: now)

    async def check():
        first = await mdx.get_latest_vi_chapter_feed(limit=24, included_tag_slugs=["action"])
        rows.insert(0, release(0, manga=900))
        monkeypatch.setattr(mdx.time, "time", lambda: now + 120)
        second = await mdx.get_latest_vi_chapter_feed(page=2, limit=24, feed_snapshot=first["data"]["feed_snapshot"], included_tag_slugs=["action"])
        return first, second

    first, second = asyncio.run(check())
    assert ids(first) == [identifier(n) for n in range(1, 25)]
    assert ids(second) == [identifier(n) for n in range(25, 49)]
    assert first["data"]["feed_snapshot"] == second["data"]["feed_snapshot"]
    assert sum(path == "/chapter" and params["offset"] == 0 for path, params in calls) == 1


def test_sparse_filter_can_scan_more_than_the_old_thirty_batch_cutoff(source):
    rows, _, _ = source
    rows.extend(release(n, tags=()) for n in range(1, 24 * 31))
    rows.append(release(24 * 31))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=1, included_tag_slugs=["action"]))
    assert ids(result) == [identifier(24 * 31)]


def test_unknown_genre_does_not_fall_back_to_all_titles(source):
    rows, calls, _ = source
    rows.append(release(1))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(included_tag_slugs=["unknown"]))
    assert ids(result) == []
    assert calls == []


def test_later_page_reuses_the_completed_filtered_window_without_rescanning(source, monkeypatch):
    rows, calls, _ = source
    rows.extend(release(n) for n in range(1, 200))

    async def check():
        fifth = await mdx.get_latest_vi_chapter_feed(page=5, limit=24, included_tag_slugs=["action"])
        prior_calls = len(calls)
        # Reading an earlier page of the same window needs no upstream calls.
        third = await mdx.get_latest_vi_chapter_feed(page=3, limit=24, feed_snapshot=fifth["data"]["feed_snapshot"], included_tag_slugs=["action"])
        assert len(calls) == prior_calls
        return fifth, third

    fifth, third = asyncio.run(check())
    assert ids(fifth) == [identifier(n) for n in range(97, 121)]
    assert ids(third) == [identifier(n) for n in range(49, 73)]


@pytest.mark.parametrize("language", ["en", "all"])
def test_language_selection_is_kept_in_release_feed_and_title_count(source, language):
    rows, calls, _ = source
    rows.extend([release(1, language="en"), release(2, language="vi")])
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(limit=2, translated_language=language))
    assert ids(result) == [identifier(n) for n in ([1] if language == "en" else [1, 2])]
    for path, params in calls:
        key = "translatedLanguage[]" if path == "/chapter" else "availableTranslatedLanguage[]"
        if language == "all":
            assert key not in params
        else:
            assert params[key] == language


def test_router_forwards_filters_and_never_replaces_release_failure_with_metadata_search(monkeypatch):
    from fastapi import HTTPException
    from fastapi_app.routers import manga

    feed = AsyncMock(side_effect=RuntimeError("upstream temporarily unavailable"))
    search = AsyncMock()
    monkeypatch.setattr(manga.mangadex_service, "get_latest_vi_chapter_feed", feed)
    monkeypatch.setattr(manga.mangadex_service, "search_manga", search)
    with pytest.raises(HTTPException) as error:
        asyncio.run(manga.mangadex_latest_feed(page=3, limit=24, show_mature=False, filter_hidden=False,
            genre_slugs="action,romance", translated_language="vi", status="ongoing",
            keyword="title", feed_snapshot="12345", db=None))
    assert error.value.status_code in {502, 503}
    assert feed.call_args.kwargs["included_tag_slugs"] == ["action", "romance"]
    assert feed.call_args.kwargs["statuses"] == ["ongoing"]
    assert feed.call_args.kwargs["page"] == 3
    search.assert_not_called()


@pytest.mark.parametrize("page,offset,size", [(20, 456, 24), (70, 1656, 24), (313, 7488, 24), (417, 9984, 16)])
def test_native_latest_deep_link_fetches_only_its_own_chapter_page(source, page, offset, size):
    rows, calls, _ = source
    rows.extend(release(n, manga=1 if n < offset else n) for n in range(1, 11001))
    result = asyncio.run(mdx.get_latest_vi_chapter_feed(page=page, limit=24))
    assert len(calls) == 1
    path, params = calls[0]
    assert path == "/chapter"
    assert params["offset"] == offset
    assert params["limit"] == size
    assert params["translatedLanguage[]"] == "vi"
    assert len(ids(result)) == size
    assert result["data"]["params"]["pagination"]["totalItems"] == 10000
    assert result["data"]["params"]["pagination"]["unit"] == "chapter"


def test_native_latest_groups_a_title_within_a_page_without_skipping_later_pages(source):
    rows, calls, _ = source
    rows.extend([release(1, manga=1), release(2, manga=1), release(3, manga=1), release(4, manga=2)])
    async def check():
        first = await mdx.get_latest_vi_chapter_feed(page=1, limit=2)
        second = await mdx.get_latest_vi_chapter_feed(page=2, limit=2)
        return first, second
    first, second = asyncio.run(check())
    assert ids(first) == [identifier(1)]
    assert ids(second) == [identifier(1), identifier(2)]
    assert first["data"]["params"]["pagination"]["totalItems"] == 4
    assert [params["offset"] for _, params in calls] == [0, 2]
