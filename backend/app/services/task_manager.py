from __future__ import annotations

import asyncio
from collections import deque
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
WATCHDOG_MAX_POLL_SECONDS = 0.5
SubscriberEvent = tuple[int, dict[str, Any]]


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
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_EVENTS_PER_TASK))
    event_total: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    subscribers: set[asyncio.Queue[SubscriberEvent]] = field(default_factory=set)
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
            "event_total": self.event_total,
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
    def _append_event(task: BackgroundTaskRecord, event: dict[str, Any]) -> None:
        task.events.append(event)
        task.event_total += 1

    @staticmethod
    def _dispatch_to_subscribers(subs: list[asyncio.Queue[SubscriberEvent]], event: SubscriberEvent) -> None:
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

    async def _watchdog_loop(self, task_id: str, poll_seconds: float) -> None:
        try:
            while True:
                await asyncio.sleep(poll_seconds)
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
            # Long-running tasks do not need a 20 Hz timer. Short explicit
            # deadlines retain a proportionally quicker check interval.
            poll_seconds = min(WATCHDOG_MAX_POLL_SECONDS, max(0.02, effective_deadline / 2))
            record.watchdog_task = asyncio.create_task(self._watchdog_loop(tid, poll_seconds))
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
            if not task or task.status != "running":
                return
            task.updated_at = time.time()
            self._append_event(task, event)
            indexed_event = (task.event_total - 1, event)
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, indexed_event)

    async def complete_task(self, task_id: str, result_data: dict[str, Any]) -> None:
        result_event = {"type": "result", "data": result_data}
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status in {"completed", "failed", "cancelled"}:
                return
            task.status = "completed"
            task.result = result_data
            task.updated_at = time.time()
            self._append_event(task, result_event)
            indexed_event = (task.event_total - 1, result_event)
            if task.watchdog_task and not task.watchdog_task.done():
                task.watchdog_task.cancel()
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, indexed_event)

    async def fail_task(self, task_id: str, error_message: str) -> None:
        err_event = {"type": "error", "message": error_message}
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status in {"completed", "failed", "cancelled"}:
                return
            task.status = "failed"
            task.error = error_message
            task.updated_at = time.time()
            self._append_event(task, err_event)
            indexed_event = (task.event_total - 1, err_event)
            if task.watchdog_task and not task.watchdog_task.done():
                task.watchdog_task.cancel()
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, indexed_event)

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
            self._append_event(task, cancel_event)
            indexed_event = (task.event_total - 1, cancel_event)
            subs = list(task.subscribers)

        self._dispatch_to_subscribers(subs, indexed_event)
        return True

    async def subscribe(
        self,
        task_id: str,
        user_id: str,
        from_index: int = 0,
        include_index: bool = False,
    ) -> AsyncGenerator[dict[str, Any] | SubscriberEvent, None]:
        queue: asyncio.Queue[SubscriberEvent] = asyncio.Queue(maxsize=MAX_SUBSCRIBER_QUEUE_SIZE)

        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.user_id != user_id:
                raise KeyError(f"Task not found or access denied: {task_id}")
            # from_index is an absolute event cursor, not an index into the
            # retained ring. A stale cursor replays all still-retained events.
            oldest_index = task.event_total - len(task.events)
            retained_start = max(0, from_index - oldest_index)
            historical = [
                (oldest_index + offset, event)
                for offset, event in enumerate(task.events)
            ][retained_start:]
            is_terminal = task.status in {"completed", "failed", "cancelled"}
            if not is_terminal:
                task.subscribers.add(queue)

        try:
            next_index = max(0, from_index)
            for index, ev in historical:
                next_index = index + 1
                yield (index, ev) if include_index else ev
                if ev.get("type") in {"result", "error"}:
                    return

            if is_terminal:
                return

            while True:
                index, ev = await queue.get()
                if index < next_index:
                    continue
                if index > next_index:
                    # A slow subscriber can overflow its bounded queue. Fill
                    # the missing range from the retained task event ring
                    # before yielding the newer queued event.
                    async with self._lock:
                        oldest_index = task.event_total - len(task.events)
                        missing = [
                            (oldest_index + offset, retained)
                            for offset, retained in enumerate(task.events)
                            if next_index <= oldest_index + offset < index
                        ]
                    if oldest_index > next_index:
                        logger.warning(
                            "Task %s stream lost events %s..%s beyond retention",
                            task_id, next_index, oldest_index - 1,
                        )
                    for missing_index, missing_event in missing:
                        next_index = missing_index + 1
                        yield (missing_index, missing_event) if include_index else missing_event
                        if missing_event.get("type") in {"result", "error"}:
                            return
                next_index = index + 1
                yield (index, ev) if include_index else ev
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
                err_event = {"type": "error", "message": t.error}
                self._append_event(t, err_event)
                self._dispatch_to_subscribers(
                    list(t.subscribers), (t.event_total - 1, err_event)
                )

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
