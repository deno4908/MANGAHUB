import importlib.util
from pathlib import Path
import tomllib
import unittest

spec=importlib.util.spec_from_file_location('standby_routes',Path(__file__).with_name('manage-standby.py'))
routes=importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)


class DeploymentRoutingTests(unittest.TestCase):
    def setUp(self):
        self.cfg=Path(__file__).with_name('wrangler-standby.toml').read_text()

    def test_update_preserves_active_routes_without_claiming_other_workers(self):
        current=[{'pattern':'mangahub.art/*','script':routes.ROUTER},
                 {'pattern':'standby.mangahub.art/*','script':routes.ROUTER},
                 {'pattern':'mangahub.art/api/mangadex-edge/*','script':'mangahub-mangadex-edge'}]
        value=tomllib.loads(routes.runtime_config(self.cfg,current,'activate'))
        self.assertEqual({r['pattern'] for r in value['routes']},{'mangahub.art/*','standby.mangahub.art/*'})
        self.assertEqual(value['vars']['FAILOVER_ENABLED'],'true')

    def test_preparation_refuses_to_detach_public_routes(self):
        with self.assertRaises(ValueError):
            routes.runtime_config(self.cfg,[{'pattern':'api.mangahub.art/*','script':routes.ROUTER}],'prepare')

    def test_first_activation_leaves_country_worker_for_the_verified_transfer(self):
        value=tomllib.loads(routes.runtime_config(self.cfg,[{'pattern':'mangahub.art/*','script':'mangahub-vn-only'}],'activate'))
        self.assertEqual(value['routes'],[])


if __name__=='__main__':
    unittest.main()
