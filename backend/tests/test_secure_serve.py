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
    monkeypatch.setattr(serve, "listener_options", lambda s: {
        "port": s.aip_tls_port, "ssl_certfile": s.aip_tls_certfile, "ssl_keyfile": s.aip_tls_keyfile,
    })
    monkeypatch.setattr(serve.uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))

    serve.main()

    assert captured["ssl_cert_reqs"] == 1  # CERT_OPTIONAL：握手可读服务端证书，命令身份校验在应用层
    assert captured["http"] is AipPeerCertH11Protocol
    import os
    assert os.environ["BACKGROUND_WORKER_ENABLED"] == "false"


def test_dedicated_listener_does_not_need_legacy_certificate_paths(monkeypatch):
    from app.config import Settings
    settings = Settings(_env_file=None, aip_tls_agent_id="travel_coordinator",
                        aip_identity_binding_enabled=True, aip_tls_client_ca_file="ca.pem")
    monkeypatch.setattr(serve, "get_settings", lambda: settings)
    monkeypatch.setattr(serve, "listener_options", lambda s: {"port": 8450})
    ports = []
    monkeypatch.setattr(serve.uvicorn, "run", lambda *a, **kw: ports.append(kw["port"]))
    serve.main()
    assert ports == [8450]


def test_listener_refuses_invalid_certificate_before_start(monkeypatch):
    import pytest
    from app.config import Settings
    from app.services.certificates import CertificateError
    settings = Settings(_env_file=None, aip_identity_binding_enabled=True, aip_tls_certfile="cert.pem",
                        aip_tls_keyfile="key.pem", aip_tls_client_ca_file="ca.pem", aip_tls_port=8443,
                        leader_aic="expected-aic", public_base_url="https://aip.example.com:8443")
    monkeypatch.setattr(serve, "get_settings", lambda: settings)
    def invalid(*args, **kwargs): raise CertificateError("证书用途错误")
    monkeypatch.setattr(serve, "validate_certificate_files", invalid)
    monkeypatch.setattr(serve.uvicorn, "run", lambda *a, **k: pytest.fail("must not open a listener"))
    with pytest.raises(SystemExit, match="证书用途错误"):
        serve.main()


def test_public_aip_authorities_are_independent():
    import pytest
    from app.config import Settings
    from app.services.aip_tls import public_aip_base, validate_agent_authorities
    from app.services.certificates import CertificateError
    settings = Settings(_env_file=None, public_base_url="https://aip.example.com:8443",
                        aip_agent_public_urls={"one": "https://aip.example.com:8443", "two": "https://aip.example.com:8444"})
    validate_agent_authorities(settings)
    assert public_aip_base(settings, "two") == "https://aip.example.com:8444"
    settings.aip_agent_public_urls["two"] = "https://aip.example.com:8443"
    with pytest.raises(CertificateError, match="不得共用"):
        validate_agent_authorities(settings)


def test_tls_listener_rejects_other_agent_identity(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from app.main import require_listener_identity, settings
    monkeypatch.setattr(settings, "aip_tls_local_aic", "own-aic")
    require_listener_identity(SimpleNamespace(aic="own-aic"))
    with pytest.raises(HTTPException) as exc:
        require_listener_identity(SimpleNamespace(aic="other-aic"))
    assert exc.value.status_code == 421


def test_dedicated_listener_uses_its_own_certificate_and_port(db, monkeypatch):
    from app.config import Settings
    from app.models import Agent
    import app.database as database
    aic = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"
    db.add(Agent(id="docs_overview", name="Docs", aic=aic, role="partner", usage_mode="both",
                 transport="openai-compatible", registration_status="approved"))
    db.commit()
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    captured = []
    monkeypatch.setattr(serve, "validate_certificate_files", lambda *args: captured.append(args))
    settings = Settings(_env_file=None, aip_tls_agent_id="docs_overview", certs_dir="/certs",
                        aip_agent_public_urls={"docs_overview": "https://aip.example.com:8444"})
    options = serve.listener_options(settings)
    assert options["port"] == 8444
    assert options["ssl_certfile"] == f"/certs/{aic}.serverauth.pem"
    assert captured[0][3:] == (aic, "serverAuth", "aip.example.com")
    assert settings.aip_tls_local_aic == aic
