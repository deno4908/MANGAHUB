import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('quota_routes',Path(__file__).with_name('quota-routes.py'))
quota=importlib.util.module_from_spec(spec);spec.loader.exec_module(quota)

class QuotaRoutingTests(unittest.TestCase):
    def fixture(self):
        rows=[{'id':str(i),'pattern':h+'/*','script':quota.manager.ROUTER,'request_limit_fail_open':False} for i,h in enumerate(['mangahub.art','standby.mangahub.art','api.mangahub.art','auth.mangahub.art'])]
        rows.append({'id':'source','pattern':'mangahub.art/api/mangadex-edge/*','script':'mangahub-mangadex-edge'})
        def api(path,value=None,method=None):
            if method=='POST':
                row={'id':'new-'+str(len(rows)),**value};rows.append(row);return row
            if method=='PUT':
                row=next(r for r in rows if r['id']==path.rsplit('/',1)[-1]);row.update(value);return row
            if method=='DELETE':
                rows[:]=[r for r in rows if r['id']!=path.rsplit('/',1)[-1]];return
            return rows
        return rows,api
    def test_relief_bypasses_only_image_and_static_paths_and_keeps_auth_and_source_routes(self):
        rows,api=self.fixture();previous=[dict(r) for r in rows]
        result=quota.apply('zone',previous,True,api)
        self.assertEqual(len([r for r in result if r.get('script') is None]),23)
        self.assertTrue(all(r.get('request_limit_fail_open') for r in result if r.get('script')==quota.manager.ROUTER))
        self.assertEqual(next(r for r in result if r['id']=='source'),previous[-1])
        count=len(result);quota.apply('zone',[dict(r) for r in result],True,api)
        self.assertEqual(len(rows),count)
    def test_frontend_country_failure_policy_is_not_relaxed_without_independent_guard(self):
        rows,api=self.fixture();quota.apply('zone',[dict(r) for r in rows],False,api)
        self.assertFalse(any(r['pattern'] in {'mangahub.art/index.html','standby.mangahub.art/index.html'} for r in rows))
        for row in rows:
            if row['pattern'] in {'mangahub.art/*','standby.mangahub.art/*'}:self.assertFalse(row['request_limit_fail_open'])
            if row['pattern'] in {'api.mangahub.art/*','auth.mangahub.art/*'}:self.assertTrue(row['request_limit_fail_open'])
    def test_unrelated_image_worker_is_preserved_and_changes_rolled_back(self):
        rows,api=self.fixture();rows.append({'id':'unrelated','pattern':'standby.mangahub.art/api/images/*','script':'other-worker'})
        before=[dict(r) for r in rows]
        with self.assertRaises(AssertionError):quota.apply('zone',before,True,api)
        self.assertEqual(rows,before)
    def test_health_bypass_preserves_operator_authentication_and_unrelated_workers(self):
        rows,api=self.fixture()
        rows.append({'id':'operator','pattern':'standby.mangahub.art/internal/router-probe*','script':quota.manager.ROUTER})
        result=quota.apply('zone',[dict(r) for r in rows],True,api)
        self.assertEqual(next(r for r in result if r['id']=='operator')['script'],quota.manager.ROUTER)
        self.assertEqual(quota.HEALTH_BYPASS,{'mangahub.art/index.html','standby.mangahub.art/index.html',
            'api.mangahub.art/health','auth.mangahub.art/auth/health','standby.mangahub.art/internal/origin-status*',
            'standby.mangahub.art/internal/router-health'})
        rows,api=self.fixture()
        rows.append({'id':'unrelated','pattern':'standby.mangahub.art/internal/origin-status*','script':'other-worker'})
        before=[dict(r) for r in rows]
        with self.assertRaises(AssertionError):quota.apply('zone',before,True,api)
        self.assertEqual(rows,before)
    def test_nginx_public_bypass_cannot_open_internal_endpoints_or_spoof_client_ip(self):
        text=(Path(__file__).parent.parent/'deploy/standby/nginx.conf.template').read_text()
        block=text.split('map $uri $mh_public_bytes {',1)[1].split('}',1)[0]
        self.assertIn('default 0;',block);self.assertNotIn('internal',block);self.assertNotIn('auth',block)
        self.assertIn('map "$mh_origin_allowed:$http_x_mangahub_client_ip"',text)
        self.assertIn('if ($mh_request_allowed = 0) { return 404; }',text)
        self.assertIn('include /etc/nginx/mangahub-origin-rules/*.conf;',text)

    def test_source_access_bypasses_only_the_secret_protected_policy_endpoint(self):
        self.assertEqual(quota.SOURCE_ACCESS_BYPASS,{'standby.mangahub.art/internal/source-access'})
        text=(Path(__file__).parent.parent/'deploy/standby/nginx.conf.template').read_text()
        block=text.split('location = /internal/source-access {',1)[1].split('location = /internal/router-health',1)[0]
        self.assertIn('proxy_pass http://127.0.0.1:8000/api/site-access;',block)
        self.assertIn('proxy_set_header Cookie "";',block)
        self.assertIn('limit_except GET OPTIONS { deny all; }',block)
        self.assertIn('if ($mh_request_allowed = 0) { return 404; }',text)

if __name__=='__main__':unittest.main()
