from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Agent, HostedTask, Invocation, OperationalLog, RoutingPolicy
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services.orchestrator import AgentTaskLease, ReliableOrchestrator
from app.services.router import QualityRouter, RoutingRequirements
from app.services.runtime_recovery import recover_interrupted_runtime, runtime_marker
from app.services.transport import PartnerResult, TransportRegistry


def seed_probe(db: Session, *, state: str = "half-open", active: int = 0) -> Agent:
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, request_timeout_seconds=5))
    agent = Agent(
        id="probe", aic="aic-probe", name="Probe", transport="test", health="online",
        input_modes=["text/plain"], output_modes=["application/json"],
        circuit_state=state, circuit_open_until=datetime.now(timezone.utc) - timedelta(minutes=1),
        consecutive_failures=3, failure_count=3, request_count=3, active_tasks=active,
    )
    db.add(agent)
    db.commit()
    return agent


def assert_probe_ready(db: Session, agent: Agent) -> None:
    db.refresh(agent)
    assert agent.circuit_state == "open"  # Recovery is not a successful model call.
    assert agent.consecutive_failures == agent.failure_count == agent.request_count == 3
    assert agent.success_count == 0
    assert agent.active_tasks == agent.queued_tasks == 0
    candidate = QualityRouter().rank(
        [agent], db.get(RoutingPolicy, 1), RoutingRequirements(query="研究"),
    )[0]
    assert candidate.eligible
    audit = db.scalar(select(OperationalLog).where(OperationalLog.action == "circuit_probe_recovered"))
    assert audit is not None
    assert audit.detail["agent_id"] == agent.id


@pytest.mark.parametrize("role", ["partner", "leader"])
async def test_cancelled_half_open_call_returns_to_probe_ready(
    db: Session, registered_directory, role: str,
) -> None:
    agent = seed_probe(db, state="open")
    agent.role = role
    db.commit()
    started = asyncio.Event()

    class WaitingTransport:
        async def execute(self, *args, **kwargs):
            started.set()
            await asyncio.Future()

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": WaitingTransport()}))
    task = asyncio.create_task(orchestrator.run(ChatRequest(message="研究", agent_id=agent.id)))
    await asyncio.wait_for(started.wait(), 2)
    db.refresh(agent)
    assert agent.circuit_state == "half-open"
    assert agent.active_tasks == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert_probe_ready(db, agent)
    assert db.scalar(select(Invocation)).status == "cancelled"


@pytest.mark.parametrize("own_session", [False, True])
def test_last_lease_recovers_probe_once(db: Session, own_session: bool) -> None:
    agent = seed_probe(db)
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    lease = AgentTaskLease(agent.id, factory)
    session = None if own_session else db
    lease.acquire(session)
    lease.release(session)
    lease.release(session)
    assert_probe_ready(db, agent)
    assert len(db.scalars(select(OperationalLog)).all()) == 1


def test_releasing_a_lease_does_not_clear_another_live_probe(db: Session) -> None:
    agent = seed_probe(db)
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    first, second = AgentTaskLease(agent.id, factory), AgentTaskLease(agent.id, factory)
    with factory() as first_db:
        first.acquire(first_db)
        stale = first_db.get(Agent, agent.id)
        assert stale.active_tasks == 1
        second.acquire()  # Another API worker; the first session's object is stale.
        assert stale.active_tasks == 1
        first.release(first_db)
    db.refresh(agent)
    assert agent.active_tasks == 1
    assert agent.circuit_state == "half-open"
    assert db.scalar(select(OperationalLog)) is None
    second.release()
    assert_probe_ready(db, agent)


def test_queued_work_prevents_probe_recovery(db: Session) -> None:
    agent = seed_probe(db)
    agent.queued_tasks = 1
    db.commit()
    lease = AgentTaskLease(agent.id)
    lease.acquire(db)
    lease.release(db)
    db.refresh(agent)
    assert agent.circuit_state == "half-open"
    assert agent.queued_tasks == 1


@pytest.mark.parametrize("live_kind", ["invocation", "hosted"])
def test_startup_preserves_live_peer_probe(db: Session, live_kind: str) -> None:
    agent = seed_probe(db, active=1)
    if live_kind == "invocation":
        db.add(Invocation(id="live", session_id="live", query="研究", status="working",
                          result_data={"_runtime": runtime_marker()}))
    else:
        db.add(HostedTask(task_id="live", agent_id=agent.id, session_id="live", state="working",
                          result_data={"_runtime": runtime_marker()}))
    db.commit()
    assert recover_interrupted_runtime(db) == (0, 0)
    db.refresh(agent)
    assert agent.circuit_state == "half-open"
    assert agent.active_tasks == 1
    assert db.scalar(select(OperationalLog)) is None


@pytest.mark.parametrize("dead_work", [False, True])
def test_startup_recovers_abandoned_probe_with_production_session(db: Session, dead_work: bool) -> None:
    agent = seed_probe(db, active=1 if dead_work else 0)
    if dead_work:
        db.add(Invocation(id="dead", session_id="dead", query="研究", status="working"))
        db.add(HostedTask(task_id="dead", agent_id=agent.id, session_id="dead", state="accepted"))
        db.commit()
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    with factory() as production_db:
        assert recover_interrupted_runtime(production_db) == ((1, 1) if dead_work else (0, 0))
        recovered = production_db.get(Agent, agent.id)
        assert recovered.active_tasks == 0
        assert recovered.circuit_state == "open"
        assert recover_interrupted_runtime(production_db) == (0, 0)
    assert_probe_ready(db, agent)
    assert len(db.scalars(select(OperationalLog)).all()) == 1


def test_recovery_preserves_unexpired_cooldown(db: Session) -> None:
    agent = seed_probe(db)
    until = datetime.now(timezone.utc) + timedelta(minutes=2)
    agent.circuit_open_until = until
    db.commit()
    recover_interrupted_runtime(db)
    db.refresh(agent)
    assert agent.circuit_state == "open"
    assert QualityRouter._as_aware(agent.circuit_open_until) == until
    candidate = QualityRouter().rank(
        [agent], db.get(RoutingPolicy, 1), RoutingRequirements(query="研究"),
    )[0]
    assert not candidate.eligible


@pytest.mark.parametrize("fail", [False, True])
async def test_actual_probe_result_still_controls_circuit(db: Session, fail: bool) -> None:
    agent = seed_probe(db, state="open")

    class ResultTransport:
        async def execute(self, *args, **kwargs):
            if fail:
                raise ConnectionError("probe failed")
            return PartnerResult(text="研究结果", data={})

    orchestrator = ReliableOrchestrator(db, TransportRegistry({"test": ResultTransport()}))
    invocation, _, _ = await orchestrator.run(ChatRequest(message="研究", agent_id=agent.id))
    db.refresh(agent)
    assert invocation.status == ("failed" if fail else "completed")
    assert agent.circuit_state == ("open" if fail else "closed")
    assert agent.active_tasks == 0
    assert agent.failure_count == (4 if fail else 3)
    assert agent.success_count == (0 if fail else 1)
    assert agent.consecutive_failures == (4 if fail else 0)
    if fail:
        assert QualityRouter._as_aware(agent.circuit_open_until) > datetime.now(timezone.utc)
    assert db.scalar(select(OperationalLog)) is None
