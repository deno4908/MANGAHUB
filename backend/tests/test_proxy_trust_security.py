import unittest

from proxy_trust import resolve_client_ip


class ProxyTrustSecurityTests(unittest.TestCase):
    def test_direct_client_cannot_spoof_forwarded_headers(self):
        resolved = resolve_client_ip(
            "203.0.113.25",
            {
                "x-forwarded-for": "198.51.100.99",
                "x-real-ip": "198.51.100.88",
            },
            trusted_proxy_cidrs="127.0.0.1/32,::1/128",
        )
        self.assertEqual(resolved, "203.0.113.25")

    def test_trusted_nginx_uses_rightmost_untrusted_forwarded_ip(self):
        resolved = resolve_client_ip(
            "127.0.0.1",
            {"x-forwarded-for": "198.51.100.99, 203.0.113.25"},
            trusted_proxy_cidrs="127.0.0.1/32,::1/128",
        )
        self.assertEqual(resolved, "203.0.113.25")

    def test_cloudflare_hop_can_be_declared_trusted(self):
        resolved = resolve_client_ip(
            "127.0.0.1",
            {"x-forwarded-for": "198.51.100.99, 173.245.48.5"},
            trusted_proxy_cidrs="127.0.0.1/32,173.245.48.0/20",
        )
        self.assertEqual(resolved, "198.51.100.99")


if __name__ == "__main__":
    unittest.main()
