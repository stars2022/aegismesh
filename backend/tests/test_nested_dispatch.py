"""Three-level fan-out must finish on both local and delivered MQ paths."""
import asyncio

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.models import Agent, RoutingPolicy, TraceEvent
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services import interop
from app.services.orchestrator import NoEligibleAgentError, ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry


TREE = {"a": ["b", "c"], "b": ["d", "e"], "c": ["f", "g"]}


def setup_tree(db, monkeypatch, compatibility):
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, interop_compatibility=compatibility,
                         request_timeout_seconds=3, max_attempts=1))
    for name in "abcdefg":
        db.add(Agent(id=name, aic=f"1.2.156.3088.1.FIXTURE.{name}", name=name,
                     role="leader" if name in TREE else "partner", transport="openai-compatible",
                     registration_status="approved", health="online", usage_mode="internal",
                     skills=[{"id": "research", "name": "research"}],
                     input_modes=["text/plain"], output_modes=["application/json"]))
    db.commit()
    monkeypatch.setattr(get_settings(), "leader_aic", db.get(Agent, "a").aic)


@pytest.mark.parametrize("compatibility", [False, True])
@pytest.mark.parametrize("collect_explicitly", [False, True])
async def test_six_edges_finish_before_parent_receipts(db, registered_directory, monkeypatch, compatibility, collect_explicitly):
    setup_tree(db, monkeypatch, compatibility)
    receipts, calls = [], []

    async def delivered(caller, target, query, session_id, timeout, execute):
        result = await execute()
        # A coordinator's official completion must contain its leaf reports.
        for child in TREE.get(target.id, []):
            assert f"leaf:{child}" in result.text
        receipts.append((caller, target.aic))
        return result

    monkeypatch.setattr(interop, "invoke_hosted", delivered)

    class Runtime:
        async def execute(self, agent, query, timeout_seconds, *, tool_registry, max_rounds, **kwargs):
            if max_rounds == 0:
                return PartnerResult(query, {}, llm_calls=1)
            calls.append(agent.id)
            if agent.id not in TREE:
                await asyncio.sleep(.01)
                return PartnerResult(f"leaf:{agent.id}", {}, llm_calls=1)
            for target in TREE[agent.id]:
                reply = await tool_registry.execute("dispatch_task", {"agent": target, "task": f"research {target}", "wait": False})
                assert reply["ok"] and reply["result"]["ok"], reply
            if collect_explicitly:
                reply = await tool_registry.execute("check_subagent_status", {"wait_for_all": True})
                assert reply["ok"], reply
                rows = reply["result"]["collaborations"]
                assert {r["agent_id"] for r in rows} == set(TREE[agent.id])
                assert all(r["status"] == "completed" for r in rows), rows
                return PartnerResult("\n".join(r["result"] for r in rows), {}, llm_calls=1)
            return PartnerResult("Children are working", {}, llm_calls=1)

    runtime = ReliableOrchestrator(db, TransportRegistry({"openai-compatible": Runtime()}))
    result, _, _ = await asyncio.wait_for(runtime.run(ChatRequest(message="research", agent_id="a")), 4)
    assert result.status == "completed", result.result_text
    assert result.attempt_count == 6
    assert sorted(calls) == list("abcdefg")
    assert all(f"leaf:{leaf}" in result.result_text for leaf in "defg")
    assert len(result.result_data["collaborations"]) == 6
    assert all(c["status"] == "completed" for c in result.result_data["collaborations"])
    assert len(receipts) == (6 if compatibility else 0)
    assert all(a.active_tasks == 0 for a in db.scalars(select(Agent)))
    events = db.scalars(select(TraceEvent).where(TraceEvent.event_type == "DISPATCH_STARTED")).all()
    assert sorted(e.detail["callChain"] for e in events) == [
        ["a", "b"], ["a", "b", "d"], ["a", "b", "e"],
        ["a", "c"], ["a", "c", "f"], ["a", "c", "g"],
    ]


async def test_compatibility_excludes_local_only_discovery_identity(db, monkeypatch):
    setup_tree(db, monkeypatch, True)
    db.add(Agent(id="agent_discovery", aic="local:agent_discovery", name="Discovery",
                 role="leader", transport="openai-compatible", registration_status="local"))
    db.commit()
    runtime = ReliableOrchestrator(db)
    assert runtime._usable_leader().id == "a"
    with pytest.raises(NoEligibleAgentError, match="已审核"):
        await runtime.run(ChatRequest(message="research", agent_id="agent_discovery"))
    assert db.get(Agent, "agent_discovery").aic == "local:agent_discovery"
