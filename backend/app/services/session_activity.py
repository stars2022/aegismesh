"""Read-only reconstruction of session activity, including legacy failed turns."""
from copy import deepcopy

from sqlalchemy import select

from ..models import TraceEvent


def activity_data(db, invocation):
    data = deepcopy(invocation.result_data or {})
    by_task = {c["task_id"]: c for c in data.get("collaborations", []) if c.get("task_id")}
    for event in db.scalars(select(TraceEvent).where(
        TraceEvent.invocation_id == invocation.id).order_by(TraceEvent.id)):
        detail = event.detail or {}
        task_id = detail.get("taskId")
        if not task_id:
            continue
        if event.event_type in {"DISPATCH_STARTED", "SUBAGENT_TASK_RECEIVED"}:
            item = by_task.setdefault(task_id, {"task_id": task_id, "status": "running"})
            for dest, source in {"agent_id": "agentId", "agent_name": "agentName", "task": "task",
                                 "caller_id": "callerId", "call_chain": "callChain"}.items():
                if detail.get(source) is not None and (not item.get(dest) or
                        (dest == "task" and event.event_type == "SUBAGENT_TASK_RECEIVED")):
                    item[dest] = detail[source]
        elif task_id in by_task and event.event_type == "DISPATCH_COMPLETED":
            by_task[task_id].update(status="completed", latency_ms=detail.get("latencyMs"))
        elif task_id in by_task and event.event_type in {"DISPATCH_FAILED", "SUBAGENT_TASK_FAILED", "DISPATCH_CANCELLED"}:
            by_task[task_id].update(status="failed", error=detail.get("error") or "任务已中断")
    for item in by_task.values():
        item.update(session_id=invocation.session_id, invocation_id=invocation.id)
        item.setdefault("agent_name", item.get("agent_id", "子智能体"))
        if item.get("status") == "running" and invocation.status not in {"working", "routing"}:
            item.update(status="failed", phase_name="已中断", error=item.get("error") or "主任务已结束，未保存完整回传")
        for tool in item.get("tools") or []:
            if tool.get("status") == "running" and item.get("status") != "running":
                tool["status"] = "cancelled"
        if item.get("status") != "running":
            item["current_tool"] = None
    # Preserve old entries without a task ID as well, scoped by invocation in UI.
    data["collaborations"] = [*by_task.values(), *[c for c in data.get("collaborations", []) if not c.get("task_id")]]
    for tool in data.get("runtime_tools") or []:
        if tool.get("status") == "running" and invocation.status not in {"working", "routing"}:
            tool["status"] = "cancelled"
    return data
