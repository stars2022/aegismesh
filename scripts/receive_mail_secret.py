"""One-shot loopback form for transferring a copied SMTP secret without echoing it.

Run locally; paste into the password field using the browser clipboard. The
secret is saved outside the repository with mode 0600, never printed or logged.
This does not enable accounts, send email, or change the running service.
"""
from __future__ import annotations

import html
import argparse
import os
import re
import secrets
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["resend", "cloudflare"], default="resend")
    provider = parser.parse_args().provider
    label = "Cloudflare Turnstile 配置 Token" if provider == "cloudflare" else "Resend 发送密钥"
    directory = Path(tempfile.mkdtemp(prefix="aegismesh-mail-"))
    destination = directory / ("cloudflare-token" if provider == "cloudflare" else "smtp-secret")
    route = "/" + secrets.token_urlsafe(24)
    expires = time.monotonic() + 600
    received = False

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def page(self, status: int, body: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>AegisMesh 安全配置</title><style>body{font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#232323;background:#f5f5f2}input,button{box-sizing:border-box;width:100%;padding:14px;margin:12px 0;border:1px solid #ddd;border-radius:10px;font:inherit}button{background:#222;color:white}p{line-height:1.8}</style>" + body).encode())

        def do_GET(self):
            if self.path != route or time.monotonic() > expires:
                return self.page(404, "<h1>配置入口已关闭</h1>")
            if received:
                return self.page(200, "<h1>密钥已安全接收</h1><p>没有显示、回传或写入 Git。可以关闭此页面。</p>")
            self.page(200, f"<h1>AegisMesh 安全配置</h1><p>只保存在本机私有配置文件，不会在聊天中显示。</p><form method=post action='{html.escape(route)}'><label for=secret>{label}</label><input id=secret name=secret type=password autocomplete=off spellcheck=false required><button>安全接收</button></form>")

        def do_POST(self):
            nonlocal received
            origin = f"http://127.0.0.1:{self.server.server_port}"
            same_origin = self.headers.get("Origin") == origin or (
                self.headers.get("Origin") in {None, "null"}
                and self.headers.get("Sec-Fetch-Site") == "same-origin")
            if (self.path != route or received or time.monotonic() > expires
                    or not same_origin
                    or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"):
                return self.page(403, "<h1>请求被拒绝</h1>")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 1 <= size <= 512:
                    raise ValueError()
                value = parse_qs(self.rfile.read(size).decode(), max_num_fields=1).get("secret", [""])[0].strip()
                pattern = r"[A-Za-z0-9_-]{30,200}" if provider == "cloudflare" else r"re_[A-Za-z0-9_-]{20,200}"
                if not re.fullmatch(pattern, value):
                    raise ValueError()
            except (ValueError, UnicodeError):
                return self.page(422, "<h1>密钥格式不正确</h1><p>未保存任何内容，请返回重试。</p>")
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(value)
            received = True
            self.page(200, "<h1>密钥已安全接收</h1><p>没有显示、回传或写入 Git。可以关闭此页面。</p>")
            print(f"Secret received: {destination}", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 1
    print(f"Open: http://127.0.0.1:{server.server_port}{route}", flush=True)
    print(f"Private destination: {destination}", flush=True)
    try:
        while not received and time.monotonic() < expires:
            server.handle_request()
    finally:
        server.server_close()
        if not received:
            directory.rmdir()


if __name__ == "__main__":
    main()
