from __future__ import annotations

import asyncio
import pytest
from app.services.task_manager import TaskManager


@pytest.mark.asyncio
async def test_task_manager_lifecycle_and_isolation():
    tm = TaskManager()

    # User 1 creates a task
    task1 = await tm.create_task(user_id="user_1", session_id="ses_1", agent_id="leader")
    assert task1.status == "running"
    assert task1.user_id == "user_1"
    assert task1.session_id == "ses_1"

    # User 2 cannot access user 1's task
    assert await tm.get_task(task1.task_id, user_id="user_2") is None
    # User 1 can access it
    assert await tm.get_task(task1.task_id, user_id="user_1") is not None

    # Publish events
    await tm.publish_event(task1.task_id, {"type": "delta", "text": "Hello "})
    await tm.publish_event(task1.task_id, {"type": "delta", "text": "world!"})

    # User 1 subscribes late and gets replay
    received = []
    async def sub():
        async for ev in tm.subscribe(task1.task_id, user_id="user_1"):
            received.append(ev)
            if ev.get("type") in {"result", "error"}:
                break

    sub_coro = asyncio.create_task(sub())
    await asyncio.sleep(0.01)

    # Complete task
    await tm.complete_task(task1.task_id, {"answer": "Hello world!"})
    await sub_coro

    assert len(received) == 3
    assert received[0] == {"type": "delta", "text": "Hello "}
    assert received[1] == {"type": "delta", "text": "world!"}
    assert received[2]["type"] == "result"
    assert received[2]["data"]["answer"] == "Hello world!"


@pytest.mark.asyncio
async def test_task_manager_active_task():
    tm = TaskManager()

    # Initially no active task
    assert await tm.get_active_task("u1", "s1") is None

    # u1 creates task in s1
    t1 = await tm.create_task("u1", "s1")
    active = await tm.get_active_task("u1", "s1")
    assert active is not None
    assert active.task_id == t1.task_id

    # u2 querying s1 returns None
    assert await tm.get_active_task("u2", "s1") is None

    # cancel task
    ok = await tm.cancel_task(t1.task_id, "u1")
    assert ok is True
    t1_fetch = await tm.get_task(t1.task_id, "u1")
    assert t1_fetch.status == "cancelled"


@pytest.mark.asyncio
async def test_task_manager_cancel_running_asyncio_task():
    tm = TaskManager()
    t = await tm.create_task("u1", "s1")

    cancelled_flag = False

    async def long_running():
        nonlocal cancelled_flag
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled_flag = True
            raise

    coro_task = asyncio.create_task(long_running())
    tm.attach_asyncio_task(t.task_id, coro_task)

    events = []
    async def sub():
        async for ev in tm.subscribe(t.task_id, "u1"):
            events.append(ev)
            if ev.get("type") in {"result", "error"}:
                break

    sub_task = asyncio.create_task(sub())
    await asyncio.sleep(0.01)

    ok = await tm.cancel_task(t.task_id, "u1")
    assert ok is True
    await sub_task
    assert cancelled_flag is True
    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert "取消" in events[0]["message"]

