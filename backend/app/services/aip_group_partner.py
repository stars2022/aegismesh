from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import select

from ..config import get_settings
from ..database import SessionLocal
from ..models import Agent

logger = logging.getLogger(__name__)


def _mq_kwargs() -> dict[str, Any]:
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
        from .aip_group import parse_mq_url

        return parse_mq_url(settings.aip_group_mq_url)
    return {}


async def _execute_local_task(agent_id: str, task_text: str) -> str:
    """复用托管运行时执行群任务，返回文本结果。"""
    from .hosted_aip import HostedAipService

    with SessionLocal() as db:
        agent = db.get(Agent, agent_id)
        if agent is None:
            raise RuntimeError(f"群组 Partner 智能体 {agent_id} 不存在")
        service = HostedAipService(db, agent)
        task_id = f"group-{uuid.uuid4().hex[:10]}"
        from ..models import HostedTask

        task = HostedTask(
            task_id=task_id,
            agent_id=agent.id,
            session_id="aip-group",
            state="accepted",
            query=task_text,
            command_history=[],
        )
        db.add(task)
        db.commit()
        await service._run(task)
        db.commit()
        return task.result_text or ""


async def _partner_loop() -> None:
    """AIP 国标群组 Partner：监听收件箱邀请，入群后执行群任务并回传。"""
    from acps_sdk.aip import TaskCommandType, TaskState, TextDataItem
    from acps_sdk.aip.aip_group_partner import GroupPartnerMqClient

    settings = get_settings()
    with SessionLocal() as db:
        agent_id = settings.aip_group_partner_agent_id or ""
        if not agent_id:
            agent = db.scalars(
                select(Agent).where(Agent.role == "partner", Agent.transport != "aip-rpc").order_by(Agent.id)
            ).first()
            agent_id = agent.id if agent else ""
        agent = db.get(Agent, agent_id) if agent_id else None
        if agent is None:
            logger.warning("event=group_partner_skip reason=no_agent")
            return
        partner_aic = agent.aic
        agent_name = agent.name

    client = GroupPartnerMqClient(partner_aic=partner_aic, **_mq_kwargs())

    async def on_command(message: Any) -> None:
        command = getattr(message, "command", None) or message
        task_id = getattr(command, "taskId", "") or f"task-{uuid.uuid4().hex[:8]}"
        session_id = getattr(command, "sessionId", "") or "aip-group"
        text = "\n".join(
            item.text for item in (getattr(command, "dataItems", None) or []) if getattr(item, "type", "") == "text"
        )
        if not text or getattr(command, "command", None) != TaskCommandType.Start:
            return
        logger.info("event=group_partner_task group=%s task=%s", getattr(command, "groupId", ""), task_id)
        try:
            answer = await _execute_local_task(settings.aip_group_partner_agent_id, text)
            from acps_sdk.aip import Product

            await client.send_task_result(
                task_id=task_id,
                session_id=session_id,
                state=TaskState.AwaitingCompletion,
                products=[Product(id=f"product-{task_id}", name="Group task result", dataItems=[TextDataItem(text=answer or "已完成")])],
            )
        except Exception as exc:
            await client.send_task_result(
                task_id=task_id,
                session_id=session_id,
                state=TaskState.Failed,
                status_data_items=[TextDataItem(text=f"执行失败：{exc}")],
            )

    client.set_invitation_handler(lambda invitation: None)
    client.set_command_handler(on_command)
    try:
        await client.connect()
        await client.ensure_inbox_queue()
        await client.start_inbox_consuming()
        logger.info("event=group_partner_ready aic=%s agent=%s", partner_aic, agent_name)
        await asyncio.Future()  # 常驻
    except Exception as exc:
        logger.error("event=group_partner_error error=%s", exc)


async def start_partner_listener() -> asyncio.Task | None:
    settings = get_settings()
    if not settings.aip_group_partner_enabled:
        return None
    if not _mq_kwargs():
        logger.warning("event=group_partner_skip reason=mq_not_configured")
        return None
    return asyncio.create_task(_partner_loop())
