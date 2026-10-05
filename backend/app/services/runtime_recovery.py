"""Identify work abandoned by a dead API process without touching live peers."""

from __future__ import annotations

import os
import socket
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from ..models import Agent, BountyBoard, BountyWorkItem, HostedTask, Invocation, OperationalLog, TraceEvent
from .bounty import close_abandoned_board


_HOST = socket.gethostname()
INTERRUPTED_MESSAGE = "服务重启中断，任务已终止。"
HOSTED_INTERRUPTED_MESSAGE = "服务重启中断，托管任务已终止。"


def _process_start_ticks(pid: int) -> str | None:
    """Linux process birth marker; avoids mistaking a reused PID for its owner."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return fields[19]  # /proc stat field 22, after the pid and command fields.
    except (OSError, IndexError):
        return None


def runtime_marker() -> dict[str, Any]:
    pid = os.getpid()
    marker: dict[str, Any] = {"host": _HOST, "pid": pid}
    if start_ticks := _process_start_ticks(pid):
        marker["start_ticks"] = start_ticks
    return marker


def runtime_is_live(marker: Any) -> bool:
    if not isinstance(marker, dict):
        return False
    host, pid = marker.get("host"), marker.get("pid")
    if not isinstance(host, str) or not isinstance(pid, int) or pid <= 0:
        return False
    # A shared database may also contain work from another machine. Its
    # liveness cannot be established from this host, so leave it untouched.
    if host != _HOST:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    expected_start = marker.get("start_ticks")
    if expected_start and (actual_start := _process_start_ticks(pid)):
        return expected_start == actual_start
    return True


def _runtime_quiescent():
    return (
        ~select(Invocation.id).where(Invocation.status.in_(["routing", "working"])).exists()
        & ~select(HostedTask.task_id).where(HostedTask.state.in_(["accepted", "working"])).exists()
    )


def recover_idle_probe(
    db: Session, agent_id: str, *, reason: str, require_quiescent: bool = False,
) -> bool:
    """Release an abandoned probe, never declare a successful/healthy agent.

    The conditional update checks persisted load, not a caller's stale ORM
    snapshot. Startup additionally requires no live work anywhere in this DB.
    Keep the original cooldown and all failure statistics: only an actual
    successful call may close the breaker.
    """
    conditions = [
        Agent.id == agent_id, Agent.circuit_state == "half-open",
        Agent.active_tasks == 0, Agent.queued_tasks == 0,
    ]
    if require_quiescent:
        conditions.append(_runtime_quiescent())
    changed = db.execute(
        update(Agent).where(*conditions).values(circuit_state="open")
        .execution_options(synchronize_session="fetch")
    ).rowcount
    if not changed:
        return False
    # Local audit in the same transaction; this is not an AMP task/call event.
    db.add(OperationalLog(
        event_key=f"circuit-recovery:{uuid.uuid4().hex}", origin="admin", kind="audit",
        occurred_at=datetime.now(timezone.utc), actor="system:runtime-recovery",
        action="circuit_probe_recovered", target=f"/runtime/agents/{agent_id}/circuit",
        outcome="success", summary="未完成的半开探测已释放，等待真实调用验证",
        detail={"agent_id": agent_id, "reason": reason, "from": "half-open", "to": "open"},
    ))
    return True


def recover_interrupted_runtime(db: Session) -> tuple[int, int]:
    """Commit terminal states for work whose owning process no longer exists."""
    now = datetime.now(timezone.utc)
    recovered_invocations = 0
    recovered_hosted = 0
    for inv in db.scalars(select(Invocation).where(Invocation.status.in_(["routing", "working"]))).all():
        if runtime_is_live((inv.result_data or {}).get("_runtime")):
            continue
        partial_result = (inv.result_text or "").strip()
        inv.status = "failed"
        inv.finished_at = now
        inv.result_text = (
            f"{partial_result}\n\n[{INTERRUPTED_MESSAGE}]" if partial_result else INTERRUPTED_MESSAGE
        )
        inv.result_data = {
            **(inv.result_data or {}),
            "interrupted": True,
            "interruption_reason": "server_restart",
            "interrupted_partial": partial_result,
        }
        close_abandoned_board(db, inv, "服务重启中断，本轮已结束，未自动重投")
        db.add(TraceEvent(
            invocation=inv,
            event_type="TASK_INTERRUPTED",
            detail={"reason": "服务重启中断，系统自动清理僵尸任务"},
        ))
        recovered_invocations += 1

    for task in db.scalars(select(HostedTask).where(HostedTask.state.in_(["accepted", "working"]))).all():
        if runtime_is_live((task.result_data or {}).get("_runtime")):
            continue
        partial_result = (task.result_text or "").strip()
        task.state = "failed"
        task.state_changed_at = now
        task.result_text = (
            f"{partial_result}\n\n[{HOSTED_INTERRUPTED_MESSAGE}]"
            if partial_result else HOSTED_INTERRUPTED_MESSAGE
        )
        task.result_data = {
            **(task.result_data or {}),
            "interrupted": True,
            "reason": "Server restarted while task was running",
            "interrupted_partial": partial_result,
        }
        recovered_hosted += 1

    # Production sessions disable autoflush: terminal states must reach the DB
    # before checking for live work. Check quiescence in the UPDATE itself so a
    # newly accepted request also prevents cleanup, not just an earlier SELECT.
    db.flush()
    terminal_boards = select(Invocation.id).where(Invocation.status.not_in(["routing", "working"]))
    db.execute(update(BountyBoard).where(BountyBoard.invocation_id.in_(terminal_boards)).values(closed=True))
    db.execute(update(BountyWorkItem).where(
        BountyWorkItem.invocation_id.in_(terminal_boards), BountyWorkItem.status.in_(["open", "claimed"]),
    ).values(status="cancelled", review_note="所属任务已终止，未自动重投", finished_at=now))
    db.execute(
        update(Agent).where(
            _runtime_quiescent(), or_(Agent.active_tasks != 0, Agent.queued_tasks != 0),
        ).values(active_tasks=0, queued_tasks=0).execution_options(synchronize_session="fetch")
    )
    for agent_id in db.scalars(select(Agent.id).where(Agent.circuit_state == "half-open")):
        recover_idle_probe(db, agent_id, reason="runtime_interrupted", require_quiescent=True)
    db.commit()
    from .quotas import recover_reservations
    recover_reservations(db)
    from .model_budget import recover_terminal_model_reservations
    recover_terminal_model_reservations(db)
    db.commit()
    return recovered_invocations, recovered_hosted
