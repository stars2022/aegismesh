"""AegisMesh 服务启动器：按配置自动启用 AIP 托管端点的 HTTPS/mTLS 监听。

用法：
    PYTHONPATH=backend .venv/bin/python -m scripts.serve

环境变量（与 .env 一致）：
    AIP_TLS_CERTFILE / AIP_TLS_KEYFILE   服务端证书链与私钥（启用 HTTPS）
    AIP_TLS_CLIENT_CA_FILE               客户端证书 CA（启用 mTLS 双向校验）
    AIP_TLS_PORT                          HTTPS 监听端口，默认 8443；0 表示不启用
"""
from __future__ import annotations

import uvicorn
from acps_sdk.aip.aip_peer_cert import AipPeerCertH11Protocol

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    if not (
        settings.aip_identity_binding_enabled
        and settings.aip_tls_certfile
        and settings.aip_tls_keyfile
        and settings.aip_tls_client_ca_file
        and settings.aip_tls_port
    ):
        raise SystemExit(
            "托管 AIP 监听要求 AIP_IDENTITY_BINDING_ENABLED=true，并完整配置 "
            "AIP_TLS_CERTFILE、AIP_TLS_KEYFILE、AIP_TLS_CLIENT_CA_FILE 与 AIP_TLS_PORT"
        )
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.aip_tls_port,
        ssl_certfile=settings.aip_tls_certfile,
        ssl_keyfile=settings.aip_tls_keyfile,
        ssl_ca_certs=settings.aip_tls_client_ca_file,
        # CERT_OPTIONAL：无客户端证书也能完成握手（互操作预检需读取服务端
        # serverAuth 证书）；AIP 命令的身份校验仍在应用层执行。
        ssl_cert_reqs=1,
        http=AipPeerCertH11Protocol,
    )


if __name__ == "__main__":
    main()
