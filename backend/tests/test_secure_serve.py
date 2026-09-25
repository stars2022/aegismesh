from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

from acps_sdk.aip.aip_peer_cert import AipPeerCertH11Protocol

_SERVE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "serve.py"
_SPEC = importlib.util.spec_from_file_location("aegismesh_test_serve", _SERVE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
serve = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(serve)


def test_aip_server_uses_peer_certificate_protocol(monkeypatch) -> None:
    settings = SimpleNamespace(
        aip_identity_binding_enabled=True,
        aip_tls_certfile="server.pem",
        aip_tls_keyfile="server.key",
        aip_tls_client_ca_file="clients.pem",
        aip_tls_port=8443,
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(serve, "get_settings", lambda: settings)
    monkeypatch.setattr(serve.uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))

    serve.main()

    assert captured["ssl_cert_reqs"] == 2
    assert captured["http"] is AipPeerCertH11Protocol
