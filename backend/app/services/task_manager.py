from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
import time
import uuid
from typing import Any, AsyncGenerator

from .adaptive_lease import AdaptiveDeadlineController

logger = logging.getLogger(__name__)


MAX_EVENTS_PER_TASK = 1000
MAX_SUBSCRIBER_QUEUE_SIZE = 200
DEFAULT_TASK_DEADLINE_SECONDS = 600.0


@dataclass
class BackgroundTaskRecord:
    task_id: str
    user_id: str
    session_id: str
    agent_id: str | None
    status: str = "running"  # "running" | "completed" | "failed" | "cancelled"
    deadline_seconds: float = DEFAULT_TASK_DEADLINE_SECONDS
    controller: AdaptiveDeadlineController | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    events: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    asyncio_task: asyncio.Task[Any] | None = None
    watchdog_task: asyncio.Task[Any] | None = None

    def to_summary(self) -> dict[str, Any]:
        data = {
            "task_id": self.task_id,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "event_count": len(self.events),
            "has_result": self.result is not None,
            "error": self.error,
        }
        if self.controller:
            data.update(self.controller.get_summary())
        return data


class TaskManager:
    """Manages background chat executions detached from HTTP connection lifecycles.

    Features:
    - Background asyncio.Task is NOT cancelled when frontend disconnects or refreshes.
    - Captures an in-memory bounded event stream (ring/list) for replay upon reconnect.
    - Strictly isolated by user_id and session_id.
    - Allows multiple concurrent subscribers with bounded queue capacity.
    - Hard execution deadline watchdog and done callbacks for unhandled exceptions.
    - Idempotent terminal state transitions.
    """

    def __init__(self, max_retained_tasks: int = 200, task_retention_seconds: float = 3600.0) -> None:
        self._tasks: dict[str, BackgroundTaskRecord] = {}
        self._max_retained = max_retained_tasks
        self._retention_seconds = task_retention_seconds
        self._lock = asyncio.Lock()

    @staticmethod
    def _dispatch_to_subscribers(subs: list[asyncio.Queue[dict[str, Any]]], event: dict[str, Any]) -> None:
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass
            except Exception:
                pass

    async def _watchdog_loop(self, task_id: str) -> None:
        try:
            while True:
                await asyncio.sleep(0.05)
                async with self._lock:
                    task = self._tasks.get(task_id)
                    if not task or task.status != "running":
                        return
                    if task.controller:
                        expired, code, message = task.controller.check_deadline()
                    else:
                        elapsed = time.time() - task.created_at
                        if elapsed > task.deadline_seconds:
                            expired, code, message = (
                                True,
                                "absolute_timeout",
                                f"任务执行超时（超过 {task.deadline_seconds} 秒）",
                            )
                        else:
                            expired, code, message = False, None, None

                    if expired:
                        logger.warning("Task %s deadline reached (%s): %s", task_id, code, message)
                        if task.asyncio_task and not task.asyncio_task.done():
                            task.asyncio_task.cancel()
                        err_msg = message or "任务执行超时"
                        break
            await self.fail_task(task_id, err_msg)
        except asyncio.CancelledError:
            pass
        except Exception as err:
            logger.error("Watchdog error for task %s: %s", task_id, err)

    async def create_task(
        self,
        user_id: str,
        session_id: str,
        agent_id: str | None = None,
        task_id: str | None = None,
        deadline_seconds: float = DEFAULT_TASK_DEADLINE_SECONDS,
        controller: AdaptiveDeadlineController | None = None,
    ) -> BackgroundTaskRecord:
        async with self._lock:
            self._cleanup_expired()
            tid = task_id or f"task_{uuid.uuid4().hex[:12]}"
            effective_deadline = (
                controller.absolute_deadline_seconds if controller else deadline_seconds
            )
            record = BackgroundTaskRecord(
                task_id=tid,
                user_id=user_id,
                session_id=session_id,
                agent_id=agent_id,
                deadline_seconds=effective_deadline,
                controller=controller,
            )
            self._tasks[tid] = record
            record.watchdog_task = asyncio.create_task(self._watchdog_loop(tid))
            return record

    def attach_asyncio_task(self, task_id: str, task: asyncio.Task[Any]) -> None:
        record = self._tasks.get(task_id)
        if not record:
            return
        record.asyncio_task = task

        def _on_task_done(fut: asyncio.Future) -> None:
            try:
                if fut.cancelled():
                    asyncio.create_task(self.fail_task(task_id, "任务已被取消或中断"))
                elif fut.exception() is not None:
                    exc = fut.exception()
                    logger.exception("Background task %s unhandled exception: %s", task_id, exc)
                    asyncio.create_task(self.fail_task(task_id, f"任务后台异常：{exc}"))
            except Exception as cb_err:
                logger.error("Error in done_callback for task %s: %s", task_id, cb_err)

        task.add_done_callback(_on_task_done)

    async def get_task(self, task_id: str, user_id: str | None = None) -> BackgroundTaskRecord | None:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            if user_id and task.user_id != user_id:
                return None
            return task

    async def get_active_task(self, user_id: str, session_id: str) -> BackgroundTaskRecord | None:
        async with self._lock:
            matching: list[BackgroundTaskRecord] = [
                t
                for t in self._tasks.values()
                if t.user_id == user_id and t.session_id == session_id
            ]
            if not matching:
                return None
            matching.sort(key=lambda t: t.created_at, reverse=True)
            for t in matching:
                if t.status == "running":
                    return t
            newest = matching[0]
            if time.time() - newest.updated_at < 180.0:
                return newest
            return None

    async def publish_event(self, task_id: str, event: dict[str, Any]) -> None:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            task.updated_at = time.time()
            task.events.append(event)
            if len(task.events) > MAX_EVENTS_PER_TASK:
                task.events = task.events[-MAX_EVENTS_PER_TASK:]
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, event)

    async def complete_task(self, task_id: str, result_data: dict[str, Any]) -> None:
        result_event = {"type": "result", "data": result_data}
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status in {"completed", "failed", "cancelled"}:
                return
            task.status = "completed"
            task.result = result_data
            task.updated_at = time.time()
            task.events.append(result_event)
            if len(task.events) > MAX_EVENTS_PER_TASK:
                task.events = task.events[-MAX_EVENTS_PER_TASK:]
            if task.watchdog_task and not task.watchdog_task.done():
                task.watchdog_task.cancel()
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, result_event)

    async def fail_task(self, task_id: str, error_message: str) -> None:
        err_event = {"type": "error", "message": error_message}
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status in {"completed", "failed", "cancelled"}:
                return
            task.status = "failed"
            task.error = error_message
            task.updated_at = time.time()
            task.events.append(err_event)
            if len(task.events) > MAX_EVENTS_PER_TASK:
                task.events = task.events[-MAX_EVENTS_PER_TASK:]
            if task.watchdog_task and not task.watchdog_task.done():
                task.watchdog_task.cancel()
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, err_event)

    async def cancel_task(self, task_id: str, user_id: str) -> bool:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.user_id != user_id:
                return False
            if task.status in {"completed", "failed", "cancelled"}:
                return True
            task.status = "cancelled"
            task.updated_at = time.time()
            if task.watchdog_task and not task.watchdog_task.done():
                task.watchdog_task.cancel()
            if task.asyncio_task and not task.asyncio_task.done():
                task.asyncio_task.cancel()
            cancel_event = {"type": "error", "message": "任务已被用户取消"}
            task.events.append(cancel_event)
            if len(task.events) > MAX_EVENTS_PER_TASK:
                task.events = task.events[-MAX_EVENTS_PER_TASK:]
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, cancel_event)
        return True

    async def subscribe(
        self,
        task_id: str,
        user_id: str,
        from_index: int = 0,
    ) -> AsyncGenerator[dict[str, Any], None]:
        task = await self.get_task(task_id, user_id)
        if not task:
            raise KeyError(f"Task not found or access denied: {task_id}")

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_SUBSCRIBER_QUEUE_SIZE)

        async with self._lock:
            historical = list(task.events[from_index:])
            is_terminal = task.status in {"completed", "failed", "cancelled"}
            task.subscribers.add(queue)

        try:
            for ev in historical:
                yield ev

            if is_terminal and not historical:
                return

            while True:
                ev = await queue.get()
                yield ev
                if ev.get("type") in {"result", "error"}:
                    break
        finally:
            async with self._lock:
                task.subscribers.discard(queue)

    def _cleanup_expired(self) -> None:
        now = time.time()
        # 1. Clean up zombie running tasks exceeding 1.5x deadline
        for tid, t in list(self._tasks.items()):
            if t.status == "running" and (now - t.created_at > max(t.deadline_seconds * 1.5, 900.0)):
                logger.warning("Cleaning up zombie running task %s", tid)
                if t.asyncio_task and not t.asyncio_task.done():
                    t.asyncio_task.cancel()
                if t.watchdog_task and not t.watchdog_task.done():
                    t.watchdog_task.cancel()
                t.status = "failed"
                t.error = "任务超时被系统清理"
                t.updated_at = now

        # 2. Clean up retained finished tasks
        expired_ids = [
            tid
            for tid, t in self._tasks.items()
            if t.status != "running" and (now - t.updated_at > self._retention_seconds)
        ]
        for tid in expired_ids:
            self._tasks.pop(tid, None)

        # 3. If still over max capacity, drop oldest finished tasks
        if len(self._tasks) > self._max_retained:
            sorted_tasks = sorted(self._tasks.values(), key=lambda t: t.updated_at)
            for t in sorted_tasks:
                if len(self._tasks) <= self._max_retained:
                    break
                if t.status != "running":
                    self._tasks.pop(t.task_id, None)


# Global singleton instance
task_manager = TaskManager()
