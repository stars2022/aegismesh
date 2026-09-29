"""Per-agent public TLS authorities, independent of local dispatch policy."""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from .certificates import CertificateError


def public_aip_base(settings, agent_id: str) -> str:
    base = settings.aip_agent_public_urls.get(agent_id, settings.public_base_url).rstrip("/")
    parsed = urlsplit(base)
    try:
        port = parsed.port
    except ValueError as exc:
        raise CertificateError("AIP 公开端点端口无效") from exc
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path or port == 0):
        raise CertificateError("AIP 公开端点必须是无路径、无凭据的 HTTPS origin")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def validate_agent_authorities(settings) -> None:
    authorities = {}
    for agent_id in settings.aip_agent_public_urls:
        parsed = urlsplit(public_aip_base(settings, agent_id))
        authority = (parsed.hostname, parsed.port or 443)
        if authority in authorities:
            raise CertificateError(f"不同 AIC 不得共用 TLS 主机和端口：{authorities[authority]} / {agent_id}")
        authorities[authority] = agent_id
