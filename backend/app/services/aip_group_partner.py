from __future__ import annotations

import asyncio
import logging
import json
import time
import uuid
from contextlib import suppress
from types import SimpleNamespace
from sqlalchemy import select
from ..config import get_settings
from ..database import SessionLocal
from ..models import Agent
from .aip_group import mq_settings, message_emitter
from .interop import identity_context, deliveries, ready_partners, outgoing_groups
from .amp_service import amp_service

logger = logging.getLogger("uvicorn.error.aip_group_partner")
GROUP_CLOSE_TIMEOUT = 3


async def _close_group(client, agent_id: str) -> None:
    # A dissolved exchange can leave an SDK robust channel waiting to recover.
    # Cleanup of that old group must never block the next inbox invitation.
    try:
        await asyncio.wait_for(client.close(), GROUP_CLOSE_TIMEOUT)
    except Exception as exc:
        logger.warning("event=group_cleanup_failed agent=%s error_type=%s", agent_id, type(exc).__name__)
        connection = client.connection
        if connection and not connection.is_closed:
            with suppress(Exception):
                await asyncio.wait_for(connection.close(), GROUP_CLOSE_TIMEOUT)


async def _join_invitation(agent_id, aic, kwargs, groups, joining, inv):
    from acps_sdk.aip.aip_group_partner import GroupPartnerMqClient
    logger.info("event=group_invitation_received agent=%s group=%s", agent_id, inv.groupId)
    stale = [groups.pop(gid) for gid, peer in list(groups.items())
             if gid not in joining and not peer.is_joined]
    await asyncio.gather(*(_close_group(peer, agent_id) for peer in stale))
    if inv.groupId in groups:
        return
    if len(groups) >= 32:
        logger.warning("Group capacity reached for %s", agent_id)
        return
    # Only the long-lived inbox reconnects automatically. A task group is
    # ephemeral; resurrecting a dissolved exchange cannot restore its ACL.
    child = GroupPartnerMqClient(partner_aic=aic, robust_connection=False, **kwargs)
    groups[inv.groupId] = child
    joining.add(inv.groupId)
    async def on_command(command, is_mentioned):
        await handle_command(agent_id, child, command, is_mentioned, inv.group.leader.aic)
    async def disconnected(client, group_id):
        if groups.get(group_id) is client:
            groups.pop(group_id, None)
    child.set_command_handler(on_command)
    child.set_disconnect_handler(disconnected)
    joined = False
    try:
        await asyncio.wait_for(child.connect(), 15)
        joined = await asyncio.wait_for(child.join_group_from_invitation(inv), 30)
        if joined:
            logger.info("event=group_invitation_joined agent=%s group=%s", agent_id, inv.groupId)
    except Exception as exc:
        logger.warning("event=group_invitation_failed agent=%s group=%s error_type=%s", agent_id, inv.groupId, type(exc).__name__)
    finally:
        joining.discard(inv.groupId)
        if not joined:
            if groups.get(inv.groupId) is child:
                groups.pop(inv.groupId, None)
            await _close_group(child, agent_id)


async def handle_command(agent_id, client, command, is_mentioned, leader_aic):
    """SDK verifies AMQP user_id; only the group's authenticated leader may execute."""
    from acps_sdk.aip import TaskCommandType, TaskState
    from acps_sdk.aip.aip_rpc_model import RpcRequest
    from .hosted_aip import HostedAipService
    if not is_mentioned or command.senderId != leader_aic:
        return
    if command.command not in {TaskCommandType.Start, TaskCommandType.Complete, TaskCommandType.Cancel, TaskCommandType.Get}:
        await client.reject_task(command.taskId, command.sessionId, "Unsupported command")
        return
    started = time.monotonic()
    with SessionLocal() as db:
        agent = db.get(Agent, agent_id)
        if not agent or not agent.active:
            await client.reject_task(command.taskId, command.sessionId, "Agent unavailable")
            return
        binding = deliveries.get((command.senderId, agent.aic, command.taskId))
        runtime = None
        if binding:
            received = "\n".join(i.text for i in (command.dataItems or []) if getattr(i, "type", "") == "text")
            if command.command == TaskCommandType.Start and received != binding.query:
                await client.reject_task(command.taskId, command.sessionId, "Task binding mismatch")
                return
            async def execute(*args, **kwargs):
                binding.running = asyncio.create_task(binding.execute())
                binding.result = await binding.running
                return binding.result
            runtime = SimpleNamespace(execute=execute)
        # Bound calls already have their metrics recorded by the orchestrator.
        service = HostedAipService(db, agent, runtime=runtime, owner_peer_aic=command.senderId,
                                   record_metrics=binding is None)
        first = command.command == TaskCommandType.Start and service._task_row(command.taskId) is None
        if first:
            await client.accept_task(command.taskId, command.sessionId)
            await client.start_working(command.taskId, command.sessionId)
        response = await service.dispatch(RpcRequest.model_validate({
            "jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "rpc",
            "params": {"command": command.model_dump(mode="json")},
        }))
        result = response.result
        if response.error or result is None:
            await client.fail_task(command.taskId, command.sessionId, "Task unavailable")
            return
        await client.send_task_result(task_id=command.taskId, session_id=command.sessionId,
                                     state=result.status.state, products=result.products)
        if first:
            await amp_service.record_access(caller_aic=command.senderId, callee_aic=agent.aic,
                reporter_aic=agent.aic, task_id=command.taskId, session_id=command.sessionId,
                method="AMQP", url="aip/group/task", route="aip/group/task",
                status_code=200 if result.status.state in {TaskState.AwaitingCompletion, TaskState.Completed} else 500,
                duration_ms=int((time.monotonic()-started)*1000))


async def _partner_loop(agent_id: str, aic: str) -> None:
    from acps_sdk.aip.aip_group_partner import GroupPartnerMqClient
    # Separate client per group: joining another invitation must not evict an
    # existing group. Retry inbox connection after failures; close all on shutdown.
    while True:
        inbox = None
        groups = {}
        joining = set()
        try:
            kwargs = {**mq_settings(), "ssl_context": identity_context(aic),
                      "identity_binding_enabled": True, "message_emitter": message_emitter(aic)}
            inbox = GroupPartnerMqClient(partner_aic=aic, **kwargs)
            await asyncio.wait_for(inbox.connect(), 15)

            async def invitation(inv):
                await _join_invitation(agent_id, aic, kwargs, groups, joining, inv)

            # One consumer per AIC, for both SDK leader error replies and partner
            # invitations. Keep SDK payload and AMQP user_id identity validation.
            from acps_sdk.aip.aip_group_model import InboxGroupInvitation, InboxGroupInvitationError
            from acps_sdk.aip.aip_group_identity import assert_incoming_group_message_identity, extract_amqp_user_id
            async def route_inbox(message):
                async with message.process():
                    body = json.loads(message.body)
                    kind = body.get("type")
                    model = InboxGroupInvitation if kind == "group-invitation" else InboxGroupInvitationError if kind == "group-invitation-error" else None
                    if model is None:
                        return
                    value = model.model_validate(body)
                    assert_incoming_group_message_identity(value, amqp_user_id=extract_amqp_user_id(message), expected_group_id=value.groupId)
                    if kind == "group-invitation":
                        await invitation(value)
                    else:
                        for owner in list(outgoing_groups.get(aic, [])):
                            pending = owner._pending_invitations.get(value.senderId or value.partnerAic)
                            if pending and pending.invitation_token == value.invitationToken:
                                await owner._handle_invitation_error(value)
            queue = await inbox.ensure_inbox_queue()
            await queue.consume(route_inbox)
            ready_partners.add(aic)
            logger.info("event=group_partner_ready agent=%s aic=%s", agent_id, aic)
            await asyncio.Future()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Group Partner connection failed: %s", agent_id)
        finally:
            ready_partners.discard(aic)
            for client in [*groups.values(), inbox]:
                if client:
                    with suppress(Exception):
                        await asyncio.wait_for(client.close(), 5)
        await asyncio.sleep(10)


async def start_partner_listener() -> asyncio.Task | None:
    settings = get_settings()
    if not settings.aip_group_partner_enabled or not settings.aip_group_listener_worker:
        return None
    if not mq_settings():
        logger.error("Group Partner enabled but MQ not configured")
        return None
    with SessionLocal() as db:
        agents = [(a.id, a.aic) for a in db.scalars(select(Agent)).all()
                  if a.active and a.transport != "aip-rpc" and a.registration_status == "approved"
                  and not a.aic.startswith("local:")
                  and (not settings.aip_group_partner_agent_id or a.id == settings.aip_group_partner_agent_id)]
    async def supervise():
        async with asyncio.TaskGroup() as group:
            for agent_id, aic in agents:
                group.create_task(_partner_loop(agent_id, aic))
    return asyncio.create_task(supervise(), name="aip-group-partners")
