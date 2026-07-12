import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import Request

from fastapi_app.routers import manga


def _request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/manga/example/view",
            "headers": [(b"user-agent", b"security-test")],
            "client": ("203.0.113.25", 12345),
            "server": ("testserver", 443),
            "scheme": "https",
        }
    )


class ViewTrackingSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_otruyen_chapter_must_belong_to_requested_manga(self):
        chapter_payload = {
            "data": {
                "item": {
                    "comic_slug": "actual-manga",
                    "chapter_path": "uploads/comics/actual-manga/chapter-1",
                }
            }
        }
        with (
            patch.object(manga.cache, "get", return_value=None),
            patch.object(manga.cache, "set"),
            patch.object(
                manga.otruyen_service,
                "get_chapter",
                new=AsyncMock(return_value=chapter_payload),
            ),
        ):
            result = await manga._validate_view_chapter_owner(
                object(),
                "different-manga",
                "507f1f77bcf86cd799439011",
            )
        self.assertEqual(result, "invalid")

    async def test_mangadex_chapter_relationship_is_verified(self):
        manga_id = "11111111-1111-4111-8111-111111111111"
        chapter_id = "22222222-2222-4222-8222-222222222222"
        payload = {
            "data": {
                "relationships": [
                    {"type": "manga", "id": manga_id},
                ]
            }
        }
        with (
            patch.object(manga.cache, "get", return_value=None),
            patch.object(manga.cache, "set"),
            patch.object(
                manga.mangadex_service,
                "get_chapter_metadata",
                new=AsyncMock(return_value=payload),
            ),
        ):
            result = await manga._validate_view_chapter_owner(object(), manga_id, chapter_id)
        self.assertEqual(result, "valid")

    async def test_rpc_failure_never_falls_back_to_increment(self):
        payload = manga.ViewPayload(
            chapter_id="507f1f77bcf86cd799439011",
            read_session_id="11111111-1111-4111-8111-111111111111",
            elapsed_seconds=20,
            progress=30,
            page_seen=3,
            total_pages=10,
        )
        db = Mock()
        with (
            patch.object(manga, "_canonical_view_slug", new=AsyncMock(return_value="example-manga")),
            patch.object(manga, "_validate_view_chapter_owner", new=AsyncMock(return_value="valid")),
            patch.object(manga, "_track_manga_view_checked_rpc", return_value=None),
            patch.object(
                manga,
                "check_fixed_window",
                return_value=(True, 1, 60),
            ) as rate_check,
            patch.object(manga, "check_recent_once", return_value=(True, 900)),
        ):
            result = await manga.add_view(_request(), "example-manga", payload, user=None, db=db)

        self.assertEqual(result["reason"], "tracking-unavailable")
        self.assertFalse(result["counted"])
        self.assertTrue(
            any(str(call.args[0]).startswith("view-ip:") for call in rate_check.call_args_list)
        )
        db.rpc.assert_not_called()
        db.table.assert_not_called()


if __name__ == "__main__":
    unittest.main()
