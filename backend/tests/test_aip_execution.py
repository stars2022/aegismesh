from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from acps_sdk.aip import StructuredDataItem, TaskCommandType, TaskState
from acps_sdk.aip.aip_rpc_model import RpcRequest

from app.models import Agent, HostedTask, Invocation, ProviderConfig, RoutingPolicy, WebSearchConfig
from app.database import Base
from app.schemas import ChatRequest
from app.services import aip_execution, hosted_aip, orchestrator, transport, web_search
from app.services.aip_execution import AipExecutionContext, InboundAipOrchestrator
from app.services.context_projection import ContextProjectionEngine, ProjectedSnippet
from app.services.hosted_aip import HostedAipService
from app.services.prompt import effective_tool_names
from app.seed import DEFAULT_WEIGHTS
from app.services.transport import PartnerResult, TransportRegistry, build_aip_start_command


AICS = {
    "research": "1.2.156.3088.1.BUPT.L2K8YU.9FTJ5K.FUG31M.0VW4",
    "travel": "1.2.156.3088.1.BUPT.L2K8YU.2YZ71D.3VDX21.1BC2",
    "news": "1.2.156.3088.1.BUPT.L2K8YU.6MG2PD.KYH34C.16L0",
    "heritage": "1.2.156.3088.1.BUPT.L2K8YU.PGOU71.CC6FV3.0UIW",
    "sources": "1.2.156.3088.1.BUPT.L2K8YU.JWCQL2.8DFGI8.0FKI",
}
PEER = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"


@pytest.fixture
def db(tmp_path):
    # Separate physical connections reproduce cross-worker write locks that an
    # in-memory StaticPool cannot expose. Keep parent autoflush on deliberately.
    engine = create_engine(f"sqlite:///{tmp_path / 'inbound.sqlite3'}", poolclass=NullPool,
                           connect_args={"check_same_thread": False, "timeout": .1})
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def wire_task(agent_id="travel", *, peer=None, context=None, session="same-wire-session"):
    caller = peer or AICS["research"]
    command = build_aip_start_command(caller, session, "recursive fixture", None, context)
    return HostedTask(task_id="scope-fixture", external_task_id=command.taskId,
                      agent_id=agent_id, owner_peer_aic=caller, session_id=session,
                      query="recursive fixture", command_history=[command.model_dump(mode="json")])


def request(command):
    return RpcRequest.model_validate({"jsonrpc": "2.0", "id": "test-rpc", "method": "rpc",
                                     "params": {"command": command.model_dump(mode="json")}})


def test_wire_context_preserves_deadline_and_extends_authenticated_chain():
    parent = AipExecutionContext((AICS["research"],), time.time() + 77, "test-trace")
    task = wire_task(context=parent.outgoing(AICS["research"]))
    child = AipExecutionContext.from_task(task, Agent(aic=AICS["travel"]))
    assert child.chain == (AICS["research"], AICS["travel"])
    assert child.deadline == parent.deadline
    assert child.trace_id == "test-trace"
    assert child.remaining() <= parent.remaining() + .01
    assert task.command_history[0]["dataItems"][-1]["type"] == "data"


@pytest.mark.parametrize("change", [
    {"chain": [AICS["news"]]},
    {"chain": [AICS["research"], AICS["research"]]},
    {"chain": [AICS["travel"], AICS["research"]]},
    {"chain": [AICS["heritage"], AICS["news"], AICS["research"]]},
    {"deadline": float("nan")}, {"deadline": True}, {"trace_id": "x" * 129},
])
def test_invalid_or_forged_wire_context_is_rejected(change):
    parent = AipExecutionContext((AICS["research"],), time.time() + 60, "trace")
    task = wire_task(context={**parent.outgoing(AICS["research"]), **change})
    with pytest.raises(ValueError):
        AipExecutionContext.from_task(task, Agent(aic=AICS["travel"]))


def test_expired_context_does_not_start_or_reset_its_budget():
    ctx = {"kind": aip_execution.EXECUTION_KIND, "chain": [AICS["research"]],
           "deadline": time.time() - 1, "trace_id": "expired"}
    with pytest.raises(TimeoutError):
        AipExecutionContext.from_task(wire_task(context=ctx), Agent(aic=AICS["travel"]))
    with pytest.raises(ValueError, match="最大深度"):
        AipExecutionContext(tuple(AICS.values())[:3], time.time() + 60, "trace").outgoing(AICS["news"])


@pytest.fixture
def fleet(db):
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, interop_compatibility=False,
                         external_delegation_enabled=True,
                         request_timeout_seconds=3, max_attempts=1))
    db.add(ProviderConfig(id="fixture", name="Fixture", kind="fixture-runtime",
                          base_url="https://fixture.invalid", default_model="fixture"))
    for key, aic in AICS.items():
        db.add(Agent(id=key, aic=aic, name=key, description="research news travel evidence",
                     role="leader" if key in {"research", "travel", "news"} else "partner",
                     transport="provider", model_provider="fixture", model_name="fixture",
                     usage_mode="internal", active=True, health="online",
                     registration_status="approved", tools=["web_search", "current_time"],
                     input_modes=["text/plain"], output_modes=["application/json"],
                     security_schemes=["mtls"], skills=[{"id": key, "name": key, "tags": ["research"]}]))
    db.commit()
    return db


@pytest.mark.parametrize("search_backend", ["legacy", "exa"])
async def test_real_inbound_registry_recurses_via_transport_and_executes_search(
    fleet, registered_directory, monkeypatch, search_backend,
):
    db = fleet
    factory = sessionmaker(bind=db.get_bind())
    edges, searches, entry_tools = [], [], {}
    # Force the CONTEXT_PROJECTED write before each remote call; it previously
    # autoflushed and blocked the remote worker's independent SQLite connection.
    monkeypatch.setattr(ContextProjectionEngine, "score_and_slice", lambda *a, **k: [
        ProjectedSnippet("peer_report", "fixture", "Research evidence", "research context", .9)])

    class Search:
        def __init__(self, *_, **__): pass
        async def __call__(self, args):
            searches.append(args["query"])
            return {"ok": True, "results": [{"url": "https://fixture.invalid/evidence"}]}

    class Runtime:
        async def execute(self, agent, query, timeout_seconds, *, tool_registry, **kwargs):
            assert kwargs.get("harness") is True  # Same runtime rules at each official inbound hop.
            if kwargs.get("max_rounds") == 0:
                return PartnerResult("verified synthesis", {}, llm_calls=1)
            tools = {s["function"]["name"] for s in tool_registry.schemas(effective_tool_names(agent))}
            entry_tools[agent.id] = tools
            targets = {"research": ["travel", "news"], "travel": ["heritage"], "news": ["sources"]}
            if agent.id in targets:
                assert {"list_agents", "dispatch_task", "web_search"} <= tools
                for target in targets[agent.id]:
                    listing = await tool_registry.execute("list_agents", {"scope": "all", "aic": AICS[target]})
                    assert listing["ok"], listing
                    assert any(row["agent_id"] == target and row["callable"] for row in listing["result"])
                    reply = await tool_registry.execute("dispatch_task", {"agent": target, "task": f"{query}: {target}", "wait": True})
                    assert reply["ok"] and reply["result"]["ok"], reply
            else:
                assert "dispatch_task" not in tools
                await tool_registry.execute("web_search", {"query": agent.id})
            return PartnerResult("verified fixture result", {"agent": agent.id}, llm_calls=1)

    class Rpc:
        async def execute(self, target, query, timeout_seconds, **kwargs):
            assert kwargs["interop_compatibility"] is True
            assert kwargs["execution_context"]["chain"][-1] == kwargs["caller_aic"]
            edges.append((kwargs["caller_aic"], target.aic, kwargs["execution_context"]))
            command = build_aip_start_command(kwargs["caller_aic"], kwargs["session_id"], query,
                                              kwargs.get("history"), kwargs["execution_context"])
            with factory() as inner:
                service = HostedAipService(inner, inner.get(Agent, target.id),
                                           owner_peer_aic=kwargs["caller_aic"])
                response = await service.dispatch(request(command))
                assert response.result.status.state == TaskState.AwaitingCompletion, response
                row = service._task_row(command.taskId)
                data = dict(row.result_data or {})
                completed = command.model_copy(update={"command": TaskCommandType.Complete, "dataItems": []})
                await service.dispatch(request(completed))
                return PartnerResult(row.result_text, {**data, "task_id": command.taskId})

    registry = TransportRegistry({"fixture-runtime": Runtime(), "aip-rpc": Rpc()})
    monkeypatch.setattr(orchestrator, "TransportRegistry", lambda: registry)
    if search_backend == "exa":
        db.add(WebSearchConfig(id=1, backend="exa"))
        db.commit()
        monkeypatch.setattr(web_search, "ExaWebSearch", Search)
    else:
        monkeypatch.setattr(web_search, "supports_deepseek_search", lambda _: True)
        monkeypatch.setattr(web_search, "DeepSeekWebSearch", Search)
    service = HostedAipService(db, db.get(Agent, "research"), owner_peer_aic=PEER)
    command = build_aip_start_command(PEER, "test-recursion", "research", None)
    response = await service.dispatch(request(command))
    assert response.result.status.state == TaskState.AwaitingCompletion, service._task_row(command.taskId).result_data
    assert [(a, b) for a, b, _ in edges] == [
        (AICS["research"], AICS["travel"]), (AICS["travel"], AICS["heritage"]),
        (AICS["research"], AICS["news"]), (AICS["news"], AICS["sources"]),
    ]
    assert sorted(searches) == ["heritage", "sources"]
    assert len({meta["deadline"] for _, _, meta in edges}) == 1
    assert {len(meta["chain"]) for _, _, meta in edges} == {1, 2}
    db.expire_all()
    assert db.get(RoutingPolicy, 1).interop_compatibility is False
    assert len(db.scalars(select(Invocation)).all()) == 5
    assert len(db.scalars(select(HostedTask)).all()) == 5


async def test_background_start_is_prompt_idempotent_and_cancelable(fleet, monkeypatch):
    db = fleet
    started, stopped = asyncio.Event(), asyncio.Event()
    async def execute(*args, **kwargs):
        started.set()
        try:
            await asyncio.Future()
        finally:
            stopped.set()
    work = AsyncMock(side_effect=execute)
    monkeypatch.setattr(aip_execution, "execute_inbound_task", work)
    service = HostedAipService(db, db.get(Agent, "travel"), owner_peer_aic=PEER, background=True)
    command = build_aip_start_command(PEER, "cancel-session", "research", None)
    response = await asyncio.wait_for(service.dispatch(request(command)), .5)
    assert response.result.status.state == TaskState.Accepted
    await asyncio.wait_for(started.wait(), 1)
    db.expire_all()
    repeated = await service.dispatch(request(command))
    assert repeated.result.status.state == TaskState.Working
    assert work.await_count == 1
    cancel = command.model_copy(update={"command": TaskCommandType.Cancel, "dataItems": []})
    assert (await service.dispatch(request(cancel))).result.status.state == TaskState.Canceled
    await asyncio.wait_for(stopped.wait(), 1)
    await asyncio.gather(*list(hosted_aip._background_rpc_tasks.values()), return_exceptions=True)
    db.expire_all()
    assert service._task_row(command.taskId).state == "canceled"
    assert not hosted_aip._active_runtime_tasks


async def test_inbound_scope_cannot_open_user_or_other_peer_history(fleet, monkeypatch):
    captures = []
    async def run(self, req, owner_id=""):
        captures.append((req.session_id, owner_id, req.delegation_path, req.interface))
        return Invocation(id="fixture-inv", status="completed", result_text="safe",
                          result_data={}, prompt_tokens=0, completion_tokens=0, llm_calls=0), [], None
    monkeypatch.setattr(InboundAipOrchestrator, "run", run)
    for key, peer in [("travel", PEER), ("travel", AICS["news"]), ("news", PEER)]:
        await aip_execution.execute_inbound_task(fleet, fleet.get(Agent, key),
                                                 wire_task(key, peer=peer, session="user-secret-session"))
    assert len({row[0] for row in captures}) == 3
    assert len({row[1] for row in captures}) == 3
    assert all(row[0] != "user-secret-session" for row in captures)
    assert all(row[3] == "harness" for row in captures)


async def test_background_result_can_be_polled_and_completed_without_reexecution(fleet, monkeypatch):
    work = AsyncMock(return_value=PartnerResult("real search result", {"tool_executions": ["web_search"]}))
    monkeypatch.setattr(aip_execution, "execute_inbound_task", work)
    service = HostedAipService(fleet, fleet.get(Agent, "travel"), owner_peer_aic=PEER, background=True)
    command = build_aip_start_command(PEER, "poll-session", "specific query", None)
    assert (await service.dispatch(request(command))).result.status.state == TaskState.Accepted
    await asyncio.gather(*list(hosted_aip._background_rpc_tasks.values()))
    fleet.expire_all()
    poll = command.model_copy(update={"command": TaskCommandType.Get, "dataItems": []})
    assert (await service.dispatch(request(poll))).result.status.state == TaskState.AwaitingCompletion
    complete = command.model_copy(update={"command": TaskCommandType.Complete, "dataItems": []})
    assert (await service.dispatch(request(complete))).result.status.state == TaskState.Completed
    assert service._task_row(command.taskId).result_text == "real search result"
    assert work.await_count == 1


async def test_missing_directory_endpoint_never_falls_back_to_local_runtime(fleet):
    root = fleet.get(Agent, "research")
    target = fleet.get(Agent, "travel")
    runner = InboundAipOrchestrator(fleet, AipExecutionContext((root.aic,), time.time() + 10, "trace"))
    with pytest.raises(RuntimeError, match="不回退"):
        await runner._invoke(target, "q", Invocation(), ChatRequest(message="q"),
                             runner._routing_policy(), [], caller_aic=root.aic)
    with pytest.raises(ValueError, match="回调"):
        await runner._invoke(root, "q", Invocation(), ChatRequest(message="q"),
                             runner._routing_policy(), [], caller_aic=root.aic)


@pytest.mark.parametrize("search_backend", ["legacy", "exa"])
async def test_external_delegation_switch_keeps_search_but_disables_child_tools(fleet, monkeypatch, search_backend):
    policy = fleet.get(RoutingPolicy, 1)
    policy.external_delegation_enabled = False
    fleet.commit()
    searched = []

    class Search:
        def __init__(self, *_, **__): pass
        async def __call__(self, arguments):
            searched.append(arguments["query"])
            return {"results": [{"url": "https://fixture.invalid/source"}]}

    class Runtime:
        async def execute(self, agent, query, timeout_seconds, *, tool_registry, **kwargs):
            names = {s["function"]["name"] for s in tool_registry.schemas(effective_tool_names(agent))}
            assert "web_search" in names
            assert not {"dispatch_task", "list_agents", "execute_workflow", "run_swarm"} & names
            await tool_registry.execute("web_search", {"query": "specific question"})
            return PartnerResult("own search completed", {}, llm_calls=1)

    registry = TransportRegistry({"fixture-runtime": Runtime()})
    monkeypatch.setattr(orchestrator, "TransportRegistry", lambda: registry)
    if search_backend == "exa":
        fleet.add(WebSearchConfig(id=1, backend="exa"))
        fleet.commit()
        monkeypatch.setattr(web_search, "ExaWebSearch", Search)
    else:
        monkeypatch.setattr(web_search, "supports_deepseek_search", lambda _: True)
        monkeypatch.setattr(web_search, "DeepSeekWebSearch", Search)
    root = fleet.get(Agent, "research")
    task = wire_task("research", peer=PEER)
    result = await aip_execution.execute_inbound_task(fleet, root, task)
    assert result.text == "own search completed" and searched == ["specific question"]
    # This permission never changes the normal user-facing coordination path.
    assert orchestrator.ReliableOrchestrator(fleet)._coordination_capable(root)
    runner = InboundAipOrchestrator(fleet, AipExecutionContext((root.aic,), time.time() + 10, "off"))
    with pytest.raises(ValueError, match="关闭"):
        await runner._invoke(fleet.get(Agent, "travel"), "q", Invocation(), ChatRequest(message="q"),
                             runner._routing_policy(), [], caller_aic=root.aic)


def test_admin_policy_switch_is_persisted_audited_and_preserved_for_older_clients(fleet):
    from starlette.requests import Request
    from app.main import update_policy
    from app.schemas import PolicyRead, PolicyUpdate
    policy = fleet.get(RoutingPolicy, 1)
    payload = PolicyRead.model_validate(policy).model_dump()
    payload["external_delegation_enabled"] = False
    req = Request({"type": "http"})
    assert not update_policy(PolicyUpdate(**payload), fleet, req).external_delegation_enabled
    assert req.state.audit_policy_changes["external_delegation_enabled"] == {"before": True, "after": False}
    payload["external_delegation_enabled"] = True
    assert update_policy(PolicyUpdate(**payload), fleet, req).external_delegation_enabled
    del payload["external_delegation_enabled"]
    assert update_policy(PolicyUpdate(**payload), fleet, req).external_delegation_enabled
