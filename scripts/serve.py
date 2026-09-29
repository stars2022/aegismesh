"""AegisMesh 服务启动器：按配置自动启用 AIP 托管端点的 HTTPS/mTLS 监听。

用法：
    PYTHONPATH=backend .venv/bin/python -m scripts.serve

环境变量（与 .env 一致）：
    AIP_TLS_CERTFILE / AIP_TLS_KEYFILE   服务端证书链与私钥（启用 HTTPS）
    AIP_TLS_CLIENT_CA_FILE               客户端证书 CA（启用 mTLS 双向校验）
    AIP_TLS_PORT                          HTTPS 监听端口，默认 8443；0 表示不启用
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

import uvicorn
from acps_sdk.aip.aip_peer_cert import AipPeerCertH11Protocol

from app.config import get_settings
from app.services.certificates import CertificateError, validate_certificate_files
from app.services.aip_tls import public_aip_base, validate_agent_authorities


def listener_options(settings) -> dict:
    """Fail before opening sockets when the certificate cannot identify this AIC."""
    validate_agent_authorities(settings)
    aic = settings.leader_aic
    certfile, keyfile = settings.aip_tls_certfile, settings.aip_tls_keyfile
    base, port = settings.public_base_url, settings.aip_tls_port
    if settings.aip_tls_agent_id:
        from app.database import SessionLocal
        from app.models import Agent
        with SessionLocal() as db:
            agent = db.get(Agent, settings.aip_tls_agent_id)
            if not agent or agent.registration_status != "approved" or agent.transport == "aip-rpc" or agent.usage_mode == "internal":
                raise CertificateError("TLS 入口必须绑定已审核的托管智能体")
            aic = agent.aic
        if settings.aip_tls_agent_id not in settings.aip_agent_public_urls:
            raise CertificateError("独立 TLS 入口缺少 AIP_AGENT_PUBLIC_URLS 映射")
        base = public_aip_base(settings, settings.aip_tls_agent_id)
        port = urlsplit(base).port or 443
        root = Path(settings.certs_dir)
        certfile, keyfile = str(root / f"{aic}.serverauth.pem"), str(root / f"{aic}.serverauth.key")
    validate_certificate_files(certfile, keyfile, settings.aip_ca_file or settings.aip_tls_client_ca_file,
                               aic, "serverAuth", urlsplit(base).hostname)
    settings.aip_tls_local_aic = aic
    return {"port": port, "ssl_certfile": certfile, "ssl_keyfile": keyfile}


def main() -> None:
    import os
    os.environ["AIP_GROUP_LISTENER_WORKER"] = "false"
    os.environ["LOG_INDEXER_ENABLED"] = "false"
    os.environ["BACKGROUND_WORKER_ENABLED"] = "false"
    settings = get_settings()
    if not (
        settings.aip_identity_binding_enabled
        and settings.aip_tls_client_ca_file
        and (getattr(settings, "aip_tls_agent_id", "") or (
            settings.aip_tls_certfile and settings.aip_tls_keyfile and settings.aip_tls_port
        ))
    ):
        raise SystemExit(
            "托管 AIP 监听要求 AIP_IDENTITY_BINDING_ENABLED=true，并完整配置 "
            "AIP_TLS_CERTFILE、AIP_TLS_KEYFILE、AIP_TLS_CLIENT_CA_FILE 与 AIP_TLS_PORT"
        )
    try:
        options = listener_options(settings)
    except CertificateError as exc:
        raise SystemExit(f"AIP TLS 启动检查失败：{exc}") from exc
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        **options,
        ssl_ca_certs=settings.aip_tls_client_ca_file,
        # CERT_OPTIONAL：无客户端证书也能完成握手（互操作预检需读取服务端
        # serverAuth 证书）；AIP 命令的身份校验仍在应用层执行。
        ssl_cert_reqs=1,
        http=AipPeerCertH11Protocol,
    )


if __name__ == "__main__":
    main()
