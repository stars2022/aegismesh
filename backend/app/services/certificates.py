from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..config import get_settings


class CertificateError(RuntimeError):
    pass


@dataclass(slots=True)
class IssuedCertificate:
    aic: str
    cert_path: str
    key_path: str
    trust_bundle_path: str


def _ensure_cli_deps() -> None:
    global AcmeClient, AcmeError, generate_csr, generate_private_key, load_private_key, save_private_key, normalize_acme_object
    try:
        from acps_cli.ca.acme import AcmeClient, AcmeError, normalize_acme_object
        from acps_cli.ca.keys import generate_csr, generate_private_key, load_private_key, save_private_key
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise CertificateError("acps-cli 未安装，无法签发证书（pip install -e '.[test]'）") from exc


def issue_certificate_sync(
    aic: str,
    eab: dict,
    ca_server_url: str,
    account_key_path: str,
    output_dir: str,
    usage: str = "clientAuth",
    poll_seconds: float = 1.0,
    max_polls: int = 30,
) -> IssuedCertificate:
    """用官方 acps-cli 的 ACME 客户端完成 EAB 绑定、账户注册、下单签发。"""
    _ensure_cli_deps()
    if not ca_server_url:
        raise CertificateError("请先配置 CA_SERVER_URL")
    if not eab.get("keyId") or not eab.get("macKey"):
        raise CertificateError("EAB 凭据不完整（缺少 keyId 或 macKey）")

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    key_path = output / f"{aic}.key"
    cert_path = output / f"{aic}.pem"
    trust_path = output / "trust-bundle.pem"

    account_key_path = Path(account_key_path) if account_key_path else output / "acme-account.key"
    account_key_path.parent.mkdir(parents=True, exist_ok=True)
    if account_key_path.exists():
        account_key = load_private_key(str(account_key_path))
    else:
        account_key = generate_private_key("ec")
        save_private_key(account_key, str(account_key_path))

    agent_key = generate_private_key("ed25519")
    save_private_key(agent_key, str(key_path))
    csr_obj = generate_csr(agent_key, aic, str(output / f"{aic}.csr"))
    from cryptography.hazmat.primitives import serialization

    csr_pem = csr_obj.public_bytes(serialization.Encoding.PEM)

    client = AcmeClient(ca_server_url, account_key)
    try:
        client.get_directory()
        client.new_account(eab_credential={"keyId": str(eab["keyId"]), "macKey": str(eab["macKey"])})
        order = client.new_order(aic, usage=usage)
        order = client.finalize_order(order["finalize"], csr_pem)
        polls = 0
        while order.get("status") in {"processing", "pending"}:
            polls += 1
            if polls > max_polls:
                raise CertificateError(f"证书签发轮询超时（{max_polls} 次）")
            time.sleep(poll_seconds)
            order_url = order["url"]
            response = client._post(order_url, None)
            order = normalize_acme_object(response.json(), ca_server_url)
            order["url"] = order_url
        if order.get("status") != "valid":
            raise CertificateError(f"证书订单未通过：{order.get('status')} {order.get('error') or ''}")
        cert_pem = client.get_certificate(order["certificate"])
    except AcmeError as exc:
        raise CertificateError(f"CA 签发失败：{exc}") from exc
    cert_path.write_bytes(cert_pem)
    try:
        trust_response = httpx.get(
            f"{ca_server_url.rstrip('/')}/ca/trust-bundle",
            timeout=10,
        )
        trust_response.raise_for_status()
    except httpx.HTTPError as exc:
        raise CertificateError(f"下载 CA 信任链失败：{exc}") from exc
    trust_path.write_bytes(trust_response.content)
    return IssuedCertificate(
        aic=aic,
        cert_path=str(cert_path),
        key_path=str(key_path),
        trust_bundle_path=str(trust_path),
    )


async def issue_certificate(aic: str, eab: dict) -> IssuedCertificate:
    settings = get_settings()
    # The official registry binds an ACME account to one registered AIC.  Keep
    # account keys isolated so issuing a certificate for one agent cannot make
    # subsequent orders inherit the wrong external-account binding.
    account_key = settings.ca_account_key_file or str(Path(settings.certs_dir) / f"{aic}.account.key")
    return await asyncio.to_thread(
        issue_certificate_sync,
        aic,
        eab,
        settings.ca_server_url,
        account_key,
        settings.certs_dir,
    )
