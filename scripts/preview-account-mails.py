"""Serve actual email templates locally without SMTP, accounts or real tokens.

PYTHONPATH=backend .venv/bin/python scripts/preview-account-mails.py
"""
import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from app.services.account_mail import LOGO_CID, LOGO_PATH, build_account_mail


class Preview(BaseHTTPRequestHandler):
    def do_GET(self):
        purpose = urlsplit(self.path).path.strip("/") or "register"
        if purpose not in ("register", "reset"):
            self.send_error(404)
            return
        message = build_account_mail(sender="AegisMesh <no-reply@example.test>", recipient="preview@example.test",
                                     origin="https://demmo.cc.cd", purpose=purpose, token="preview-invalid-token")
        html = message.get_body(preferencelist=("html",)).get_content()
        html = html.replace(f"cid:{LOGO_CID}", "data:image/png;base64," + base64.b64encode(LOGO_PATH.read_bytes()).decode())
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("Local-only email previews: http://127.0.0.1:5198/register and /reset", flush=True)
    HTTPServer(("127.0.0.1", 5198), Preview).serve_forever()
