from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models import Agent, HostedTask, Invocation, ProviderConfig, RoutingPolicy, WebSearchConfig
from app.schemas import ChatRequest
from app.services import aip_group, source_pages, web_search
from app.services.aip_execution import AipExecutionContext, InboundAipOrchestrator
from app.services.orchestrator import ReliableOrchestrator
from app.services.tools import ToolRegistry
from app.services.transport import build_aip_start_command

CALLER = "1.2.156.3088.1.BUPT.L2K8YU.7LFQWP.QT8L11.1BF9"
CALLEE = "1.2.156.3088.1.BUPT.L2K8YU.7AS8QU.INQ4LY.0WL6"


def config(db, **changes):
    row = WebSearchConfig(id=1, backend="exa", timeout_seconds=25, max_results=2,
                          max_queries=changes.get("max_queries", 8))
    db.add(row)
    db.commit()
    return row


@pytest.mark.asyncio
async def test_malformed_calculator_is_recoverable_and_journal_status_is_durable(db):
    agent = Agent(id="calc", aic="local:calc", name="Calc", role="partner")
    invocation = Invocation(id="tool-fixture", session_id="fixture", owner_id="fixture",
                            query="method fixture", status="working")
    db.add_all([agent, invocation])
    db.commit()
    runtime = ReliableOrchestrator(db)
    journal = runtime._journal_registry(ToolRegistry(), agent, invocation, ChatRequest(message="fixture"))
    invalid = "mean of [2,1,2,1,2,2,2,1] = 13/8; sd = sqrt(1.875/7)"
    result = await journal.execute("calculator", {"expression": invalid})
    assert result["ok"] is False and "syntax" in result["error"]
    db.expire(invocation)
    assert invocation.result_data["runtime_tools"][0]["status"] == "failed"
    assert invocation.result_data["runtime_tools"][0]["completed_at"]
    assert (await journal.execute("calculator", {"expression": "13/8"}))["result"] == 1.625
    db.expire(invocation)
    assert [item["status"] for item in invocation.result_data["runtime_tools"]] == ["failed", "completed"]


@pytest.mark.asyncio
async def test_task_search_limit_does_not_change_saved_or_other_branch_budget(db, monkeypatch):
    row = config(db)
    execute = AsyncMock(side_effect=lambda args: {"sources": [], "query": args["query"]})
    monkeypatch.setattr(web_search.ExaWebSearch, "__call__", execute)
    cache = {}
    strict = web_search.configured_search(db, None, cache, budget_scope="strict", max_queries=1)
    normal = web_search.configured_search(db, None, cache, budget_scope="normal")
    assert (await strict({"query": "one"}))["search_budget"]["limit"] == 1
    assert (await strict({"query": "two"}))["status"] == "budget_exhausted"
    assert (await normal({"query": "other"}))["search_budget"]["limit"] == 8
    assert execute.await_count == 2 and row.max_queries == 8


@pytest.mark.asyncio
async def test_task_search_cannot_raise_admin_limit_or_overspend_concurrently(db, monkeypatch):
    config(db, max_queries=1)
    release, seen = asyncio.Event(), []
    async def execute(_self, args):
        seen.append(args["query"])
        await release.wait()
        return {"sources": []}
    monkeypatch.setattr(web_search.ExaWebSearch, "__call__", execute)
    search = web_search.configured_search(db, None, {}, max_queries=20)
    tasks = [asyncio.create_task(search({"query": query})) for query in ["one", "two"]]
    await asyncio.sleep(0)
    assert seen == ["one"]
    release.set()
    first, blocked = await asyncio.gather(*tasks)
    assert first["search_budget"]["limit"] == 1 and blocked["status"] == "budget_exhausted"


@pytest.mark.asyncio
async def test_legacy_search_obeys_explicit_task_limit(db, monkeypatch):
    execute = AsyncMock(return_value={"sources": []})
    monkeypatch.setattr(web_search.DeepSeekWebSearch, "__call__", execute)
    provider = ProviderConfig(id="ds", name="DS", base_url="https://api.deepseek.com", active=True)
    search = web_search.configured_search(db, provider, {}, max_queries=1)
    await search({"query": "one"})
    assert (await search({"query": "two"}))["status"] == "budget_exhausted"
    execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_read_consumes_tightened_page_limit(monkeypatch):
    cache, calls = {}, []
    urls = ["https://example.org/one", "https://example.org/two"]
    source_pages.remember_sources(cache, "task", [{"url": url} for url in urls])
    async def fail(url):
        calls.append(url)
        raise RuntimeError("blocked origin")
    monkeypatch.setattr(source_pages, "_fetch_excerpt", fail)
    reader = source_pages.SourcePageReader(cache, "task", max_pages=1)
    with pytest.raises(RuntimeError):
        await reader({"url": urls[0]})
    blocked = await reader({"url": urls[1]})
    assert blocked["page_budget"] == {"used": 1, "limit": 1, "remaining": 0}
    assert blocked["status"] == "budget_exhausted" and len(calls) == 1
    for invalid in [-1, 3, True, "1"]:
        with pytest.raises(ValueError):
            source_pages.SourcePageReader(cache, "bad", max_pages=invalid)


def task(context):
    command = build_aip_start_command(CALLER, "wire-fixture", "fixture", None, context)
    return HostedTask(task_id="scope-fixture", external_task_id=command.taskId,
                      agent_id="calc", owner_peer_aic=CALLER, session_id="wire-fixture",
                      query="fixture", command_history=[command.model_dump(mode="json")])


def test_authenticated_task_tool_limits_are_extended_and_propagated():
    parent = AipExecutionContext((CALLER,), time.time() + 60, "trace",
                                 tool_limits={"web_search": 1, "read_web_page": 2})
    child = AipExecutionContext.from_task(task(parent.outgoing(CALLER)), Agent(aic=CALLEE))
    assert child.chain == (CALLER, CALLEE)
    assert child.tool_limits == {"web_search": 1, "read_web_page": 2}
    assert child.outgoing(CALLEE)["tool_limits"] == child.tool_limits


@pytest.mark.parametrize("limits", [[], {"web_search": True}, {"web_search": -1}, {"web_search": 21}, {"read_web_page": 3}, {"exempt": True}])
def test_invalid_task_limits_cannot_grant_authority(limits):
    context = AipExecutionContext((CALLER,), time.time() + 60, "trace").outgoing(CALLER)
    with pytest.raises(ValueError, match="工具预算"):
        AipExecutionContext.from_task(task({**context, "tool_limits": limits}), Agent(aic=CALLEE))


def test_no_search_task_hides_network_tools_but_keeps_calculator(db):
    db.add(RoutingPolicy(id=1, weights={}))
    config(db)
    context = AipExecutionContext((CALLEE,), time.time() + 60, "trace",
                                  tool_limits={"web_search": 0, "read_web_page": 0})
    registry = InboundAipOrchestrator(db, context)._runtime_registry(None)
    assert registry.schemas(["web_search", "read_web_page"]) == []
    assert registry.execute("calculator", {"expression": "13/8"})["result"] == 1.625


@pytest.mark.asyncio
async def test_mq_uses_official_structured_command_for_task_limits(monkeypatch):
    client = SimpleNamespace(start_task=AsyncMock(), send_task_command=AsyncMock())
    session = aip_group.MqGroupSession(CALLER, [aip_group.ExternalPartner(CALLEE, "Calc", "")])
    session._leader = object()
    session._session = SimpleNamespace(leader_mq_client=client, state_update_event=asyncio.Event(),
                                      get_partner_task_snapshot=lambda *_: {"state": "completed", "product_text": "done"})
    monkeypatch.setattr(aip_group.amp_service, "record_access", AsyncMock())
    context = AipExecutionContext((CALLER,), time.time() + 60, "trace",
                                  tool_limits={"web_search": 1}).outgoing(CALLER)
    assert await session.send_and_collect("fixture", "wire", CALLEE, 1, task_id="task-fixed", execution_context=context) == "done"
    client.start_task.assert_not_awaited()
    sent = client.send_task_command.await_args
    assert sent.kwargs["data_items"][0].data == context
    assert sent.kwargs["mentions"] == [CALLEE]
