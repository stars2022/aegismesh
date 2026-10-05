from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import OperationalError

from app.account_models import AccountPolicy, ModelUsage, QuotaBucket, QuotaEntry
from app.database import configure_sqlite_connection
from app.models import Agent, Invocation, RouteAttempt, RoutingPolicy, TraceEvent
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services.model_budget import recover_terminal_model_reservations
from app.services.orchestrator import AgentTaskLease, ReliableOrchestrator
from app.services.persistence import StorageFailure, sql_cleanup
from app.services.tools import ToolRegistry
from app.services.transport import PartnerResult, TransportRegistry


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["partner", "leader"])
async def test_failed_statistics_flush_terminates_without_replaying_model(db, registered_directory, role):
    agent = Agent(id="worker", aic="local:worker", name="Worker", role=role,
                  transport="openai-compatible", health="online", input_modes=["text/plain"],
                  output_modes=["text/plain"])
    db.add_all([agent, AccountPolicy(id=1, values={"accounts_enabled": True, "quota_mode": "enforce"}),
                RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2,
                                    circuit_cooldown_seconds=60, max_attempts=2, request_timeout_seconds=2)])
    db.commit()

    class OneResponse:
        calls = 0

        async def execute(self, agent, query, timeout_seconds, **kwargs):
            self.calls += 1
            return PartnerResult(text="模型已经响应，不允许再次调用", data={})

    transport = OneResponse()
    failed = []

    def fail_once(_conn, _cursor, statement, parameters, _context, _many):
        if statement.startswith("UPDATE agents SET") and "success_count" in statement and not failed:
            failed.append(True)
            raise OperationalError(statement, parameters, sqlite3.OperationalError("database is locked"))

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", fail_once)
    try:
        invocation, _, selected = await ReliableOrchestrator(
            db, TransportRegistry({"openai-compatible": transport}),
        ).run(ChatRequest(message="测试存储失败", agent_id="worker"), owner_id="guest_storage")
    finally:
        event.remove(bind, "before_cursor_execute", fail_once)
    db.expire_all()
    assert failed and transport.calls == 1
    assert invocation.status == "failed" and invocation.finished_at is not None
    assert invocation.result_data["storage_error"] == "database_busy"
    assert "UPDATE agents" not in invocation.result_text
    assert "rollback" not in invocation.result_text.lower()
    assert db.get(Agent, "worker").active_tasks == 0
    assert db.get(Agent, "worker").failure_count == 0  # Infrastructure, not agent capability.
    assert db.get(QuotaEntry, invocation.id).status == "released"
    events = list(db.scalars(select(TraceEvent).where(TraceEvent.invocation_id == invocation.id)))
    assert sum(e.event_type == "TASK_STORAGE_FAILED" for e in events) == 1
    assert not any(e.event_type == "SELF_EXECUTION_FALLBACK" for e in events)
    assert all(attempt.state == "failed" for attempt in db.scalars(
        select(RouteAttempt).where(RouteAttempt.invocation_id == invocation.id)))
    from app.main import _chat_response
    assert _chat_response(invocation, [], selected, db).status == "failed"


@pytest.mark.asyncio
async def test_tool_receipt_write_failure_does_not_reexecute_completed_tool(db, monkeypatch):
    agent = Agent(id="worker", aic="aic-worker", name="Worker")
    invocation = Invocation(id="inv-tool", owner_id="guest", session_id="session", query="test",
                            selected_agent_id="worker", status="working", result_data={})
    db.add_all([agent, invocation])
    db.commit()
    orchestrator = ReliableOrchestrator(db)
    registry = ToolRegistry()
    registry._tools.clear()
    calls = []

    def tool(_args):
        calls.append("executed")
        return "真实回执"

    registry.register("fixture", {"type": "function", "function": {"name": "fixture"}}, tool)
    commit = db.commit

    def fail_finished_receipt():
        tools = (invocation.result_data or {}).get("runtime_tools") or []
        if tools and tools[-1]["status"] == "completed":
            raise OperationalError("UPDATE invocations", {}, sqlite3.OperationalError("database is locked"))
        commit()

    monkeypatch.setattr(db, "commit", fail_finished_receipt)
    journal = orchestrator._journal_registry(registry, agent, invocation, ChatRequest(message="test"))
    with pytest.raises(StorageFailure) as failure:
        await journal.execute("fixture", {})
    assert calls == ["executed"] and db.is_active
    recovered, _, _ = orchestrator._finish_storage_failure("inv-tool", failure.value)
    assert recovered.status == "failed"
    assert recovered.result_data["runtime_tools"][-1]["status"] == "failed"
    assert calls == ["executed"]
    with pytest.raises(StorageFailure):
        await journal.execute("fixture", {})
    assert calls == ["executed"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failed", [False, True])
async def test_statistics_and_finally_release_only_own_lease(db, failed):
    agent = Agent(id="worker", aic="aic-worker", name="Worker", active_tasks=1)
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2)
    db.add_all([agent, policy])
    db.commit()
    orchestrator = ReliableOrchestrator(db)
    lease = AgentTaskLease("worker", orchestrator.session_factory)
    lease.acquire(db)
    if failed:
        orchestrator._record_failure(agent, policy)
    else:
        orchestrator._record_success(agent, 10)
    # Even a deadline raised before the statistics commit cannot double-release.
    assert agent.active_tasks == 2
    lease.release(db)
    lease.release(db)
    db.refresh(agent)
    assert agent.active_tasks == 1


@pytest.mark.asyncio
async def test_background_storage_error_stops_synthesis(db):
    invocation = Invocation(id="background", session_id="background", query="fixture", status="working")
    agent = Agent(id="worker", aic="aic-worker", name="Worker")
    db.add_all([invocation, agent])
    db.commit()
    orchestrator = ReliableOrchestrator(db)

    async def failed_child():
        await asyncio.sleep(0)
        orchestrator._abort_storage_failure(OperationalError("UPDATE", {}, sqlite3.OperationalError("database is locked")))

    child = asyncio.create_task(failed_child())
    with pytest.raises(StorageFailure):
        await orchestrator._collect_branch_result(
            PartnerResult(text="阶段性内容", data={}), agent=agent, invocation=invocation,
            request=ChatRequest(message="fixture"), policy=RoutingPolicy(), history=[],
            collaborations=[{"task_id": "child", "call_chain": ["worker", "child"]}],
            active_tasks={"child": child}, call_chain=["worker"], controller=None,
        )
    assert child.done() and isinstance(child.exception(), StorageFailure)


def test_storage_cleanup_terminates_unfinished_branch_but_preserves_completed_receipt(db):
    db.add(Invocation(id="branches", session_id="branches", query="fixture", status="working", result_data={
        "collaborations": [
            {"task_id": "done", "status": "completed", "result": "已保存的回执"},
            {"task_id": "pending", "status": "running", "tools": [{"name": "fixture", "status": "running"}]},
        ],
    }))
    db.commit()
    inv, _, _ = ReliableOrchestrator(db)._finish_storage_failure("branches", StorageFailure("database_busy"))
    done, pending = inv.result_data["collaborations"]
    assert done["status"] == "completed" and done["result"] == "已保存的回执"
    assert pending["status"] == pending["tools"][0]["status"] == "failed"


def test_failed_lease_release_retries_only_uncommitted_decrement(db, monkeypatch):
    db.add(Agent(id="worker", aic="aic-worker", name="Worker", active_tasks=2))
    db.commit()
    orchestrator = ReliableOrchestrator(db)
    lease = AgentTaskLease("worker", orchestrator.session_factory)
    lease._acquired = True

    def failed_commit():
        raise OperationalError("UPDATE agents", {}, sqlite3.OperationalError("database is locked"))

    monkeypatch.setattr(db, "commit", failed_commit)
    lease.release(db)
    lease.release(db)
    db.expire_all()
    assert db.get(Agent, "worker").active_tasks == 1  # Other task's lease is preserved.
    assert not lease._acquired


def test_cleanup_retry_is_bounded_and_only_for_lock_errors(db):
    factory = ReliableOrchestrator(db).session_factory
    calls = []

    def busy(_db):
        calls.append(1)
        raise OperationalError("UPDATE", {}, sqlite3.OperationalError("database is locked"))

    with pytest.raises(OperationalError):
        sql_cleanup(factory, busy)
    assert len(calls) == 3
    calls.clear()

    def full(_db):
        calls.append(1)
        raise OperationalError("UPDATE", {}, sqlite3.OperationalError("database or disk is full"))

    with pytest.raises(OperationalError):
        sql_cleanup(factory, full)
    assert len(calls) == 1


def test_persistent_cleanup_lock_returns_safe_error_without_sql_to_user(db):
    db.add(Invocation(id="locked", session_id="locked", query="fixture", status="working"))
    db.commit()
    calls = []

    def busy(_conn, _cursor, statement, parameters, _context, _many):
        if statement.startswith("UPDATE route_attempts"):
            calls.append(1)
            raise OperationalError(statement, parameters, sqlite3.OperationalError("database is locked"))

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", busy)
    try:
        with pytest.raises(StorageFailure) as failure:
            ReliableOrchestrator(db)._finish_storage_failure("locked", StorageFailure("database_busy"))
    finally:
        event.remove(bind, "before_cursor_execute", busy)
    assert len(calls) == 3
    assert "UPDATE" not in str(failure.value) and "parameters" not in str(failure.value)


def test_cleanup_retry_after_quota_commit_does_not_double_release_or_duplicate_trace(db):
    from app.services import quotas
    db.add(AccountPolicy(id=1, values={"accounts_enabled": True, "quota_mode": "enforce"}))
    db.add(Invocation(id="retry", session_id="retry", query="fixture", status="working"))
    db.commit()
    quotas.reserve(db, owner="guest_retry", entry_id="retry", session_id="retry")
    failures = []

    def busy_once(_conn, _cursor, statement, parameters, _context, _many):
        if statement.startswith("UPDATE model_usage") and not failures:
            failures.append(1)
            raise OperationalError(statement, parameters, sqlite3.OperationalError("database is locked"))

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", busy_once)
    try:
        inv, _, _ = ReliableOrchestrator(db)._finish_storage_failure("retry", StorageFailure("database_busy"))
    finally:
        event.remove(bind, "before_cursor_execute", busy_once)
    db.expire_all()
    assert inv.status == "failed" and failures
    assert db.get(QuotaEntry, "retry").status == "released"
    assert all(bucket.reserved == bucket.used == 0 for bucket in db.scalars(select(QuotaBucket)))
    assert len(list(db.scalars(select(TraceEvent).where(TraceEvent.invocation_id == "retry")))) == 1


def test_file_database_uses_wal_and_writer_commits_while_reader_is_open(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "wal.db"))
    event.listen(engine, "connect", configure_sqlite_connection)
    with engine.begin() as writer:
        writer.exec_driver_sql("CREATE TABLE item (value INTEGER)")
        writer.exec_driver_sql("INSERT INTO item VALUES (1)")
    reader = engine.raw_connection()
    try:
        assert reader.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert reader.execute("PRAGMA busy_timeout").fetchone()[0] == 10000
        reader.execute("BEGIN")
        assert reader.execute("SELECT value FROM item").fetchone()[0] == 1
        with engine.begin() as writer:
            writer.exec_driver_sql("UPDATE item SET value=2")
        assert reader.execute("SELECT value FROM item").fetchone()[0] == 1
        reader.rollback()
        assert reader.execute("SELECT value FROM item").fetchone()[0] == 2
    finally:
        reader.close()
        engine.dispose()


def test_model_recovery_keeps_estimated_cost_and_live_ticket(db):
    for state in ("failed", "completed", "working"):
        db.add(Invocation(id=state, session_id=state, query="fixture", status=state))
        db.add(ModelUsage(id=state, owner_id="guest", session_id=state, invocation_id=state,
                          model="fixture", provider_id="fixture", units=12345, status="reserved"))
    db.commit()
    assert recover_terminal_model_reservations(db) == 2
    db.commit()
    db.expire_all()
    assert db.get(ModelUsage, "failed").status == "estimated"
    assert db.get(ModelUsage, "completed").status == "estimated"
    assert db.get(ModelUsage, "working").status == "reserved"
    assert all(db.get(ModelUsage, state).units == 12345 for state in ("failed", "completed", "working"))


def test_backup_uses_consistent_offline_snapshot_and_checks_disk_reserve(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[2] / "scripts/backup-production.py"
    spec = importlib.util.spec_from_file_location("backup_production_fixture", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source, target = tmp_path / "source.db", tmp_path / "snapshot.db"
    with sqlite3.connect(source) as writer:
        writer.execute("CREATE TABLE fixture (value TEXT)")
        writer.execute("INSERT INTO fixture VALUES ('已提交记录')")
    module.snapshot_database(source, target)
    with sqlite3.connect(target) as reader:
        assert reader.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert reader.execute("SELECT value FROM fixture").fetchone()[0] == "已提交记录"
    monkeypatch.setattr(module.shutil, "disk_usage", lambda _path: SimpleNamespace(free=1))
    with pytest.raises(RuntimeError, match="headroom"):
        module.snapshot_database(source, tmp_path / "no-headroom.db")
