import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('daily_health', Path(__file__).parents[1] / 'deploy/standby/daily-health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class DailyHealthTests(unittest.TestCase):
    def test_shared_result_survives_restarts_and_network_is_checked_once_per_day(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secret = root / 'secret'
            secret.write_text('fixture-secret')
            def probe(host, path, **kwargs):
                return {'ok': True, 'milliseconds': 10, 'value': {'status': 'ready', 'accept_extra': True}}
            with patch.object(health, 'ROOT', root), patch.object(health, 'SECRET_PATH', secret), \
                 patch.object(health, 'probe', side_effect=probe) as network, patch.object(health.time, 'time', return_value=100000) as clock:
                health.main()
                snapshot = json.loads((root / 'daily.json').read_text())
                self.assertEqual(network.call_count, 5)
                self.assertTrue(snapshot['backup']['ok'])
                self.assertNotIn('fixture-secret', json.dumps(snapshot))
                clock.return_value += 86399
                health.main()
                self.assertEqual(network.call_count, 5)
                clock.return_value += 2
                health.main()
                self.assertEqual(network.call_count, 10)

    def test_daily_metadata_is_private_and_keeps_the_network_hop_gate(self):
        nginx = (Path(__file__).parents[1] / 'deploy/standby/nginx.conf.template').read_text()
        public = nginx.split('map $uri $mh_public_bytes {', 1)[1].split('}', 1)[0]
        self.assertNotIn('router-health', public)
        self.assertIn('if ($mh_request_allowed = 0) { return 404; }', nginx)
        self.assertIn('location = /internal/router-health {', nginx)
        self.assertIn('alias /var/lib/mangahub-router-health/daily.json;', nginx)
        self.assertIn('limit_except GET { deny all; }', nginx)


if __name__ == '__main__':
    unittest.main()
