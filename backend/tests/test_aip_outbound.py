from __future__ import annotations

import secrets
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import Agent, Invocation
from app.services.orchestrator import ReliableOrchestrator
from app.services.shared_context import SharedCollaborationContext
from app.services.transport import (
    AipSdkTransport,
    compose_aip_user_input,
    partner_stream_url,
)
from app.services import transport as transport_module


def test_notification_inbox_checks_token() -> None:
    import asyncio

    from app.services.aip_notify import notification_inbox

    async def check() -> None:
        future = notification_inbox.register("task-notify-1", "secret-token")
        assert notification_inbox.accept("task-notify-1", "wrong", {"taskId": "task-notify-1"}) is False
        assert notification_inbox.accept("task-notify-1", "secret-token", {"taskId": "task-notify-1", "ok": True}) is True
        assert future.result()["ok"] is True

    asyncio.run(check())


def test_notification_callback_rejects_unknown_task() -> None:
    with TestClient(app) as test_client:
        response = test_client.post(
            "/api/aip/notifications/callback",
            json={"taskId": "missing-task"},
            headers={"X-ACPs-AIP-Notification-Token": "secret-token"},
        )
    assert response.status_code == 401


def test_partner_stream_url_replaces_rpc_suffix() -> None:
    assert partner_stream_url("https://partner.example/aip/agent/rpc") == "https://partner.example/aip/agent/stream"
    assert partner_stream_url("https://partner.example/aip/agent/rpc/") == "https://partner.example/aip/agent/stream"
    assert partner_stream_url("https://partner.example/invoke") == "https://partner.example/invoke/stream"


def test_compose_aip_user_input_keeps_projection_and_task() -> None:
    text = compose_aip_user_input(
        "汇总路由实验",
        [
            {"role": "user", "content": "【平台调用链自适应上下文投影】\n延迟下降 18%"},
            {"role": "assistant", "content": "已接收投影背景"},
        ],
    )
    assert "延迟下降 18%" in text
    assert "【当前任务】\n汇总路由实验" in text
    assert compose_aip_user_input("只发任务", None) == "只发任务"


class _TaskState:
    Accepted = "accepted"
    Working = "working"
    AwaitingInput = "awaiting-input"
    AwaitingCompletion = "awaiting-completion"
    Completed = "completed"
    Canceled = "canceled"
    Failed = "failed"
    Rejected = "rejected"


class _Product:
    def __init__(self, text: str, product_id: str = "p1") -> None:
        self.id = product_id
        self.dataItems = [SimpleNamespace(type="text", text=text)]

    def model_dump(self, exclude_none: bool = True) -> dict:
        return {"id": self.id, "dataItems": [{"type": "text", "text": self.dataItems[0].text}]}


def _task(state: str, text: str, task_id: str = "task-1"):
    return SimpleNamespace(
        taskId=task_id,
        status=SimpleNamespace(state=state, dataItems=[]),
        products=[_Product(text)],
        dataItems=[],
    )


def _chunk(text: str, *, append: bool = False, task_id: str = "task-1"):
    payload = SimpleNamespace(
        type="product-chunk",
        taskId=task_id,
        product=_Product(text),
        append=append,
        lastChunk=False,
    )
    return SimpleNamespace(result=SimpleNamespace(eventData=payload), error=None)


def _status(state: str, task_id: str = "task-1"):
    payload = SimpleNamespace(
        type="task-status-update",
        taskId=task_id,
        status=SimpleNamespace(state=state),
    )
    return SimpleNamespace(result=SimpleNamespace(eventData=payload), error=None)


class _FakeStream:
    instances: list["_FakeStream"] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.inputs: list[str] = []
        self.commands: list = []
        self.session_id = ""
        self.completed: list[tuple[str, str]] = []
        self.events: list = []
        self.error: Exception | None = None
        self.error_after_events = False
        self.closed = False
        _FakeStream.instances.append(self)

    def stream_with_reconnect(self, session_id: str, user_input: str, **_kwargs):
        self.session_id = session_id
        self.inputs.append(user_input)
        events = list(self.events)
        error = self.error
        error_after = self.error_after_events

        async def generate():
            if error and not error_after:
                raise error
            for event in events:
                yield event
            if error and error_after:
                raise error

        return generate()

    def open_stream(self, command):
        self.commands.append(command)
        self.session_id = getattr(command, "sessionId", "") or self.session_id
        return self.stream_with_reconnect(session_id=self.session_id, user_input="")

    async def complete(self, task_id: str, session_id: str):
        self.completed.append((task_id, session_id))
        return _task("completed", "流式结果", task_id)

    async def close(self) -> None:
        self.closed = True


class _FakeRpc:
    instances: list["_FakeRpc"] = []

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.started: list[str] = []
        self.commands: list = []
        self.closed = False
        _FakeRpc.instances.append(self)

    async def _send_request(self, command):
        self.commands.append(command)
        task_text = ""
        for item in getattr(command, "dataItems", []) or []:
            metadata = getattr(item, "metadata", None) or {}
            if getattr(item, "type", None) == "text" and metadata.get("role") == "task":
                task_text = item.text
        self.started.append(task_text)
        return SimpleNamespace(result=_task("completed", "轮询结果"))

    async def start_task(self, session_id: str, user_input: str, task_id: str | None = None):
        self.started.append(user_input)
        return _task("completed", "轮询结果")

    async def get_task(self, task_id: str, session_id: str):
        return _task("completed", "轮询结果", task_id)

    async def complete_task(self, task_id: str, session_id: str):
        return _task("completed", "轮询结果", task_id)

    async def close(self) -> None:
        self.closed = True


def _install_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeStream.instances = []
    _FakeRpc.instances = []
    monkeypatch.setattr(
        transport_module,
        "_load_aip_sdk",
        lambda: (_FakeRpc, _FakeStream, _TaskState),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            leader_aic="1.2.156.leader",
            aip_identity_binding_enabled=False,
            aip_ca_file="",
            aip_cert_file="",
            aip_key_file="",
            aip_poll_interval_seconds=0.01,
        ),
    )


def _agent(*, streaming: bool) -> Agent:
    return Agent(
        id="ext-partner",
        aic="1.2.156.3088.0.1.2.3.4.ABCD",
        name="External",
        endpoint_url="https://partner.example/aip/agent/rpc",
        transport="aip-rpc",
        streaming_enabled=streaming,
        registration_status="imported",
    )


@pytest.mark.asyncio
async def test_streaming_partner_forwards_chunks_and_completes(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sdk(monkeypatch)
    seen: list[str] = []

    async def on_text(delta: str) -> None:
        seen.append(delta)

    stream = _FakeStream()
    stream.events = [_chunk("延迟"), _chunk("下降", append=True), _status("awaiting-completion")]
    _FakeStream.instances = [stream]

    def factory(**kwargs):
        stream.kwargs = kwargs
        return stream

    monkeypatch.setattr(
        transport_module,
        "_load_aip_sdk",
        lambda: (_FakeRpc, factory, _TaskState),
    )

    result = await AipSdkTransport().execute(
        _agent(streaming=True),
        "汇总路由实验",
        5,
        history=[{"role": "user", "content": "投影：延迟基线 900ms"}],
        on_text=on_text,
    )

    assert seen == ["延迟", "下降"]
    assert result.text == "延迟下降"
    assert result.data["mode"] == "aip-stream"
    assert stream.completed == [("task-1", stream.session_id)]
    command = stream.commands[0]
    task_item = next(item for item in command.dataItems if (item.metadata or {}).get("role") == "task")
    context_text = next(item for item in command.dataItems if item.type == "text" and (item.metadata or {}).get("role") == "context")
    assert task_item.text == "汇总路由实验"
    assert "投影：延迟基线 900ms" in context_text.text
    assert any(item.type == "data" and item.data["kind"] == "aegismesh.context-projection" for item in command.dataItems)
    assert stream.kwargs["partner_stream_url"] == "https://partner.example/aip/agent/stream"
    assert _FakeRpc.instances == []
    assert stream.closed is True


@pytest.mark.asyncio
async def test_polling_partner_still_receives_projected_context(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sdk(monkeypatch)
    result = await AipSdkTransport().execute(
        _agent(streaming=False),
        "汇总路由实验",
        5,
        history=[{"role": "user", "content": "投影：样本 42 组"}],
    )
    assert result.text == "轮询结果"
    assert result.data["mode"] == "aip-direct-rpc"
    assert _FakeStream.instances == []
    assert len(_FakeRpc.instances) == 1
    command = _FakeRpc.instances[0].commands[0]
    task_item = next(item for item in command.dataItems if (item.metadata or {}).get("role") == "task")
    context_item = next(item for item in command.dataItems if (item.metadata or {}).get("role") == "context" and item.type == "text")
    assert task_item.text == "汇总路由实验"
    assert "投影：样本 42 组" in context_item.text


@pytest.mark.asyncio
async def test_stream_connect_failure_falls_back_to_one_rpc_start(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sdk(monkeypatch)
    stream = _FakeStream()
    stream.error = httpx.ConnectError("connection refused")

    def factory(**kwargs):
        stream.kwargs = kwargs
        return stream

    monkeypatch.setattr(transport_module, "_load_aip_sdk", lambda: (_FakeRpc, factory, _TaskState))
    result = await AipSdkTransport().execute(_agent(streaming=True), "任务", 5)
    assert result.data["mode"] == "aip-direct-rpc"
    assert len(_FakeRpc.instances) == 1
    assert _FakeRpc.instances[0].started == ["任务"]
    assert stream.closed is True


@pytest.mark.asyncio
async def test_structured_stream_resumes_after_chunk(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sdk(monkeypatch)
    stream = _FakeStream()
    stream.events = [_chunk("已经开始")]
    stream.error = httpx.ConnectError("reset")
    stream.error_after_events = True
    stream.resumed: list[tuple[str, int | None]] = []

    def re_stream(task_id: str, session_id: str, last_event_seq: int | None = None):
        stream.resumed.append((task_id, last_event_seq))
        stream.error = None
        stream.error_after_events = False
        stream.events = [_status("awaiting-completion")]
        return stream.stream_with_reconnect(session_id=session_id, user_input="")

    stream.re_stream = re_stream

    def factory(**kwargs):
        stream.kwargs = kwargs
        return stream

    monkeypatch.setattr(transport_module, "_load_aip_sdk", lambda: (_FakeRpc, factory, _TaskState))
    result = await AipSdkTransport().execute(
        _agent(streaming=True),
        "任务",
        5,
        history=[{"role": "user", "content": "投影背景"}],
    )
    assert result.text == "已经开始"
    assert stream.resumed and stream.resumed[0][0] == "task-1"
    assert _FakeRpc.instances == []


@pytest.mark.asyncio
async def test_stream_failure_after_chunk_does_not_start_rpc(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_sdk(monkeypatch)
    stream = _FakeStream()
    stream.events = [_chunk("已经开始")]
    stream.error = httpx.ConnectError("reset")
    stream.error_after_events = True

    def factory(**kwargs):
        return stream

    monkeypatch.setattr(transport_module, "_load_aip_sdk", lambda: (_FakeRpc, factory, _TaskState))
    with pytest.raises(httpx.ConnectError):
        await AipSdkTransport().execute(_agent(streaming=True), "任务", 5)
    assert _FakeRpc.instances == []


def test_import_persists_streaming_disabled() -> None:
    suffix = secrets.token_hex(2).upper()
    aic = f"1.2.156.3088.1.BUPT.TEST.STRM.OFF.{suffix}"
    with TestClient(app) as test_client:
        response = test_client.post(
            "/api/discovery/import",
            json={
                "aic": aic,
                "name": "无流式外部智能体",
                "endpoint": "https://external-agent.example.com/rpc",
                "transport": "aip",
                "streaming": False,
                "skills": [],
            },
        )
    assert response.status_code == 201
    created = response.json()
    assert created["streaming_enabled"] is False
    assert created["usage_mode"] == "external"


def test_import_without_streaming_flag_stays_off() -> None:
    suffix = secrets.token_hex(2).upper()
    aic = f"1.2.156.3088.1.BUPT.TEST.DFLT.OFF.{suffix}"
    with TestClient(app) as test_client:
        response = test_client.post(
            "/api/discovery/import",
            json={
                "aic": aic,
                "name": "未声明流式",
                "endpoint": "https://external-agent.example.com/rpc",
                "transport": "aip",
                "skills": [],
            },
        )
    assert response.status_code == 201
    assert response.json()["streaming_enabled"] is False


def test_external_dispatch_projects_peer_report(db) -> None:
    invocation = Invocation(id="inv-ext", session_id="sess-ext", query="汇总", status="working")
    db.add(invocation)
    db.commit()
    shared = SharedCollaborationContext(
        root_invocation_id=invocation.id,
        session_id=invocation.session_id,
        overall_objective="汇总路由实验",
    )
    shared.completed_reports.append(
        {
            "agent_id": "peer",
            "agent_name": "文献智能体",
            "task_id": "peer-task",
            "task": "检索路由延迟",
            "result": "多智能体路由延迟实验显示平均延迟从 900 毫秒下降到 420 毫秒",
            "summary": "延迟下降",
        }
    )
    orchestrator = ReliableOrchestrator(db)
    agent = _agent(streaming=True)
    projected = orchestrator._history_for_external_dispatch(
        agent,
        "请汇总多智能体路由延迟实验",
        invocation,
        [{"role": "user", "content": "整段会话历史不应原样外发"}],
        shared,
    )
    joined = "\n".join(item["content"] for item in projected)
    assert "420" in joined
    assert "整段会话历史不应原样外发" not in joined
