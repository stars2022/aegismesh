from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import inspect
import time
import logging
import socket
import ssl
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from typing import AsyncIterator
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)
_tracked_notification_tasks: set[asyncio.Task] = set()

from sqlalchemy import select
from sqlalchemy.orm import Session

from acps_sdk.aip import (
    Product,
    StructuredDataItem,
    TaskCommandType,
    TaskResult,
    TaskState,
    TaskStatus,
    TextDataItem,
)
from acps_sdk.aip.aip_notification_model import (
    NOTIFICATION_TOKEN_HEADER,
    NotificationConfig,
    NotificationDeleteRequest,
    NotificationGetRequest,
    NotificationRequest,
    NotificationStartRequest,
)
from acps_sdk.aip.aip_rpc_model import JSONRPCError, JSONRPCResponse, RpcRequest, RpcResponse
from acps_sdk.aip.aip_stream_model import (
    ProductChunkEvent,
    StreamEventData,
    StreamRequest,
    StreamResponse,
    TaskStatusUpdateEvent,
)

from ..config import get_settings
from ..models import Agent, AipNotification, HostedTask, ProviderConfig
from .transport import PartnerTransport, TransportRegistry


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_rpc_dump(response: JSONRPCResponse) -> dict:
    return response.model_dump(by_alias=True, exclude_none=True, mode="json")


class HostedAipService:
    """Persistent business handler dispatched by the official AIP RPC server."""

    def __init__(
        self,
        db: Session,
        agent: Agent,
        runtime: PartnerTransport | None = None,
        owner_peer_aic: str = "",
    ) -> None:
        self.db = db
        self.agent = agent
        self.owner_peer_aic = owner_peer_aic
        provider = db.get(ProviderConfig, agent.model_provider) if agent.transport == "provider" else None
        self.provider = provider
        self.runtime = runtime or TransportRegistry().get(provider.kind if provider else agent.transport)

    async def handle(self, payload: dict) -> dict:
        request = RpcRequest.model_validate(payload)
        response = await self.dispatch(request)
        return response.model_dump(by_alias=True, exclude_none=True, mode="json")

    async def sse_stream(self, payload: dict) -> AsyncIterator[bytes]:
        """AIP v2 流式方式：执行任务并以 SSE 帧推送状态与产出物分块。"""
        request = StreamRequest.model_validate(payload)
        command = request.params.message
        task_id = command.taskId or f"task-{uuid.uuid4()}"
        seq = 0

        async def frame(event) -> bytes:
            nonlocal seq
            seq += 1
            response = StreamResponse(
                id=request.id, result=StreamEventData(eventSeq=seq, eventData=event)
            )
            return f"data: {response.model_dump_json(exclude_none=True)}\n\n".encode()

        task = self._task_row(task_id)
        if task is None:
            task = HostedTask(
                task_id=self._storage_task_id(task_id),
                external_task_id=task_id,
                agent_id=self.agent.id,
                owner_peer_aic=self.owner_peer_aic,
                session_id=command.sessionId or "",
                state=TaskState.Accepted.value,
                query=self._text(command.dataItems),
                command_history=[command.model_dump(exclude_none=True, mode="json")],
            )
            self.db.add(task)
            self.db.commit()

        def event_base() -> dict:
            return {
                "id": f"evt-{uuid.uuid4().hex[:10]}",
                "sentAt": utc_iso(),
                "senderRole": "partner",
                "senderId": self.agent.aic,
            }

        yield await frame(
            TaskStatusUpdateEvent(
                **event_base(), taskId=task_id, status=self._status(task, TaskState.Working)
            )
        )
        chunk_queue: asyncio.Queue[str] = asyncio.Queue()

        async def on_text(delta: str) -> None:
            await chunk_queue.put(delta)

        run_task = asyncio.create_task(self._run(task, on_text=on_text))
        streamed_text = ""
        append = False
        try:
            while not run_task.done() or not chunk_queue.empty():
                getter = asyncio.create_task(chunk_queue.get())
                try:
                    done, _ = await asyncio.wait({run_task, getter}, return_when=asyncio.FIRST_COMPLETED)
                    if getter in done:
                        delta = getter.result()
                        streamed_text += delta
                        product = Product(
                            id=f"product-{task.external_task_id or task.task_id}",
                            name="Agent result",
                            dataItems=[TextDataItem(text=delta)],
                        )
                        yield await frame(
                            ProductChunkEvent(
                                **event_base(),
                                taskId=task_id,
                                product=product,
                                append=append,
                                lastChunk=False,
                            )
                        )
                        append = True
                    else:
                        getter.cancel()
                        with suppress(asyncio.CancelledError):
                            await getter
                except Exception:
                    if not getter.done():
                        getter.cancel()
                        with suppress(asyncio.CancelledError):
                            await getter
                    raise
            await run_task
        except asyncio.CancelledError:
            if not run_task.done():
                run_task.cancel()
                with suppress(asyncio.CancelledError):
                    await run_task
            raise
        finally:
            if not run_task.done():
                run_task.cancel()
                with suppress(asyncio.CancelledError):
                    await run_task
        self.db.commit()
        result = self._result(task)
        text = task.result_text or ""
        if text and not streamed_text:
            chunk_size = 200
            for start in range(0, len(text), chunk_size):
                product = Product(
                    id=f"product-{task.external_task_id or task.task_id}",
                    name="Agent result",
                    dataItems=[TextDataItem(text=text[start : start + chunk_size])],
                )
                yield await frame(
                    ProductChunkEvent(
                        **event_base(),
                        taskId=task_id,
                        product=product,
                        append=start > 0,
                        lastChunk=start + chunk_size >= len(text),
                    )
                )
        elif streamed_text:
            product = Product(
                id=f"product-{task.external_task_id or task.task_id}",
                name="Agent result",
                dataItems=[TextDataItem(text="")],
            )
            yield await frame(
                ProductChunkEvent(
                    **event_base(), taskId=task_id, product=product, append=True, lastChunk=True
                )
            )
        yield await frame(
            TaskStatusUpdateEvent(**event_base(), taskId=task_id, status=result.status)
        )
        yield await frame(result)

    async def handle_notification(self, action: str, payload: dict) -> dict:
        """AIP v2 通知方式：notification/set|get|delete|start 的托管实现。"""
        if action == "set":
            request = NotificationRequest.model_validate(payload)
            validate_callback_url(request.params.url)
            row = AipNotification(
                id=f"notif-{uuid.uuid4().hex[:12]}",
                agent_id=self.agent.id,
                owner_peer_aic=self.owner_peer_aic,
                task_id=request.params.taskId,
                url=request.params.url,
                token=request.params.token,
            )
            self.db.add(row)
            self.db.commit()
            stored = NotificationConfig(id=row.id, url=row.url, token=row.token, taskId=row.task_id)
            return json_rpc_dump(
                JSONRPCResponse(id=request.id, result=stored.model_dump(by_alias=True, exclude_none=True, mode="json"))
            )
        if action == "get":
            request = NotificationGetRequest.model_validate(payload)
            rows = self._notification_rows(request.params.taskId, getattr(request.params, "notificationConfigId", None))
            configs = [
                NotificationConfig(id=row.id, url=row.url, token="", taskId=row.task_id).model_dump(
                    by_alias=True, exclude_none=True, mode="json"
                )
                for row in rows
            ]
            return json_rpc_dump(JSONRPCResponse(id=request.id, result=configs))
        if action == "delete":
            request = NotificationDeleteRequest.model_validate(payload)
            for row in self._notification_rows(request.params.taskId, getattr(request.params, "notificationConfigId", None)):
                self.db.delete(row)
            self.db.commit()
            return json_rpc_dump(JSONRPCResponse(id=request.id, result=True))
        if action == "start":
            request = NotificationStartRequest.model_validate(payload)
            command = request.params.message
            config_id = (command.commandParams or {}).get("notificationConfigId")
            task_id = command.taskId or f"task-{uuid.uuid4()}"
            row = None
            if config_id:
                row = self.db.scalar(
                    select(AipNotification).where(
                        AipNotification.id == config_id,
                        AipNotification.agent_id == self.agent.id,
                        AipNotification.owner_peer_aic == self.owner_peer_aic,
                        AipNotification.task_id == task_id,
                    )
                )
                if row is None:
                    return json_rpc_dump(
                        JSONRPCResponse(
                            id=request.id,
                            error=JSONRPCError(
                                code=-32001, message="Notification config not found"
                            ),
                        )
                    )
                validate_callback_url(row.url)
            if self._task_row(task_id) is not None:
                return json_rpc_dump(
                    JSONRPCResponse(
                        id=request.id,
                        error=JSONRPCError(code=-32001, message="Task not found"),
                    )
                )
            task = HostedTask(
                task_id=self._storage_task_id(task_id),
                external_task_id=task_id,
                agent_id=self.agent.id,
                owner_peer_aic=self.owner_peer_aic,
                session_id=command.sessionId or "",
                state=TaskState.Accepted.value,
                query=self._text(command.dataItems),
                command_history=[command.model_dump(exclude_none=True, mode="json")],
            )
            self.db.add(task)
            self.db.commit()
            if row is not None:
                config = {"url": row.url, "token": row.token}
                agent_id = self.agent.id
                ntask = asyncio.create_task(
                    run_notification_task(agent_id, task.task_id, config)
                )
                _tracked_notification_tasks.add(ntask)
                ntask.add_done_callback(_tracked_notification_tasks.discard)
            return json_rpc_dump(JSONRPCResponse(id=request.id, result=True))
        return json_rpc_dump(JSONRPCResponse(id=None, error=JSONRPCError(code=-32601, message="Method not found")))

    def _notification_rows(self, task_id: str, config_id: str | None) -> list[AipNotification]:
        query = self.db.query(AipNotification).filter(
            AipNotification.agent_id == self.agent.id,
            AipNotification.owner_peer_aic == self.owner_peer_aic,
            AipNotification.task_id == task_id,
        )
        if config_id:
            query = query.filter(AipNotification.id == config_id)
        return list(query.all())

    async def dispatch(self, request: RpcRequest) -> RpcResponse:
        command = request.params.command
        task_id = command.taskId or f"task-{uuid.uuid4()}"
        task = self._task_row(task_id)

        if command.command == TaskCommandType.Start:
            if task:
                self._append_history(task, command)
            else:
                task = HostedTask(
                    task_id=self._storage_task_id(task_id),
                    external_task_id=task_id,
                    agent_id=self.agent.id,
                    owner_peer_aic=self.owner_peer_aic,
                    session_id=command.sessionId or "",
                    state=TaskState.Accepted.value,
                    query=self._text(command.dataItems),
                    command_history=[command.model_dump(exclude_none=True, mode="json")],
                )
                self.db.add(task)
                await self._run(task)
        else:
            if not task:
                return RpcResponse(
                    id=request.id,
                    error=JSONRPCError(
                        code=-32001,
                        message="Task not found",
                        data={"taskId": task_id},
                    ),
                )
            if command.command == TaskCommandType.Get:
                pass
            elif command.command == TaskCommandType.Complete:
                self._append_history(task, command)
                if task.state == TaskState.AwaitingCompletion.value:
                    self._set_state(task, TaskState.Completed)
            elif command.command == TaskCommandType.Cancel:
                if task.state not in self._terminal_states():
                    self._append_history(task, command)
                    self._set_state(task, TaskState.Canceled)
            elif command.command == TaskCommandType.Continue:
                self._append_history(task, command)
                extra = self._text(command.dataItems)
                if task.state in {
                    TaskState.AwaitingInput.value,
                    TaskState.AwaitingCompletion.value,
                } and extra.strip():
                    task.query = f"{task.query}\n{extra}".strip()
                    await self._run(task)
            else:
                return RpcResponse(
                    id=request.id,
                    error=JSONRPCError(code=-32602, message="Invalid params"),
                )

        self.db.commit()
        assert task is not None
        return RpcResponse(id=request.id, result=self._result(task))

    def _task_row(self, task_id: str) -> HostedTask | None:
        return self.db.scalar(
            select(HostedTask).where(
                HostedTask.external_task_id == task_id,
                HostedTask.agent_id == self.agent.id,
                HostedTask.owner_peer_aic == self.owner_peer_aic,
            )
        )

    def _storage_task_id(self, external_task_id: str) -> str:
        scope = f"{self.agent.id}\0{self.owner_peer_aic}\0{external_task_id}".encode()
        return f"scope-{hashlib.sha256(scope).hexdigest()}"

    async def _run(self, task: HostedTask, on_text=None) -> None:
        started = time.monotonic()
        self._set_state(task, TaskState.Working)
        try:
            kwargs = {"session_id": task.session_id}
            if self.provider:
                kwargs["provider"] = self.provider
            if (
                on_text
                and self.agent.streaming_enabled
                and "on_text" in inspect.signature(self.runtime.execute).parameters
            ):
                kwargs["on_text"] = on_text
            result = await self.runtime.execute(self.agent, task.query, timeout_seconds=30, **kwargs)
            latency_ms = (time.monotonic() - started) * 1000
            task.result_text = result.text
            task.result_data = result.data
            task.prompt_tokens = result.prompt_tokens
            task.completion_tokens = result.completion_tokens
            task.llm_calls = result.llm_calls
            self._record_success(latency_ms)
            self._set_state(task, TaskState.AwaitingCompletion)
        except Exception as exc:
            latency_ms = (time.monotonic() - started) * 1000
            task.result_text = ""
            task.result_data = {"error": str(exc)[:500]}
            self._record_failure(latency_ms)
            self._set_state(task, TaskState.Failed)

    def _status(self, task: HostedTask, state: TaskState | None = None) -> TaskStatus:
        resolved = state or TaskState(task.state)
        status_items = None
        if resolved == TaskState.Failed:
            status_items = [TextDataItem(text="Agent execution failed")]
        return TaskStatus(
            state=resolved,
            stateChangedAt=task.state_changed_at.isoformat(),
            dataItems=status_items,
        )

    def _result(self, task: HostedTask) -> TaskResult:
        state = TaskState(task.state)
        status = self._status(task)
        products = None
        if state in {TaskState.AwaitingCompletion, TaskState.Completed}:
            products = [
                Product(
                    id=f"product-{task.external_task_id or task.task_id}",
                    name="Agent result",
                    dataItems=[
                        TextDataItem(text=task.result_text),
                        StructuredDataItem(data=task.result_data or {}),
                    ],
                )
            ]
        return TaskResult(
            id=f"result-{uuid.uuid4()}",
            sentAt=utc_iso(),
            senderRole="partner",
            senderId=self.agent.aic,
            sessionId=task.session_id,
            taskId=task.external_task_id or task.task_id,
            status=status,
            statusHistory=[status],
            products=products,
            commandHistory=task.command_history,
        )

    def _record_success(self, latency_ms: float) -> None:
        previous = self.agent.request_count
        self.agent.avg_latency_ms = round(
            ((self.agent.avg_latency_ms * previous) + latency_ms) / (previous + 1), 2
        )
        self.agent.request_count += 1
        self.agent.success_count += 1
        self.agent.health = "online"

    def _record_failure(self, latency_ms: float) -> None:
        previous = self.agent.request_count
        self.agent.avg_latency_ms = round(
            ((self.agent.avg_latency_ms * previous) + latency_ms) / (previous + 1), 2
        )
        self.agent.request_count += 1
        self.agent.failure_count += 1
        self.agent.health = "degraded"

    @staticmethod
    def _set_state(task: HostedTask, state: TaskState) -> None:
        task.state = state.value
        task.state_changed_at = datetime.now(timezone.utc)

    @staticmethod
    def _terminal_states() -> set[str]:
        return {
            TaskState.Completed.value,
            TaskState.Failed.value,
            TaskState.Rejected.value,
            TaskState.Canceled.value,
        }

    @staticmethod
    def _append_history(task: HostedTask, command) -> None:
        history = list(task.command_history or [])
        history.append(command.model_dump(exclude_none=True, mode="json"))
        task.command_history = history

    @staticmethod
    def _text(items) -> str:
        return "\n".join(
            item.text for item in (items or []) if getattr(item, "type", "") == "text"
        )


async def run_notification_task(agent_id: str, task_id: str, config: dict) -> None:
    """后台执行托管任务，完成后把 TaskResult 推送到通知回调 URL。"""
    from ..database import SessionLocal

    try:
        result: TaskResult | None = None
        with SessionLocal() as db:
            agent = db.get(Agent, agent_id)
            task = db.get(HostedTask, task_id)
            if agent is None or task is None:
                return
            service = HostedAipService(db, agent, owner_peer_aic=task.owner_peer_aic)
            await service._run(task)
            db.commit()
            result = service._result(task)
        await post_notification_callback(
            config["url"],
            config["token"],
            result.model_dump_json(exclude_none=True),
        )
    except Exception as exc:
        logger.exception(
            "Background notification task failed for agent %s task %s: %s",
            agent_id,
            task_id,
            exc,
        )


def resolve_callback_target(value: str):
    if "\r" in value or "\n" in value:
        raise ValueError("通知回调 URL 格式无效")
    parts = urlsplit(value.strip())
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.fragment
    ):
        raise ValueError("通知回调必须是无用户信息和片段的 HTTPS URL")
    port = parts.port or 443
    origin = f"https://{parts.hostname.lower()}"
    if port != 443:
        origin = f"{origin}:{port}"
    allowed = {
        item.rstrip("/").lower()
        for item in get_settings().aip_notification_allowed_origins
        if item.strip()
    }
    if origin.lower() not in allowed:
        raise ValueError("通知回调来源不在 AIP_NOTIFICATION_ALLOWED_ORIGINS 白名单中")
    try:
        addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("通知回调主机无法解析") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("通知回调不得指向私有、环回、链路本地或保留地址")
    if not addresses:
        raise ValueError("通知回调主机没有可用地址")
    return parts, str(ipaddress.ip_address(addresses[0][4][0]))


def validate_callback_url(value: str) -> None:
    resolve_callback_target(value)


async def post_notification_callback(url: str, token: str, body: str) -> None:
    if "\r" in token or "\n" in token:
        raise ValueError("通知令牌格式无效")
    parts, pinned_ip = resolve_callback_target(url)
    assert parts.hostname is not None
    port = parts.port or 443
    host = parts.hostname
    host_header = f"[{host}]" if ":" in host else host
    if port != 443:
        host_header = f"{host_header}:{port}"
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    body_bytes = body.encode("utf-8")
    request_bytes = (
        f"POST {target} HTTP/1.1\r\n"
        f"Host: {host_header}\r\n"
        f"{NOTIFICATION_TOKEN_HEADER}: {token}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii") + body_bytes
    ssl_context = ssl.create_default_context()
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            host=pinned_ip,
            port=port,
            ssl=ssl_context,
            server_hostname=host,
        ),
        timeout=10,
    )
    try:
        writer.write(request_bytes)
        await asyncio.wait_for(writer.drain(), timeout=10)
        status_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if len(status_line) > 8_192:
            raise RuntimeError("通知回调响应状态行过长")
        parts_status = status_line.decode("ascii", errors="replace").split(" ", 2)
        if len(parts_status) < 2 or not parts_status[1].isdigit():
            raise RuntimeError("通知回调响应无效")
        status_code = int(parts_status[1])
        if status_code < 200 or status_code >= 300:
            raise RuntimeError(f"通知回调返回 HTTP {status_code}")
    finally:
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()
