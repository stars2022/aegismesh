from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from acps_sdk.aip import TaskCommand, TaskCommandType, TaskState, TextDataItem
from acps_sdk.aip.aip_rpc_model import RpcRequest, RpcRequestParams, RpcResponse
from acps_sdk.aip.aip_rpc_server import CommandHandlers, handle_rpc_request
from starlette.requests import Request

from app.config import get_settings
from app.models import Agent, AipNotification
from app.services.acs import build_acs
from app.services import hosted_aip as hosted_aip_module
from app.services.hosted_aip import (
    HostedAipService,
    post_notification_callback,
    validate_callback_url,
)
from app.services.transport import PartnerResult


class TestRuntime:
    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> PartnerResult:
        return PartnerResult(
            text="fixture result",
            data={"source": "test-runtime"},
            prompt_tokens=4,
            completion_tokens=2,
            llm_calls=1,
        )


class TestStreamingRuntime(TestRuntime):
    async def execute(self, *args, on_text=None, **kwargs) -> PartnerResult:
        if on_text:
            await on_text("第一段")
            await on_text("第二段")
        return PartnerResult(
            text="第一段第二段",
            data={"source": "test-stream-runtime"},
            prompt_tokens=4,
            completion_tokens=2,
            llm_calls=1,
        )


def partner() -> Agent:
    return Agent(
        id="hosted-partner",
        aic="1.2.156.3088.1.1.89AB.123456.7LMNOP.1ABC",
        name="Hosted Partner",
        role="partner",
        description="Hosted test partner",
        transport="openai-compatible",
        active=True,
        health="online",
        input_modes=["text/plain"],
        output_modes=["application/json"],
        security_schemes=["mtls"],
        skills=[{"id": "test", "name": "测试", "description": "执行测试", "tags": ["测试"]}],
        tools=["calculator"],
    )


def request(command: TaskCommandType, task_id: str | None = None) -> dict:
    task_command = TaskCommand(
        id=f"cmd-{command.value}",
        sentAt=datetime.now(timezone.utc).isoformat(),
        senderRole="leader",
        senderId="1.2.156.3088.1.1.89AB.123456.7LMNOP.2ABC",
        sessionId="session-1",
        taskId=task_id,
        command=command,
        dataItems=[TextDataItem(text="执行测试任务")] if command == TaskCommandType.Start else None,
    )
    return RpcRequest(
        id=f"rpc-{command.value}", params=RpcRequestParams(command=task_command)
    ).model_dump(exclude_none=True, mode="json")


async def sdk_server_dispatch(service: HostedAipService, payload: dict) -> RpcResponse:
    body = json.dumps(payload).encode()
    delivered = False

    async def receive() -> dict:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    http_request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/rpc",
            "raw_path": b"/rpc",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "client": ("test", 1234),
            "server": ("test", 80),
        },
        receive,
    )
    return await handle_rpc_request(
        http_request,
        CommandHandlers(),
        local_aic=service.agent.aic,
        identity_binding_enabled=False,
        dispatch_request=service.dispatch,
    )


async def test_hosted_partner_aip_lifecycle(db: Session) -> None:
    agent = partner()
    db.add(agent)
    db.commit()
    service = HostedAipService(db, agent, TestRuntime())

    started = await sdk_server_dispatch(service, request(TaskCommandType.Start))
    assert started.result is not None
    assert started.result.status.state == TaskState.AwaitingCompletion
    assert started.result.products

    repeated = await sdk_server_dispatch(
        service, request(TaskCommandType.Start, started.result.taskId)
    )
    assert repeated.result is not None
    assert repeated.result.taskId == started.result.taskId

    completed = await sdk_server_dispatch(
        service, request(TaskCommandType.Complete, started.result.taskId)
    )
    assert completed.result is not None
    assert completed.result.status.state == TaskState.Completed

    canceled_after_completion = await sdk_server_dispatch(
        service, request(TaskCommandType.Cancel, started.result.taskId)
    )
    assert canceled_after_completion.result is not None
    assert canceled_after_completion.result.status.state == TaskState.Completed


async def test_hosted_partner_streams_runtime_deltas(db: Session) -> None:
    agent = partner()
    db.add(agent)
    db.commit()
    service = HostedAipService(db, agent, TestStreamingRuntime())
    payload = request(TaskCommandType.Start)
    payload["method"] = "stream"
    payload["params"] = {"message": payload["params"]["command"]}

    frames = [
        json.loads(chunk.decode().removeprefix("data: "))
        async for chunk in service.sse_stream(payload)
    ]
    events = [frame["result"]["eventData"] for frame in frames]
    chunks = [event for event in events if event["type"] == "product-chunk"]

    assert [item["product"]["dataItems"][0]["text"] for item in chunks[:2]] == [
        "第一段",
        "第二段",
    ]
    assert chunks[-1]["lastChunk"] is True
    assert events[-1]["type"] == "task-result"


async def test_hosted_tasks_are_scoped_to_authenticated_peer(db: Session) -> None:
    agent = partner()
    db.add(agent)
    db.commit()
    owner = HostedAipService(db, agent, TestRuntime(), owner_peer_aic="peer-a")
    other = HostedAipService(db, agent, TestRuntime(), owner_peer_aic="peer-b")

    started = await owner.dispatch(
        RpcRequest.model_validate(request(TaskCommandType.Start, "shared-task"))
    )
    assert started.result is not None

    denied = await other.dispatch(
        RpcRequest.model_validate(request(TaskCommandType.Get, "shared-task"))
    )
    assert denied.result is None
    assert denied.error is not None
    assert denied.error.message == "Task not found"

    other_started = await other.dispatch(
        RpcRequest.model_validate(request(TaskCommandType.Start, "shared-task"))
    )
    assert other_started.result is not None
    owner_task = owner._task_row("shared-task")
    other_task = other._task_row("shared-task")
    assert owner_task is not None and other_task is not None
    assert owner_task.task_id != other_task.task_id


async def test_notifications_are_scoped_and_tokens_are_redacted(db: Session) -> None:
    agent = partner()
    db.add(agent)
    db.add(
        AipNotification(
            id="notif-owned",
            agent_id=agent.id,
            owner_peer_aic="peer-a",
            task_id="task-owned",
            url="https://callback.example.com/result",
            token="sensitive-token",
        )
    )
    db.commit()
    owner = HostedAipService(db, agent, TestRuntime(), owner_peer_aic="peer-a")
    other = HostedAipService(db, agent, TestRuntime(), owner_peer_aic="peer-b")
    payload = {
        "jsonrpc": "2.0",
        "method": "notification/get",
        "id": "get-1",
        "params": {"taskId": "task-owned"},
    }

    visible = await owner.handle_notification("get", payload)
    hidden = await other.handle_notification("get", payload)
    assert visible["result"][0]["token"] == ""
    assert hidden["result"] == []


def test_callback_validation_requires_allowlisted_public_https(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(
        settings,
        "aip_notification_allowed_origins",
        ["https://callback.example.com"],
    )
    monkeypatch.setattr(
        hosted_aip_module.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("8.8.8.8", 443))],
    )
    validate_callback_url("https://callback.example.com/result")

    monkeypatch.setattr(
        hosted_aip_module.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))],
    )
    with pytest.raises(ValueError, match="私有"):
        validate_callback_url("https://callback.example.com/result")
    with pytest.raises(ValueError, match="白名单"):
        validate_callback_url("https://untrusted.example.com/result")


async def test_callback_connection_uses_the_validated_pinned_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(
        settings,
        "aip_notification_allowed_origins",
        ["https://callback.example.com"],
    )
    resolutions = 0

    def resolve(*_args, **_kwargs):
        nonlocal resolutions
        resolutions += 1
        address = "8.8.8.8" if resolutions == 1 else "127.0.0.1"
        return [(2, 1, 6, "", (address, 443))]

    class Reader:
        async def readline(self):
            return b"HTTP/1.1 204 No Content\r\n"

    class Writer:
        def write(self, _data):
            return None

        async def drain(self):
            return None

        def close(self):
            return None

        async def wait_closed(self):
            return None

    connected: dict[str, object] = {}

    async def open_connection(**kwargs):
        connected.update(kwargs)
        return Reader(), Writer()

    monkeypatch.setattr(hosted_aip_module.socket, "getaddrinfo", resolve)
    monkeypatch.setattr(hosted_aip_module.asyncio, "open_connection", open_connection)

    await post_notification_callback(
        "https://callback.example.com/result",
        "safe-token",
        "{}",
    )
    assert resolutions == 1
    assert connected["host"] == "8.8.8.8"
    assert connected["server_hostname"] == "callback.example.com"


def test_generated_acs_validates_with_sdk(db: Session) -> None:
    from acps_sdk.acs import AgentCapabilitySpec

    agent = partner()
    db.add(agent)
    db.commit()
    payload = build_acs(agent, "https://example.com/aip/hosted-partner/rpc")
    parsed = AgentCapabilitySpec.model_validate(payload)
    assert parsed.aic == agent.aic
    assert parsed.end_points[0].transport == "JSONRPC"
