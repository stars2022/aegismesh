"""Identity checks and runtime bindings consumed only after authenticated MQ delivery."""
from __future__ import annotations

import ssl
import asyncio
from contextlib import suppress
from pathlib import Path
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Any
from ..config import get_settings


def registered_hosted_identity(agent: Any) -> bool:
    return bool(agent.registration_status == "approved" and agent.aic
                and not agent.aic.startswith("local:"))


def identity_context(aic: str) -> ssl.SSLContext:
    if not aic or aic.startswith("local:") or any(c in aic for c in "/\\"):
        raise RuntimeError("兼容模式要求已注册的 AIC 身份，不能使用本地 ID")
    settings = get_settings()
    root = Path(settings.certs_dir)
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    cert = x509.load_pem_x509_certificate((root / f"{aic}.pem").read_bytes())
    names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    if len(names) != 1 or names[0].value != aic:
        raise RuntimeError("clientAuth 证书身份与发送方 AIC 不一致")
    context = ssl.create_default_context(cafile=settings.aip_ca_file or str(root / "trust-bundle.pem"))
    context.load_cert_chain(str(root / f"{aic}.pem"), str(root / f"{aic}.key"))
    return context


def compatibility_prerequisites() -> None:
    settings = get_settings()
    if not (settings.aip_group_mq_host or settings.aip_group_mq_url):
        raise RuntimeError("尚未配置官方 MQ 接入地址")
    if not settings.aip_group_auth_url.startswith("https://"):
        raise RuntimeError("尚未配置 HTTPS 群组授权服务 AIP_GROUP_AUTH_URL")
    if not settings.aip_group_partner_enabled:
        raise RuntimeError("尚未启用群组 Partner 服务")
    identity_context(settings.leader_aic)


@dataclass
class DeliveryBinding:
    query: str
    execute: Callable[[], Awaitable[Any]]
    result: Any = None
    running: asyncio.Task | None = None


deliveries: dict[tuple[str, str, str], DeliveryBinding] = {}
ready_partners: set[str] = set()
outgoing_groups: dict[str, list[Any]] = {}


async def invoke_hosted(caller_aic: str, agent: Any, query: str, session_id: str,
                        timeout: float, execute: Callable[[], Awaitable[Any]]) -> Any:
    import uuid
    from .aip_group import ExternalPartner, MqGroupSession, inbox_acs
    compatibility_prerequisites()
    if caller_aic == agent.aic:
        raise RuntimeError("AIP 不把智能体调用自身视为互联任务，请选择其他成员")
    identity_context(caller_aic)
    if caller_aic not in ready_partners or agent.aic not in ready_partners:
        raise RuntimeError(f"{agent.name} 的认证 MQ Partner 尚未就绪，兼容模式不回退直调")
    task_id = f"task-{uuid.uuid4().hex}"
    key = (caller_aic, agent.aic, task_id)
    binding = DeliveryBinding(query, execute)
    deliveries[key] = binding
    session = MqGroupSession(caller_aic, [ExternalPartner(agent.aic, agent.name, "", inbox_acs(agent.aic))])
    try:
        text = await session.send_and_collect(query, session_id, agent.aic, timeout, task_id=task_id)
        if binding.result is None:
            raise RuntimeError("收到群组结果但未找到本机任务执行结果")
        binding.result.text = text
        binding.result.data = {**(binding.result.data or {}), "interop": {"transport": "aip-mq", "task_id": task_id, "caller_aic": caller_aic, "callee_aic": agent.aic}}
        return binding.result
    finally:
        deliveries.pop(key, None)
        if binding.running and not binding.running.done():
            binding.running.cancel()
            with suppress(asyncio.CancelledError):
                await binding.running
        await session.close()
