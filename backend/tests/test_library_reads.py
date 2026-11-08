import asyncio
import threading

import pytest

from fastapi_app.routers import bookmarks, history
from test_qq_statistics import DB


@pytest.mark.parametrize("endpoint,table,key", [
    (bookmarks.get_bookmarks, "bookmarks", "bookmarks"),
    (bookmarks.get_follows, "follows", "follows"),
    (history.get_history, "reading_history", "history"),
])
def test_library_reads_do_not_block_other_api_work_and_remain_user_scoped(endpoint, table, key):
    main_thread = threading.get_ident()
    threads = []
    row = {"manga_slug": "book-123", "manga_title": "Saved", "user_id": "reader",
           "created_at": "2026-11-08", "read_at": "2026-11-08", "page": 7, "progress": 62}
    db = DB({table: [row, {**row, "user_id": "someone-else", "page": 0}]})
    original = db.table

    def query(name):
        result = original(name)
        execute = result.execute
        def run():
            threads.append(threading.get_ident())
            return execute()
        result.execute = run
        return result

    db.table = query
    result = asyncio.run(endpoint(user={"id": "reader"}, db=db))
    assert len(result[key]) == 1
    assert result[key][0]["page"] == 7 and result[key][0]["progress"] == 62
    assert db.reads == [(table, {"user_id": ["reader"]})]
    assert threads and all(thread != main_thread for thread in threads)
    assert not db.writes


def test_history_library_keeps_latest_hundred_limit_and_deduplication():
    rows = [{"manga_slug": f"book-{index}", "user_id": "reader", "read_at": f"{index:03d}"}
            for index in range(110)]
    rows.append({**rows[-1], "read_at": "999"})
    db = DB({"reading_history": rows})
    items = asyncio.run(history.get_history(user={"id": "reader"}, db=db))["history"]
    assert len(items) == 99
    assert items[0]["manga_slug"] == "book-109" and items[0]["read_at"] == "999"
    assert items[-1]["manga_slug"] == "book-11"
