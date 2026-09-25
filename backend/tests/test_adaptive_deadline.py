from __future__ import annotations

import asyncio
import time
from sqlalchemy.orm import Session

import pytest

from app.models import Agent, RoutingPolicy
from app.schemas import ChatRequest
from app.services.adaptive_lease import (
    AdaptiveDeadlineController,
    ProgressPhase,
    IdleTimeoutError,
    AbsoluteTimeoutError,
)
from app.services.orchestrator import ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry


def setup_policy_and_agents(db: Session) -> None:
    db.query(Agent).delete()
    db.query(RoutingPolicy).delete()
    db.commit()

    from app.seed import DEFAULT_WEIGHTS
    db.add(
        RoutingPolicy(
            id=1,
            weights=DEFAULT_WEIGHTS,
            failure_threshold=2,
            circuit_cooldown_seconds=60,
            max_attempts=2,
            request_timeout_seconds=60.0,
        )
    )
    db.add(
        Agent(
            id="partner-a",
            aic="aic-partner-a",
            name="Partner A",
            role="partner",
            transport="test-stream",
            input_modes=["text/plain"],
            output_modes=["application/json"],
            skills=[{"id": "s1", "name": "Skill 1"}],
            health="online",
            active_tasks=0,
            streaming_enabled=True,
        )
    )
    db.commit()


def test_adaptive_controller_permissions_and_bounds() -> None:
    # Standard profile non-admin capped at 900
    c1 = AdaptiveDeadlineController("t1", profile_name="standard", hard_deadline_seconds=1200.0, is_admin=False)
    assert c1.absolute_deadline_seconds == 900.0

    # Research profile non-admin allows up to 1200
    c2 = AdaptiveDeadlineController("t2", profile_name="research", hard_deadline_seconds=800.0, is_admin=False)
    assert c2.absolute_deadline_seconds == 800.0

    c3 = AdaptiveDeadlineController("t3", profile_name="research", hard_deadline_seconds=1500.0, is_admin=False)
    assert c3.absolute_deadline_seconds == 1200.0

    # Admin allows up to 1800
    c4 = AdaptiveDeadlineController("t4", profile_name="research", hard_deadline_seconds=2000.0, is_admin=True)
    assert c4.absolute_deadline_seconds == 1800.0


def test_anti_trickle_filter() -> None:
    ctrl = AdaptiveDeadlineController("t1", profile_name="standard")
    assert ctrl.phase == ProgressPhase.WAITING_FIRST_TOKEN

    # Single character / whitespace is rejected as trickle keepalive
    assert ctrl.record_tokens(" ") is False
    assert ctrl.record_tokens(".") is False
    assert ctrl.phase == ProgressPhase.WAITING_FIRST_TOKEN

    # Substantial chunk (>= 8 chars or >= 3 tokens) is accepted and transitions phase
    assert ctrl.record_tokens("这是第一批有效的回复文本") is True
    assert ctrl.phase == ProgressPhase.GENERATING
    assert ctrl.token_count > 0


def test_ewma_tokens_per_second_and_calibration() -> None:
    ctrl = AdaptiveDeadlineController("t1", profile_name="standard", expected_tokens=100)
    ctrl.record_tokens("第一段充足的内容，用于推进进度租约")
    time.sleep(0.02)
    ctrl.record_tokens("第二段充足的内容，继续计算生成速率")

    summary = ctrl.get_summary()
    assert summary["tokens_per_second_approximate"] is True
    assert summary["tokens_per_second"] is not None
    assert summary["tokens_per_second"] > 0

    # Provider usage calibration
    ctrl.calibrate_tokens(50)
    summary_calibrated = ctrl.get_summary()
    assert summary_calibrated["tokens_per_second_approximate"] is False
    assert summary_calibrated["token_count"] == 50


class SteadyStreamTransport:
    """Simulates steady streaming that would exceed idle timeout if not renewed."""
    def __init__(self, step_sleep: float = 0.08, steps: int = 4):
        self.step_sleep = step_sleep
        self.steps = steps

    async def execute(self, agent, query, timeout_seconds, on_text=None, **kwargs):
        for i in range(self.steps):
            await asyncio.sleep(self.step_sleep)
            if on_text:
                await on_text(f"【有效进度块 {i+1}】：持续输出详细分析内容以刷新有效租约。")
        return PartnerResult(text="最终完成分析报告", data={}, llm_calls=1, prompt_tokens=10, completion_tokens=50)


class TrickleStreamTransport:
    """Simulates trickle attack sending single byte keeps without real progress."""
    def __init__(self, step_sleep: float = 0.05, steps: int = 8):
        self.step_sleep = step_sleep
        self.steps = steps

    async def execute(self, agent, query, timeout_seconds, on_text=None, **kwargs):
        for _ in range(self.steps):
            await asyncio.sleep(self.step_sleep)
            if on_text:
                await on_text(".")  # 1 char trickle, rejected
        return PartnerResult(text="完成", data={}, llm_calls=1, prompt_tokens=5, completion_tokens=5)


@pytest.mark.asyncio
async def test_slow_steady_streaming_survives_idle_timeout(db: Session) -> None:
    """稳定流式输出能持续续租，不会被短 idle timeout 误杀。"""
    setup_policy_and_agents(db)
    agent_a = db.get(Agent, "partner-a")

    transports = TransportRegistry({"test-stream": SteadyStreamTransport(step_sleep=0.08, steps=4)})
    orchestrator = ReliableOrchestrator(db, transports)

    controller = AdaptiveDeadlineController(
        "steady-test",
        profile_name="standard",
        hard_deadline_seconds=2.0,
    )
    # Configure idle timeout to 0.2s (total execution ~0.35s > 0.2s)
    controller.idle_deadline_seconds = 0.2
    orchestrator.controller = controller

    invocation, _, selected = await orchestrator.run(
        ChatRequest(
            message="生成长研究报告",
            agent_id="partner-a",
            hard_deadline_seconds=2.0,
        )
    )

    assert invocation.status == "completed"
    assert "最终完成分析报告" in invocation.result_text
    db.refresh(agent_a)
    assert agent_a.active_tasks == 0


@pytest.mark.asyncio
async def test_trickle_stream_rejected_and_idle_times_out(db: Session) -> None:
    """微量保活（trickle）被有效进度过滤器拒绝，触发 idle timeout。"""
    setup_policy_and_agents(db)
    agent_a = db.get(Agent, "partner-a")

    transports = TransportRegistry({"test-stream": TrickleStreamTransport(step_sleep=0.06, steps=8)})
    orchestrator = ReliableOrchestrator(db, transports)

    controller = AdaptiveDeadlineController(
        "trickle-test",
        profile_name="standard",
        hard_deadline_seconds=2.0,
    )
    controller.idle_deadline_seconds = 0.15
    orchestrator.controller = controller

    invocation, _, selected = await orchestrator.run(
        ChatRequest(
            message="测试防涓流",
            agent_id="partner-a",
            hard_deadline_seconds=2.0,
        )
    )

    assert invocation.status == "failed"
    assert "超时" in (invocation.result_text or "")
    db.refresh(agent_a)
    assert agent_a.active_tasks == 0

    idle_events = [e for e in invocation.events if e.event_type == "TASK_IDLE_TIMEOUT"]
    assert len(idle_events) == 1
    timeout_events = [e for e in invocation.events if e.event_type == "TASK_TIMEOUT"]
    assert len(timeout_events) == 1


@pytest.mark.asyncio
async def test_absolute_ceiling_enforced_even_with_progress(db: Session) -> None:
    """即使持续有高频有效输出，达到 absolute ceiling 时必须强制终止。"""
    setup_policy_and_agents(db)
    agent_a = db.get(Agent, "partner-a")

    # Endless stream
    class InfiniteStreamTransport:
        async def execute(self, agent, query, timeout_seconds, on_text=None, **kwargs):
            while True:
                await asyncio.sleep(0.04)
                if on_text:
                    await on_text("这是一批非常充分的持续有效输出内容。")

    transports = TransportRegistry({"test-stream": InfiniteStreamTransport()})
    orchestrator = ReliableOrchestrator(db, transports)

    controller = AdaptiveDeadlineController(
        "absolute-test",
        profile_name="standard",
        hard_deadline_seconds=0.2,
    )
    orchestrator.controller = controller

    invocation, _, selected = await orchestrator.run(
        ChatRequest(
            message="测试绝对截止上限",
            agent_id="partner-a",
            hard_deadline_seconds=0.2,
        )
    )

    assert invocation.status == "failed"
    assert "超时" in (invocation.result_text or "")
    db.refresh(agent_a)
    assert agent_a.active_tasks == 0

    abs_events = [e for e in invocation.events if e.event_type == "TASK_ABSOLUTE_TIMEOUT"]
    assert len(abs_events) == 1
    timeout_events = [e for e in invocation.events if e.event_type == "TASK_TIMEOUT"]
    assert len(timeout_events) == 1


def test_adaptive_controller_set_phase_always_resets_idle_timer() -> None:
    ctrl = AdaptiveDeadlineController("test-phase-reset", profile_name="standard")
    ctrl.set_phase(ProgressPhase.GENERATING, reason="first transition")
    t1 = ctrl.last_progress_at
    time.sleep(0.01)
    # Transitioning to the SAME phase should still refresh last_progress_at
    ctrl.set_phase(ProgressPhase.GENERATING, reason="re-enter phase")
    assert ctrl.last_progress_at > t1


def test_adaptive_controller_configured_idle_watchdog(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace
    from app import config

    monkeypatch.setattr(
        config,
        "get_settings",
        lambda: SimpleNamespace(idle_watchdog_timeout_seconds=75.0),
    )
    ctrl = AdaptiveDeadlineController("test-cfg-idle", profile_name="standard")
    assert ctrl.idle_grace_by_phase[ProgressPhase.GENERATING] >= 75.0
    assert ctrl.idle_grace_by_phase[ProgressPhase.WAITING_FIRST_TOKEN] >= 75.0
    assert ctrl.idle_grace_by_phase[ProgressPhase.SYNTHESIZING] >= 75.0

