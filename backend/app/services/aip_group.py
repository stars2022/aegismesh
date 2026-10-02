from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, unquote, quote
from ..config import get_settings
from .interop import identity_context
from .amp_service import amp_service


class AipGroupBridgeError(RuntimeError):
    pass


@dataclass(slots=True)
class ExternalPartner:
    aic: str
    name: str
    rpc_url: str
    acs: dict | None = None


@dataclass(slots=True)
class GroupDiscussionResult:
    speeches: list[dict[str, Any]]
    transport: str
    group_id: str | None = None


def parse_mq_url(url: str) -> dict[str, Any]:
    parts = urlsplit(url)
    if parts.scheme not in {"amqp", "amqps"} or not parts.hostname:
        raise AipGroupBridgeError("无效的 MQ URL（应为 amqps://host:port/vhost）")
    return {"rabbitmq_host": parts.hostname,
            "rabbitmq_port": parts.port or (5671 if parts.scheme == "amqps" else 5672),
            "rabbitmq_vhost": unquote(parts.path.lstrip("/")) or "/",
            "rabbitmq_user": unquote(parts.username) if parts.username else None,
            "rabbitmq_password": unquote(parts.password) if parts.password else None}


def mq_settings() -> dict[str, Any]:
    settings = get_settings()
    if settings.aip_group_mq_host:
        return {"rabbitmq_host": settings.aip_group_mq_host,
                "rabbitmq_port": settings.aip_group_mq_port,
                "rabbitmq_vhost": settings.aip_group_mq_vhost,
                "rabbitmq_user": None, "rabbitmq_password": None}
    if settings.aip_group_mq_url:
        if not settings.aip_group_mq_url.startswith("amqps://"):
            raise AipGroupBridgeError("官方 MQ 接入要求 AMQPS + EXTERNAL 证书认证")
        config = parse_mq_url(settings.aip_group_mq_url)
        if config["rabbitmq_user"] or config["rabbitmq_password"]:
            raise AipGroupBridgeError("官方 MQ 接入不能使用账号密码，请使用智能体证书")
        return config
    return {}


def inbox_acs(aic: str, *, registration_template: bool = False) -> dict:
    from acps_sdk.aip.aip_group_runtime import build_inbox_queue_name
    mq = mq_settings()
    if not mq:
        raise AipGroupBridgeError("未配置 MQ 地址")
    # Registration assigns AIC on approval and substitutes literal {AIC} in URLs.
    # Runtime callers still go through the SDK's strict AIC validation.
    if registration_template and aic != "{AIC}":
        raise AipGroupBridgeError("注册模板必须使用 {AIC} 占位符")
    queue = "inbox_{AIC}" if registration_template else quote(build_inbox_queue_name(aic), safe='')
    url = f"amqps://{mq['rabbitmq_host']}:{mq['rabbitmq_port']}/{quote(mq['rabbitmq_vhost'], safe='')}?inbox={queue}"
    return {"aic": aic, "endPoints": [{"transport": "AMQP", "url": url}]}


def message_emitter(aic: str):
    from acps_sdk.amp import MessageEmitter
    return MessageEmitter(amp_service.log_dir / "amp_message_aegismesh.jsonl", aic=aic)


class MqGroupSession:
    """Official GroupLeader owns ACLs/invitations; states are keyed by task AND peer."""
    def __init__(self, leader_aic: str, partners: list[ExternalPartner]) -> None:
        self._leader_aic = leader_aic
        self._partners = partners
        self._leader: Any = None
        self._session: Any = None
        self._session_id = f"aegis-{uuid.uuid4().hex}"
        self._lock = asyncio.Lock()
        self.group_id: str | None = None

    async def ensure(self) -> None:
        if self._leader is not None:
            return
        from acps_sdk.aip.aip_group_leader import GroupLeader
        from acps_sdk.aip.aip_group_model import ACSObject
        from .interop import ready_partners, outgoing_groups
        mq = mq_settings()
        if not mq:
            raise AipGroupBridgeError("未配置 MQ 接入地址")
        auth_url = get_settings().aip_group_auth_url
        if not auth_url.startswith("https://"):
            raise AipGroupBridgeError("未配置 HTTPS 群组授权地址 AIP_GROUP_AUTH_URL")
        leader = GroupLeader(self._leader_aic, {
            "host": mq["rabbitmq_host"], "port": mq["rabbitmq_port"],
            "vhost": mq["rabbitmq_vhost"], "user": None, "password": None,
            "auth_service_url": auth_url,
        }, ssl_context=identity_context(self._leader_aic), identity_binding_enabled=True,
           message_emitter=message_emitter(self._leader_aic))
        self._leader = leader
        if self._leader_aic in ready_partners:
            # The pinned SDK has separate leader/partner inbox consumers. In a
            # multi-role host these would steal each other's messages. One
            # authenticated consumer routes invitation/error to SDK handlers.
            async def shared_inbox():
                if self._leader_aic not in ready_partners:
                    raise AipGroupBridgeError("共享 AIC 收件箱未就绪")
            leader._ensure_inbox = shared_inbox
            outgoing_groups.setdefault(self._leader_aic, []).append(leader)
        try:
            stage = "连接与建群"
            self._session = await asyncio.wait_for(leader.create_group_session(
                self._session_id, [ACSObject(aic=p.aic) for p in self._partners]), 30)
            self.group_id = self._session.group_id
            for p in self._partners:
                stage = f"等待 {p.name} 入群"
                await asyncio.wait_for(leader.invite_partner(self._session_id, ACSObject(aic=p.aic),
                                            partner_rpc_url=p.rpc_url or None, partner_acs_data=p.acs), 45)
        except TimeoutError as exc:
            await self.close()
            raise AipGroupBridgeError(f"官方 MQ {stage}超时，尚未发送子任务，未回退本地直调") from exc
        except BaseException:
            await self.close()
            raise

    async def send_and_collect(self, text: str, session_id: str, target_aic: str | None = None,
                               timeout_seconds: float = 90, *, task_id: str | None = None,
                               execution_context: dict[str, Any] | None = None) -> str:
        if not target_aic or target_aic not in {p.aic for p in self._partners}:
            raise AipGroupBridgeError("必须指定群内目标智能体")
        task_id = task_id or f"task-{uuid.uuid4().hex}"
        started, status = time.monotonic(), 500
        sent = False
        async with self._lock:
            try:
                async with asyncio.timeout(timeout_seconds):
                    await self.ensure()
                    # SDK Message tap uses sessionId as correlationId. Give each
                    # task its own wire session so both edges emit the real taskId.
                    if execution_context is None:
                        await self._session.leader_mq_client.start_task(task_id, text_content=text,
                                                      task_id=task_id, mentions=[target_aic])
                    else:
                        from acps_sdk.aip import StructuredDataItem, TaskCommandType
                        await self._session.leader_mq_client.send_task_command(
                            TaskCommandType.Start, task_id, task_id, text_content=text,
                            data_items=[StructuredDataItem(data=execution_context,
                                                          metadata={"role": "execution-context"})],
                            mentions=[target_aic])
                    sent = True
                    completion_sent = False
                    while True:
                        self._session.state_update_event.clear()
                        snapshot = self._session.get_partner_task_snapshot(task_id, target_aic)
                        if snapshot:
                            state = getattr(snapshot["state"], "value", snapshot["state"])
                            if state == "completed":
                                status = 200
                                return snapshot.get("product_text") or ""
                            if state in {"failed", "rejected", "canceled", "awaiting-input"}:
                                raise AipGroupBridgeError(f"群组任务未完成：{state}")
                            if state == "awaiting-completion" and not completion_sent:
                                completion_sent = True
                                await self._session.leader_mq_client.complete_task(task_id, task_id, mentions=[target_aic])
                                continue
                        await self._session.state_update_event.wait()
            except BaseException:
                if sent:
                    with suppress(Exception):
                        await asyncio.wait_for(self._session.leader_mq_client.cancel_task(task_id, task_id,
                                                mentions=[target_aic]), 3)
                raise
            finally:
                if sent:
                    await amp_service.record_access(caller_aic=self._leader_aic, callee_aic=target_aic,
                        reporter_aic=self._leader_aic, task_id=task_id, session_id=session_id,
                        method="AMQP", url="aip/group/task", route="aip/group/task",
                        status_code=status, duration_ms=int((time.monotonic()-started)*1000))

    async def close(self) -> None:
        from .interop import outgoing_groups
        leader, self._leader = self._leader, None
        if leader:
            owners = outgoing_groups.get(self._leader_aic, [])
            if leader in owners:
                owners.remove(leader)
            if not owners:
                outgoing_groups.pop(self._leader_aic, None)
            with suppress(Exception):
                await asyncio.wait_for(leader.close(), 10)


async def run_aip_group_discussion(leader_aic: str, partners: list[ExternalPartner], topic: str,
                                 rounds: int, initial_context: str, on_speech,
                                 timeout_seconds: float) -> GroupDiscussionResult:
    if not partners:
        raise AipGroupBridgeError("参与者为空")
    session = MqGroupSession(leader_aic, partners)
    speeches = []
    try:
        async with asyncio.timeout(timeout_seconds):
            for round_no in range(1, rounds+1):
                for partner in partners:
                    statement = await session.send_and_collect(
                        f"第 {round_no}/{rounds} 轮：{topic}\n{initial_context}", session._session_id,
                        partner.aic, timeout_seconds)
                    speeches.append({"agent": partner.aic, "statement": statement, "round": round_no})
                    on_speech(partner.aic, statement)
        return GroupDiscussionResult(speeches, "aip-mq", session.group_id)
    finally:
        await session.close()


async def get_mq_session(group_key: str, leader_aic: str, partners: list[ExternalPartner]) -> MqGroupSession:
    # Scoped session: callers must close it, no unbounded global cache.
    return MqGroupSession(leader_aic, partners)
