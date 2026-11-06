import asyncio
import threading
from types import SimpleNamespace
from fastapi_app.routers import history
from fastapi_app.models.schemas import HistoryEntry
from fastapi_app.services import qq_statistics
from test_qq_statistics import DB

MDX = "5272da37-6c69-4ecc-a1e0-d25db7b3e80f"


def test_lookup_reads_old_book_beyond_library_window_and_scopes_to_current_user(monkeypatch):
    monkeypatch.setattr(qq_statistics, "cached_aliases", lambda ids: {})
    rows = [{"manga_slug": f"book-{i}", "user_id": "reader", "read_at": f"2026-11-06T10:{i:03}:00Z"} for i in range(150)]
    old = {"manga_slug": f"mdx-{MDX}", "user_id": "reader", "read_at": "2026-01-01T00:00:00Z", "page": 19}
    rows.extend([old, {**old, "user_id": "someone-else", "read_at": "2026-11-06T10:00:00Z", "page": 0}])
    db = DB({"reading_history": rows})
    result = asyncio.run(history.get_manga_history(MDX, aliases="", user={"id": "reader"}, db=db))
    assert result["history"] == old
    assert len(db.reads) == 1
    assert db.reads[0][1]["user_id"] == ["reader"]
    assert set(db.reads[0][1]["manga_slug"]) == {MDX, "mdx-" + MDX, "mangadex-" + MDX, "mangadex:" + MDX}
    assert not db.writes


def test_lookup_uses_only_verified_qq_aliases_and_newest_checkpoint(monkeypatch):
    monkeypatch.setattr(qq_statistics, "cached_aliases", lambda ids: {"book-23": ["book-23", "old-book"]})
    old = {"manga_slug": "old-book", "user_id": "reader", "read_at": "2026-11-05T10:00:00Z", "page": 12}
    new = {**old, "manga_slug": "book-23", "read_at": "2026-11-06T10:00:00Z", "page": 4}
    db = DB({"reading_history": [old, new]})
    assert asyncio.run(history.get_manga_history("book-23", aliases="", user={"id": "reader"}, db=db))["history"] == new
    assert db.reads[0][1]["manga_slug"] == ["book-23", "old-book"]
    assert asyncio.run(history.get_manga_history("unrelated-23", aliases="", user={"id": "reader"}, db=db))["history"] is None


def test_save_runs_database_work_off_event_loop_and_rejects_delayed_old_checkpoint(monkeypatch):
    events, writes, threads = [], [], []
    row = {"id": "saved", "manga_title": "Saved title", "manga_thumb": "cover.jpg", "read_at": "2026-01-01T00:00:00+00:00"}
    class Query:
        payload = None
        def select(self, *args, **kwargs): return self
        def eq(self, *args): return self
        def order(self, *args, **kwargs): return self
        def or_(self, *args): return self
        def update(self, payload): self.payload = payload; return self
        def execute(self):
            threads.append(threading.get_ident())
            if self.payload:
                row.update(self.payload); writes.append(self.payload)
            return SimpleNamespace(data=[row])
    db = SimpleNamespace(table=lambda table: Query())
    monkeypatch.setattr(history, "enforce_user_action_limit", lambda *args, **kwargs: None)
    monkeypatch.setattr(history, "clear_user_stats_cache", lambda *args: None)
    monkeypatch.setattr(history, "_record_reading_activity_event", lambda *args: events.append(args))
    loop_thread = threading.get_ident()
    async def save():
        await history.add_or_update_history(None, HistoryEntry(manga_slug=MDX, chapter_id="new-chapter", page=12,
            progress=64, client_read_at="2026-01-03T00:00:00Z"), user={"id": "reader"}, db=db)
        result = await history.add_or_update_history(None, HistoryEntry(manga_slug=MDX, chapter_id="old-chapter", page=0,
            client_read_at="2026-01-02T00:00:00Z"), user={"id": "reader"}, db=db)
        assert result["stale"]
    asyncio.run(save())
    assert row["chapter_id"] == "new-chapter" and row["page"] == 12
    assert row["manga_title"] == "Saved title" and row["manga_thumb"] == "cover.jpg"
    assert len(writes) == len(events) == 1
    assert threads and all(thread != loop_thread for thread in threads)


def test_late_database_write_cannot_overwrite_newer_reading_from_another_tab(monkeypatch):
    row = {"id": "saved", "read_at": "2026-01-01T00:00:00+00:00"}
    class Query:
        payload = None
        def select(self, *args, **kwargs): return self
        def eq(self, *args): return self
        def order(self, *args, **kwargs): return self
        def update(self, payload):
            self.payload = payload
            # Another request commits after our SELECT but before our UPDATE.
            row.update(read_at="2026-01-04T00:00:00+00:00", chapter_id="newer-chapter", page=19)
            return self
        def or_(self, expression):
            self.require_older = "read_at.lte." in expression
            return self
        def execute(self):
            if self.payload:
                if self.require_older and row["read_at"] > self.payload["read_at"]:
                    return SimpleNamespace(data=[])
                row.update(self.payload)
            return SimpleNamespace(data=[dict(row)])
    monkeypatch.setattr(history, "_record_reading_activity_event", lambda *args: None)
    monkeypatch.setattr(history, "clear_user_stats_cache", lambda *args: None)
    result = history._persist_history(HistoryEntry(manga_slug=MDX, chapter_id="older-chapter", page=3,
        client_read_at="2026-01-03T00:00:00Z"), {"id": "reader"}, SimpleNamespace(table=lambda table: Query()))
    assert result["stale"]
    assert row["chapter_id"] == "newer-chapter" and row["page"] == 19
