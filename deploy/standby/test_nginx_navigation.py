"""Exercise the real Nginx template on loopback with disposable static/backend fixtures.

Run on a machine with Nginx installed: python3 deploy/standby/test_nginx_navigation.py
No production port, credential, application process or Cloudflare call is used.
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


@unittest.skipUnless(shutil.which('nginx'), 'Nginx is required for integration tests')
class StandbyNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='mh-nginx-navigation-')
        cls.addClassCleanup(cls.tmp.cleanup)
        root = Path(cls.tmp.name)
        root.chmod(0o755)
        dist = root / 'dist'
        (dist / 'assets').mkdir(parents=True)
        (dist / 'index.html').write_text('<html>MangaHub navigation fixture</html>')
        (dist / 'assets' / 'app.js').write_text('/* fixture */')
        (dist / 'favicon.svg').write_text('<svg/>')
        cls.backend_calls = []

        class Backend(BaseHTTPRequestHandler):
            def dispatch(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                value = {'method': self.command, 'path': self.path, 'body': body.decode()}
                cls.backend_calls.append(value)
                data = json.dumps(value).encode()
                self.send_response(405 if self.path == '/auth/unsupported' else 200)
                self.send_header('Content-Type', 'application/json')
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
        template = Path(os.environ.get('NGINX_TEMPLATE', Path(__file__).with_name('nginx.conf.template'))).read_text()
        maps = template.split('\nserver {', 1)[0]
        server = 'server {' + template.rsplit('\nserver {', 1)[1]
        server = server.replace('listen 443 ssl;', f'listen 127.0.0.1:{cls.port};')
        server = re.sub(r'^\s*ssl_\w+ [^;]+;\s*$', '', server, flags=re.M)
        server = server.replace('include /etc/nginx/mangahub-origin-rules/*.conf;', 'allow 127.0.0.1; deny all;')
        server = server.replace('/opt/mangahub/standby/dist', str(dist))
        server = server.replace('/opt/mangahub;', str(dist) + ';')
        server = server.replace('127.0.0.1:8000', f'127.0.0.1:{cls.backend.server_port}')
        config = root / 'nginx.conf'
        config.write_text('daemon off; master_process off;\n'
                          f'pid {root}/nginx.pid; error_log {root}/error.log;\n'
                          'events { worker_connections 64; }\n'
                          'http { access_log off; default_type text/html;\n'
                          + ''.join(f'{kind}_temp_path {root}/{kind};\n' for kind in
                                    ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'])
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

    def request(self, path='/', method='GET', accept='text/html', trusted=True, body=None):
        headers = {'Host': 'standby.mangahub.art', 'Accept': accept}
        if trusted:
            headers['X-MangaHub-Origin-Secret'] = 'ORIGIN_SECRET_PLACEHOLDER'
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_document_get_and_head_still_work(self):
        for method in ['GET', 'HEAD']:
            for path in ['/', '/manga?sort=rating', '/chapter/qq-fixture', '/auth/callback?code=fixture']:
                with self.subTest(method=method, path=path):
                    status, headers, body = self.request(path, method)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers.get('Cache-Control'), 'private, no-store')
                    if method == 'HEAD':
                        self.assertFalse(body)

    def test_document_post_returns_spa_without_a_redirect_or_upstream(self):
        before = len(self.backend_calls)
        for path in ['/', '/index.html', '/manga?sort=rating', '/manga/fixture',
                     '/chapter/qq-fixture?resume=3', '/auth/callback?code=fixture']:
            with self.subTest(path=path):
                status, headers, body = self.request(path, 'POST', body='navigation=fixture')
                self.assertEqual(status, 200)
                self.assertIn(b'MangaHub navigation fixture', body)
                self.assertEqual(headers.get('Cache-Control'), 'private, no-store')
                self.assertNotIn('Location', headers)
        self.assertEqual(len(self.backend_calls), before)

    def test_api_and_auth_posts_keep_method_body_and_status(self):
        for path in ['/api/history', '/auth/google', '/auth/unsupported']:
            with self.subTest(path=path):
                status, _, body = self.request(path, 'POST', body='keep=this')
                self.assertEqual(status, 405 if path.endswith('unsupported') else 200)
                self.assertEqual(json.loads(body), {'method': 'POST', 'path': path, 'body': 'keep=this'})

    def test_non_document_posts_and_other_methods_are_not_accepted_as_spa(self):
        for path in ['/', '/chapter/fixture']:
            self.assertEqual(self.request(path, 'POST', accept='application/json')[0], 405)
            self.assertEqual(self.request(path, 'PUT')[0], 405)

    def test_static_file_posts_are_not_converted_to_documents(self):
        for path in ['/assets/app.js', '/favicon.svg']:
            self.assertEqual(self.request(path, 'POST')[0], 405)

    def test_unsigned_document_cannot_use_internal_recovery(self):
        status, headers, _ = self.request('/chapter/fixture?resume=3', 'POST', trusted=False)
        self.assertEqual(status, 307)
        self.assertEqual(headers['Location'], 'https://mangahub.art/chapter/fixture?resume=3')
        self.assertEqual(self.request('/api/history', 'POST', trusted=False)[0], 404)

    def test_recovery_uri_cannot_be_called_externally(self):
        for trusted in [False, True]:
            self.assertEqual(self.request('/internal/frontend-document', trusted=trusted)[0], 404)


if __name__ == '__main__':
    unittest.main()
