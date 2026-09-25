from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

from ..config import get_settings

logger = logging.getLogger(__name__)


class AipGroupBridgeError(RuntimeError):
    pass


@dataclass(slots=True)
class ExternalPartner:
    aic: str
    name: str
    rpc_url: str


@dataclass(slots=True)
class GroupDiscussionResult:
    speeches: list[dict[str, Any]]
    transport: str  # "aip-mq" | "local"
    group_id: str | None = None


def parse_mq_url(url: str) -> dict[str, Any]:
    """把 amqp(s)://user:pass@host:port/vhost 解析成 SDK 构造参数。"""
    from urllib.parse import urlsplit, unquote

    parts = urlsplit(url)
    if parts.scheme not in {"amqp", "amqps"} or not parts.hostname:
        raise AipGroupBridgeError(f"无效的 AIP_GROUP_MQ_URL：{url}")
    return {
        "rabbitmq_host": parts.hostname,
        "rabbitmq_port": parts.port or (5671 if parts.scheme == "amqps" else 5672),
        "rabbitmq_vhost": unquote(parts.path.lstrip("/")) or "/",
        "rabbitmq_user": unquote(parts.username) if parts.username else "guest",
        "rabbitmq_password": unquote(parts.password) if parts.password else "guest",
    }


def mq_settings() -> dict[str, Any]:
    """从配置构造 GroupLeaderMqClient 参数；未配置时返回空 dict。"""
    settings = get_settings()
    if settings.aip_group_mq_host:
        return {
            "rabbitmq_host": settings.aip_group_mq_host,
            "rabbitmq_port": settings.aip_group_mq_port,
            "rabbitmq_vhost": settings.aip_group_mq_vhost,
            "rabbitmq_user": settings.aip_group_mq_user,
            "rabbitmq_password": settings.aip_group_mq_password,
        }
    if settings.aip_group_mq_url:
        return parse_mq_url(settings.aip_group_mq_url)
    return {}


async def run_aip_group_discussion(
    leader_aic: str,
    partners: list[ExternalPartner],
    topic: str,
    rounds: int,
    initial_context: str,
    on_speech,
    timeout_seconds: float,
) -> GroupDiscussionResult:
    """国标 AIP 群组模式：经 RabbitMQ 群组 Exchange 与外部 Partner 完成多轮研讨。

    on_speech(agent_name, statement) 逐条回调（调用方负责写入黑板）。
    任一环节失败抛 AipGroupBridgeError，由调用方决定回退本地黑板。
    """
    mq = mq_settings()
    if not mq:
        raise AipGroupBridgeError("未配置 AIP_GROUP_MQ_HOST / AIP_GROUP_MQ_URL")
    if not partners:
        raise AipGroupBridgeError("外部参与者为空")

    try:
        from acps_sdk.aip import TaskCommandType
        from acps_sdk.aip.aip_group_leader import GroupLeaderMqClient
        from acps_sdk.aip.aip_group_model import ACSObject
    except ImportError as exc:  # pragma: no cover
        raise AipGroupBridgeError("acps-sdk 群组模块不可用") from exc

    client = GroupLeaderMqClient(leader_aic=leader_aic, **mq)
    received: list[dict[str, Any]] = []
    expected = len(partners) * rounds
    done = asyncio.Event()

    def extract_text(result: Any) -> str:
        chunks: list[str] = []
        for product in getattr(result, "products", None) or []:
            for item in getattr(product, "dataItems", None) or []:
                if getattr(item, "type", None) == "text" and getattr(item, "text", ""):
                    chunks.append(item.text)
        return "\n".join(chunks)

    async def handle_message(message: Any) -> None:
        # SDK 的 MessageHandler 直接收到解析后的 TaskResult（兼容可能的包装结构）
        payload = getattr(message, "result", None) or message
        sender = getattr(payload, "senderId", "") or "partner"
        state = getattr(getattr(payload, "status", None), "state", None)
        text = extract_text(payload)
        if text:
            received.append({"agent": sender, "statement": text, "state": str(state)})
            on_speech(str(sender), text)
            if len(received) >= expected:
                done.set()

    client.set_message_handler(handle_message)
    try:
        await asyncio.wait_for(client.connect(), timeout=15)
        await client.create_group()
        for partner in partners:
            await client.invite_partner(
                ACSObject(aic=partner.aic),
                partner.rpc_url,
                timeout=min(30.0, max(5.0, timeout_seconds / 2)),
            )

        session_id = f"group-{uuid.uuid4().hex[:10]}"
        started = time.monotonic()
        for round_no in range(1, rounds + 1):
            round_topic = topic if rounds == 1 else f"【第 {round_no}/{rounds} 轮】{topic}"
            if initial_context and round_no == 1:
                round_topic = f"{round_topic}\n背景材料：{initial_context}"
            await client.send_task_command(
                TaskCommandType.Start,
                task_id=f"task-{uuid.uuid4().hex[:10]}",
                session_id=session_id,
                text_content=round_topic,
                mentions="all",
            )
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(done.wait(), timeout=remaining)
                done.clear()
            except asyncio.TimeoutError:
                logger.warning("event=group_round_timeout round=%s received=%s", round_no, len(received))
                break

        return GroupDiscussionResult(
            speeches=received,
            transport="aip-mq",
            group_id=client.group_id,
        )
    finally:
        for cleanup in (client.broadcast_group_shutdown, client.cleanup_group_resources, client.dissolve_group):
            try:
                await asyncio.wait_for(cleanup(), timeout=5)
            except Exception:
                continue
        try:
            await client.close()
        except Exception:
            pass
