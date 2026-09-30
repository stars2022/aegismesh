from __future__ import annotations

import asyncio
import inspect

import pytest
from sqlalchemy.orm import Session

from app.models import Agent, Invocation, RouteAttempt, RoutingPolicy
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services.orchestrator import NoEligibleAgentError, ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry


class FixtureTransport:
    def __init__(self) -> None:
        self.histories: list[list[dict[str, str]]] = []

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        harness: bool = False,
    ) -> PartnerResult:
        self.histories.append(history or [])
        if "test-failure" in (agent.tools or []):
            raise ConnectionError("test failure")
        return PartnerResult(text="real transport fixture result", data={"fixture": True})


def add_agent(db: Session, agent_id: str, score_seed: int, fail: bool = False) -> None:
    db.add(
        Agent(
            id=agent_id,
            aic=f"aic-{agent_id}",
            name=agent_id,
            transport="test",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            skills=[{"id": "research", "name": "研究", "tags": ["研究", "报告"]}],
            tools=["test-failure"] if fail else ["search"],
            health="online",
            avg_latency_ms=300 + score_seed,
            success_count=100 - score_seed,
            failure_count=score_seed,
            request_count=100,
        )
    )


async def test_failover_completes_with_second_agent(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=1,
            circuit_cooldown_seconds=60,
            max_attempts=2,
            request_timeout_seconds=2,
        )
    )
    add_agent(db, "primary", 0, fail=True)
    add_agent(db, "backup", 10)
    db.commit()

    invocation, _, selected = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport()})
    ).run(
        ChatRequest(message="请研究并生成报告", requested_skill="research")
    )
    assert invocation.status == "completed"
    assert invocation.attempt_count == 2
    assert selected is not None and selected.id == "backup"
    assert db.get(Agent, "primary").circuit_state == "open"


async def test_same_session_loads_completed_turns(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=1,
            request_timeout_seconds=2,
        )
    )
    add_agent(db, "partner", 0)
    db.commit()
    transport = FixtureTransport()
    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": transport}))

    await orchestrator.run(ChatRequest(message="第一轮", session_id="session-test"))
    await orchestrator.run(ChatRequest(message="第二轮", session_id="session-test"))

    assert transport.histories[0] == []
    assert transport.histories[1] == [
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "real transport fixture result"},
    ]


async def test_same_session_id_is_isolated_by_authenticated_owner(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=1,
            request_timeout_seconds=2,
        )
    )
    add_agent(db, "partner", 0)
    db.commit()
    transport = FixtureTransport()
    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": transport}))

    await orchestrator.run(
        ChatRequest(message="owner-a secret", session_id="shared-session"),
        owner_id="owner-a",
    )
    from app.services.identity import ConversationOwnershipError
    with pytest.raises(ConversationOwnershipError):
        await orchestrator.run(
            ChatRequest(message="owner-b question", session_id="shared-session"),
            owner_id="owner-b",
        )

    assert transport.histories == [[]]


async def test_assistant_presentation_preserves_history_and_audit(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    add_agent(db, "partner", 0)
    db.commit()
    transport = FixtureTransport()
    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": transport}))
    first, _, _ = await orchestrator.run(ChatRequest(
        message="周末去哪里玩", session_id="human-one", agent_id="partner", presentation="assistant",
    ), owner_id="guest-human")
    assert transport.histories[0][0]["role"] == "system"
    assert "数字人助手" in transport.histories[0][0]["content"]
    assert "隐瞒失败" in transport.histories[0][0]["content"]
    assert not any(event.event_type == "CONTEXT_LOADED" for event in first.events)
    assert any(event.event_type == "REQUEST_ACCEPTED" for event in first.events)
    await orchestrator.run(ChatRequest(
        message="带父母去", session_id="human-one", agent_id="partner", presentation="assistant",
    ), owner_id="guest-human")
    assert transport.histories[1][:2] == [
        {"role": "user", "content": "周末去哪里玩"},
        {"role": "assistant", "content": "real transport fixture result"},
    ]
    assert len([m for m in transport.histories[1] if m["role"] == "system"]) == 1
    assert ChatRequest(message="普通工作台").presentation == "workspace"


async def test_collaboration_runs_multiple_partners(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=3,
            request_timeout_seconds=2,
        )
    )
    add_agent(db, "partner-one", 0)
    add_agent(db, "partner-two", 5)
    db.commit()

    invocation, _, _ = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport()})
    ).run(ChatRequest(message="共同研究", mode="collaborate", max_partners=2))

    assert invocation.status == "completed"
    assert invocation.attempt_count == 2
    assert invocation.result_data["mode"] == "collaborate"
    assert len(invocation.result_data["contributions"]) == 2


def add_leader(db: Session, agent_id: str, transport: str) -> None:
    db.add(
        Agent(
            id=agent_id,
            aic=f"aic-{agent_id}",
            name=agent_id,
            role="leader",
            transport=transport,
            input_modes=["text/plain"],
            output_modes=["application/json"],
            health="online",
        )
    )


class CoordinatorTransport:
    """Fake leader runtime that dispatches through the injected coordination tools."""

    def __init__(self) -> None:
        self.dispatched: list[str] = []
        self.styles: list[str] = []
        self.histories: list[list[dict[str, str]]] = []

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: object = None,
        harness: bool = False,
        tool_registry: object = None,
        max_rounds: int = 4,
        collab_style: str = "auto",
    ) -> PartnerResult:
        assert harness is True
        self.styles.append(collab_style)
        self.histories.append(history or [])
        advanced = tool_registry.schemas(["execute_workflow", "run_swarm_discussion"])
        assert [item["function"]["name"] for item in advanced] == [
            "execute_workflow", "run_swarm_discussion",
        ]
        roster = tool_registry.execute("list_agents", {})
        if inspect.isawaitable(roster):
            roster = await roster
        assert any(item["agent_id"] == "partner-one" for item in roster["result"])
        outcome = tool_registry.execute("dispatch_task", {"task": f"子任务：{query}"})
        if inspect.isawaitable(outcome):
            outcome = await outcome
        assert outcome["ok"] is True
        self.dispatched.append(outcome["result"]["agent_id"])
        return PartnerResult(
            text=f"协调汇总：{outcome['result']['result']}",
            data={"summary": "coordinated", "tool_executions": [
                {"name": "dispatch_task", "arguments": {"task": query}, "output": outcome}
            ]},
        )


async def test_session_history_compresses_older_turns(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    add_agent(db, "partner", 0)
    db.commit()
    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))
    for index in range(6):
        message = "必须使用公开来源" if index == 0 else f"第{index}轮"
        await orchestrator.run(ChatRequest(message=message, session_id="session-compress"))

    history = orchestrator._session_history("session-compress")
    user_messages = [message for message in history if message["role"] == "user"]
    assert len(user_messages) == 5
    assert user_messages[0]["content"].startswith("（以下是本次会话较早")
    assert "必须使用公开来源" in user_messages[0]["content"] and "第1轮" in user_messages[0]["content"]
    assert user_messages[-1]["content"] == "第5轮"
    assert all("工具" not in message["content"] for message in user_messages[:1])


async def test_external_only_agent_excluded_from_internal_routing(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    db.add(
        Agent(
            id="outer-only",
            aic="aic-outer-only",
            name="outer-only",
            transport="test",
            usage_mode="external",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            skills=[{"id": "research", "name": "研究", "tags": ["研究"]}],
            health="online",
        )
    )
    db.commit()

    with pytest.raises(NoEligibleAgentError):
        await ReliableOrchestrator(
            db, TransportRegistry({"test": FixtureTransport()})
        ).run(ChatRequest(message="请研究并生成报告"))


async def test_agent_id_runs_direct_partner(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    add_agent(db, "partner", 0)
    db.commit()

    invocation, ranked, selected = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport()})
    ).run(ChatRequest(message="直接任务", agent_id="partner"))

    assert invocation.status == "completed"
    assert invocation.result_text == "real transport fixture result"
    assert selected is not None and selected.id == "partner"
    assert ranked == []
    assert invocation.attempt_count == 1


async def test_agent_id_leader_coordinates_and_synthetizes(db: Session, registered_directory) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=3, request_timeout_seconds=2))
    add_agent(db, "partner-one", 0)
    add_agent(db, "partner-two", 5)
    add_leader(db, "lead", "openai-compatible")
    db.commit()
    coordinator = CoordinatorTransport()

    invocation, _, selected = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport(), "openai-compatible": coordinator})
    ).run(ChatRequest(message="规划一次调研", agent_id="lead", interface="harness", collab_style="workflow"))

    assert invocation.status == "completed"
    assert selected is not None and selected.id == "lead"
    assert invocation.result_data["mode"] == "coordination"
    assert invocation.result_text == "协调汇总：real transport fixture result"
    assert coordinator.dispatched == ["partner-one"]
    assert coordinator.styles == ["workflow"]
    assert all("显示名称是麦溪" not in m["content"] for m in coordinator.histories[0])
    assert invocation.attempt_count == 1
    dispatches = [event for event in invocation.events if event.event_type == "DISPATCH_COMPLETED"]
    assert len(dispatches) == 1
    subagent_received = [event for event in invocation.events if event.event_type == "SUBAGENT_TASK_RECEIVED"]
    assert len(subagent_received) == 1
    assert subagent_received[0].detail["agentId"] == "partner-one"
    assert len(invocation.result_data.get("collaborations", [])) == 1
    assert invocation.result_data["collaborations"][0]["agent_id"] == "partner-one"
    assert db.query(RouteAttempt).filter(RouteAttempt.agent_id == "partner-one").count() == 1


async def test_digital_human_keeps_coordination_and_audit_available(db: Session, registered_directory) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=3, request_timeout_seconds=2))
    add_agent(db, "partner-one", 0)
    add_leader(db, "lead", "openai-compatible")
    db.commit()
    coordinator = CoordinatorTransport()
    invocation, _, selected = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport(), "openai-compatible": coordinator})
    ).run(ChatRequest(
        message="规划一次调研", session_id="human-coordination", presentation="assistant",
        mode="collaborate", interface="harness", collab_style="auto",
    ), owner_id="guest-human")
    assert invocation.status == "completed"
    assert selected.id == "lead"
    assert coordinator.dispatched == ["partner-one"]
    assert any("显示名称是麦溪，英文名 Mesh" in m["content"] for m in coordinator.histories[0])
    assert all("小美" not in m["content"] for m in coordinator.histories[0])
    assert any(e.event_type == "DISPATCH_COMPLETED" for e in invocation.events)
    assert invocation.owner_id == "guest-human"
    assert invocation.session_id == "human-coordination"


class BackgroundCoordinatorTransport:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        tool_registry=None,
        max_rounds: int = 4,
        **kwargs,
    ) -> PartnerResult:
        self.queries.append(query)
        if query.startswith("系统自激活通知"):
            assert max_rounds == 0
            assert "阶段性草稿" in query
            assert "同伴回传" in query
            return PartnerResult(text="最终结论：已核对同伴回传，给出统一结果。", data={})
        outcome = tool_registry.execute(
            "dispatch_task", {"task": "检索证据", "agent": "partner-one", "wait": False}
        )
        if inspect.isawaitable(outcome):
            outcome = await outcome
        assert outcome["ok"] is True
        return PartnerResult(text="初步意见：等待检索证据后仍需修订。" * 12, data={})


class SlowFixtureTransport(FixtureTransport):
    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        harness: bool = False,
    ) -> PartnerResult:
        await asyncio.sleep(0.03)
        return await super().execute(agent, query, timeout_seconds, session_id, history, harness)


async def test_background_synthesis_replaces_preliminary_draft(db: Session, registered_directory) -> None:
    db.add(RoutingPolicy(
        id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2,
        circuit_cooldown_seconds=60, max_attempts=2, request_timeout_seconds=2,
    ))
    add_agent(db, "partner-one", 0)
    add_leader(db, "lead", "openai-compatible")
    db.commit()
    coordinator = BackgroundCoordinatorTransport()

    invocation, _, _ = await ReliableOrchestrator(
        db, TransportRegistry({
            "test": SlowFixtureTransport(),
            "openai-compatible": coordinator,
        }),
    ).run(ChatRequest(message="完成证据报告", agent_id="lead", interface="harness"))

    assert invocation.status == "completed", invocation.result_text
    assert invocation.result_text == "最终结论：已核对同伴回传，给出统一结果。"
    assert len(coordinator.queries) == 2
    assert len(invocation.result_data["collaborations"]) == 1
    assert invocation.result_data["collaborations"][0]["status"] == "completed"


async def test_agent_id_leader_without_hosted_transport_runs_direct(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    add_leader(db, "external-lead", "test")
    db.commit()

    invocation, _, selected = await ReliableOrchestrator(
        db, TransportRegistry({"test": FixtureTransport()})
    ).run(ChatRequest(message="外部协调", agent_id="external-lead"))

    assert invocation.status == "completed"
    assert selected is not None and selected.id == "external-lead"
    assert invocation.result_text == "real transport fixture result"


async def test_agent_id_missing_agent_raises(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    db.commit()

    with pytest.raises(NoEligibleAgentError):
        await ReliableOrchestrator(
            db, TransportRegistry({"test": FixtureTransport()})
        ).run(ChatRequest(message="任何任务", agent_id="ghost"))


async def test_agent_id_rejects_external_only_agent(db: Session) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    add_agent(db, "external-only", 0)
    db.get(Agent, "external-only").usage_mode = "external"
    db.commit()

    with pytest.raises(NoEligibleAgentError, match="不允许用于平台内部调用"):
        await ReliableOrchestrator(
            db, TransportRegistry({"test": FixtureTransport()})
        ).run(ChatRequest(message="越权直接调用", agent_id="external-only"))


async def test_dispatch_task_routes_to_best_partner(db: Session, registered_directory) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=3, request_timeout_seconds=2))
    add_agent(db, "weak", 90)
    add_agent(db, "strong", 0)
    db.commit()
    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))
    policy = db.get(RoutingPolicy, 1)
    invocation = __import__("app.models", fromlist=["Invocation"]).Invocation(
        id="inv-test", session_id="ses-test", query="研究任务", status="working"
    )
    db.add(invocation)
    db.commit()

    registry = orchestrator._coordination_registry(
        Agent(id="lead", aic="aic-lead", name="lead", role="leader"),
        invocation,
        ChatRequest(message="研究任务"),
        policy,
        [],
    )
    outcome = registry.execute("dispatch_task", {"task": "请研究多智能体协议"})
    if inspect.isawaitable(outcome):
        outcome = await outcome

    assert outcome["ok"] is True
    bad = registry.execute("dispatch_task", {"task": ""})
    if inspect.isawaitable(bad):
        bad = await bad
    assert bad["result"]["ok"] is False


def test_safe_error_message() -> None:
    import httpx
    # Python 3.11+ empty timeout exception
    empty_read_timeout = httpx.ReadTimeout("")
    assert "超时" in ReliableOrchestrator._safe_error_message(empty_read_timeout)

    empty_connect_error = httpx.ConnectError("")
    assert "网络连接异常" in ReliableOrchestrator._safe_error_message(empty_connect_error)

    normal_err = RuntimeError("真实错误信息")
    assert ReliableOrchestrator._safe_error_message(normal_err) == "真实错误信息"


async def test_self_execution_fallback_when_all_candidates_fail(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=1,
            request_timeout_seconds=2,
        )
    )
    # Partner that always fails
    add_agent(db, "broken-partner", 10, fail=True)
    # Available leader that can self-execute
    db.add(
        Agent(
            id="backup-leader",
            aic="aic-backup-leader",
            name="Backup Leader",
            role="leader",
            transport="test",
            active=True,
            health="online",
            tools=["search"],
        )
    )
    db.commit()

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))
    invocation, _, selected = await orchestrator.run(ChatRequest(message="需要执行的任务"))

    assert invocation.status == "completed"
    assert selected is not None
    assert selected.id == "backup-leader"
    assert "real transport fixture result" in invocation.result_text


async def test_explicit_or_external_agent_failure_does_not_fallback_to_leader(db: Session) -> None:
    """显式指定智能体或外部智能体失败时，必须如实报错，严禁由本地协调器伪装自执行。"""
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=1,
            request_timeout_seconds=2,
        )
    )
    # External AIP partner that fails
    db.add(
        Agent(
            id="ext-aip-partner",
            aic="1.2.156.3088.0.1.2.3.4.ABCD",
            name="External AIP Agent",
            role="partner",
            transport="aip-rpc",
            endpoint_url="https://external.test/aip",
            usage_mode="both",
            active=True,
            health="online",
        )
    )
    db.add(
        Agent(
            id="backup-leader",
            aic="aic-backup-leader",
            name="Backup Leader",
            role="leader",
            transport="test",
            active=True,
            health="online",
        )
    )
    db.commit()

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))
    # 显式指定该外部智能体
    invocation, _, selected = await orchestrator.run(
        ChatRequest(message="执行外部分析", agent_id="ext-aip-partner")
    )

    # 验证：必须为 failed，绝对不可被 backup-leader 假装完成
    assert invocation.status == "failed"
    assert "失败" in invocation.result_text or "超时" in invocation.result_text
    assert selected is not None
    assert selected.id == "ext-aip-partner"


async def test_fetch_session_history_tool(db: Session) -> None:
    session_id = "test-session-history-1"
    # Create 2 completed past invocations
    inv1 = Invocation(
        id="inv-1",
        session_id=session_id,
        owner_id="user-1",
        query="第一轮提问：分析海洋温度",
        result_text="第一轮回答：深圳海温26度",
        result_data={
            "tool_executions": [{"name": "ocean_tool", "arguments": {"city": "深圳"}, "output": {"temp": 26}}],
            "collaborations": [{"agent_name": "海洋核验智能体", "task": "核验深圳温度", "result": "26度"}],
        },
        status="completed",
    )
    inv2 = Invocation(
        id="inv-2",
        session_id=session_id,
        owner_id="user-1",
        query="第二轮提问：那广州呢？",
        result_text="第二轮回答：广州海温25度",
        result_data={
            "tool_executions": [{"name": "ocean_tool", "arguments": {"city": "广州"}, "output": {"temp": 25}}],
        },
        status="completed",
    )
    # Current active invocation (round 3)
    inv3 = Invocation(
        id="inv-3",
        session_id=session_id,
        owner_id="user-1",
        query="第三轮提问：对比两地",
        status="working",
    )
    db.add_all([inv1, inv2, inv3])
    db.commit()

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))
    fetch_fn = orchestrator._fetch_session_history(inv3)

    # 1. Overview without arguments
    overview = fetch_fn({})
    assert overview["total_turns"] == 2
    assert len(overview["turns_overview"]) == 2
    assert "海洋温度" in overview["turns_overview"][0]["user_query_snippet"]

    # 2. Specific turn by index (turn_index=1)
    turn1 = fetch_fn({"turn_index": 1})
    assert turn1["turn"] == 1
    assert turn1["user_query"] == "第一轮提问：分析海洋温度"
    assert turn1["assistant_reply"] == "第一轮回答：深圳海温26度"
    assert len(turn1["tool_executions"]) == 1
    assert len(turn1["collaborations"]) == 1
    assert turn1["collaborations"][0]["agent"] == "海洋核验智能体"

    # 3. Last turn by negative index (turn_index=-1)
    turn_last = fetch_fn({"turn_index": -1})
    assert turn_last["turn"] == 2
    assert turn_last["user_query"] == "第二轮提问：那广州呢？"

    # 4. Search by keyword
    kw_search = fetch_fn({"keyword": "广州"})
    assert kw_search["matched_turns_count"] == 1
    assert kw_search["matches"][0]["turn"] == 2

    # 5. Out of range turn
    err_res = fetch_fn({"turn_index": 99})
    assert "超出范围" in err_res["error"]


async def test_directory_query_and_dispatch_exact_name(db: Session, registered_directory) -> None:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2, circuit_cooldown_seconds=60, max_attempts=1, request_timeout_seconds=2))
    agent = Agent(
        id="empirical_design",
        aic="aic-empirical",
        name="研究设计与数据分析智能体",
        role="partner",
        transport="test",
        usage_mode="both",
        skills=[{"name": "实验设计与因果推断"}],
        active=True,
        health="online",
    )
    db.add(agent)
    db.commit()

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": FixtureTransport()}))

    # 1. Multi-token compound query in list_agents
    agents = await orchestrator._list_agents({"scope": "local", "query": "文献检索 研究设计 论文评审 海洋 数据"})
    assert any(a["agent_id"] == "empirical_design" for a in agents)

    # 2. Exact name from the directory, never fuzzy substitution during dispatch.
    inv = Invocation(id="inv-fuzzy", session_id="ses-f", query="测试", status="working")
    db.add(inv)
    db.commit()
    dispatch_fn = orchestrator._dispatch_task(
        inv,
        ChatRequest(message="测试"),
        db.get(RoutingPolicy, 1),
        [],
        [],
    )
    res = await dispatch_fn({"task": "设计实验方案", "agent": "研究设计与数据分析智能体"})
    assert res["ok"] is True
    assert res["agent_id"] == "empirical_design"
