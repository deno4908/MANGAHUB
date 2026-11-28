"""Reader side effects must not stall unrelated image/data requests."""
import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, Request, Response

from fastapi_app.models.schemas import HistoryEntry
from fastapi_app.routers import comments, history, images, manga, notifications


USER = {"id": "reader-test"}


def request():
    return Request({"type": "http", "method": "POST", "path": "/reader-test",
                    "headers": [(b"user-agent", b"reader-test")],
                    "client": ("203.0.113.25", 12345), "scheme": "https"})


class WaitingDB:
    def __init__(self, blocked):
        self.blocked = blocked
        self.filters = []
        self.executions = 0

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        self.executions += 1
        self.blocked()
        return SimpleNamespace(data=[], count=0)

    def __getattr__(self, name):
        return lambda *args, **kwargs: self


async def image_while_waiting(monkeypatch, make_operation):
    entered, release = threading.Event(), threading.Event()

    def blocked():
        entered.set()
        release.wait(2)  # Old blocking code fails the assertion without hanging pytest.

    monkeypatch.setattr(images, "_validate_image_url", AsyncMock(return_value=None))
    monkeypatch.setattr(images, "_cached_image_response",
                        lambda *args: Response(b"cached-image", media_type="image/jpeg"))
    scheduled_at = asyncio.get_running_loop().time()
    task = asyncio.create_task(make_operation(blocked))
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(.005)
        assert entered.is_set()
        assert asyncio.get_running_loop().time() - scheduled_at < .5, "Reader request was stalled before it could start"
        assert not task.done(), "Synchronous side effect blocked the API event loop"
        response = await asyncio.wait_for(images.proxy_image(
            "https://uploads.mangadex.org/covers/test.jpg", request()), .25)
        assert response.status_code == 200 and response.body == b"cached-image"
        assert not task.done()
    finally:
        release.set()
        result = await task
    return result


@pytest.mark.parametrize("operation", ["list", "read", "read-all", "delete", "delete-all"])
def test_slow_notifications_do_not_hold_reader_images(monkeypatch, operation):
    db = None
    def make(blocked):
        nonlocal db
        db = WaitingDB(blocked)
        return {
            "list": lambda: notifications.get_notifications(page=1, limit=20, user=USER, db=db),
            "read": lambda: notifications.mark_read("one", user=USER, db=db),
            "read-all": lambda: notifications.mark_all_read(user=USER, db=db),
            "delete": lambda: notifications.delete_notification("one", user=USER, db=db),
            "delete-all": lambda: notifications.clear_notifications(user=USER, db=db),
        }[operation]()
    result = asyncio.run(image_while_waiting(monkeypatch, make))
    assert db.executions == (2 if operation == "list" else 1)
    assert db.filters.count(("user_id", USER["id"])) == db.executions
    if operation == "list":
        assert result == {"notifications": [], "unread_count": 0, "page": 1,
                          "limit": 20, "degraded": False}


def test_slow_history_rate_check_keeps_images_responsive_and_runs_before_save(monkeypatch):
    checks = []
    persist = Mock(return_value={"saved": True})
    monkeypatch.setattr(history, "_persist_history", persist)
    data = HistoryEntry(manga_slug="book-1", chapter_id="qq--book-1--2")
    def make(blocked):
        def check(key, user_id, **kwargs):
            assert not persist.called
            checks.append((key, user_id, kwargs["limit"], kwargs["window_seconds"]))
            blocked()
        monkeypatch.setattr(history, "enforce_user_action_limit", check)
        return history.add_or_update_history(request(), data, USER, object())
    assert asyncio.run(image_while_waiting(monkeypatch, make)) == {"saved": True}
    assert checks == [("history:min", USER["id"], 90, 60),
                      ("history:10m", USER["id"], 600, 600)]
    persist.assert_called_once()


@pytest.mark.parametrize("status", [429, 503])
def test_failed_history_guard_never_saves_or_retries(monkeypatch, status):
    check = Mock(side_effect=HTTPException(status, "denied"))
    persist = Mock()
    monkeypatch.setattr(history, "enforce_user_action_limit", check)
    monkeypatch.setattr(history, "_persist_history", persist)
    with pytest.raises(HTTPException) as error:
        asyncio.run(history.add_or_update_history(request(),
            HistoryEntry(manga_slug="book-1", chapter_id="chapter-1"), USER, object()))
    assert error.value.status_code == status
    check.assert_called_once()
    persist.assert_not_called()


@pytest.mark.parametrize("operation", ["start", "view"])
@pytest.mark.parametrize("stage", ["guard", "rpc"])
def test_view_tracking_network_does_not_block_images(monkeypatch, operation, stage):
    monkeypatch.setattr(manga, "_canonical_view_slug", AsyncMock(return_value="book-1"))
    monkeypatch.setattr(manga, "_validate_view_chapter_owner", AsyncMock(return_value="valid"))
    monkeypatch.setattr(manga, "check_recent_once", Mock(return_value=(True, 900)))
    monkeypatch.setattr(manga, "_bump_manga_views_lookup_cache", Mock())
    guards = []
    writes = []
    def make(blocked):
        def guard(key, limit, window):
            guards.append(key)
            if stage == "guard":
                blocked()
            return True, 1, 60
        def write(*args, **kwargs):
            assert len(guards) == 4
            writes.append(kwargs)
            if stage == "rpc":
                blocked()
            return {"ok": True, "counted": True}
        monkeypatch.setattr(manga, "check_fixed_window", guard)
        monkeypatch.setattr(manga, "_start_manga_read_session_rpc", write)
        monkeypatch.setattr(manga, "_track_manga_view_checked_rpc", write)
        values = dict(chapter_id="507f1f77bcf86cd799439011",
                      read_session_id="11111111-1111-4111-8111-111111111111")
        if operation == "start":
            return manga.start_view_session(request(), "book-1", manga.ViewSessionPayload(**values), None, object())
        return manga.add_view(request(), "book-1", manga.ViewPayload(**values,
            elapsed_seconds=20, progress=30, page_seen=3, total_pages=10), None, object())
    result = asyncio.run(image_while_waiting(monkeypatch, make))
    assert result["ok"] is True
    assert len(guards) == 4 and len(writes) == 1


def test_slow_comment_list_does_not_block_images(monkeypatch):
    db = None
    def make(blocked):
        nonlocal db
        db = WaitingDB(blocked)
        return comments.get_comments("book-1", None, 1, 20, USER, db)
    result = asyncio.run(image_while_waiting(monkeypatch, make))
    assert result == {"comments": [], "page": 1, "limit": 20, "has_more": False}
    assert db.executions == 1 and ("manga_slug", "book-1") in db.filters


@pytest.mark.parametrize('stage', ['follow-list', 'cache-read', 'cache-write', 'followers', 'notify'])
def test_background_chapter_check_keeps_reader_images_responsive(monkeypatch, stage):
    from fastapi_app.services import chapter_checker as checker, cache_service
    executions, notifications_written, cache_written, filters = [], [], [], []
    token = 'qq--book-123--2'
    detail = {'data': {'item': {'chapters': [{'server_data': [{
        'chapter_name': '2', 'chapter_api_data': '/api/manga/chapter/' + token,
    }]}]}}}
    get_detail = AsyncMock(return_value=detail)
    monkeypatch.setattr(checker.truyenqq_service, 'get_manga_detail', get_detail)

    def make(blocked):
        class Query:
            def __init__(self, table):
                self.table = table
            def select(self, *args):
                return self
            def eq(self, key, value):
                filters.append((key, value))
                return self
            def insert(self, values):
                notifications_written.extend(values)
                return self
            def execute(self):
                executions.append(self.table)
                if (self.table == 'notifications' and stage == 'notify' or
                    self.table == 'follows' and stage in {'follow-list', 'followers'}):
                    blocked()
                return SimpleNamespace(data=[] if stage == 'follow-list' else [{'user_id': 'follower-1'}])
        db = SimpleNamespace(table=Query)
        monkeypatch.setattr(checker, 'get_supabase_admin', lambda: db)
        def get(key):
            assert key == 'last_chapter:truyenqq:book-123'
            if stage == 'cache-read':
                blocked()
                return token  # An already-seen chapter does not notify again.
            return None if stage == 'cache-write' else 'qq--book-123--1'
        def set_value(key, value, ttl):
            if stage == 'cache-write':
                blocked()
            cache_written.append((key, value, ttl))
        monkeypatch.setattr(cache_service, 'cache', SimpleNamespace(get=get, set=set_value))
        return checker._check_new_chapters() if stage == 'follow-list' else checker._check_single_manga(db, 'book-123', 'Book title')

    assert asyncio.run(image_while_waiting(monkeypatch, make)) is None
    if stage == 'follow-list':
        get_detail.assert_not_awaited()
    else:
        get_detail.assert_awaited_once_with('book-123')
    if stage in {'follow-list', 'cache-read'}:
        assert not cache_written and not notifications_written
    else:
        assert cache_written == [('last_chapter:truyenqq:book-123', token, 7 * 86400)]
        if stage == 'cache-write':
            assert not notifications_written and not executions
        else:
            assert executions == ['follows', 'notifications']
            assert filters == [('manga_slug', 'book-123')]
            assert notifications_written == [{
                'user_id': 'follower-1', 'type': 'new_chapter', 'title': 'Chương mới: Book title',
                'message': 'Chương 2 đã được cập nhật!', 'manga_slug': 'book-123',
                'chapter_id': token, 'is_read': False,
            }]


@pytest.mark.parametrize('operation', ['tags', 'latest', 'metadata', 'lookup', 'detail', 'pages', 'search'])
def test_slow_mangadex_cache_reads_do_not_hold_unrelated_reader_images(monkeypatch, operation):
    from fastapi_app.services import mangadex_service as mdx
    identifier = '11111111-1111-4111-8111-111111111111'
    values = {
        'tags': {'action': 'tag-1'},
        'latest': {'id': 'chapter-1', 'chapter_name': '2'},
        'metadata': {'data': {'id': identifier}},
        'lookup': {'manga': {'id': identifier, 'title': 'Cached title'}},
        'detail': {'manga': {'id': identifier, 'chapters': [{'id': 'chapter-1'}]}},
        'pages': {'chapter_id': identifier, 'mode': 'data-saver', 'image_urls': ['https://cdn.example/1.jpg']},
        'search': {'data': {'items': [{'slug': identifier}], 'params': {'pagination': {'currentPage': 3}}}},
    }
    expected = values[operation]
    monkeypatch.setattr(mdx, '_live_revision', lambda *args: '')
    source = AsyncMock(side_effect=AssertionError('A cached result must not refetch its source'))
    monkeypatch.setattr(mdx, '_request_json', source)
    def make(blocked):
        def get(key):
            blocked()
            return json.dumps(expected)
        monkeypatch.setattr(mdx, 'cache', SimpleNamespace(get=get))
        return {
            'tags': lambda: mdx._get_mangadex_tag_id_by_slug(),
            'latest': lambda: mdx._get_latest_vi_chapter_for_manga(identifier),
            'metadata': lambda: mdx._get_manga_metadata(identifier),
            'lookup': lambda: mdx.get_manga_lookup(identifier),
            'detail': lambda: mdx.get_manga_detail(identifier),
            'pages': lambda: mdx.get_chapter_pages(identifier, mode='saver'),
            'search': lambda: mdx.search_manga('', page=3, sort='popular', attach_latest=False),
        }[operation]()
    assert asyncio.run(image_while_waiting(monkeypatch, make)) == expected
    source.assert_not_awaited()


@pytest.mark.parametrize('stage', ['revision', 'manifest-write'])
def test_mangadex_cache_revisions_and_image_manifest_writes_do_not_stop_other_images(monkeypatch, stage):
    from fastapi_app.services import mangadex_service as mdx
    identifier = '11111111-1111-4111-8111-111111111111'
    writes = []
    monkeypatch.setattr(mdx, '_live_revision', lambda *args: '')
    source = AsyncMock(return_value={'baseUrl': 'https://cdn.example',
        'chapter': {'hash': 'hash', 'dataSaver': ['small.jpg'], 'data': ['large.jpg']}})
    monkeypatch.setattr(mdx, '_request_json', source)
    def make(blocked):
        if stage == 'revision':
            def revision(*args):
                blocked()
                return 'revision-1'
            monkeypatch.setattr(mdx, '_live_revision', revision)
            monkeypatch.setattr(mdx, 'cache', SimpleNamespace(get=lambda key: json.dumps({'manga': {'id': identifier}})))
            # Bypass the outer decorator to exercise the per-book key read.
            return mdx.get_manga_detail.__wrapped__(identifier)
        def set_value(key, value, ttl):
            blocked()
            writes.append((key, json.loads(value), ttl))
        monkeypatch.setattr(mdx, 'cache', SimpleNamespace(get=lambda key: None, set=set_value))
        return mdx.get_chapter_pages(identifier, mode='saver')
    result = asyncio.run(image_while_waiting(monkeypatch, make))
    if stage == 'revision':
        assert result == {'manga': {'id': identifier}}
        source.assert_not_awaited()
    else:
        assert result['image_urls'] == ['https://cdn.example/data-saver/hash/small.jpg']
        assert result['fallback_image_urls'] == ['https://cdn.example/data/hash/large.jpg']
        assert writes == [(f'mangadex:chapter-pages:{identifier}:data-saver', result, mdx.CHAPTER_PAGES_TTL)]
        source.assert_awaited_once_with('/at-home/server/' + identifier)
