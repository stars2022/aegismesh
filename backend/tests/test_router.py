from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import Agent, RoutingPolicy
from app.services.acs import build_acs
from app.seed import DEFAULT_WEIGHTS, seed_database
from app.services.orchestrator import ReliableOrchestrator
from app.services.router import QualityRouter, RoutingRequirements


def make_agent(agent_id: str, *, tags: list[str], latency: float = 500, health: str = "online") -> Agent:
    return Agent(
        id=agent_id,
        aic=f"aic-{agent_id}",
        name=agent_id,
        input_modes=["text/plain"],
        output_modes=["application/json"],
        skills=[{"id": agent_id, "name": agent_id, "tags": tags}],
        avg_latency_ms=latency,
        success_count=20,
        failure_count=2,
        request_count=22,
        health=health,
    )


def test_router_prefers_relevant_skill() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    data_agent = make_agent("data", tags=["数据", "数据库", "SQL"])
    writer = make_agent("writer", tags=["写作", "文案"])
    ranked = QualityRouter().rank(
        [writer, data_agent],
        policy,
        RoutingRequirements(query="分析数据库中的销售数据"),
    )
    assert ranked[0].agent.id == "data"
    assert ranked[0].score > ranked[1].score


def test_router_filters_incompatible_modes() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    agent = make_agent("data", tags=["数据"])
    ranked = QualityRouter().rank(
        [agent],
        policy,
        RoutingRequirements(query="分析数据", input_mode="image/png"),
    )
    assert not ranked[0].eligible
    assert "输入模式不匹配：image/png" in ranked[0].reasons


def test_router_uses_smoothed_user_feedback() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    liked = make_agent("liked", tags=["数据"])
    disliked = make_agent("disliked", tags=["数据"])
    liked.feedback_positive_count = 8
    liked.feedback_negative_count = 1
    disliked.feedback_positive_count = 1
    disliked.feedback_negative_count = 8

    ranked = QualityRouter().rank(
        [disliked, liked],
        policy,
        RoutingRequirements(query="数据"),
    )

    assert ranked[0].agent.id == "liked"
    assert ranked[0].breakdown["feedback"] > ranked[1].breakdown["feedback"]
    assert any("用户满意度" in reason for reason in ranked[0].reasons)


def test_router_matches_chinese_query_to_english_skill() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    literature = make_agent("literature", tags=["literature", "search"])
    writer = make_agent("writer", tags=["writing"])
    ranked = QualityRouter().rank(
        [writer, literature],
        policy,
        RoutingRequirements(query="做一次文献检索"),
    )
    assert ranked[0].agent.id == "literature"


def test_router_matches_abbreviation_to_skill() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    rag = make_agent("rag", tags=["rag", "llm"])
    writer = make_agent("writer", tags=["writing"])
    ranked = QualityRouter().rank(
        [writer, rag],
        policy,
        RoutingRequirements(query="用大模型做检索增强"),
    )
    assert ranked[0].agent.id == "rag"


def test_imported_partner_stays_out_of_automatic_pool(db) -> None:
    local = make_agent("local-worker", tags=["数据"])
    local.usage_mode = "both"
    pinned = make_agent("pinned-partner", tags=["文献"])
    pinned.registration_status = "imported"
    pinned.usage_mode = "external"
    pinned.transport = "aip-rpc"
    pinned.endpoint_url = "https://partner.example/rpc"
    db.add(local)
    db.add(pinned)
    db.commit()
    orchestrator = ReliableOrchestrator(db)
    pooled = {agent.id for agent in orchestrator._internal_partners()}
    assert local.id in pooled
    assert pinned.id not in pooled
    assert orchestrator._driver(pinned.id).id == pinned.id


def test_hosted_acs_does_not_advertise_notification_without_mtls(monkeypatch) -> None:
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "aip_identity_binding_enabled", False)
    monkeypatch.setattr(settings, "aip_tls_port", 0)
    agent = make_agent("hosted", tags=["数据"])
    agent.transport = "openai-compatible"
    agent.security_schemes = ["mtls"]
    agent.active = True
    agent.description = "hosted"
    agent.updated_at = datetime.now(timezone.utc)
    acs = build_acs(agent, "https://aip.example.com/aip/hosted/rpc")
    assert acs["capabilities"]["notification"] is False
    assert acs["capabilities"]["messageQueue"] == []


def test_alive_map_does_not_invent_online_status() -> None:
    from app.services.discovery import health_from_alive_map

    assert health_from_alive_map({"aic-1": {"alive": True}}, "aic-1") == "online"
    assert health_from_alive_map({"aic-1": {"alive": False}}, "aic-1") == "offline"
    assert health_from_alive_map({}, "aic-1") == "unknown"


def test_router_half_open_allows_only_expired_breaker() -> None:
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS)
    agent = make_agent("data", tags=["数据"])
    agent.circuit_state = "open"
    agent.circuit_open_until = datetime.now(timezone.utc) + timedelta(seconds=60)
    cooling = QualityRouter().rank([agent], policy, RoutingRequirements(query="数据"))
    assert not cooling[0].eligible
    assert "连续失败后，暂时暂停编排确保服务稳定" in cooling[0].reasons

    agent.circuit_open_until = datetime.now(timezone.utc) - timedelta(seconds=1)
    ready = QualityRouter().rank([agent], policy, RoutingRequirements(query="数据"))
    assert ready[0].eligible
    assert "正在测试模型稳定程度" in ready[0].reasons

    agent.circuit_state = "half-open"
    busy = QualityRouter().rank([agent], policy, RoutingRequirements(query="数据"))
    assert not busy[0].eligible
    assert "正在测试模型稳定程度" in busy[0].reasons


def test_half_open_failure_doubles_cooldown(db) -> None:
    policy = RoutingPolicy(
        id=1,
        weights=DEFAULT_WEIGHTS,
        failure_threshold=2,
        circuit_cooldown_seconds=30,
    )
    agent = make_agent("data", tags=["数据"])
    agent.consecutive_failures = 1
    db.add(policy)
    db.add(agent)
    db.commit()
    orchestrator = ReliableOrchestrator(db)
    orchestrator._record_failure(agent, policy)
    assert agent.circuit_state == "open"
    first_wait = (agent.circuit_open_until - datetime.now(timezone.utc)).total_seconds()
    assert 25 <= first_wait <= 31

    agent.circuit_state = "half-open"
    orchestrator._record_failure(agent, policy)
    second_wait = (agent.circuit_open_until - datetime.now(timezone.utc)).total_seconds()
    assert agent.circuit_state == "open"
    assert 55 <= second_wait <= 61


def test_seed_backfills_missing_routing_dimensions(db) -> None:
    db.add(RoutingPolicy(id=1, weights={"skill": 0.5, "reliability": 0.5}))
    db.commit()
    seed_database(db)
    weights = db.get(RoutingPolicy, 1).weights
    assert "load" in weights
    assert "feedback" in weights
    assert abs(sum(weights.values()) - 1) < 0.02
