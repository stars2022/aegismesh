from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app import main
from app.models import Agent, Invocation, RoutingPolicy
from app.schemas import ChatRequest, DiscoveryQuery
from app.seed import DEFAULT_WEIGHTS
from app.services.discovery import AdpDiscoveryClient, DiscoveryError
from app.services.discovery_pool import discovery_candidates, rank_discovery, remember_selected_candidate
from app.services.orchestrator import ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry


def directory(*aics, alive=True):
    return {
        "acsMap": {aic: {
            "name": "研究助手", "description": "实验设计", "skills": [{"name": "实验设计"}],
            "endPoints": [{"url": "https://partner.example/rpc", "transport": "JSONRPC"}],
            "defaultInputModes": ["text/plain"], "defaultOutputModes": ["application/json"],
        } for aic in aics},
        "aliveMap": {aic: {"alive": alive} for aic in aics},
    }


@pytest.fixture
def pool(db):
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, max_attempts=1, request_timeout_seconds=5))
    known = Agent(id="known", aic="known-aic", name="原名称", transport="aip-rpc", usage_mode="external",
                  endpoint_url="https://old.example/rpc", health="online", request_count=20,
                  success_count=20, failure_count=0, avg_latency_ms=50,
                  feedback_positive_count=10, feedback_negative_count=0)
    outsider = Agent(id="outsider", aic="absent-aic", name="缓存中的高分成员", transport="test",
                     success_count=1000, request_count=1000, health="online")
    db.add_all([known, outsider]); db.commit()
    return known


def test_directory_membership_and_aic_join_preserve_history(db, pool):
    response = directory("known-aic", "new-aic")
    candidates = discovery_candidates(db, response)
    assert {a.aic for a in candidates} == {"known-aic", "new-aic"}
    scores = rank_discovery(db, candidates, "实验设计")
    assert scores[0]["aic"] == "known-aic"
    assert scores[0]["history"]["successes"] == 20
    cold = next(s for s in scores if s["aic"] == "new-aic")
    assert cold["history"]["calls"] == 0 and not cold["has_local_history"]
    assert "先验" in cold["score_note"]
    assert pool.name == "原名称" and pool.endpoint_url == "https://old.example/rpc"
    assert db.query(Agent).count() == 2  # Merely discovering does not import candidates.
    assert response == directory("known-aic", "new-aic")


def test_retired_identity_cannot_reappear_as_external_candidate(db, pool, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "aip_retired_aics", ["known-aic", "retired-uncached"])
    response = directory("known-aic", "retired-uncached", "new-aic")
    assert [a.aic for a in discovery_candidates(db, response)] == ["new-aic"]
    from app.services.agent_search import search_constraints
    assert discovery_candidates(db, response, search_constraints({"aic": "known-aic"})) == []
    assert db.get(Agent, pool.id).aic == "known-aic"  # No history deletion or identity rewriting.


def test_refresh_preserves_local_controls_circuit_and_observations(db, pool):
    pool.active = False
    pool.circuit_state = "open"
    pool.circuit_open_until = datetime.now(timezone.utc) + timedelta(minutes=5)
    pool.consecutive_failures = 4
    pool.tools = ["private-local-tool"]
    db.commit()
    candidate = discovery_candidates(db, directory(pool.aic))[0]
    assert not rank_discovery(db, [candidate], "实验设计")[0]["eligible"]
    saved = remember_selected_candidate(db, candidate)
    assert saved.id == pool.id and saved.name == "研究助手"
    assert saved.success_count == 20 and saved.request_count == 20
    assert saved.feedback_positive_count == 10 and saved.avg_latency_ms == 50
    assert not saved.active and saved.circuit_state == "open" and saved.consecutive_failures == 4
    assert saved.tools == ["private-local-tool"]


def test_hosted_runtime_configuration_is_not_overwritten_by_directory(db, pool):
    pool.transport = "provider"
    pool.model_name = "configured-model"
    db.commit()
    view = discovery_candidates(db, directory(pool.aic))[0]
    assert view.name == "研究助手"
    assert remember_selected_candidate(db, view) is pool
    assert pool.name == "原名称" and pool.model_name == "configured-model"


@pytest.mark.parametrize("scope", ["all", "local", "network"])
async def test_all_scopes_query_adp_and_never_union_cached_members(db, pool, monkeypatch, scope):
    mock = AsyncMock(return_value=directory("known-aic", "new-aic"))
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock)
    result = await ReliableOrchestrator(db)._list_agents({"scope": scope, "query": "实验设计"})
    mock.assert_awaited_once()
    assert {s["aic"] for s in result} == (set() if scope == "local" else {"known-aic", "new-aic"})


async def test_local_scope_only_includes_directory_confirmed_hosted_members(db, pool, monkeypatch):
    pool.transport = "provider"; db.commit()
    monkeypatch.setattr(AdpDiscoveryClient, "discover", AsyncMock(return_value=directory(pool.aic)))
    result = await ReliableOrchestrator(db)._list_agents({"scope": "local"})
    assert [s["agent_id"] for s in result] == [pool.id]


async def test_directory_failure_is_not_local_fallback(db, pool, monkeypatch):
    mock = AsyncMock(side_effect=DiscoveryError("directory unavailable"))
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock)
    runner = ReliableOrchestrator(db)
    with pytest.raises(DiscoveryError):
        await runner._list_agents({})
    inv = Invocation(id="inv", session_id="s", query="q", status="working")
    db.add(inv); db.commit()
    with pytest.raises(DiscoveryError):
        await runner._dispatch_task(inv, ChatRequest(message="q"), db.get(RoutingPolicy, 1), [], [])({"agent": pool.id, "task": "q"})


@pytest.mark.parametrize("available", [False, True])
async def test_cached_explicit_target_is_revalidated_before_dispatch(db, pool, monkeypatch, available):
    response = directory(pool.aic, alive=False) if available else directory()
    mock = AsyncMock(return_value=response)
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock)
    execute = AsyncMock()
    runner = ReliableOrchestrator(db, TransportRegistry({"aip-rpc": SimpleNamespace(execute=execute)}))
    inv = Invocation(id="inv", session_id="s", query="q", status="working")
    db.add(inv); db.commit()
    result = await runner._dispatch_task(inv, ChatRequest(message="q"), db.get(RoutingPolicy, 1), [], [])({"agent": pool.id, "task": "q"})
    assert result["ok"] is False
    assert mock.call_args.kwargs["aic"] == pool.aic
    execute.assert_not_awaited()


async def test_automatic_dispatch_uses_adp_and_records_history_for_next_ranking(db, pool, monkeypatch):
    monkeypatch.setattr(AdpDiscoveryClient, "discover", AsyncMock(return_value=directory("new-aic")))
    execute = AsyncMock(return_value=PartnerResult(text="result", data={}))
    runner = ReliableOrchestrator(db, TransportRegistry({"aip-rpc": SimpleNamespace(execute=execute)}))
    inv = Invocation(id="inv", session_id="s", query="q", status="working")
    db.add(inv); db.commit()
    result = await runner._dispatch_task(inv, ChatRequest(message="q"), db.get(RoutingPolicy, 1), [], [])({"task": "实验设计"})
    assert result["ok"] is True
    execute.assert_awaited_once()
    db.expire_all()
    new = db.query(Agent).filter_by(aic="new-aic").one()
    assert new.success_count == 1 and new.request_count == 1
    scores = rank_discovery(db, discovery_candidates(db, directory(new.aic)), "实验设计")
    assert scores[0]["history"]["successes"] == 1


async def test_search_api_returns_only_directory_scores(db, pool, monkeypatch):
    monkeypatch.setattr(AdpDiscoveryClient, "discover", AsyncMock(return_value=directory(pool.aic)))
    result = await main.discover_agents(DiscoveryQuery(query="实验设计"), db)
    assert [s["aic"] for s in result["candidates"]] == [pool.aic]
    assert result["candidates"][0]["history"]["successes"] == 20


async def test_feed_cache_is_query_scoped_and_rescores_local_history(db, pool, monkeypatch):
    monkeypatch.setattr(main, "_discovery_feed_cache", {})
    mock = AsyncMock(side_effect=lambda **kw: deepcopy(directory(pool.aic if kw["query"] == "实验" else "new-aic")))
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock)
    first = await main.get_discovery_feed(db, query="实验")
    assert first[0]["cache_state"] == "fresh"
    pool.success_count = 21; pool.request_count = 21; db.commit()
    cached = await main.get_discovery_feed(db, query="实验")
    assert cached[0]["cache_state"] == "cached" and cached[0]["score"]["history"]["successes"] == 21
    assert mock.await_count == 1
    other = await main.get_discovery_feed(db, query="写作")
    assert other[0]["aic"] == "new-aic" and mock.await_count == 2
    await main.get_discovery_feed(db, query="实验", limit=10)
    assert mock.await_count == 3
    mock.side_effect = DiscoveryError("directory unavailable")
    with pytest.raises(HTTPException) as error:
        await main.get_discovery_feed(db, query="实验", refresh=True)
    assert error.value.status_code == 503
