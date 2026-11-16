"""One shared origin check per 24 hours, independent of Worker lifetimes.

Only fixed owned endpoints are read. No user cookies, tokens or data are used.
The timer can wake hourly after a reboot; a fresh result makes it a file read.
"""
import http.client
import json
import os
from pathlib import Path
import ssl
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = Path('/var/lib/mangahub-router-health')
SECRET_PATH = Path('/etc/mangahub/origin-secret')
DAY = 24 * 60 * 60
PRIMARY_ADDRESS = '76.76.21.21'  # Vercel shared ingress; TLS still verifies the host.


class OriginConnection(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, timeout=5, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        import socket
        raw = socket.create_connection((self.address, 443), timeout=5)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def probe(host, path, address=PRIMARY_ADDRESS, secret=None, html=False, public_host=None, local=False):
    started = time.monotonic()
    connection = http.client.HTTPConnection('127.0.0.1', 8000, timeout=5) if local else OriginConnection(host, address)
    headers = {'Host': public_host or host, 'Accept': 'text/html' if html else 'application/json',
               'Cache-Control': 'no-cache', 'Connection': 'close'}
    if secret:
        headers['X-MangaHub-Origin-Secret'] = secret
        headers['X-MangaHub-Public-Host'] = public_host or host
    try:
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        value = None
        if response.status == 200:
            if html:
                value = {'html': response.getheader('Content-Type', '').startswith('text/html')}
            else:
                value = json.loads(response.read(8192))
        return {'ok': response.status == 200 and (value.get('html') if html else value.get('status') in {'ok', 'ready'}),
                'milliseconds': round((time.monotonic() - started) * 1000), 'value': value}
    except (OSError, ValueError, http.client.HTTPException, AttributeError):
        return {'ok': False}
    finally:
        connection.close()


def main():
    now = time.time()
    destination = ROOT / 'daily.json'
    try:
        previous = json.loads(destination.read_text())
        if 0 <= now * 1000 - previous['checkedAt'] < DAY * 1000:
            return
    except (OSError, ValueError, KeyError, TypeError):
        pass
    secret = SECRET_PATH.read_text().strip()
    if not secret:
        raise RuntimeError('Missing private origin configuration')
    targets = {'mangahub.art': ('/index.html', True), 'api.mangahub.art': ('/health', False),
               'auth.mangahub.art': ('/auth/health', False)}
    with ThreadPoolExecutor(max_workers=5) as pool:
        primary = {host: pool.submit(probe, host, path, html=html) for host, (path, html) in targets.items()}
        readiness = pool.submit(probe, 'api.mangahub.art', '/internal/origin-status', secret=secret, local=True)
        frontend = pool.submit(probe, 'standby.mangahub.art', '/index.html', address='127.0.0.1',
                               secret=secret, html=True, public_host='mangahub.art')
        primary = {host: {k: v for k, v in job.result().items() if k != 'value'} for host, job in primary.items()}
        status, page = readiness.result(), frontend.result()
    backup = {'ok': bool(status['ok'] and page['ok']),
              'capacity': bool((status.get('value') or {}).get('accept_extra')),
              'milliseconds': status.get('milliseconds', 0), 'frontendMilliseconds': page.get('milliseconds', 0)}
    snapshot = {'checkedAt': round(now * 1000), 'primary': primary, 'backup': backup}
    ROOT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / 'daily.tmp'
    temporary.write_text(json.dumps(snapshot))
    temporary.chmod(0o644)
    os.replace(temporary, destination)
    print(json.dumps({'daily_health_written': True, 'primary_ready': all(v['ok'] for v in primary.values()),
                      'backup_ready': backup['ok']}))


if __name__ == '__main__':
    main()
