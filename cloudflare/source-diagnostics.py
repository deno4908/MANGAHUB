"""Four fixed source checks on a temporary Worker; never change production routes."""
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.error
import urllib.request


def identity():
    run = os.environ['GITHUB_RUN_ID']
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    assert re.fullmatch(r'\d{1,20}', run) and re.fullmatch(r'[a-f0-9]{32}', account)
    name = 'mh-source-check-' + run
    return account, name, Path(os.environ['RUNNER_TEMP']) / (name + '.created')


def api(path, data=None, method=None, content_type='application/json'):
    body = data if isinstance(data, bytes) else None if data is None else json.dumps(data).encode()
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path,
        data=body, method=method, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
            'Content-Type': content_type})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Provider error bodies can echo bindings. Never print them or the token.
        if error.code == 404:
            raise FileNotFoundError('Worker does not exist') from None
        try:
            codes = [row.get('code') for row in json.load(error).get('errors', [])
                     if isinstance(row.get('code'), int)][:10]
        except (ValueError, AttributeError):
            codes = []
        raise RuntimeError(f'Cloudflare API HTTP {error.code}, error codes {codes}') from None
    if not result.get('success'):
        raise RuntimeError('Cloudflare API rejected the diagnostic operation')
    return result.get('result')


def upload(path, metadata):
    boundary = 'mh-' + secrets.token_hex(16)
    parts = [('metadata', None, 'application/json', json.dumps(metadata).encode())]
    for name in ['source-diagnostic-worker.js', 'mangadex-edge-worker.js']:
        parts.append((name, name, 'application/javascript+module', Path(__file__).with_name(name).read_bytes()))
    body = bytearray()
    for field, filename, mime, data in parts:
        body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + field + '"' +
            ('; filename="' + filename + '"' if filename else '') + '\r\nContent-Type: ' + mime + '\r\n\r\n').encode())
        body.extend(data);body.extend(b'\r\n')
    body.extend(('--' + boundary + '--\r\n').encode())
    return api(path, bytes(body), 'PUT', 'multipart/form-data; boundary=' + boundary)


def cleanup():
    account, name, marker = identity()
    if marker.is_file():
        try:
            api(f'accounts/{account}/workers/scripts/{name}', method='DELETE')
        except FileNotFoundError:
            pass
        marker.unlink()
        print(json.dumps({'temporary_worker_deleted': True}))


def run():
    account, name, marker = identity()
    subdomain = os.environ['CLOUDFLARE_WORKERS_SUBDOMAIN']
    assert re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', subdomain)
    path = f'accounts/{account}/workers/scripts/{name}'
    try:
        api(path + '/settings')
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError('Refusing to replace an existing Worker')
    marker.write_text(name);marker.chmod(0o600)
    secret = secrets.token_hex(32)
    try:
        for region in ['aws:ap-southeast-1', 'aws:ap-northeast-1']:
            upload(path, {'main_module': 'source-diagnostic-worker.js', 'compatibility_date': '2026-06-10',
                'bindings': [{'name': 'OPERATOR_PROBE_SECRET', 'type': 'secret_text', 'text': secret}],
                'placement': {'mode': 'targeted', 'region': region}, 'logpush': False})
            api(path + '/subdomain', {'enabled': True, 'previews_enabled': False}, 'POST')
            time.sleep(3)
            for case in ['latest', 'detail']:
                request = urllib.request.Request(f'https://{name}.{subdomain}.workers.dev/?case={case}',
                    headers={'X-MangaHub-Source-Probe': secret, 'User-Agent': 'MangaHub-Source-Diagnostic/1.0'})
                try:
                    with urllib.request.urlopen(request, timeout=25) as response:
                        result = json.load(response)
                    allowed = {'case', 'status', 'valid', 'challenge', 'milliseconds', 'ingress', 'placement', 'sourceColo', 'transportError'}
                    print(json.dumps({'region': region, **{k: v for k, v in result.items() if k in allowed}}), flush=True)
                except urllib.error.HTTPError as error:
                    print(json.dumps({'region': region, 'case': case, 'diagnostic_http_status': error.code}), flush=True)
                except (OSError, ValueError):
                    print(json.dumps({'region': region, 'case': case, 'diagnostic_unavailable': True}), flush=True)
    finally:
        cleanup()


if __name__ == '__main__':
    try:
        {'run': run, 'cleanup': cleanup}[sys.argv[1]]()
    except (KeyError, AssertionError, RuntimeError, OSError) as error:
        print(json.dumps({'diagnostic_error': type(error).__name__,
            **({'detail': str(error)} if isinstance(error, RuntimeError) else {})}), flush=True)
        raise SystemExit(1)
