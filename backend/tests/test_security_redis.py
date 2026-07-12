import unittest
from unittest.mock import patch

from fastapi import HTTPException

from config import config
from fastapi_app.utils import anti_spam
from security_runtime import ensure_security_redis_available


class SecurityRedisTests(unittest.TestCase):
    def test_required_redis_rejects_memory_storage(self):
        with (
            patch.object(config, "SECURITY_REQUIRE_REDIS", True),
            patch.object(config, "REDIS_URL", "memory://"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Redis is required"):
                ensure_security_redis_available()

    def test_rate_limit_fails_closed_when_required_redis_is_unavailable(self):
        with (
            patch.object(config, "SECURITY_REQUIRE_REDIS", True),
            patch.object(anti_spam, "_redis_fixed_window", return_value=None),
        ):
            with self.assertRaises(HTTPException) as raised:
                anti_spam.check_fixed_window("security-test", 1, 60)

        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
