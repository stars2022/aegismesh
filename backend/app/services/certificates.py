from __future__ import annotations

import asyncio
import ipaddress
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from ..config import get_settings


class CertificateError(RuntimeError):
    pass


@dataclass(slots=True)
class IssuedCertificate:
    aic: str
    cert_path: str
    key_path: str
    trust_bundle_path: str


def validate_certificate_files(
    cert_path: str | Path,
    key_path: str | Path,
    trust_path: str | Path,
    aic: str,
    usage: str,
    server_hostname: str | None = None,
) -> None:
    """Validate the actual certificate, not its filename, before activation."""
    from acps_sdk.aic import validate_aic_format

    if usage not in {"clientAuth", "serverAuth"}:
        raise CertificateError("usage 必须为 clientAuth 或 serverAuth")
    if not validate_aic_format(aic)[0]:
        raise CertificateError("证书 AIC 格式无效")
    try:
        cert = x509.load_pem_x509_certificate(Path(cert_path).read_bytes())
        private_key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
        names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        identities = {v[7:] for v in sans.get_values_for_type(x509.UniformResourceIdentifier)
                      if v.lower().startswith("acps://")}
        if len(names) != 1 or names[0].value != aic or identities != {aic}:
            raise CertificateError("证书 CN / acps:// SAN 与目标 AIC 不一致")
        eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        expected = ExtendedKeyUsageOID.SERVER_AUTH if usage == "serverAuth" else ExtendedKeyUsageOID.CLIENT_AUTH
        if set(eku) != {expected}:
            raise CertificateError(f"证书用途错误：要求 {usage}，实际为 {[v.dotted_string for v in eku]}")
        now = datetime.now(timezone.utc)
        if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
            raise CertificateError("证书尚未生效或已经过期")
        def public_bytes(key):
            return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if public_bytes(cert.public_key()) != public_bytes(private_key.public_key()):
            raise CertificateError("证书与私钥不匹配")
        if usage == "serverAuth":
            if not server_hostname:
                raise CertificateError("serverAuth 校验必须指定公开端点的主机名")
            if not (sans.get_values_for_type(x509.DNSName) or sans.get_values_for_type(x509.IPAddress)):
                raise CertificateError("serverAuth 证书缺少 DNS/IP SAN；请先在原 AIC 的 ACS certificate.altNames 中补齐域名，再重新签发")
        command = ["openssl", "verify", "-CAfile", str(trust_path), "-untrusted", str(cert_path),
                   "-purpose", "sslserver" if usage == "serverAuth" else "sslclient"]
        if usage == "serverAuth":
            try:
                ipaddress.ip_address(server_hostname)
                flag = "-verify_ip"
            except ValueError:
                flag = "-verify_hostname"
            command.extend([flag, server_hostname])
        command.append(str(cert_path))
        verified = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
        if verified.returncode:
            raise CertificateError(f"证书信任链 / 主机名校验失败：{verified.stderr.strip()[:400]}")
    except CertificateError:
        raise
    except (OSError, ValueError, x509.ExtensionNotFound, subprocess.SubprocessError) as exc:
        raise CertificateError(f"证书校验失败：{exc}") from exc


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
    *,
    server_hostname: str | None = None,
) -> IssuedCertificate:
    """用官方 acps-cli 的 ACME 客户端完成 EAB 绑定、账户注册、下单签发。"""
    from acps_sdk.aic import validate_aic_format
    if not validate_aic_format(aic)[0]:
        raise CertificateError("证书 AIC 格式无效")
    if usage not in {"clientAuth", "serverAuth"}:
        raise CertificateError("usage 必须为 clientAuth 或 serverAuth")
    if usage == "serverAuth" and not server_hostname:
        raise CertificateError("serverAuth 签发必须指定公开端点的主机名")
    _ensure_cli_deps()
    if not ca_server_url:
        raise CertificateError("请先配置 CA_SERVER_URL")
    if not eab.get("keyId") or not eab.get("macKey"):
        raise CertificateError("EAB 凭据不完整（缺少 keyId 或 macKey）")

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    suffix = "" if usage == "clientAuth" else f".{usage.lower()}"
    key_path = output / f"{aic}{suffix}.key"
    cert_path = output / f"{aic}{suffix}.pem"
    trust_path = output / "trust-bundle.pem"

    account_key_path = Path(account_key_path) if account_key_path else output / "acme-account.key"
    account_key_path.parent.mkdir(parents=True, exist_ok=True)
    if account_key_path.exists():
        account_key = load_private_key(str(account_key_path))
    else:
        account_key = generate_private_key("ec")
        save_private_key(account_key, str(account_key_path))

    # Serialize issuance for this identity. Renewals reuse its key: a failed CA
    # request must never replace the key used by a still-running listener/MQ.
    import fcntl
    with (output / f".{aic}.issue.lock").open("a") as lock, tempfile.TemporaryDirectory(dir=output, prefix=".issue-") as staging:
        fcntl.flock(lock, fcntl.LOCK_EX)
        stage = Path(staging)
        agent_key = load_private_key(str(key_path)) if key_path.exists() else generate_private_key("ed25519")
        staged_key, staged_cert, staged_trust = stage / "key.pem", stage / "cert.pem", stage / "trust.pem"
        save_private_key(agent_key, str(staged_key))
        staged_key.chmod(0o600)
        csr_obj = generate_csr(agent_key, aic, str(stage / "request.csr"))
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
            staged_cert.write_bytes(client.get_certificate(order["certificate"]))
            trust_response = httpx.get(f"{ca_server_url.rstrip('/')}/ca/trust-bundle", timeout=10)
            trust_response.raise_for_status()
            staged_trust.write_bytes(trust_response.content)
        except (AcmeError, httpx.HTTPError) as exc:
            raise CertificateError(f"CA 签发 / 信任链下载失败：{exc}") from exc
        validate_certificate_files(staged_cert, staged_key, staged_trust, aic, usage, server_hostname)
        # Only validated artifacts may become live. Existing keys are untouched.
        os.replace(staged_trust, trust_path)
        if not key_path.exists():
            os.replace(staged_key, key_path)
        os.replace(staged_cert, cert_path)
    return IssuedCertificate(
        aic=aic,
        cert_path=str(cert_path),
        key_path=str(key_path),
        trust_bundle_path=str(trust_path),
    )


async def issue_certificate(aic: str, eab: dict, usage: str = "clientAuth", *, server_hostname: str | None = None) -> IssuedCertificate:
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
        usage,
        server_hostname=server_hostname or urlsplit(settings.public_base_url).hostname,
    )
