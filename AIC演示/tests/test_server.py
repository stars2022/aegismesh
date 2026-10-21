import importlib.util
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import re
import threading
import unittest
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('demo_server', Path(__file__).resolve().parents[1] / 'serve.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class StaticIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(server_module.Handler, directory=str(server_module.ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def test_production_routes_and_assets(self):
        html = (server_module.ROOT / 'index.html').read_text()
        entry = re.search(r'data-production-entry="(/assets/[^\"]+)"', html).group(1)
        for path in ('/', '/admin?tab=studio', '/login', '/digital-human', '/demo/bootstrap.mjs', entry, '/demo/fonts/fonts.css'):
            with urllib.request.urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("connect-src 'none'", response.headers['Content-Security-Policy'])
                self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_no_api_secrets_traversal_or_listing(self):
        for path in ('/api/health', '/api/chat', '/.env', '/../serve.py', '/%2E%2E/serve.py', '/assets/', '/tests/', '/README.md', '/demo/../../serve.py'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(self.base + path)
            self.assertEqual(error.exception.code, 404)

    def test_no_backend_or_proxy(self):
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            request = urllib.request.Request(self.base + '/api/chat', data=b'{}', method=method)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 405)

    def test_mime_and_loopback(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        with urllib.request.urlopen(self.base + '/demo/runtime.mjs') as response:
            self.assertEqual(response.headers.get_content_type(), 'application/javascript')


if __name__ == '__main__':
    unittest.main()
