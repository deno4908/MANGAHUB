import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from fastapi_app import dependencies
from fastapi_app import main as api_main
from fastapi_app.main import _minimum_api_role_for_path


class ApiAccessPolicyTests(unittest.TestCase):
    def test_privileged_api_namespaces_have_a_role_floor(self):
        self.assertEqual(_minimum_api_role_for_path("/api/admin/users"), "moderator")
        self.assertEqual(_minimum_api_role_for_path("/api/uploads/manga"), "uploader")
        self.assertEqual(_minimum_api_role_for_path("/api/editor/inpaint"), "uploader")
        self.assertIsNone(_minimum_api_role_for_path("/api/admin/announcements/active"))
        self.assertIsNone(_minimum_api_role_for_path("/api/uploads/published/one-piece"))

    def test_privileged_namespace_requires_a_token(self):
        with self.assertRaises(HTTPException) as error:
            asyncio.run(
                dependencies.authorize_api_request(None, minimum_role="uploader")
            )
        self.assertEqual(error.exception.status_code, 401)

    def test_api_gateway_runs_before_maintenance_for_privileged_paths(self):
        with patch.object(
            api_main,
            "get_maintenance_state",
            side_effect=AssertionError("maintenance must not run before API access control"),
        ):
            response = TestClient(
                api_main.app,
                raise_server_exceptions=False,
            ).get("/api/admin/not-a-route")
        self.assertEqual(response.status_code, 401)

    def test_reader_cannot_pass_uploader_role_floor(self):
        reader = {"id": "reader-id", "role": "reader"}
        with patch.object(
            dependencies,
            "get_current_user",
            new=AsyncMock(return_value=reader),
        ):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(
                    dependencies.authorize_api_request(
                        "Bearer reader-token",
                        minimum_role="uploader",
                    )
                )
        self.assertEqual(error.exception.status_code, 403)

    def test_admin_can_pass_uploader_role_floor(self):
        admin = {"id": "admin-id", "role": "admin"}
        with patch.object(
            dependencies,
            "get_current_user",
            new=AsyncMock(return_value=admin),
        ):
            result = asyncio.run(
                dependencies.authorize_api_request(
                    "Bearer admin-token",
                    minimum_role="uploader",
                )
            )
        self.assertEqual(result, admin)

    def test_optional_user_does_not_downgrade_a_banned_token_to_guest(self):
        banned_error = HTTPException(
            status_code=403,
            detail=dependencies.BANNED_ACCOUNT_DETAIL,
        )
        with patch.object(
            dependencies,
            "get_current_user",
            new=AsyncMock(side_effect=banned_error),
        ):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(dependencies.get_optional_user("Bearer banned-token"))
        self.assertEqual(error.exception.status_code, 403)

    def test_ban_cache_invalidation_removes_all_cached_tokens_for_user(self):
        dependencies._auth_cache.clear()
        dependencies._profile_cache.clear()
        dependencies._auth_cache["target-token"] = (
            9999999999,
            {"id": "target-user", "role": "reader"},
        )
        dependencies._auth_cache["other-token"] = (
            9999999999,
            {"id": "other-user", "role": "reader"},
        )
        dependencies._profile_cache["target-user"] = (9999999999, {"is_banned": False})

        dependencies.invalidate_auth_cache("target-user")

        self.assertNotIn("target-token", dependencies._auth_cache)
        self.assertIn("other-token", dependencies._auth_cache)
        self.assertNotIn("target-user", dependencies._profile_cache)
        dependencies._auth_cache.clear()
        dependencies._profile_cache.clear()


if __name__ == "__main__":
    unittest.main()
