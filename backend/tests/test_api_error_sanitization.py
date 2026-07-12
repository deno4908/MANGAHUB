import unittest

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException

from fastapi_app.main import (
    sanitized_http_exception_handler,
    sanitized_unhandled_exception_handler,
)


class ApiErrorSanitizationTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_exception_handler(StarletteHTTPException, sanitized_http_exception_handler)
        app.add_exception_handler(Exception, sanitized_unhandled_exception_handler)

        @app.get("/expected")
        async def expected_error():
            raise HTTPException(status_code=400, detail="Dữ liệu không hợp lệ")

        @app.get("/internal-http")
        async def internal_http_error():
            raise HTTPException(status_code=500, detail="private Supabase provider detail")

        @app.get("/internal-unhandled")
        async def internal_unhandled_error():
            raise RuntimeError("private database detail")

        self.client = TestClient(app, raise_server_exceptions=False)

    def test_expected_client_error_is_preserved(self):
        response = self.client.get("/expected")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "Dữ liệu không hợp lệ"})

    def test_internal_http_error_is_hidden(self):
        response = self.client.get("/internal-http")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("Supabase", response.text)
        self.assertEqual(
            response.json(),
            {"detail": "Đã xảy ra lỗi máy chủ. Vui lòng thử lại sau."},
        )

    def test_unhandled_error_is_hidden(self):
        response = self.client.get("/internal-unhandled")
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("database detail", response.text)
        self.assertEqual(
            response.json(),
            {"detail": "Đã xảy ra lỗi máy chủ. Vui lòng thử lại sau."},
        )


if __name__ == "__main__":
    unittest.main()
