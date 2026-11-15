"""Move image/static bytes off Workers, preserving other scripts and policies."""
import importlib.util
import json
import os
from pathlib import Path
import urllib.error

spec = importlib.util.spec_from_file_location('standby_routes', Path(__file__).with_name('manage-standby.py'))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)

IMAGE_PATHS = ['/api/images/*', '/api/manga/mangadex-cover/*',
               '/api/manga/truyenqq/cover/*', '/api/manga/truyenqq/image/*']
BYPASS = {host + path for host in ['api.mangahub.art', 'standby.mangahub.art'] for path in IMAGE_PATHS}
BYPASS |= {host + path for host in ['mangahub.art', 'standby.mangahub.art']
           for path in ['/assets/*', '/favicon.ico*', '/favicon.svg*', '/no-cover.svg*']}
COUNTRY_EXPRESSION = ('(http.host in {"mangahub.art" "standby.mangahub.art"} '
    'and ip.src.country ne "VN" and cf.worker.upstream_zone ne "mangahub.art" '
    'and not starts_with(http.request.uri.path, "/internal/") '
    'and not starts_with(http.request.uri.path, "/api/"))')
COUNTRY_RULE = 'MangaHub Vietnam access (quota independent)'


def country_policy(zone, api=manager.api):
    """Keep the frontend country gate active even if the router is bypassed."""
    path = f'zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint'
    try:
        ruleset = api(path)
        matching = [r for r in ruleset.get('rules', []) if r.get('description') == COUNTRY_RULE]
        if matching:
            assert any(r.get('enabled', True) and r.get('action') == 'block' and
                       r.get('expression') == COUNTRY_EXPRESSION for r in matching), 'Country rule differs; inspect manually'
            return True
        api(f'zones/{zone}/rulesets/{ruleset["id"]}/rules', {
            'description': COUNTRY_RULE, 'expression': COUNTRY_EXPRESSION, 'action': 'block', 'enabled': True}, 'POST')
        return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            try:
                api(f'zones/{zone}/rulesets', {'name': 'MangaHub public access', 'kind': 'zone',
                    'phase': 'http_request_firewall_custom', 'rules': [{'description': COUNTRY_RULE,
                    'expression': COUNTRY_EXPRESSION, 'action': 'block', 'enabled': True}]}, 'POST')
                return True
            except urllib.error.HTTPError as create_error:
                if create_error.code not in {400, 403}: raise
        elif error.code not in {400, 403}: raise
    return False


def apply(zone, previous, protected, api=manager.api):
    path = f'zones/{zone}/workers/routes'
    changes = []
    try:
        for pattern in sorted(BYPASS):
            row = next((r for r in previous if r['pattern'] == pattern), None)
            assert not row or row.get('script') is None, 'Refusing to bypass an unrelated Worker'
            if row: continue
            result = api(path, {'pattern': pattern, 'script': None}, 'POST')
            changes.append((None, result['id']))
        for row in previous:
            if row.get('script') != manager.ROUTER or row['pattern'] not in manager.TARGETS: continue
            front = row['pattern'] in {'mangahub.art/*', 'standby.mangahub.art/*'}
            # API/auth retain their own application auth, whitelist and CSRF.
            # Frontend fail-open additionally requires independent country rules.
            if front and not protected: continue
            if row.get('request_limit_fail_open') is True: continue
            api(path + '/' + row['id'], {'pattern': row['pattern'], 'script': manager.ROUTER,
                'request_limit_fail_open': True}, 'PUT')
            changes.append((row, row['id']))
        current = api(path)
        by_pattern = {r['pattern']: r for r in current}
        assert all(p in by_pattern and by_pattern[p].get('script') is None for p in BYPASS)
        for pattern in ['api.mangahub.art/*', 'auth.mangahub.art/*']:
            assert by_pattern[pattern].get('request_limit_fail_open') is True, 'API/auth fail mode was not applied'
        for row in previous:
            if row['pattern'] not in BYPASS:
                assert by_pattern.get(row['pattern'], {}).get('script') == row.get('script'), 'Unrelated route changed'
        return current
    except BaseException:
        for row, identifier in reversed(changes):
            if row:
                api(path + '/' + identifier, {k: row[k] for k in ['pattern', 'script', 'request_limit_fail_open'] if k in row}, 'PUT')
            else: api(path + '/' + identifier, method='DELETE')
        raise


def main():
    zone = manager.api('zones?name=mangahub.art')[0]['id']
    previous = manager.api(f'zones/{zone}/workers/routes')
    # Origin image/static access must have been prepared before dispatching this.
    protected = country_policy(zone)
    # Used only after the operator reports deploying the exact dashboard rule
    # when this token cannot read/write Rulesets. Never inferred from a timer.
    if not protected and os.environ.get('COUNTRY_GUARD_CONFIRMED') == 'true':
        protected = True
    current = apply(zone, previous, protected)
    print(json.dumps({'image_and_static_bypasses': len(BYPASS), 'country_guard_independent': protected,
        'frontend_fail_open': protected, 'api_auth_fail_open': True,
        'routes': [{k: r.get(k) for k in ['pattern', 'script', 'request_limit_fail_open']} for r in current]}))
    if not protected:
        print('Country rules API denied (403). Frontend fail-closed preserved. Add the exact rule below, then rerun.')
        print(COUNTRY_RULE)
        print(COUNTRY_EXPRESSION)


if __name__ == '__main__': main()
