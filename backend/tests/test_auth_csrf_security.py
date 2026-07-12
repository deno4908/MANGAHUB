import unittest
from unittest.mock import patch

from flask import Flask

from config import config
from flask_app.auth.routes import (
    _AUTH_CSRF_HEADER_NAME,
    _AUTH_CSRF_HEADER_VALUE,
    _AUTH_INTERNAL_ERROR_MESSAGE,
    _auth_csrf_error,
    _auth_internal_error,
    _refresh_cookie_samesite,
    logger as auth_logger,
)


class AuthCsrfSecurityTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)

    def test_refresh_cookie_is_lax(self):
        self.assertEqual(_refresh_cookie_samesite(), "Lax")

    def test_mutating_auth_request_requires_csrf_header(self):
        with self.app.test_request_context(
            "/auth/logout",
            method="POST",
            headers={"Origin": "https://mangahub.art"},
        ):
            _response, status = _auth_csrf_error()
            self.assertEqual(status, 403)

    def test_auth_request_rejects_untrusted_origin(self):
        headers = {
            _AUTH_CSRF_HEADER_NAME: _AUTH_CSRF_HEADER_VALUE,
            "Origin": "https://attacker.example",
        }
        with patch.object(config, "FRONTEND_URL", "https://mangahub.art"):
            with self.app.test_request_context(
                "/auth/logout",
                method="POST",
                base_url="https://mangahub.art",
                headers=headers,
            ):
                _response, status = _auth_csrf_error()
                self.assertEqual(status, 403)

    def test_auth_request_accepts_header_from_frontend_origin(self):
        headers = {
            _AUTH_CSRF_HEADER_NAME: _AUTH_CSRF_HEADER_VALUE,
            "Origin": "https://mangahub.art",
        }
        with patch.object(config, "FRONTEND_URL", "https://mangahub.art"):
            with self.app.test_request_context(
                "/auth/refresh",
                method="POST",
                base_url="https://mangahub.art",
                headers=headers,
            ):
                self.assertIsNone(_auth_csrf_error())

    def test_internal_auth_error_is_not_returned_to_client(self):
        internal_message = "private database provider detail"
        with self.app.test_request_context("/auth/login", method="POST"):
            with patch.object(auth_logger, "error"):
                response, status = _auth_internal_error(
                    "Login failed",
                    RuntimeError(internal_message),
                )
            self.assertEqual(status, 500)
            self.assertEqual(response.get_json(), {"error": _AUTH_INTERNAL_ERROR_MESSAGE})
            self.assertNotIn(internal_message, response.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
