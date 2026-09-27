"""Identify work abandoned by a dead API process without touching live peers."""

from __future__ import annotations

import os
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Agent, HostedTask, Invocation, TraceEvent


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

    # Do not wipe another process's live load counters. A stale counter may be
    # cleared only when no working invocation or hosted task remains anywhere.
    live_invocation = db.scalar(
        select(Invocation.id).where(Invocation.status.in_(["routing", "working"])).limit(1)
    )
    live_hosted = db.scalar(
        select(HostedTask.task_id).where(HostedTask.state.in_(["accepted", "working"])).limit(1)
    )
    if live_invocation is None and live_hosted is None:
        for agent in db.scalars(select(Agent)):
            if agent.active_tasks != 0 or agent.queued_tasks != 0:
                agent.active_tasks = 0
                agent.queued_tasks = 0
    db.commit()
    return recovered_invocations, recovered_hosted
