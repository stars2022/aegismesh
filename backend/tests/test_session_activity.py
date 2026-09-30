import asyncio
import hashlib
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.main import app
from app.models import Agent, Invocation, RoutingPolicy, TraceEvent
from app.schemas import ChatRequest
from app.services.orchestrator import ReliableOrchestrator
from app.services.session_activity import activity_data
from app.services.tools import ToolRegistry
from app.services.transport import PartnerResult, TransportRegistry


def invocation(db, name="turn", **changes):
    inv = Invocation(id=name, session_id="session", owner_id="owner", query="research", status="working", **changes)
    db.add(inv)
    db.commit()
    return inv


def test_session_activity_is_owned_paginated_and_recovers_interrupted_records(db):
    key = "test-public-api-key-123456"
    owner = f"api_{hashlib.sha256(key.encode()).hexdigest()[:24]}"
    timestamp = datetime(2026, 9, 30, tzinfo=timezone.utc)
    for name in ["a", "b", "c"]:
        inv = invocation(db, name, created_at=timestamp)
        inv.owner_id = owner
        inv.status = "failed"
        inv.result_data = {"runtime_tools": [{"id": f"tool-{name}", "name": "web_search", "status": "running"}]}
    foreign = invocation(db, "z-foreign", created_at=timestamp)
    foreign.result_text = "private other user's report"
    no_owner = invocation(db, "z-legacy", created_at=timestamp)
    no_owner.owner_id = ""
    other_session = invocation(db, "z-other", created_at=timestamp)
    other_session.owner_id = owner
    other_session.session_id = "other"
    db.add_all([
        TraceEvent(invocation_id="c", event_type="DISPATCH_STARTED", detail={"taskId": "sub-1", "agentId": "worker", "task": "short"}),
        TraceEvent(invocation_id="c", event_type="SUBAGENT_TASK_RECEIVED", detail={"taskId": "sub-1", "agentName": "Worker", "task": "full task text"}),
    ])
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app, headers={"X-API-Key": key})
        first = client.get("/api/chat/sessions/session/activity?limit=2")
        assert first.status_code == 200, first.text
        data = first.json()
        assert [i["invocation_id"] for i in data["items"]] == ["c", "b"]
        assert data["next_before"] == "b"
        second = client.get("/api/chat/sessions/session/activity?limit=2&before=b").json()
        assert [i["invocation_id"] for i in second["items"]] == ["a"]
        assert second["next_before"] is None
        collab = data["items"][0]["result_data"]["collaborations"][0]
        assert collab["task"] == "full task text"
        assert collab["invocation_id"] == "c" and collab["session_id"] == "session"
        assert collab["status"] == "failed" and collab["phase_name"] == "已中断"
        assert data["items"][0]["result_data"]["runtime_tools"][0]["status"] == "cancelled"
        assert db.get(Invocation, "c").result_data["runtime_tools"][0]["status"] == "running"  # read-only
        assert "private" not in first.text
        for cursor in ["z-foreign", "z-other", "missing"]:
            assert client.get(f"/api/chat/sessions/session/activity?before={cursor}").status_code == 404
        assert client.get("/api/chat/sessions/absent/activity").json()["items"] == []
        assert client.get("/api/chat/sessions/session/activity?limit=0").status_code == 422
        client.headers["X-API-Key"] = "invalid-key"
        assert client.get("/api/chat/sessions/session/activity").status_code in {401, 403}
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_legacy_reconstruction_keeps_result_and_individual_tasks(db):
    inv = invocation(db, result_data={"collaborations": [
        {"task_id": "t1", "agent_id": "same", "status": "completed", "result": "first result", "tools": [{"name": "search"}]},
        {"task_id": "t2", "agent_id": "same", "status": "failed", "error": "timeout"},
        {"agent_id": "old", "task": "legacy without ID", "status": "completed"},
    ]})
    db.add(TraceEvent(invocation_id=inv.id, event_type="DISPATCH_COMPLETED", detail={"taskId": "t1", "latencyMs": 2}))
    db.commit()
    data = activity_data(db, inv)
    assert len(data["collaborations"]) == 3
    assert data["collaborations"][0]["result"] == "first result"
    assert data["collaborations"][0]["tools"] == [{"name": "search"}]
    assert data["collaborations"][1]["error"] == "timeout"


@pytest.mark.asyncio
async def test_tool_journal_is_durable_and_exact_per_parallel_task(db):
    inv = invocation(db)
    agent = Agent(id="worker", aic="local:worker", name="Worker", role="partner")
    db.add(agent)
    db.commit()
    runtime = ReliableOrchestrator(db)
    records = [{"task_id": task_id, "agent_id": agent.id, "call_chain": ["leader", agent.id],
                "status": "running", "tools": []} for task_id in ["first", "second"]]
    runtime._persist_collaborations(inv, records)
    events = []
    async def emit(kind, data):
        events.append((kind, data))
    runtime._emit_event = emit
    gate = asyncio.Event()
    async def execute(args):
        with Session(db.get_bind()) as reader:
            snapshot = reader.get(Invocation, inv.id).result_data
            all_calls = [*snapshot.get("runtime_tools", []), *[t for c in snapshot["collaborations"] for t in c["tools"]]]
            assert any(c["arguments"] == args and c["status"] == "running" for c in all_calls)
        if args.get("cancel"):
            gate.set()
            await asyncio.Event().wait()
        if args.get("fail"):
            raise RuntimeError("controlled tool error")
        return {"value": args["value"]}
    registry = ToolRegistry()
    registry.register("probe", {"type": "function", "function": {"name": "probe"}}, execute)
    request = ChatRequest(message="research", delegation_path=["leader"])
    journals = [runtime._journal_registry(registry, agent, inv, request, c["task_id"]) for c in records]
    await asyncio.gather(*(j.execute("probe", {"value": i}) for i, j in enumerate(journals)))
    await journals[0].execute("probe", {"value": 0})  # identical repeated call must survive
    assert [len(c["tools"]) for c in records] == [2, 1]
    assert records[1]["tools"][0]["arguments"] == {"value": 1}
    calls = [t for c in records for t in c["tools"]]
    assert len({c["id"] for c in calls}) == 3
    assert all(c["status"] == "completed" for c in calls)
    assert all(e[1]["session_id"] == inv.session_id and e[1]["invocation_id"] == inv.id for e in events)
    assert {e[1]["tool_call_id"] for e in events if e[0] == "subagent_tool"} == {e[1]["tool_call_id"] for e in events if e[0] == "subagent_tool_done"}
    root = runtime._journal_registry(registry, agent, inv, ChatRequest(message="root"))
    await root.execute("probe", {"fail": True})
    assert inv.result_data["runtime_tools"][0]["status"] == "failed"
    task = asyncio.create_task(root.execute("probe", {"cancel": True}))
    await gate.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    db.expire(inv)
    assert [t["status"] for t in inv.result_data["runtime_tools"]] == ["failed", "cancelled"]


@pytest.mark.asyncio
@pytest.mark.parametrize("role,expected", [("leader", 24), ("partner", 12)])
async def test_configured_default_tool_rounds_reach_transport(db, role, expected):
    inv = invocation(db)
    agent = Agent(id="model", aic="local:model", name="Model", role=role, transport="openai-compatible")
    policy = RoutingPolicy(id=1, weights={}, request_timeout_seconds=5)
    db.add_all([agent, policy])
    db.commit()
    class Transport:
        async def execute(self, agent, query, timeout, *, max_rounds, history, **kwargs):
            assert max_rounds == expected
            assert f"最多 {expected} 轮" in history[-1]["content"]
            return PartnerResult("done", {})
    runtime = ReliableOrchestrator(db, TransportRegistry({"openai-compatible": Transport()}))
    await runtime._invoke(agent, "research", inv, ChatRequest(message="research"), policy, [], tool_registry=ToolRegistry())


@pytest.mark.asyncio
async def test_dispatch_budgets_are_per_branch_with_total_guard(db):
    inv = invocation(db)
    policy = RoutingPolicy(id=1, weights={})
    db.add(policy)
    db.commit()
    runtime = ReliableOrchestrator(db)
    assert runtime.max_dispatches == 16
    runtime._dispatch_counts[(inv.id, "leader")] = 16
    dispatch = runtime._dispatch_task(inv, ChatRequest(message="q"), policy, [], [], call_chain=["leader"])
    assert "16 次" in (await dispatch({"task": "q"}))["error"]
    runtime._dispatch_counts = {(inv.id, f"branch-{i}"): 16 for i in range(4)}
    assert "总派发" in (await dispatch({"task": "q"}))["error"]
    assert get_settings().max_dispatches_per_task == 64
    for field, value in [("coordination_tool_rounds", 0), ("partner_tool_rounds", 33), ("max_dispatches_per_task", 129)]:
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **{field: value})
