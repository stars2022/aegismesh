from __future__ import annotations

import asyncio
import pytest
from app import main as app_main
from app.services.task_manager import MAX_EVENTS_PER_TASK, TaskManager


async def collect_events(tm: TaskManager, task_id: str, user_id: str, from_index: int = 0):
    return [
        event
        async for event in tm.subscribe(task_id, user_id=user_id, from_index=from_index)
    ]


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


@pytest.mark.asyncio
async def test_finished_task_replays_and_closes_without_new_events():
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    await tm.publish_event(task.task_id, {"type": "delta", "text": "部分内容"})
    await tm.complete_task(task.task_id, {"answer": "完整内容"})

    events = await asyncio.wait_for(collect_events(tm, task.task_id, "u1"), timeout=0.2)
    assert [event["type"] for event in events] == ["delta", "result"]
    assert events[-1]["data"]["answer"] == "完整内容"
    assert task.event_total == 2

    # A terminal task cannot acquire later deltas or leave a subscriber waiting.
    await tm.publish_event(task.task_id, {"type": "delta", "text": "过期内容"})
    assert task.event_total == 2
    assert await asyncio.wait_for(collect_events(tm, task.task_id, "u1", 2), timeout=0.2) == []


@pytest.mark.asyncio
async def test_replay_cursor_remains_absolute_after_ring_rollover():
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    for index in range(MAX_EVENTS_PER_TASK + 5):
        await tm.publish_event(task.task_id, {"type": "delta", "index": index})
    await tm.complete_task(task.task_id, {"answer": "ok"})

    assert task.event_total == MAX_EVENTS_PER_TASK + 6
    assert len(task.events) == MAX_EVENTS_PER_TASK
    tail = await asyncio.wait_for(
        collect_events(tm, task.task_id, "u1", MAX_EVENTS_PER_TASK + 2), timeout=0.2
    )
    assert [event.get("index") for event in tail] == [
        MAX_EVENTS_PER_TASK + 2,
        MAX_EVENTS_PER_TASK + 3,
        MAX_EVENTS_PER_TASK + 4,
        None,
    ]


@pytest.mark.asyncio
async def test_slow_subscriber_recovers_dropped_queue_events_from_ring():
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    stream = tm.subscribe(task.task_id, "u1", include_index=True)
    await tm.publish_event(task.task_id, {"type": "delta", "index": 0})
    assert await anext(stream) == (0, {"type": "delta", "index": 0})

    for index in range(1, 260):
        await tm.publish_event(task.task_id, {"type": "delta", "index": index})
    await tm.complete_task(task.task_id, {"answer": "ok"})

    remaining = await asyncio.wait_for(
        collect_indexed_events(stream), timeout=0.5
    )
    assert [index for index, _ in remaining] == list(range(1, 261))
    assert [event.get("index") for _, event in remaining[:-1]] == list(range(1, 260))
    assert remaining[-1][1]["type"] == "result"


async def collect_indexed_events(stream):
    return [item async for item in stream]


@pytest.mark.asyncio
async def test_sse_reconnect_emits_stable_ids_without_replaying_prior_delta(monkeypatch):
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    await tm.publish_event(task.task_id, {"type": "delta", "text": "前"})
    await tm.publish_event(task.task_id, {"type": "delta", "text": "后"})
    await tm.complete_task(task.task_id, {"answer": "前后"})
    monkeypatch.setattr(app_main, "task_manager", tm)

    frames = await asyncio.wait_for(
        collect_sse_frames(app_main._stream_task_events(task.task_id, "u1", from_index=1)),
        timeout=0.2,
    )
    assert [frame.split("\n", 1)[0] for frame in frames] == ["id: 1", "id: 2"]
    assert '"text": "后"' in frames[0]
    assert '"answer": "前后"' in frames[1]


@pytest.mark.asyncio
async def test_idle_sse_sends_heartbeat_without_advancing_replay_cursor(monkeypatch):
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    monkeypatch.setattr(app_main, "task_manager", tm)
    stream = app_main._stream_task_events(task.task_id, "u1", heartbeat_seconds=0.01)
    try:
        heartbeat = await asyncio.wait_for(anext(stream), timeout=0.2)
        assert heartbeat == ": keep-alive\n\n"
        assert task.event_total == 0

        await tm.publish_event(task.task_id, {"type": "delta", "text": "你好"})
        delta = await asyncio.wait_for(anext(stream), timeout=0.2)
        assert delta.startswith("id: 0\nevent: delta\n")
        await tm.complete_task(task.task_id, {"answer": "你好"})
        result = await asyncio.wait_for(anext(stream), timeout=0.2)
        assert result.startswith("id: 1\nevent: result\n")
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
    finally:
        await stream.aclose()


@pytest.mark.asyncio
async def test_idle_sse_disconnect_removes_subscriber(monkeypatch):
    tm = TaskManager()
    task = await tm.create_task("u1", "s1")
    monkeypatch.setattr(app_main, "task_manager", tm)
    stream = app_main._stream_task_events(task.task_id, "u1", heartbeat_seconds=0.01)

    assert await asyncio.wait_for(anext(stream), timeout=0.2) == ": keep-alive\n\n"
    assert len(task.subscribers) == 1
    await stream.aclose()
    assert not task.subscribers
    await tm.cancel_task(task.task_id, "u1")


async def collect_sse_frames(stream):
    return [frame async for frame in stream]


@pytest.mark.asyncio
async def test_zombie_cleanup_publishes_terminal_error():
    tm = TaskManager()
    zombie = await tm.create_task("u1", "s1")
    zombie.created_at -= 901
    replacement = await tm.create_task("u1", "s2")

    assert zombie.status == "failed"
    events = await asyncio.wait_for(collect_events(tm, zombie.task_id, "u1"), timeout=0.2)
    assert events == [{"type": "error", "message": "任务超时被系统清理"}]
    await tm.cancel_task(replacement.task_id, "u1")
