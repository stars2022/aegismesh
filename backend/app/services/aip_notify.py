from __future__ import annotations

import asyncio
import secrets
from typing import Any


class NotificationInbox:
    """In-process mailbox for AIP partner notification callbacks."""

    def __init__(self) -> None:
        self._waiters: dict[str, tuple[str, asyncio.Future[dict[str, Any]]]] = {}

    def register(self, task_id: str, token: str) -> asyncio.Future[dict[str, Any]]:
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._waiters[task_id] = (token, future)
        return future

    def accept(self, task_id: str, token: str, payload: dict[str, Any]) -> bool:
        row = self._waiters.get(task_id)
        if row is None or not token:
            return False
        expected, future = row
        if not secrets.compare_digest(expected, token):
            return False
        if not future.done():
            future.set_result(payload)
        return True

    def discard(self, task_id: str) -> None:
        row = self._waiters.pop(task_id, None)
        if row is not None and not row[1].done():
            row[1].cancel()


notification_inbox = NotificationInbox()
