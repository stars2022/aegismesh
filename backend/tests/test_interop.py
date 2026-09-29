from types import SimpleNamespace
from unittest.mock import AsyncMock
import asyncio
import pytest
from app.services import interop, aip_group, aip_group_partner
from app.services.transport import PartnerResult


def test_compat_requires_registered_identity():
    with pytest.raises(RuntimeError, match="AIC"):
        interop.identity_context("local:agent")


def test_mq_acs_uses_official_capability_enum(db, monkeypatch):
    from app.models import Agent
    from app.services import acs
    from app.config import get_settings
    settings = get_settings().model_copy(update={"aip_group_partner_enabled": True,
        "aip_group_partner_agent_id": "", "aip_group_mq_host": "wt.ioa.pub"})
    monkeypatch.setattr(acs, "get_settings", lambda: settings)
    monkeypatch.setattr(aip_group, "get_settings", lambda: settings)
    agent = Agent(id="mq-acs", name="MQ", aic="1.2.156.3088.1.BUPT.L2K8YU.9FTJ5K.FUG31M.0VW5",
                  transport="provider", registration_status="approved", description="test")
    db.add(agent)
    db.commit()
    payload = acs.build_acs(agent, "https://example.com/aip/mq-acs/rpc")
    assert "amqp:0.9.1" in payload["capabilities"]["messageQueue"]
    assert any(p["transport"] == "AMQP" for p in payload["endPoints"])


def test_mq_disallows_plaintext_and_password(monkeypatch):
    for url in ["amqp://localhost/acps", "amqps://guest:secret@localhost/acps"]:
        monkeypatch.setattr(aip_group, "get_settings", lambda: SimpleNamespace(aip_group_mq_host="", aip_group_mq_url=url))
        with pytest.raises(aip_group.AipGroupBridgeError):
            aip_group.mq_settings()


async def test_unready_partner_never_executes_directly(monkeypatch):
    monkeypatch.setattr(interop, "compatibility_prerequisites", lambda: None)
    monkeypatch.setattr(interop, "identity_context", lambda aic: None)
    execute = AsyncMock()
    with pytest.raises(RuntimeError, match="不回退"):
        await interop.invoke_hosted("caller", SimpleNamespace(aic="offline", name="离线"), "q", "s", 1, execute)
    execute.assert_not_awaited()


async def test_bound_execution_waits_for_broker_delivery_and_cleans_up(monkeypatch):
    monkeypatch.setattr(interop, "compatibility_prerequisites", lambda: None)
    monkeypatch.setattr(interop, "identity_context", lambda aic: None)
    monkeypatch.setattr(interop, "ready_partners", {"caller", "callee"})
    monkeypatch.setattr(aip_group, "inbox_acs", lambda aic: {})
    execute = AsyncMock(return_value=PartnerResult(text="answer", data={}))
    closed = []
    class Session:
        def __init__(self, *args): pass
        async def send_and_collect(self, query, session_id, target, timeout, *, task_id):
            execute.assert_not_awaited()
            bound = interop.deliveries[("caller", "callee", task_id)]
            bound.result = await bound.execute()
            return "answer"
        async def close(self): closed.append(True)
    monkeypatch.setattr(aip_group, "MqGroupSession", Session)
    result = await interop.invoke_hosted("caller", SimpleNamespace(aic="callee", name="test"), "q", "s", 1, execute)
    assert result.data["interop"]["transport"] == "aip-mq"
    assert result.text == "answer" and closed and not interop.deliveries
    execute.assert_awaited_once()


async def test_group_timeout_is_failure_and_cancels_wire_task(monkeypatch):
    session = aip_group.MqGroupSession("caller", [aip_group.ExternalPartner("callee", "test", "")])
    wire = SimpleNamespace(start_task=AsyncMock(), cancel_task=AsyncMock())
    session._leader = object()
    session._session = SimpleNamespace(leader_mq_client=wire, state_update_event=asyncio.Event(), get_partner_task_snapshot=lambda *a: None)
    access = AsyncMock()
    monkeypatch.setattr(aip_group.amp_service, "record_access", access)
    with pytest.raises(TimeoutError):
        await session.send_and_collect("q", "s", "callee", .01, task_id="task-fixed")
    wire.cancel_task.assert_awaited_once()
    assert access.call_args.kwargs["status_code"] == 500
    assert access.call_args.kwargs["task_id"] == "task-fixed"


async def test_unmentioned_or_wrong_sender_never_executes():
    client = SimpleNamespace(reject_task=AsyncMock())
    await aip_group_partner.handle_command("missing", client, SimpleNamespace(senderId="intruder"), True, "leader")
    await aip_group_partner.handle_command("missing", client, SimpleNamespace(senderId="leader"), False, "leader")
    client.reject_task.assert_not_awaited()


async def test_access_reporter_is_actual_peer(tmp_path):
    import json
    from app.services.amp_service import AmpService
    service = AmpService(log_dir=tmp_path, aic="leader")
    for peer in ["caller", "callee"]:
        await service.record_access(caller_aic="caller", callee_aic="callee", reporter_aic=peer, task_id="task-same")
    rows = [json.loads(x) for x in (tmp_path / "amp_access_aegismesh.jsonl").read_text().splitlines()]
    assert {r["aic"] for r in rows} == {"caller", "callee"}
    # Official SDK serializes envelope field names in snake_case.
    assert {r["correlation_id"] for r in rows} == {"task-same"}


async def test_partner_preserves_wire_task_and_executes_once(db, monkeypatch):
    from app.models import Agent, HostedTask
    from app.services.transport import build_aip_start_command
    from acps_sdk.aip import TaskCommandType
    caller = "1.2.156.3088.1.BUPT.L2K8YU.9FTJ5K.FUG31M.0VW4"
    callee = "1.2.156.3088.1.BUPT.L2K8YU.9FTJ5K.FUG31M.0VW5"
    agent = Agent(id="mq-test", name="MQ test", aic=callee, transport="openai-compatible")
    db.add(agent); db.commit()
    monkeypatch.setattr(aip_group_partner, "SessionLocal", lambda: db)
    access = AsyncMock()
    monkeypatch.setattr(aip_group_partner.amp_service, "record_access", access)
    command = build_aip_start_command(caller, "session", "query", None)
    run = AsyncMock(return_value=PartnerResult(text="answer", data={}))
    key = (caller, callee, command.taskId)
    interop.deliveries[key] = interop.DeliveryBinding("query", run)
    client = SimpleNamespace(accept_task=AsyncMock(), start_working=AsyncMock(), send_task_result=AsyncMock(), fail_task=AsyncMock(), reject_task=AsyncMock())
    try:
        await aip_group_partner.handle_command("mq-test", client, command, True, caller)
        await aip_group_partner.handle_command("mq-test", client, command, True, caller)
        run.assert_awaited_once()
        assert access.await_count == 1
        assert access.call_args.kwargs["reporter_aic"] == callee
        assert access.call_args.kwargs["task_id"] == command.taskId
        completed = command.model_copy(update={"command": TaskCommandType.Complete, "dataItems": []})
        await aip_group_partner.handle_command("mq-test", client, completed, True, caller)
        row = db.query(HostedTask).filter_by(external_task_id=command.taskId).one()
        assert row.state == "completed" and row.owner_peer_aic == caller
        assert db.get(Agent, "mq-test").success_count == 0  # enclosing orchestrator owns bound-call metrics
    finally:
        interop.deliveries.pop(key, None)


async def test_timeout_cancels_bound_generation(monkeypatch):
    monkeypatch.setattr(interop, "compatibility_prerequisites", lambda: None)
    monkeypatch.setattr(interop, "identity_context", lambda aic: None)
    monkeypatch.setattr(interop, "ready_partners", {"caller", "callee"})
    monkeypatch.setattr(aip_group, "inbox_acs", lambda aic: {})
    canceled = asyncio.Event()
    async def execute():
        try:
            await asyncio.Future()
        finally:
            canceled.set()
    class Session:
        def __init__(self, *args): pass
        async def send_and_collect(self, query, session_id, target, timeout, *, task_id):
            binding = interop.deliveries[("caller", "callee", task_id)]
            binding.running = asyncio.create_task(binding.execute())
            await asyncio.sleep(0)
            raise TimeoutError()
        async def close(self): pass
    monkeypatch.setattr(aip_group, "MqGroupSession", Session)
    with pytest.raises(TimeoutError):
        await interop.invoke_hosted("caller", SimpleNamespace(aic="callee", name="test"), "q", "s", 1, execute)
    assert canceled.is_set() and not interop.deliveries


async def test_rpc_compatibility_requires_completion_handshake(monkeypatch):
    from app.services.transport import AipSdkTransport
    from acps_sdk.aip import TaskState
    import app.services.transport as transport
    task = SimpleNamespace(taskId="task-real", status=SimpleNamespace(state=TaskState.AwaitingCompletion))
    monkeypatch.setattr(transport, "_start_partner_task", AsyncMock(return_value=task))
    runtime = AipSdkTransport()
    monkeypatch.setattr(runtime, "_await_notification", AsyncMock(return_value=None))
    client = SimpleNamespace(complete_task=AsyncMock(side_effect=RuntimeError("completion failed")))
    with pytest.raises(RuntimeError, match="completion failed"):
        await runtime._consume_rpc(client, TaskState, agent=SimpleNamespace(), session_id="s",
            user_input="q", timeout_seconds=1, poll_interval=.01, controller=None, require_completion=True)
