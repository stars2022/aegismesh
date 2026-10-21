"""Loopback-only static demo. No backend, proxy, credentials or agent connection."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse

ROOT = Path(__file__).resolve().parent / "dist"
SPA_ROUTES = {"/", "/admin", "/login", "/register", "/reset", "/digital-human", "/account", "/quota"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; media-src 'self' blob:; "
       "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")

class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "application/javascript"}

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        requested = "index.html" if path in SPA_ROUTES else path.lstrip("/")
        target = (ROOT / requested).resolve()
        if (not target.is_relative_to(ROOT) or any(part.startswith(".") for part in Path(requested).parts)
                or not target.is_file() or (requested != "index.html" and not requested.startswith(("assets/", "media/", "demo/")))):
            self.send_error(404, "Only static demo assets are served")
            return None
        self.path = "/" + requested
        return super().send_head()

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def do_POST(self):
        self.send_error(405, "Offline demonstration has no API")

    do_PUT = do_PATCH = do_DELETE = do_POST

    def log_message(self, *_args):
        pass

class DemoServer(ThreadingHTTPServer):
    # Module preload + local fonts can open a burst of connections. The default
    # TCP backlog of five may reset valid requests during a full page transition.
    request_queue_size = 128


def main():
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5610)
    parser.add_argument("--static-root", type=Path, help="Optional materialized local copy of dist")
    args = parser.parse_args()
    if args.static_root:
        ROOT = args.static_root.resolve()
    if not 1024 <= args.port <= 65535:
        parser.error("Choose a port between 1024 and 65535")
    if not all((ROOT / name).is_file() for name in ("index.html", "demo/bootstrap.mjs", "demo/production-manifest.json")):
        raise SystemExit("Demo assets are incomplete")
    server = DemoServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    server.daemon_threads = True
    print(f"AegisMesh 演示版：http://127.0.0.1:{args.port}", flush=True)
    print("仅本机静态预设，不连接真实智能体。Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
