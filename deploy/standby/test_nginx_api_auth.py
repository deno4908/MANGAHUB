"""Test public byte/API ingress with disposable loopback Nginx and backend."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


@unittest.skipUnless(shutil.which('nginx'), 'Nginx is required')
class PublicAPIOriginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='mh-api-origin-test-')
        cls.addClassCleanup(cls.tmp.cleanup)
        root = Path(cls.tmp.name)
        root.chmod(0o755)
        cls.calls = []
        class Backend(BaseHTTPRequestHandler):
            def dispatch(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                row = {'method': self.command, 'path': self.path, 'body': body.decode(),
                       'host': self.headers.get('Host'), 'client': self.headers.get('X-Real-IP'),
                       'origin_secret': self.headers.get('X-MangaHub-Origin-Secret'),
                       'public_host': self.headers.get('X-MangaHub-Public-Host'),
                       'client_hint': self.headers.get('X-MangaHub-Client-IP'),
                       'csrf': self.headers.get('X-MangaHub-CSRF'),
                       'origin': self.headers.get('Origin')}
                cls.calls.append(row)
                trusted = self.headers.get('Origin') == 'https://mangahub.art'
                status = (204 if trusted else 400) if self.command == 'OPTIONS' else 403 if not trusted or not self.headers.get('Authorization') else 503 if self.path == '/api/unavailable' else 200
                if self.path in ['/auth/google', '/auth/discord', '/api/saved-url']:
                    row['url'] = 'https://auth.example/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fmangahub.art%2Fauth%2Fcallback'
                data = b'' if status == 204 else json.dumps(row).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                if trusted:
                    self.send_header('Access-Control-Allow-Origin', 'https://mangahub.art')
                    self.send_header('Access-Control-Allow-Credentials', 'true')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            do_GET = do_POST = do_OPTIONS = dispatch
            def log_message(self, *args):
                pass
        cls.backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        cls.addClassCleanup(cls.backend.server_close)
        threading.Thread(target=cls.backend.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.backend.shutdown)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        template = Path(__file__).with_name('nginx-api-auth.conf.template').read_text()
        maps = template.split('\nserver {', 1)[0]
        server = 'server {' + template.rsplit('\nserver {', 1)[1]
        server = server.replace('listen 443 ssl;', f'listen 127.0.0.1:{cls.port};')
        server = re.sub(r'^\s*ssl_\w+ [^;]+;\s*$', '', server, flags=re.M)
        server = server.replace('include /etc/nginx/mangahub-origin-rules/*.conf;', 'allow 127.0.0.1; deny all;')
        server = server.replace('127.0.0.1:8000', f'127.0.0.1:{cls.backend.server_port}')
        config = root / 'nginx.conf'
        config.write_text(f'daemon off; master_process off; pid {root}/nginx.pid; error_log {root}/error.log;\n'
            'events { worker_connections 64; }\nhttp { access_log off;\n'
            + ''.join(f'{kind}_temp_path {root}/{kind};\n' for kind in ['client_body','proxy','fastcgi','uwsgi','scgi'])
            + maps + '\n' + server + '\n}\n')
        cls.nginx = subprocess.Popen(['nginx', '-p', str(root), '-c', str(config)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        cls.addClassCleanup(cls.stop_nginx)
        for _ in range(100):
            if cls.nginx.poll() is not None:
                raise RuntimeError(cls.nginx.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=.1):
                    break
            except OSError:
                time.sleep(.02)
        else:
            raise RuntimeError('Isolated Nginx did not start')

    @classmethod
    def stop_nginx(cls):
        cls.nginx.terminate()
        cls.nginx.wait(timeout=5)
        cls.nginx.stderr.close()

    def call(self, path, *, method='GET', host='api.mangahub.art', authorized=True, body=None,
             origin='https://standby.mangahub.art'):
        headers = {'Host': host, 'CF-Connecting-IP': '203.0.113.25',
                   'X-MangaHub-Client-IP': '198.51.100.7', 'X-MangaHub-Public-Host': 'untrusted.example',
                   'X-MangaHub-Origin-Secret': 'untrusted-secret', 'X-MangaHub-CSRF': 'fixture', 'Origin': origin}
        if authorized:
            headers['Authorization'] = 'Bearer fixture'
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_images_preflight_and_api_reads_reach_the_backend_without_worker_headers(self):
        for path in ['/api/images/img?url=fixture', '/api/manga/truyenqq/cover/book-1', '/api/manga/mangadex/browse?page=1']:
            with self.subTest(path=path):
                self.assertEqual(self.call(path, method='OPTIONS', authorized=False)[0], 204)
                status, headers, body = self.call(path)
                self.assertEqual(status, 200)
                data = json.loads(body)
                self.assertEqual(data['host'], 'api.mangahub.art')
                self.assertEqual(data['client'], '203.0.113.25')
                self.assertEqual(data['origin'], 'https://mangahub.art')
                self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://standby.mangahub.art')
                for key in ['origin_secret','public_host','client_hint']:
                    self.assertIsNone(data[key])
                self.assertIn('no-store', headers['Cache-Control'])

    def test_app_authorization_and_failed_writes_keep_their_status_and_run_once(self):
        self.assertEqual(self.call('/api/manga/categories', authorized=False)[0], 403)
        before = len(self.calls)
        self.assertEqual(self.call('/api/unavailable', method='POST', body='save-once')[0], 503)
        self.assertEqual(len(self.calls), before + 1)
        self.assertEqual(self.calls[-1]['body'], 'save-once')
        status, _, body = self.call('/auth/refresh', method='POST', host='auth.mangahub.art', body='refresh-once')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['host'], 'auth.mangahub.art')
        self.assertEqual(json.loads(body)['csrf'], 'fixture')

    def test_only_fixed_oauth_responses_adopt_the_owned_standby_callback(self):
        for path in ['/auth/google', '/auth/discord']:
            for origin in ['https://standby.mangahub.art', 'https://mangahub.art']:
                status, headers, body = self.call(path, method='POST', host='auth.mangahub.art', origin=origin)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
                callback = origin.replace(':', '%3A').replace('/', '%2F') + '%2Fauth%2Fcallback'
                self.assertIn('redirect_to=' + callback, json.loads(body)['url'])
        self.assertIn('redirect_to=https%3A%2F%2Fmangahub.art%2Fauth%2Fcallback',
                      json.loads(self.call('/api/saved-url')[2])['url'])

    def test_other_origins_are_not_authorized_or_given_credentialed_cors(self):
        status, headers, _ = self.call('/api/manga/categories', method='OPTIONS', origin='https://untrusted.example')
        self.assertEqual(status, 400)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        status, headers, _ = self.call('/auth/google', method='POST', host='auth.mangahub.art', origin='https://untrusted.example')
        self.assertEqual(status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_private_and_frontend_paths_are_not_exposed(self):
        before = len(self.calls)
        for path in ['/internal/origin-status', '/internal/router-health', '/internal/source-access', '/']:
            self.assertEqual(self.call(path)[0], 404)
        self.assertEqual(len(self.calls), before)


if __name__ == '__main__':
    unittest.main()
