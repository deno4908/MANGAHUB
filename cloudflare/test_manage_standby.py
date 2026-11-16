import importlib.util
from pathlib import Path
import tomllib
import unittest
from unittest.mock import patch

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

    def test_existing_operator_probe_is_not_rewritten_during_a_live_update(self):
        calls=[]
        def api(path, value=None, method=None):
            calls.append((path,value,method))
            return [{'id':'zone'}] if path.startswith('zones?') else [
                {'id':'existing','pattern':'standby.mangahub.art/internal/router-probe*','script':routes.ROUTER}]
        with patch.object(routes,'api',api):
            routes.main('probe')
        self.assertEqual(len(calls),2)
        self.assertTrue(all(value is None and method is None for _,value,method in calls))

    def test_deployment_restores_prior_quota_policy_without_opening_operator_or_source_routes(self):
        rows=[{'id':'api','pattern':'api.mangahub.art/*','script':routes.ROUTER,'request_limit_fail_open':False},
              {'id':'private','pattern':'standby.mangahub.art/internal/router-probe*','script':routes.ROUTER,'request_limit_fail_open':False},
              {'id':'source','pattern':'mangahub.art/api/mangadex-edge/*','script':'mangahub-mangadex-edge','request_limit_fail_open':False},
              {'id':'images','pattern':'api.mangahub.art/api/images/*','script':None}]
        before=[dict(r) for r in rows];changes=[]
        def api(path,value=None,method=None):
            if method=='PUT':
                row=next(r for r in rows if r['id']==path.rsplit('/',1)[-1])
                changes.append(row['id']);row.update(value)
            return rows
        routes.restore_failure_policy('zone',before,[{'pattern':rows[0]['pattern'],'request_limit_fail_open':True},
            {'pattern':rows[1]['pattern'],'request_limit_fail_open':False}],api)
        self.assertEqual(changes,['api'])
        self.assertTrue(rows[0]['request_limit_fail_open'])
        self.assertEqual(rows[1:],before[1:])
        with self.assertRaises(AssertionError):
            routes.restore_failure_policy('zone',rows,[{'pattern':rows[2]['pattern'],'request_limit_fail_open':True}],api)


if __name__=='__main__':
    unittest.main()
