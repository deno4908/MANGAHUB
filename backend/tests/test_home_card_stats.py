import asyncio
import threading

from fastapi_app.routers import manga, ratings
from test_qq_statistics import DB, hints, OLD, NATIVE

MDX = "f239fcd4-9f7f-4296-9e52-ee5a66a7e938"


def test_home_stats_match_detail_alias_totals_and_read_personal_score_in_parallel(hints):
    db = DB({"manga_views": [{"manga_slug": MDX, "views": 2}, {"manga_slug": "mdx-" + MDX, "views": 4},
        {"manga_slug": OLD, "views": 83}, {"manga_slug": NATIVE, "views": 7}],
        "ratings": [{"manga_slug": MDX, "score": 2, "user_id": "me", "updated_at": "2026-11-01"},
        {"manga_slug": "mdx-" + MDX, "score": 5, "user_id": "me", "updated_at": "2026-11-02"},
        {"manga_slug": MDX, "score": 3, "user_id": "other", "updated_at": "2026-11-01"}]})
    response = asyncio.run(ratings.get_batch_ratings(ratings.BatchRatingsRequest(
        manga_slugs=[MDX, NATIVE, "unviewed"], include_views=True), user={"id": "me"}, db=db))
    assert response["views"] == {MDX: 6, NATIVE: 90, "unviewed": 0}
    assert response["ratings"][MDX] == {"average": 4.0, "count": 2}
    assert response["my_scores"] == {MDX: 5}
    assert [table for table, _ in db.reads].count("ratings") == 2
    assert [table for table, _ in db.reads].count("manga_views") == 1
    assert response["views"][MDX] == manga._sum_manga_views(db, [MDX, "mdx-" + MDX])


def test_home_database_reads_overlap_off_event_loop_and_default_omits_views(hints):
    db = DB({})
    base = db.table
    both = threading.Barrier(2, timeout=2)
    event_thread = threading.get_ident()
    def table(name):
        query = base(name)
        execute = query.execute
        def wait():
            assert threading.get_ident() != event_thread
            both.wait()
            return execute()
        query.execute = wait
        return query
    db.table = table
    response = asyncio.run(ratings.get_batch_ratings(ratings.BatchRatingsRequest(
        manga_slugs=[MDX], include_views=True), user=None, db=db))
    assert response["views"] == {MDX: 0}
    assert not response.get("incomplete")
    plain = DB({})
    result = asyncio.run(ratings.get_batch_ratings(ratings.BatchRatingsRequest(manga_slugs=[MDX]), user=None, db=plain))
    assert "views" not in result
    assert [name for name, _ in plain.reads] == ["ratings"]


def test_database_errors_are_unknown_stats_not_invented_zeros(hints):
    class BrokenDB:
        def table(self, name):
            raise RuntimeError("unavailable")
    response = asyncio.run(ratings.get_batch_ratings(ratings.BatchRatingsRequest(
        manga_slugs=[MDX], include_views=True), user=None, db=BrokenDB()))
    assert response == {"ratings": {}, "my_scores": {}, "incomplete": True}


def test_parallel_home_requests_share_one_hidden_read(monkeypatch):
    db = DB({"manga_overrides": [{"manga_slug": MDX, "hidden_reason": "Hidden", "is_hidden": True}]})
    monkeypatch.setattr(manga, "_hidden_cache", {})
    monkeypatch.setattr(manga, "_hidden_cache_at", 0)
    async def run():
        values = await asyncio.gather(*[manga._get_hidden_slugs(db) for _ in range(6)])
        assert all(value[MDX] == "Hidden" for value in values)
        assert len(db.reads) == 1
        values[0].clear()
        assert (await manga._get_hidden_slugs(db))[MDX] == "Hidden"
    asyncio.run(run())
