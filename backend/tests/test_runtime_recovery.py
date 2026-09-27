from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.main import demo_get_active_task
from app.models import Agent, HostedTask, Invocation, TraceEvent
from app.services import runtime_recovery


def test_startup_recovery_commits_dead_work_and_preserves_live_peer(
    db: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    db.add(Agent(id="worker", aic="aic-worker", name="Worker", active_tasks=2, queued_tasks=1))
    db.add_all([
        Invocation(id="dead", session_id="s1", owner_id="u1", query="old", status="working",
                   result_text="已生成的前半段",
                   result_data={"_runtime": {"host": "local", "pid": 1}}),
        Invocation(id="live", session_id="s2", owner_id="u2", query="other", status="working",
                   result_data={"_runtime": {"host": "local", "pid": 2}}),
        HostedTask(task_id="hosted-dead", agent_id="worker", session_id="s1", state="accepted",
                   result_data={"_runtime": {"host": "local", "pid": 1}}),
        HostedTask(task_id="hosted-live", agent_id="worker", session_id="s2", state="working",
                   result_data={"_runtime": {"host": "local", "pid": 2}}),
    ])
    db.commit()
    monkeypatch.setattr(runtime_recovery, "runtime_is_live", lambda marker: marker["pid"] == 2)

    assert runtime_recovery.recover_interrupted_runtime(db) == (1, 1)
    db.expire_all()
    assert db.get(Invocation, "dead").status == "failed"
    assert db.get(Invocation, "dead").result_data["interrupted"] is True
    assert db.get(Invocation, "dead").result_data["interrupted_partial"] == "已生成的前半段"
    assert "已生成的前半段" in db.get(Invocation, "dead").result_text
    assert db.get(HostedTask, "hosted-dead").state == "failed"
    assert db.get(HostedTask, "hosted-dead").result_data["interrupted"] is True
    assert db.get(Invocation, "live").status == "working"
    assert db.get(HostedTask, "hosted-live").state == "working"
    assert db.get(Agent, "worker").active_tasks == 2
    assert db.scalar(select(TraceEvent).where(TraceEvent.invocation_id == "dead")).event_type == "TASK_INTERRUPTED"


def test_startup_recovery_clears_stale_load_when_no_work_remains(db: Session) -> None:
    db.add(Agent(id="worker", aic="aic-worker", name="Worker", active_tasks=2, queued_tasks=1))
    db.add(Invocation(id="legacy", session_id="s1", query="old", status="working"))
    db.add(Invocation(id="routing-legacy", session_id="s2", query="old", status="routing"))
    db.commit()

    assert runtime_recovery.recover_interrupted_runtime(db) == (2, 0)
    db.expire_all()
    assert db.get(Agent, "worker").active_tasks == 0
    assert db.get(Agent, "worker").queued_tasks == 0
    assert db.get(Invocation, "legacy").result_data["interruption_reason"] == "server_restart"
    assert db.get(Invocation, "routing-legacy").status == "failed"


def test_runtime_marker_detects_dead_or_reused_process(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = runtime_recovery.runtime_marker()
    assert runtime_recovery.runtime_is_live(marker)
    assert not runtime_recovery.runtime_is_live(None)
    assert runtime_recovery.runtime_is_live({**marker, "host": "another-host"})
    monkeypatch.setattr(runtime_recovery, "_process_start_ticks", lambda _pid: "different")
    if marker.get("start_ticks"):
        assert not runtime_recovery.runtime_is_live(marker)
    def missing_process(_pid: int, _signal: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(runtime_recovery.os, "kill", missing_process)
    assert not runtime_recovery.runtime_is_live(marker)


@pytest.mark.asyncio
async def test_active_task_endpoint_reports_only_owners_interruption(db: Session) -> None:
    owner = "anon_" + hashlib.sha256(b"127.0.0.1").hexdigest()[:24]
    db.add(Invocation(
        id="interrupted", session_id="session-one", owner_id=owner, query="write",
        status="failed", result_text="服务重启中断，任务已终止。",
        result_data={"interrupted": True},
    ))
    db.commit()
    request = Request({"type": "http", "client": ("127.0.0.1", 1234), "headers": []})
    other = Request({"type": "http", "client": ("127.0.0.2", 1234), "headers": []})

    own_result = await demo_get_active_task("session-one", request, db)
    other_result = await demo_get_active_task("session-one", other, db)
    assert own_result["interrupted"]["invocation_id"] == "interrupted"
    assert other_result == {"active": False}
