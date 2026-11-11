"""Explicit activation with rollback, without modifying DNS or unrelated routes."""
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

TARGETS = {host + '/*' for host in ('mangahub.art', 'api.mangahub.art', 'auth.mangahub.art', 'standby.mangahub.art')}
ROUTER = 'mangahub-standby-router'


def runtime_config(config, previous, operation):
    owned=[{'pattern':r['pattern'],'zone_name':'mangahub.art'} for r in previous if r.get('script')==ROUTER]
    if operation=='prepare' and any(r['pattern'] in TARGETS for r in owned):
        raise ValueError('Refusing detached preparation while public standby routing is active')
    tables=', '.join('{ pattern = '+json.dumps(r['pattern'])+', zone_name = "mangahub.art" }' for r in owned)
    config=config.replace('routes = []','routes = ['+tables+']')
    if operation=='activate':
        config=config.replace('FAILOVER_ENABLED = "false"','FAILOVER_ENABLED = "true"').replace('BALANCE_ENABLED = "false"','BALANCE_ENABLED = "true"')
    return config


def api(path, value=None, method=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path,
        data=None if value is None else json.dumps(value).encode(), method=method,
        headers={'Authorization':'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    assert result['success'], 'Cloudflare operation failed'
    return result['result']


def main(operation):
    zone = api('zones?name=mangahub.art')[0]['id']
    route_path = f'zones/{zone}/workers/routes'
    previous = api(route_path)
    if operation.startswith('config-'):
        mode=operation.removeprefix('config-')
        assert mode in {'prepare','activate'}
        source=Path(__file__).with_name('wrangler-standby.toml')
        source.with_name('standby-runtime.toml').write_text(runtime_config(source.read_text(),previous,mode))
        return
    if operation=='probe':
        pattern='standby.mangahub.art/internal/router-probe*'
        row=next((r for r in previous if r['pattern']==pattern),None)
        assert not row or row.get('script') in {None,ROUTER}
        api(route_path+('/'+row['id'] if row else ''),{'pattern':pattern,'script':ROUTER},'PUT' if row else 'POST')
        print('Installed credential-protected operator probe only')
        return
    dns = {}
    for host in ('mangahub.art','api.mangahub.art','auth.mangahub.art','standby.mangahub.art'):
        path = '/health' if host=='api.mangahub.art' else '/auth/health' if host=='auth.mangahub.art' else '/'
        try:
            response=urllib.request.urlopen('https://'+host+path,timeout=15)
        except urllib.error.HTTPError as error:
            response=error
        with response:
            dns[host]=bool(response.headers.get('CF-Ray'))
    print(json.dumps({'proxied':dns,'routes':[{'pattern':r['pattern'],'script':r.get('script')} for r in previous]}))
    if operation == 'inspect':
        return
    assert operation in {'activate','rollback'}
    if operation == 'activate':
        assert all(dns.values()), 'All four public DNS hostnames must be proxied before activation'
        assert any(r['pattern']=='mangahub.art/api/mangadex-edge/*' and r.get('script')=='mangahub-mangadex-edge' for r in previous), 'Source route is missing'
    changed = []
    try:
        for pattern in sorted(TARGETS):
            row = next((r for r in previous if r['pattern']==pattern), None)
            allowed = {None, ROUTER} | ({'mangahub-vn-only'} if pattern == 'mangahub.art/*' else set())
            assert not row or row.get('script') in allowed, 'Refusing to replace an unrelated Worker'
            desired = ROUTER if operation=='activate' else ('mangahub-vn-only' if pattern=='mangahub.art/*' else None)
            if row and row.get('script')==desired:
                continue
            if desired:
                result = api(route_path + ('/' + row['id'] if row else ''),{'pattern':pattern,'script':desired},'PUT' if row else 'POST')
                changed.append((row,result['id']))
            elif row and row.get('script')==ROUTER:
                api(route_path+'/'+row['id'],method='DELETE')
                changed.append((row,None))
        current = {r['pattern']:r.get('script') for r in api(route_path)}
        for r in previous:
            if r['pattern'] not in TARGETS:
                assert current.get(r['pattern'])==r.get('script'), 'Unrelated route changed'
        if operation=='activate':
            assert all(current.get(p)==ROUTER for p in TARGETS)
        print('Route operation verified: '+operation)
    except BaseException:
        for row, current_id in reversed(changed):
            if row:
                api(route_path+('/'+current_id if current_id else ''),{'pattern':row['pattern'],'script':row.get('script')},'PUT' if current_id else 'POST')
            elif current_id:
                api(route_path+'/'+current_id,method='DELETE')
        raise


if __name__=='__main__':
    main(sys.argv[1])
