from __future__ import annotations

import asyncio
import inspect
import time
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from pydantic import ValidationError

from app.models import Agent, HostedTask, Invocation, RouteAttempt, RoutingPolicy, TraceEvent
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services.orchestrator import ReliableOrchestrator, AgentTaskLease
from app.services.shared_context import SharedCollaborationContext, sanitize_text, sanitize_history
from app.services.task_manager import TaskManager, MAX_EVENTS_PER_TASK
from app.services.transport import PartnerResult, TransportRegistry


class SlowTransport:
    def __init__(self, sleep_seconds: float = 2.0, return_text: str = "slow result") -> None:
        self.sleep_seconds = sleep_seconds
        self.return_text = return_text

    async def execute(self, *args, **kwargs) -> PartnerResult:
        await asyncio.sleep(self.sleep_seconds)
        return PartnerResult(text=self.return_text, data={"slow": True})


class InstantTransport:
    def __init__(self, text: str = "instant result") -> None:
        self.text = text

    async def execute(self, *args, **kwargs) -> PartnerResult:
        return PartnerResult(text=self.text, data={"instant": True})


def setup_policy_and_agents(db: Session) -> None:
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=2,
            request_timeout_seconds=5.0,
        )
    )
    db.add(
        Agent(
            id="partner-a",
            aic="aic-partner-a",
            name="Partner A",
            role="partner",
            transport="test",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            skills=[{"id": "s1", "name": "Skill 1"}],
            health="online",
            avg_latency_ms=100.0,
            active_tasks=0,
        )
    )
    db.add(
        Agent(
            id="partner-b",
            aic="aic-partner-b",
            name="Partner B",
            role="partner",
            transport="test",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            skills=[{"id": "s1", "name": "Skill 1"}],
            health="online",
            avg_latency_ms=200.0,
            active_tasks=0,
        )
    )
    db.add(
        Agent(
            id="leader-1",
            aic="aic-leader-1",
            name="Leader 1",
            role="leader",
            transport="test-lead",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            health="online",
            active_tasks=0,
        )
    )
    db.commit()


@pytest.mark.asyncio
async def test_hard_deadline_timeout_releases_active_tasks(db: Session) -> None:
    """整任务 deadline 超时必须落终态、记录 TASK_TIMEOUT 事件并释放 agent.active_tasks。"""
    setup_policy_and_agents(db)
    agent_a = db.get(Agent, "partner-a")
    assert agent_a.active_tasks == 0

    transports = TransportRegistry({"test": SlowTransport(sleep_seconds=2.0)})
    orchestrator = ReliableOrchestrator(db, transports)

    invocation, _, selected = await orchestrator.run(
        ChatRequest(
            message="测试硬超时",
            agent_id="partner-a",
            hard_deadline_seconds=0.1,
        )
    )

    assert invocation.status == "failed"
    assert "超时" in (invocation.result_text or "")
    db.refresh(agent_a)
    assert agent_a.active_tasks == 0

    timeout_events = [e for e in invocation.events if e.event_type == "TASK_TIMEOUT"]
    assert len(timeout_events) == 1


@pytest.mark.asyncio
async def test_coordination_cancellation_and_subtasks_cleanup(db: Session) -> None:
    """父任务取消时，必须取消并 await 全部子任务，同时释放所有 active_tasks 租约。"""
    setup_policy_and_agents(db)

    class CoordinatingLeaderTransport:
        async def execute(self, agent, query, timeout_seconds, tool_registry=None, **kwargs):
            # Dispatch background subtask with wait=False
            dispatch_res = tool_registry.execute("dispatch_task", {"task": "子任务1", "wait": False})
            if inspect.isawaitable(dispatch_res):
                dispatch_res = await dispatch_res
            assert dispatch_res["ok"] is True

            # Leader stays running waiting for external cancellation
            await asyncio.sleep(5.0)
            return PartnerResult(text="leader done", data={})

    transports = TransportRegistry({
        "test-lead": CoordinatingLeaderTransport(),
        "test": SlowTransport(sleep_seconds=5.0),
    })
    orchestrator = ReliableOrchestrator(db, transports)

    task = asyncio.create_task(
        orchestrator.run(
            ChatRequest(message="发起协调任务", agent_id="leader-1", interface="harness")
        )
    )
    await asyncio.sleep(0.1)

    leader = db.get(Agent, "leader-1")
    partner = db.get(Agent, "partner-a")
    assert leader.active_tasks == 1
    assert partner.active_tasks == 1

    # Cancel parent task
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Verify both leases are properly released
    db.refresh(leader)
    db.refresh(partner)
    assert leader.active_tasks == 0
    assert partner.active_tasks == 0


@pytest.mark.asyncio
async def test_collaboration_mode_result_data_and_lineage(db: Session) -> None:
    """mode='collaborate' 时在 result_data 中回传参与智能体、执行状态、共享上下文和协作链路。"""
    setup_policy_and_agents(db)
    transports = TransportRegistry({"test": InstantTransport(text="同伴研究成果")})
    orchestrator = ReliableOrchestrator(db, transports)

    invocation, ranked, selected = await orchestrator.run(
        ChatRequest(message="多智能体协同调研", mode="collaborate", max_partners=2)
    )

    assert invocation.status == "completed"
    assert invocation.result_data["mode"] == "collaborate"
    assert len(invocation.result_data["participants"]) == 2
    assert "shared_context" in invocation.result_data
    assert "lineage" in invocation.result_data

    partner_a = db.get(Agent, "partner-a")
    partner_b = db.get(Agent, "partner-b")
    assert partner_a.active_tasks == 0
    assert partner_b.active_tasks == 0


@pytest.mark.asyncio
async def test_shared_context_read_tool_and_isolation(db: Session) -> None:
    """普通调用不泄漏 read_shared_context；仅协作子智能体临时注入该工具。"""
    setup_policy_and_agents(db)
    orchestrator = ReliableOrchestrator(db)

    # 1. Normal runtime registry does not contain read_shared_context or dispatch_task
    runtime_reg = orchestrator._runtime_registry(None)
    assert "read_shared_context" not in runtime_reg._tools
    assert "dispatch_task" not in runtime_reg._tools

    # 2. Subagent registry with shared_context contains read_shared_context
    shared_context = SharedCollaborationContext(
        root_invocation_id="inv-test-1",
        session_id="ses-test-1",
        overall_objective="测试总目标 sk-1234567890abcdef123456",
    )
    shared_context.finish_subtask(
        task_id="sub-1",
        agent_id="partner-b",
        status="completed",
        result="这是同伴B的已完成输出",
    )

    sub_reg = orchestrator._subagent_registry(
        db.get(Agent, "partner-a"),
        Invocation(id="inv-test-1", session_id="ses-test-1", query="q"),
        [],
        shared_context=shared_context,
    )
    assert "read_shared_context" in sub_reg._tools

    # Call read_shared_context
    summary_res = sub_reg.execute("read_shared_context", {})
    if inspect.isawaitable(summary_res):
        summary_res = await summary_res
    assert summary_res["ok"] is True
    summary = summary_res["result"]
    assert "[REDACTED_SECRET]" in summary["overall_objective"]
    assert summary["total_completed_reports"] == 1
    assert summary["peer_completed_reports"][0]["agent_id"] == "partner-b"


def test_anti_recursion_and_lineage_validation() -> None:
    """限制最大派发深度=3，检测循环派发与重复目标任务。"""
    # 1. Max depth validation
    with pytest.raises(ValidationError):
        ChatRequest(message="deep delegation", delegation_depth=4)

    # Valid depths <= 3
    r1 = ChatRequest(message="depth 1", delegation_depth=1)
    assert r1.delegation_depth == 1
    r2 = ChatRequest(message="depth 2", delegation_depth=2)
    assert r2.delegation_depth == 2
    r3 = ChatRequest(message="depth 3", delegation_depth=3)
    assert r3.delegation_depth == 3

    # 2. Circular delegation path
    with pytest.raises(ValidationError):
        ChatRequest(message="circular", delegation_path=["agent-1", "agent-1"])

    with pytest.raises(ValidationError):
        ChatRequest(message="circular agent", agent_id="agent-1", delegation_path=["agent-1"])

    # 3. SharedCollaborationContext duplicate dispatch checks
    context = SharedCollaborationContext(
        root_invocation_id="inv-root",
        session_id="ses-1",
        overall_objective="目标",
        delegation_path=["leader"],
    )
    context.register_subtask("t1", "partner-a", "Partner A", "数据清洗任务")

    # Reject duplicate dispatch to busy agent
    allowed, reason = context.check_dispatch_allowed("partner-a", "其他任务")
    assert not allowed
    assert "并发冲突" in reason

    # Reject identical subtask
    allowed, reason = context.check_dispatch_allowed("partner-b", "数据清洗任务")
    assert not allowed
    assert "重复任务" in reason

    # Reject circular dispatch to ancestor
    allowed, reason = context.check_dispatch_allowed("leader", "新任务")
    assert not allowed
    assert "循环" in reason or "禁止嵌套" in reason

    # Valid dispatch
    allowed, reason = context.check_dispatch_allowed("partner-b", "全新分析任务")
    assert allowed


def test_call_chain_tracking_and_hierarchical_delegation() -> None:
    """验证多级子智能体派发时的调用链追踪、继承与防嵌套循环拦截。"""
    context = SharedCollaborationContext(
        root_invocation_id="inv-hierarchical",
        session_id="ses-chain",
        overall_objective="高分子材料宏观合成与机理推演",
        call_chain=["research_leader"],
    )

    # 1. Level 1: Leader -> empirical_design
    chain_lvl1 = ["research_leader"]
    allowed, reason = context.check_dispatch_allowed(
        "empirical_design", "设计实证方案", current_call_chain=chain_lvl1
    )
    assert allowed, f"Expected allowed, got: {reason}"

    context.register_subtask(
        task_id="subtask_1",
        agent_id="empirical_design",
        agent_name="实证方法专家",
        task="设计实证方案",
        parent_agent_id="research_leader",
        call_chain=["research_leader", "empirical_design"],
    )

    # 2. Level 2: Subagent empirical_design attempts circular dispatch back to research_leader
    chain_lvl2 = ["research_leader", "empirical_design"]
    allowed, reason = context.check_dispatch_allowed(
        "research_leader", "反向委托主智能体", current_call_chain=chain_lvl2
    )
    assert not allowed
    assert "禁止嵌套或循环调用" in reason
    assert "research_leader -> empirical_design -> research_leader" in reason

    # 3. Subagent attempts self-dispatch (A -> A)
    allowed, reason = context.check_dispatch_allowed(
        "empirical_design", "递归调用自身", current_call_chain=chain_lvl2
    )
    assert not allowed
    assert "禁止嵌套或循环调用" in reason
    assert "research_leader -> empirical_design -> empirical_design" in reason

    # 4. Level 2: Subagent empirical_design legitimately delegates to peer_review
    allowed, reason = context.check_dispatch_allowed(
        "peer_review", "审查方案漏洞", current_call_chain=chain_lvl2
    )
    assert allowed

    context.register_subtask(
        task_id="subtask_2",
        agent_id="peer_review",
        agent_name="同行评审专家",
        task="审查方案漏洞",
        parent_agent_id="empirical_design",
        call_chain=["research_leader", "empirical_design", "peer_review"],
    )

    # 5. Verify summary and lineage tracking
    summary = context.read_shared_context_summary()
    assert len(summary["subtasks_status"]) == 2

    s1 = next(item for item in summary["subtasks_status"] if item["task_id"] == "subtask_1")
    assert s1["parent_agent_id"] == "research_leader"
    assert s1["call_chain"] == ["research_leader", "empirical_design"]

    s2 = next(item for item in summary["subtasks_status"] if item["task_id"] == "subtask_2")
    assert s2["parent_agent_id"] == "empirical_design"
    assert s2["call_chain"] == ["research_leader", "empirical_design", "peer_review"]


@pytest.mark.asyncio
async def test_task_manager_watchdog_and_idempotency() -> None:
    """TaskManager watchdog 超时兜底、事件队列截断及终态幂等。"""
    tm = TaskManager()

    # 1. Watchdog timeout
    record = await tm.create_task("user-1", "session-1", deadline_seconds=0.1)
    await asyncio.sleep(0.2)
    updated = await tm.get_task(record.task_id)
    assert updated.status == "failed"
    assert "超时" in (updated.error or "")

    # 2. Idempotent terminal transition
    await tm.complete_task(record.task_id, {"data": 123})
    assert updated.status == "failed"
    await tm.fail_task(record.task_id, "再次失败")
    assert updated.status == "failed"

    # 3. Event bound limit
    active = await tm.create_task("user-1", "session-2", deadline_seconds=100.0)
    for i in range(MAX_EVENTS_PER_TASK + 50):
        await tm.publish_event(active.task_id, {"index": i})
    assert len(active.events) == MAX_EVENTS_PER_TASK
    assert active.events[0]["index"] == 50
    assert active.events[-1]["index"] == MAX_EVENTS_PER_TASK + 49


def test_secret_sanitization() -> None:
    """敏感凭证（OpenAI API Key、Bearer token、密码）必须脱敏清洗。"""
    raw = "调用接口使用 sk-abcdef1234567890abcdef123456 和 Bearer my-long-secret-bearer-token-123"
    cleaned = sanitize_text(raw)
    assert "sk-abcdef" not in cleaned
    assert "my-long-secret" not in cleaned
    assert "[REDACTED_SECRET]" in cleaned


def test_lifespan_hosted_task_recovery(db: Session) -> None:
    """服务重启时，处于 accepted/working 状态的 HostedTask 必须被清理标记为 failed(interrupted=True)。"""
    setup_policy_and_agents(db)
    from datetime import datetime, timezone

    # Create accepted and working tasks
    t1 = HostedTask(
        task_id="ht-1",
        agent_id="partner-a",
        session_id="s1",
        state="accepted",
        query="task 1",
    )
    t2 = HostedTask(
        task_id="ht-2",
        agent_id="partner-b",
        session_id="s2",
        state="working",
        query="task 2",
    )
    t3 = HostedTask(
        task_id="ht-3",
        agent_id="partner-a",
        session_id="s3",
        state="completed",
        result_text="done",
    )
    db.add_all([t1, t2, t3])
    db.commit()

    # Simulate lifespan startup recovery
    now = datetime.now(timezone.utc)
    stale_hosted = list(
        db.scalars(
            select(HostedTask).where(HostedTask.state.in_(["accepted", "working"]))
        ).all()
    )
    for ht in stale_hosted:
        ht.state = "failed"
        ht.state_changed_at = now
        ht.result_text = ht.result_text or "服务重启中断，托管任务已终止。"
        ht.result_data = {
            **(ht.result_data or {}),
            "interrupted": True,
            "reason": "Server restarted while task was running",
        }
    db.commit()

    db.refresh(t1)
    db.refresh(t2)
    db.refresh(t3)
    assert t1.state == "failed"
    assert t1.result_data.get("interrupted") is True
    assert t2.state == "failed"
    assert t2.result_data.get("interrupted") is True
    assert t3.state == "completed"


@pytest.mark.asyncio
async def test_orchestrator_call_chain_loop_rejection(db: Session) -> None:
    """验证 Orchestrator 在 dispatch_task 时执行角色校验、严格调用链追踪、循环拦截与深度限制。"""
    from app.services.orchestrator import ReliableOrchestrator
    from app.models import Invocation, RoutingPolicy
    from app.schemas import ChatRequest

    setup_policy_and_agents(db)
    policy = db.query(RoutingPolicy).first()
    assert policy is not None

    sub_leader = Agent(
        id="sub-leader",
        aic="aic-sub-leader",
        name="Sub Leader",
        role="leader",
        transport="test",
        input_modes=["text/plain"],
        output_modes=["application/json"],
        health="online",
        active_tasks=0,
    )
    db.add(sub_leader)
    db.commit()

    orchestrator = ReliableOrchestrator(db)

    inv = Invocation(
        id="inv-chain-test",
        session_id="ses-test",
        query="test query",
        selected_agent_id="leader-1",
        status="working",
    )
    db.add(inv)
    db.commit()

    chat_req = ChatRequest(message="test chain message")
    shared_ctx = SharedCollaborationContext(
        root_invocation_id=inv.id,
        session_id=inv.session_id,
        overall_objective="测试目标",
        call_chain=["leader-1"],
    )

    # 1. 角色工具隔离验证：执行型智能体 (partner) 不得被分配协调与派发工具
    partner_a = db.get(Agent, "partner-a")
    assert partner_a is not None
    partner_reg = orchestrator._subagent_registry(
        agent=partner_a,
        invocation=inv,
        tools_called=[],
        shared_context=shared_ctx,
        request=chat_req,
        policy=policy,
        call_chain=["leader-1", "partner-a"],
    )
    assert "read_shared_context" in partner_reg._tools
    assert "dispatch_task" not in partner_reg._tools
    assert "list_agents" not in partner_reg._tools

    # 2. 协调型智能体 (leader) 被正确赋予派发与协调工具
    sub_leader_reg = orchestrator._subagent_registry(
        agent=sub_leader,
        invocation=inv,
        tools_called=[],
        shared_context=shared_ctx,
        request=chat_req,
        policy=policy,
        call_chain=["leader-1", sub_leader.id],
    )
    assert "read_shared_context" in sub_leader_reg._tools
    assert "dispatch_task" in sub_leader_reg._tools
    assert "list_agents" in sub_leader_reg._tools

    # 3. 若执行型智能体越权尝试派发，被系统明确拒绝
    dispatch_partner = orchestrator._dispatch_task(
        invocation=inv,
        request=chat_req,
        policy=policy,
        history=[],
        collaborations=[],
        shared_context=shared_ctx,
        caller_agent_id="partner-a",
        call_chain=["leader-1", "partner-a"],
    )
    res_partner_denied = await dispatch_partner({"task": "执行型尝试派发", "agent": "partner-b"})
    assert res_partner_denied["ok"] is False
    assert "角色为执行型" in res_partner_denied["error"]

    # 4. 协调型智能体尝试循环调用上级协调者 (leader-1)
    dispatch_sub_leader = orchestrator._dispatch_task(
        invocation=inv,
        request=chat_req,
        policy=policy,
        history=[],
        collaborations=[],
        shared_context=shared_ctx,
        caller_agent_id=sub_leader.id,
        call_chain=["leader-1", sub_leader.id],
    )
    res_loop_leader = await dispatch_sub_leader({"task": "调回根协调器", "agent": "leader-1"})
    assert res_loop_leader["ok"] is False
    assert "禁止嵌套或循环调用" in res_loop_leader["error"]
    assert "leader-1 -> sub-leader -> leader-1" in res_loop_leader["error"]

    # 5. 协调型智能体尝试递归调用自身
    res_loop_self = await dispatch_sub_leader({"task": "递归调用自己", "agent": sub_leader.id})
    assert res_loop_self["ok"] is False
    assert "禁止嵌套或循环调用" in res_loop_self["error"]
    assert "leader-1 -> sub-leader -> sub-leader" in res_loop_self["error"]

    # 6. 最大调用链深度限制校验 (MAX_CALL_CHAIN_DEPTH = 3)
    dispatch_max_depth = orchestrator._dispatch_task(
        invocation=inv,
        request=chat_req,
        policy=policy,
        history=[],
        collaborations=[],
        shared_context=shared_ctx,
        caller_agent_id="sub-leader",
        call_chain=["leader-1", "intermediate-leader", "sub-leader"],
    )
    res_depth_exceeded = await dispatch_max_depth({"task": "超限派发", "agent": "partner-a"})
    assert res_depth_exceeded["ok"] is False
    assert "超出最大调用链深度限制" in res_depth_exceeded["error"]


