from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import ssl
import time
import uuid
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx

from ..config import get_settings
from ..models import Agent, ProviderConfig
from .prompt import build_system_prompt, effective_tool_names
from .provider_secrets import resolve_api_key
from .tools import ToolRegistry


@dataclass(slots=True)
class PartnerResult:
    text: str
    data: dict[str, Any]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    llm_calls: int = 0


StreamCallback = Callable[[str], Awaitable[None] | None]


async def emit_text(callback: StreamCallback | None, text: str) -> None:
    if not callback or not text:
        return
    result = callback(text)
    if inspect.isawaitable(result):
        await result


def sse_payload(line: str) -> dict[str, Any] | None:
    if not line.startswith("data:"):
        return None
    raw = line[5:].strip()
    if not raw or raw == "[DONE]":
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def tool_usage(output: Any) -> tuple[int, int, int]:
    if not isinstance(output, dict) or not isinstance(output.get("result"), dict):
        return 0, 0, 0
    usage = output["result"].get("_usage")
    if not isinstance(usage, dict):
        return 0, 0, 0
    return (
        int(usage.get("llm_calls") or 0),
        int(usage.get("prompt_tokens") or 0),
        int(usage.get("completion_tokens") or 0),
    )


def format_transport_error(exc: Exception) -> str:
    msg = str(exc).strip()
    exc_name = type(exc).__name__
    if isinstance(exc, httpx.TimeoutException):
        return f"模型服务响应超时 ({exc_name})：服务响应超过时限，请稍后重试"
    if isinstance(exc, httpx.NetworkError):
        return f"网络连接异常 ({exc_name})：无法连接模型服务地址"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        detail = ""
        try:
            detail = exc.response.text[:200]
        except Exception:
            pass
        return f"模型接口异常 HTTP {status}：{detail or msg or '服务暂时不可用'}"
    if msg:
        return msg
    return f"{exc_name}: 运行时异常"


DSML_MARKER_PATTERN = re.compile(r"<[｜|].*?[｜|]>", re.DOTALL)


def has_unexecuted_tool_markers(text: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    return (
        "dsml" in lower
        or "<｜" in text
        or "<|" in text
        or "<tool_call" in lower
        or "</tool_call" in lower
        or "<invoke" in lower
        or "</invoke" in lower
        or "dispatch_task(" in lower
        or "list_agents(" in lower
        or "check_subagent_status(" in lower
        or "fetch_session_history(" in lower
        or '{"name": "dispatch_task"' in lower
        or '{"name":"dispatch_task"' in lower
    )


def clean_model_output(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    cleaned = DSML_MARKER_PATTERN.sub("", cleaned)
    cleaned = re.sub(
        r"</?(?:invoke|parameter|calls|tool_call|function)[^>]*>",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r'name="[^"]*"\s*(?:string="[^"]*")?>', "", cleaned)
    cleaned = re.sub(
        r'```(?:json)?\s*\{\s*"name"\s*:\s*"(?:dispatch_task|list_agents|check_subagent_status|fetch_session_history|web_search|run_swarm_discussion|execute_workflow|canvas_read|canvas_write_section|canvas_append|canvas_history)"[\s\S]*?\}\s*```',
        "",
        cleaned,
    )
    return cleaned.strip()


def make_transport_timeout(timeout_seconds: float) -> httpx.Timeout:
    """
    流式与非流式自适应超时配置：
    - connect: 15.0s (DNS解析与TCP建连，避免无限挂起)
    - read: max(timeout_seconds, 15.0) (等待首包及后续数据，流式每收到一个chunk会自动重置定时器)
    - write: 30.0s (请求体写入)
    - pool: 15.0s (连接池等待)
    """
    return httpx.Timeout(
        connect=15.0,
        read=max(timeout_seconds, 15.0),
        write=30.0,
        pool=15.0,
    )


class PartnerTransport(Protocol):
    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: ProviderConfig | None = None,
        harness: bool = False,
        on_text: StreamCallback | None = None,
    ) -> PartnerResult: ...


class OpenAICompatibleTransport:
    """Hosted Partner runtime for DeepSeek, Qwen, Doubao and compatible chat APIs."""

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: ProviderConfig | None = None,
        harness: bool = False,
        tool_registry: ToolRegistry | None = None,
        max_rounds: int = 4,
        on_text: StreamCallback | None = None,
        controller: Any | None = None,
        **kwargs: Any,
    ) -> PartnerResult:
        settings = get_settings()
        api_key = resolve_api_key(provider) if provider else settings.llm_api_key
        if not api_key:
            raise RuntimeError("请先配置 LLM_API_KEY")

        model = agent.model_name or (provider.default_model if provider else settings.llm_model)
        api_base = provider.base_url if provider else settings.llm_api_base
        started = time.monotonic()
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": build_system_prompt(agent, harness)},
            *(history or []),
            {"role": "user", "content": query},
        ]
        tool_registry = tool_registry or ToolRegistry()
        tool_schemas = tool_registry.schemas(effective_tool_names(agent))
        executions: list[dict[str, Any]] = []
        prompt_tokens = 0
        completion_tokens = 0
        llm_calls = 0
        max_retries = 2
        async with httpx.AsyncClient(timeout=make_transport_timeout(timeout_seconds)) as client:
            for round_index in range(max_rounds + 1):
                if round_index >= max_rounds and executions:
                    if messages and messages[-1].get("role") == "tool":
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    "工具调用已经结束。请只根据上面已经返回的资料回答。"
                                    "有出处就写出处；没有出处就写「未核实」，不要编造文献、数据或调用结果。"
                                    "直接给出正文，不要再调用工具。"
                                ),
                            }
                        )

                body: dict[str, Any] = {
                    "model": model,
                    "messages": messages,
                    "temperature": 0.2,
                }
                if tool_schemas and round_index < max_rounds:
                    body["tools"] = tool_schemas
                    body["tool_choice"] = "auto"
                endpoint = f"{api_base.rstrip('/')}/chat/completions"
                headers = {"Authorization": f"Bearer {api_key}"}

                message: dict[str, Any] = {}
                usage: dict[str, Any] = {}
                for attempt in range(max_retries + 1):
                    try:
                        if on_text and agent.streaming_enabled:
                            body["stream"] = True
                            body["stream_options"] = {"include_usage": True}
                            content_parts: list[str] = []
                            reasoning_parts: list[str] = []
                            streamed_calls: dict[int, dict[str, Any]] = {}
                            async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                                response.raise_for_status()
                                async for line in response.aiter_lines():
                                    event = sse_payload(line)
                                    if not event:
                                        continue
                                    if event.get("usage"):
                                        usage = event["usage"]
                                    choices = event.get("choices") or []
                                    if not choices:
                                        continue
                                    delta = choices[0].get("delta") or {}

                                    # 1. 文本内容增量
                                    text_delta = str(delta.get("content") or "")
                                    if text_delta:
                                        content_parts.append(text_delta)
                                        if not has_unexecuted_tool_markers(text_delta):
                                            await emit_text(on_text, text_delta)

                                    # 2. 思考/推理内容增量 (DeepSeek-R1 / Qwen Thinking / o1/o3 reasoning_content)
                                    reasoning_delta = str(
                                        delta.get("reasoning_content")
                                        or delta.get("reasoning")
                                        or delta.get("thinking")
                                        or delta.get("thought")
                                        or ""
                                    )
                                    if reasoning_delta:
                                        reasoning_parts.append(reasoning_delta)
                                        if controller and hasattr(controller, "record_tokens"):
                                            controller.record_tokens(reasoning_delta)

                                    # 3. 工具调用增量 (参数流式生成，记录 token 进展以防空闲超时)
                                    for item in delta.get("tool_calls") or []:
                                        index = int(item.get("index") or 0)
                                        current = streamed_calls.setdefault(
                                            index,
                                            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                                        )
                                        if item.get("id"):
                                            current["id"] += str(item["id"])
                                        function = item.get("function") or {}
                                        fn_name = str(function.get("name") or "")
                                        fn_args = str(function.get("arguments") or "")
                                        current["function"]["name"] += fn_name
                                        current["function"]["arguments"] += fn_args
                                        tool_chunk = fn_name + fn_args
                                        if tool_chunk and controller and hasattr(controller, "record_tokens"):
                                            controller.record_tokens(tool_chunk)

                            final_text = "".join(content_parts)
                            if not final_text and not streamed_calls and reasoning_parts:
                                final_text = "".join(reasoning_parts)
                            message = {
                                "content": final_text or ("" if streamed_calls else None),
                                "reasoning_content": "".join(reasoning_parts) if reasoning_parts else None,
                                "tool_calls": [streamed_calls[key] for key in sorted(streamed_calls)],
                            }
                        else:
                            if controller and hasattr(controller, "touch_progress"):
                                controller.touch_progress()
                            response = await client.post(endpoint, headers=headers, json=body)
                            response.raise_for_status()
                            if controller and hasattr(controller, "touch_progress"):
                                controller.touch_progress()
                            payload = response.json()
                            usage = payload.get("usage") or {}
                            choices = payload.get("choices") or []
                            if not choices:
                                raise RuntimeError("模型服务未返回结果")
                            message = choices[0].get("message") or {}
                        break
                    except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                        is_retryable = (
                            isinstance(exc, (httpx.TimeoutException, httpx.NetworkError))
                            or (isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {429, 500, 502, 503, 504})
                        )
                        if attempt < max_retries and is_retryable:
                            await asyncio.sleep(0.5 * (2 ** attempt))
                            continue
                        raise RuntimeError(format_transport_error(exc)) from exc
                    except Exception as exc:
                        raise RuntimeError(format_transport_error(exc)) from exc

                llm_calls += 1
                prompt_tokens += int(usage.get("prompt_tokens") or 0)
                completion_tokens += int(usage.get("completion_tokens") or 0)
                tool_calls = message.get("tool_calls") or []
                if not tool_calls:
                    raw_answer = str(message.get("content") or "").strip()
                    answer = clean_model_output(raw_answer)

                    if executions and (has_unexecuted_tool_markers(raw_answer) or len(answer) < 80):
                        if controller and hasattr(controller, "record_synthesizing"):
                            controller.record_synthesizing()
                        tool_summaries = []
                        for exc in executions:
                            e_name = exc.get("name")
                            e_args = exc.get("arguments") or {}
                            e_out = exc.get("output")
                            e_out_str = (
                                json.dumps(e_out, ensure_ascii=False)
                                if isinstance(e_out, (dict, list))
                                else str(e_out)
                            )
                            tool_summaries.append(
                                f"【工具 {e_name} 执行结果】：\n{e_out_str[:1500]}"
                            )
                        summary_context = "\n\n".join(tool_summaries)
                        synth_messages = [
                            {"role": "system", "content": build_system_prompt(agent, harness)},
                            *(history or []),
                            {"role": "user", "content": query},
                            {
                                "role": "user",
                                "content": (
                                    f"协同调研与客观数据检索已就绪：\n\n{summary_context}\n\n"
                                    f"请基于上述客观数据，针对问题“{query}”，直接撰写专业详实、结构严谨的最终分析报告（包含关键指标及出处）。"
                                ),
                            },
                        ]
                        synth_body = {
                            "model": model,
                            "messages": synth_messages,
                            "temperature": 0.3,
                        }
                        for s_attempt in range(max_retries + 1):
                            try:
                                synth_resp = await client.post(endpoint, headers=headers, json=synth_body)
                                synth_resp.raise_for_status()
                                synth_payload = synth_resp.json()
                                synth_usage = synth_payload.get("usage") or {}
                                llm_calls += 1
                                prompt_tokens += int(synth_usage.get("prompt_tokens") or 0)
                                completion_tokens += int(synth_usage.get("completion_tokens") or 0)
                                synth_choices = synth_payload.get("choices") or []
                                if synth_choices:
                                    synth_raw = str((synth_choices[0].get("message") or {}).get("content") or "").strip()
                                    answer = clean_model_output(synth_raw)
                                    if on_text and agent.streaming_enabled and answer:
                                        await emit_text(on_text, answer)
                                break
                            except Exception:
                                if s_attempt >= max_retries:
                                    break
                                await asyncio.sleep(0.5 * (2 ** s_attempt))

                    if not answer:
                        raise RuntimeError("模型结果为空")
                    break
                if round_index >= max_rounds:
                    raise RuntimeError("模型未完成最终汇总")
                messages.append(
                    {
                        "role": "assistant",
                        "content": message.get("content"),
                        "tool_calls": tool_calls,
                    }
                )
                for call in tool_calls:
                    function = call.get("function") or {}
                    name = str(function.get("name") or "")
                    try:
                        arguments = json.loads(function.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        arguments = {}
                    if controller and hasattr(controller, "record_tool_start"):
                        controller.record_tool_start(name, arguments)
                    try:
                        output = tool_registry.execute(name, arguments)
                        if inspect.isawaitable(output):
                            output = await output
                    finally:
                        if controller and hasattr(controller, "record_tool_finish"):
                            controller.record_tool_finish(name, output if "output" in locals() else None)
                    tool_calls_used, tool_prompt_tokens, tool_completion_tokens = tool_usage(output)
                    llm_calls += tool_calls_used
                    prompt_tokens += tool_prompt_tokens
                    completion_tokens += tool_completion_tokens
                    executions.append({"name": name, "arguments": arguments, "output": output})
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.get("id"),
                            "content": json.dumps(output, ensure_ascii=False),
                        }
                    )
            else:
                raise RuntimeError("工具调用轮次超过上限")

        return PartnerResult(
            text=answer,
            data={
                "summary": answer,
                "agent": agent.name,
                "model": model,
                "declared_tools": agent.tools,
                "tool_executions": executions,
                "reasoning_content": message.get("reasoning_content"),
                "mode": "openai-compatible",
                "latency_ms": round((time.monotonic() - started) * 1000, 2),
            },
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            llm_calls=llm_calls,
        )


class _AipStreamUnavailable(Exception):
    """Partner stream endpoint rejected the connection before any product chunk."""


def partner_stream_url(rpc_url: str) -> str:
    """Derive the AIP /stream endpoint that sits beside a /rpc endpoint."""
    return f"{_partner_aip_base(rpc_url)}/stream"


def _partner_aip_base(rpc_url: str) -> str:
    trimmed = rpc_url.rstrip("/")
    if trimmed.endswith("/rpc"):
        return trimmed[:-4]
    return trimmed


CONTEXT_KIND = "aegismesh.context-projection"


def context_document(history: list[dict[str, str]] | None) -> dict[str, Any] | None:
    """Separate background from the current task so a partner can read either."""
    items = [
        {"role": str(message.get("role") or "user"), "content": str(message.get("content") or "").strip()}
        for message in (history or [])
        if str(message.get("content") or "").strip()
    ]
    if not items:
        return None
    return {"kind": CONTEXT_KIND, "items": items}


def compose_aip_user_input(query: str, history: list[dict[str, str]] | None) -> str:
    """Put projected or session context into the single text DataItem AIP can carry."""
    blocks = [
        str(message.get("content") or "").strip()
        for message in (history or [])
        if str(message.get("content") or "").strip()
    ]
    task = (query or "").strip()
    if not blocks:
        return task
    context = "\n\n".join(blocks)
    if not task:
        return context
    return f"{context}\n\n【当前任务】\n{task}"


def build_aip_start_command(
    leader_id: str,
    session_id: str,
    task_text: str,
    history: list[dict[str, str]] | None,
):
    """Task text stays the first item. Context is a second text item plus structured data."""
    try:
        from datetime import datetime, timezone

        from acps_sdk.aip.aip_base_model import (
            StructuredDataItem,
            TaskCommand,
            TaskCommandType,
            TextDataItem,
        )
    except ImportError:
        return None
    items: list[Any] = [TextDataItem(text=task_text or "", metadata={"role": "task"})]
    document = context_document(history)
    if document:
        items.append(
            TextDataItem(
                text="\n\n".join(item["content"] for item in document["items"]),
                metadata={"role": "context", "kind": CONTEXT_KIND},
            )
        )
        items.append(StructuredDataItem(data=document, metadata={"role": "context", "kind": CONTEXT_KIND}))
    return TaskCommand(
        id=f"cmd-{uuid.uuid4()}",
        sentAt=datetime.now(timezone.utc).isoformat(),
        senderRole="leader",
        senderId=leader_id,
        dataItems=items,
        sessionId=session_id,
        command=TaskCommandType.Start,
        taskId=f"task-{uuid.uuid4()}",
    )


async def _start_partner_task(client: Any, command: Any, session_id: str, user_input: str, timeout_seconds: float) -> Any:
    if command is not None and hasattr(client, "_send_request"):
        response = await asyncio.wait_for(client._send_request(command), timeout=timeout_seconds)
        result = getattr(response, "result", None)
        if result is None and isinstance(response, dict):
            result = response.get("result")
        if result is None:
            raise RuntimeError("AIP start 未返回任务")
        return result
    return await asyncio.wait_for(
        client.start_task(session_id=session_id, user_input=user_input),
        timeout=timeout_seconds,
    )


def _load_aip_sdk():
    try:
        from acps_sdk.aip import AipRpcClient, TaskState
        from acps_sdk.aip.aip_stream_client import AipStreamClient
    except ImportError as exc:  # pragma: no cover - environment-specific dependency
        raise RuntimeError("Install the 'aip' extra to use real AIP partners") from exc
    return AipRpcClient, AipStreamClient, TaskState


def _state_value(state: Any) -> str:
    value = getattr(state, "value", state)
    return str(value or "")


def _text_from_items(items: Any) -> str:
    parts: list[str] = []
    for item in items or []:
        if isinstance(item, dict):
            if item.get("type") == "text" and item.get("text"):
                parts.append(str(item["text"]))
            continue
        if getattr(item, "type", None) == "text" and getattr(item, "text", None):
            parts.append(str(item.text))
    return "".join(parts)


def _dump_product(product: Any) -> dict[str, Any]:
    if hasattr(product, "model_dump"):
        return product.model_dump(exclude_none=True)
    return {
        "id": getattr(product, "id", ""),
        "dataItems": [
            {"type": "text", "text": _text_from_items(getattr(product, "dataItems", []))}
        ],
    }


def _aip_ssl_context(endpoint_url: str, settings: Any) -> ssl.SSLContext | None:
    if not endpoint_url.startswith("https://"):
        return None
    context = ssl.create_default_context()
    if settings.aip_ca_file and os.path.exists(settings.aip_ca_file):
        try:
            context.load_verify_locations(cafile=settings.aip_ca_file)
        except Exception:
            pass
    if (
        settings.aip_cert_file
        and settings.aip_key_file
        and os.path.exists(settings.aip_cert_file)
        and os.path.exists(settings.aip_key_file)
    ):
        context.load_cert_chain(settings.aip_cert_file, settings.aip_key_file)
    return context


def _stream_endpoint_missing(exc: Exception) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in {404, 405, 501}
    return isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.RemoteProtocolError))


class AipSdkTransport:
    """Outbound AIP adapter: stream when the partner declares it, otherwise poll RPC."""

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: ProviderConfig | None = None,
        harness: bool = False,
        on_text: StreamCallback | None = None,
        controller: Any | None = None,
    ) -> PartnerResult:
        if not agent.endpoint_url:
            raise ValueError(f"AIP endpoint is missing for {agent.name}")
        settings = get_settings()
        if not settings.leader_aic:
            raise RuntimeError("请先配置可信注册签发的 LEADER_AIC")
        rpc_client_cls, stream_client_cls, task_state = _load_aip_sdk()
        user_input = compose_aip_user_input(query, history)
        session_id = session_id or f"session-{uuid.uuid4()}"
        command = build_aip_start_command(settings.leader_aic, session_id, query, history)
        ssl_context = _aip_ssl_context(agent.endpoint_url, settings)
        identity_binding = bool(settings.aip_identity_binding_enabled)
        client_kwargs = {
            "leader_id": settings.leader_aic,
            "ssl_context": ssl_context,
            "expected_partner_aic": agent.aic,
            "identity_binding_enabled": identity_binding,
        }
        if agent.streaming_enabled:
            stream_client = stream_client_cls(
                partner_stream_url=partner_stream_url(agent.endpoint_url),
                partner_rpc_url=agent.endpoint_url,
                **client_kwargs,
            )
            try:
                try:
                    return await self._consume_stream(
                        stream_client,
                        session_id=session_id,
                        user_input=user_input,
                        command=command,
                        history=history,
                        timeout_seconds=timeout_seconds,
                        on_text=on_text,
                        controller=controller,
                    )
                except _AipStreamUnavailable:
                    pass
            finally:
                await stream_client.close()
        rpc_client = rpc_client_cls(partner_url=agent.endpoint_url, **client_kwargs)
        try:
            return await self._consume_rpc(
                rpc_client,
                task_state,
                agent=agent,
                session_id=session_id,
                user_input=user_input,
                command=command,
                timeout_seconds=timeout_seconds,
                poll_interval=settings.aip_poll_interval_seconds,
                controller=controller,
            )
        finally:
            await rpc_client.close()

    async def _consume_stream(
        self,
        client: Any,
        *,
        session_id: str,
        user_input: str,
        timeout_seconds: float,
        on_text: StreamCallback | None,
        controller: Any | None,
        command: Any = None,
        history: list[dict[str, str]] | None = None,
    ) -> PartnerResult:
        started = time.monotonic()
        received_chunk = False
        completed = False
        product_text: dict[str, str] = {}
        product_order: list[str] = []
        final_task: Any = None
        state = ""
        task_id = getattr(command, "taskId", "") or ""
        last_seq: int | None = None
        reconnects = 0
        structured = command is not None and context_document(history) and hasattr(client, "open_stream")
        iterator = (
            client.open_stream(command).__aiter__()
            if structured
            else client.stream_with_reconnect(session_id=session_id, user_input=user_input).__aiter__()
        )
        while True:
            try:
                while True:
                    remaining = timeout_seconds - (time.monotonic() - started)
                    if remaining <= 0:
                        raise TimeoutError(f"AIP task timed out after {timeout_seconds}s")
                    try:
                        event = await asyncio.wait_for(iterator.__anext__(), timeout=remaining)
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError as exc:
                        raise TimeoutError(f"AIP task timed out after {timeout_seconds}s") from exc
                    payload = getattr(getattr(event, "result", None), "eventData", None)
                    if payload is None:
                        continue
                    kind = getattr(payload, "type", "")
                    task_id = getattr(payload, "taskId", None) or task_id
                    seq = getattr(getattr(event, "result", None), "eventSeq", None)
                    if isinstance(seq, int):
                        last_seq = seq
                    if kind == "product-chunk":
                        received_chunk = True
                        chunk = _text_from_items(getattr(getattr(payload, "product", None), "dataItems", []))
                        product_id = getattr(getattr(payload, "product", None), "id", None) or "product"
                        if product_id not in product_order:
                            product_order.append(product_id)
                        if getattr(payload, "append", False):
                            product_text[product_id] = product_text.get(product_id, "") + chunk
                        elif chunk:
                            product_text[product_id] = chunk
                        elif product_id not in product_text:
                            product_text[product_id] = ""
                        if chunk:
                            await emit_text(on_text, chunk)
                            if controller and hasattr(controller, "record_tokens"):
                                controller.record_tokens(chunk)
                            if controller and hasattr(controller, "record_aip_progress"):
                                controller.record_aip_progress("working", has_chunk=True)
                    elif kind == "task-status-update":
                        state = _state_value(getattr(getattr(payload, "status", None), "state", ""))
                        if controller and hasattr(controller, "record_aip_progress"):
                            controller.record_aip_progress(state, has_chunk=False)
                        if state == "awaiting-completion" and not completed and task_id:
                            completed = True
                            try:
                                final_task = await client.complete(task_id=task_id, session_id=session_id)
                                state = _state_value(getattr(getattr(final_task, "status", None), "state", state))
                            except Exception:
                                pass
                        elif state in {"failed", "rejected", "canceled"}:
                            raise RuntimeError(f"AIP task ended in {state}")
                    elif kind == "task-result":
                        final_task = payload
                        state = _state_value(getattr(getattr(payload, "status", None), "state", state))
                        task_id = getattr(payload, "taskId", None) or task_id
                break
            except Exception as exc:
                retriable = isinstance(
                    exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadError, httpx.RemoteProtocolError)
                )
                if (
                    structured
                    and retriable
                    and received_chunk
                    and task_id
                    and reconnects < 3
                    and hasattr(client, "re_stream")
                ):
                    reconnects += 1
                    await asyncio.sleep(0.2 * reconnects)
                    iterator = client.re_stream(
                        task_id=task_id, session_id=session_id, last_event_seq=last_seq
                    ).__aiter__()
                    continue
                if not received_chunk and _stream_endpoint_missing(exc):
                    raise _AipStreamUnavailable(str(exc)) from exc
                raise
        accumulated = "\n".join(product_text[key] for key in product_order if product_text.get(key)).strip()
        return self._result_from_task(
            final_task,
            state=state,
            task_id=task_id,
            mode="aip-stream",
            preferred_text=accumulated,
        )

    async def _await_notification(
        self,
        *,
        agent: Agent,
        task: Any,
        session_id: str,
        timeout_seconds: float,
        started: float,
    ) -> Any | None:
        """Subscribe to partner notifications. Return a terminal task, or None to keep polling."""
        if not getattr(agent, "notification_enabled", False):
            return None
        settings = get_settings()
        public = (settings.public_base_url or "").rstrip("/")
        task_id = getattr(task, "taskId", "") or ""
        if not public or not task_id:
            return None
        import secrets

        from .aip_notify import notification_inbox

        try:
            from acps_sdk.aip.aip_base_model import TaskResult
            from acps_sdk.aip.aip_notification_client import AipNotificationClient
        except ImportError:
            return None
        token = secrets.token_urlsafe(24)
        future = notification_inbox.register(task_id, token)
        identity_binding = bool(settings.aip_identity_binding_enabled)
        client = None
        try:
            client = AipNotificationClient(
                partner_url=_partner_aip_base(agent.endpoint_url),
                leader_id=settings.leader_aic,
                ssl_context=_aip_ssl_context(agent.endpoint_url, settings),
                expected_partner_aic=agent.aic,
                identity_binding_enabled=identity_binding,
            )
            config = await client.set_config(
                task_id=task_id,
                callback_url=f"{public}/api/aip/notifications/callback",
                token=token,
            )
            if not config.id:
                return None
            await client.start_notification(
                task_id=task_id,
                config_id=config.id,
                session_id=session_id,
            )
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                return None
            payload = await asyncio.wait_for(future, timeout=remaining)
        except Exception:
            return None
        finally:
            notification_inbox.discard(task_id)
            if client is not None:
                await client.close()
        try:
            parsed = TaskResult.model_validate(payload)
        except Exception:
            return None
        if _state_value(parsed.status.state) in {"accepted", "working"}:
            return None
        return parsed

    async def _consume_rpc(
        self,
        client: Any,
        task_state: Any,
        *,
        agent: Agent,
        session_id: str,
        user_input: str,
        timeout_seconds: float,
        poll_interval: float,
        controller: Any | None,
        command: Any = None,
    ) -> PartnerResult:
        started = time.monotonic()
        last_products_len = 0
        task = await _start_partner_task(client, command, session_id, user_input, timeout_seconds)
        if controller and hasattr(controller, "record_aip_progress"):
            controller.record_aip_progress(_state_value(task.status.state), has_chunk=False)
        notified = await self._await_notification(
            agent=agent,
            task=task,
            session_id=session_id,
            timeout_seconds=timeout_seconds,
            started=started,
        )
        if notified is not None:
            task = notified
        while _state_value(task.status.state) in {_state_value(task_state.Accepted), _state_value(task_state.Working)}:
            if time.monotonic() - started > timeout_seconds:
                raise TimeoutError(f"AIP task timed out after {timeout_seconds}s")
            await asyncio.sleep(poll_interval)
            task = await client.get_task(task_id=task.taskId, session_id=session_id)
            if controller and hasattr(controller, "record_aip_progress"):
                curr_products = len(task.products or [])
                has_new = curr_products > last_products_len
                controller.record_aip_progress(_state_value(task.status.state), has_chunk=has_new)
                last_products_len = curr_products
        state = _state_value(task.status.state)
        if state == _state_value(task_state.AwaitingInput):
            prompt_text = _text_from_items(getattr(task.status, "dataItems", []))
            if not prompt_text:
                prompt_text = _text_from_items(getattr(task, "dataItems", []))
            return PartnerResult(
                text=prompt_text,
                data={"task_id": task.taskId, "state": "awaiting-input", "mode": "aip-direct-rpc"},
            )
        if state == _state_value(task_state.AwaitingCompletion):
            try:
                task = await client.complete_task(task_id=task.taskId, session_id=session_id)
                state = _state_value(task.status.state)
            except Exception:
                pass
        if state not in {_state_value(task_state.Completed), _state_value(task_state.AwaitingCompletion)}:
            raise RuntimeError(f"AIP task ended in {state}")
        return self._result_from_task(task, state=state, task_id=task.taskId, mode="aip-direct-rpc")

    @staticmethod
    def _result_from_task(
        task: Any,
        *,
        state: str,
        task_id: str,
        mode: str,
        preferred_text: str = "",
    ) -> PartnerResult:
        if state == "awaiting-input":
            prompt = _text_from_items(getattr(getattr(task, "status", None), "dataItems", []))
            if not prompt and task is not None:
                prompt = _text_from_items(getattr(task, "dataItems", []))
            return PartnerResult(
                text=preferred_text or prompt,
                data={"task_id": task_id, "state": "awaiting-input", "mode": mode},
            )
        if state in {"failed", "rejected", "canceled"}:
            raise RuntimeError(f"AIP task ended in {state}")
        products: list[dict[str, Any]] = []
        text_parts: list[str] = []
        for product in getattr(task, "products", None) or []:
            products.append(_dump_product(product))
            text_parts.append(_text_from_items(getattr(product, "dataItems", [])))
        if not text_parts and task is not None and getattr(getattr(task, "status", None), "dataItems", None):
            text_parts.append(_text_from_items(task.status.dataItems))
        final_text = preferred_text or "\n".join(part for part in text_parts if part).strip()
        if not final_text and not products:
            raise RuntimeError("AIP 外部智能体未返回有效文本或产品数据")
        resolved_id = task_id or getattr(task, "taskId", "") or ""
        return PartnerResult(
            text=final_text,
            data={"products": products, "task_id": resolved_id, "mode": mode},
        )


class OpenAIResponsesTransport:
    """Hosted Partner runtime using the OpenAI Responses API."""

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: ProviderConfig | None = None,
        harness: bool = False,
        tool_registry: ToolRegistry | None = None,
        max_rounds: int = 4,
        on_text: StreamCallback | None = None,
        controller: Any | None = None,
        **kwargs: Any,
    ) -> PartnerResult:
        settings = get_settings()
        api_key = resolve_api_key(provider) if provider else settings.openai_api_key
        if not api_key:
            raise RuntimeError("请先配置 OPENAI_API_KEY")
        model = agent.model_name or (provider.default_model if provider else settings.openai_model)
        api_base = provider.base_url if provider else settings.openai_api_base
        registry = tool_registry or ToolRegistry()
        chat_schemas = registry.schemas(effective_tool_names(agent))
        tools = [
            {
                "type": "function",
                "name": item["function"]["name"],
                "description": item["function"]["description"],
                "parameters": item["function"]["parameters"],
            }
            for item in chat_schemas
        ]
        instructions = build_system_prompt(agent, harness)
        input_items: list[dict[str, Any]] = [*(history or []), {"role": "user", "content": query}]
        executions: list[dict[str, Any]] = []
        prompt_tokens = completion_tokens = llm_calls = 0
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=make_transport_timeout(timeout_seconds)) as client:
            for round_index in range(max_rounds + 1):
                body: dict[str, Any] = {
                    "model": model,
                    "instructions": instructions,
                    "input": input_items,
                }
                if tools and round_index < max_rounds:
                    body["tools"] = tools
                endpoint = f"{api_base.rstrip('/')}/responses"
                headers = {"Authorization": f"Bearer {api_key}"}
                if on_text and agent.streaming_enabled:
                    body["stream"] = True
                    streamed_text: list[str] = []
                    output: list[dict[str, Any]] = []
                    usage: dict[str, Any] = {}
                    async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            event = sse_payload(line)
                            if not event:
                                continue
                            event_type = str(event.get("type") or "")
                            if event_type == "response.output_text.delta":
                                delta = str(event.get("delta") or "")
                                streamed_text.append(delta)
                                await emit_text(on_text, delta)
                            elif event_type in (
                                "response.function_call_arguments.delta",
                                "response.reasoning.delta",
                                "response.thought.delta",
                            ):
                                delta = str(event.get("delta") or "")
                                if delta and controller and hasattr(controller, "record_tokens"):
                                    controller.record_tokens(delta)
                            elif event_type == "response.output_item.done":
                                item = event.get("item")
                                if isinstance(item, dict):
                                    output.append(item)
                            elif event_type == "response.completed":
                                completed = event.get("response") or {}
                                usage = completed.get("usage") or {}
                                if not output:
                                    output = completed.get("output") or []
                    payload = {"output": output, "output_text": "".join(streamed_text), "usage": usage}
                else:
                    if controller and hasattr(controller, "touch_progress"):
                        controller.touch_progress()
                    response = await client.post(endpoint, headers=headers, json=body)
                    response.raise_for_status()
                    if controller and hasattr(controller, "touch_progress"):
                        controller.touch_progress()
                    payload = response.json()
                llm_calls += 1
                usage = payload.get("usage") or {}
                prompt_tokens += int(usage.get("input_tokens") or 0)
                completion_tokens += int(usage.get("output_tokens") or 0)
                output = payload.get("output") or []
                calls = [item for item in output if item.get("type") == "function_call"]
                if calls:
                    if round_index >= max_rounds:
                        raise RuntimeError("模型未完成最终汇总")
                    input_items.extend(output)
                    for call in calls:
                        try:
                            arguments = json.loads(call.get("arguments") or "{}")
                        except json.JSONDecodeError:
                            arguments = {}
                        name = str(call.get("name") or "")
                        if controller and hasattr(controller, "record_tool_start"):
                            controller.record_tool_start(name, arguments)
                        try:
                            tool_output = registry.execute(name, arguments)
                            if inspect.isawaitable(tool_output):
                                tool_output = await tool_output
                        finally:
                            if controller and hasattr(controller, "record_tool_finish"):
                                controller.record_tool_finish(name, tool_output if "tool_output" in locals() else None)
                        tool_calls_used, tool_prompt_tokens, tool_completion_tokens = tool_usage(
                            tool_output
                        )
                        llm_calls += tool_calls_used
                        prompt_tokens += tool_prompt_tokens
                        completion_tokens += tool_completion_tokens
                        executions.append({"name": name, "arguments": arguments, "output": tool_output})
                        input_items.append(
                            {
                                "type": "function_call_output",
                                "call_id": call.get("call_id"),
                                "output": json.dumps(tool_output, ensure_ascii=False),
                            }
                        )
                    continue
                answer = str(payload.get("output_text") or "").strip()
                if not answer:
                    answer = "\n".join(
                        str(block.get("text") or "")
                        for item in output
                        if item.get("type") == "message"
                        for block in (item.get("content") or [])
                        if block.get("type") == "output_text"
                    ).strip()
                if not answer:
                    raise RuntimeError("OpenAI Responses 未返回文本结果")
                break
            else:
                raise RuntimeError("工具调用轮次超过上限")
        return PartnerResult(
            text=answer,
            data={
                "summary": answer,
                "agent": agent.name,
                "model": model,
                "tool_executions": executions,
                "mode": "openai-responses",
                "latency_ms": round((time.monotonic() - started) * 1000, 2),
            },
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            llm_calls=llm_calls,
        )


class AnthropicTransport:
    """Hosted Partner runtime using the Anthropic Messages API."""

    async def execute(
        self,
        agent: Agent,
        query: str,
        timeout_seconds: float,
        session_id: str | None = None,
        history: list[dict[str, str]] | None = None,
        provider: ProviderConfig | None = None,
        harness: bool = False,
        tool_registry: ToolRegistry | None = None,
        max_rounds: int = 4,
        on_text: StreamCallback | None = None,
        controller: Any | None = None,
        **kwargs: Any,
    ) -> PartnerResult:
        settings = get_settings()
        api_key = resolve_api_key(provider) if provider else settings.anthropic_api_key
        if not api_key:
            raise RuntimeError("请先配置 ANTHROPIC_API_KEY")
        model = agent.model_name or (provider.default_model if provider else settings.anthropic_model)
        api_base = provider.base_url if provider else settings.anthropic_api_base
        registry = tool_registry or ToolRegistry()
        tools = [
            {
                "name": item["function"]["name"],
                "description": item["function"]["description"],
                "input_schema": item["function"]["parameters"],
            }
            for item in registry.schemas(effective_tool_names(agent))
        ]
        messages: list[dict[str, Any]] = [*(history or []), {"role": "user", "content": query}]
        system = build_system_prompt(agent, harness)
        executions: list[dict[str, Any]] = []
        prompt_tokens = completion_tokens = llm_calls = 0
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=make_transport_timeout(timeout_seconds)) as client:
            for round_index in range(max_rounds + 1):
                body: dict[str, Any] = {
                    "model": model,
                    "max_tokens": 4096,
                    "system": system,
                    "messages": messages,
                }
                if tools and round_index < max_rounds:
                    body["tools"] = tools
                endpoint = f"{api_base.rstrip('/')}/messages"
                headers = {
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }
                if on_text and agent.streaming_enabled:
                    body["stream"] = True
                    blocks: dict[int, dict[str, Any]] = {}
                    usage: dict[str, Any] = {}
                    async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            event = sse_payload(line)
                            if not event:
                                continue
                            event_type = str(event.get("type") or "")
                            if event_type == "message_start":
                                usage.update((event.get("message") or {}).get("usage") or {})
                            elif event_type == "message_delta":
                                usage.update(event.get("usage") or {})
                            elif event_type == "content_block_start":
                                index = int(event.get("index") or 0)
                                block = event.get("content_block") or {}
                                blocks[index] = dict(block)
                                if block.get("type") == "tool_use":
                                    blocks[index]["_input_json"] = ""
                            elif event_type == "content_block_delta":
                                index = int(event.get("index") or 0)
                                delta = event.get("delta") or {}
                                block = blocks.setdefault(index, {"type": "text", "text": ""})
                                delta_type = delta.get("type")
                                if delta_type == "text_delta":
                                    text_delta = str(delta.get("text") or "")
                                    block["text"] = str(block.get("text") or "") + text_delta
                                    await emit_text(on_text, text_delta)
                                elif delta_type == "input_json_delta":
                                    partial_json = str(delta.get("partial_json") or "")
                                    block["_input_json"] = str(block.get("_input_json") or "") + partial_json
                                    if partial_json and controller and hasattr(controller, "record_tokens"):
                                        controller.record_tokens(partial_json)
                                elif delta_type == "thinking_delta":
                                    thinking_text = str(delta.get("thinking") or "")
                                    block["thinking"] = str(block.get("thinking") or "") + thinking_text
                                    if thinking_text and controller and hasattr(controller, "record_tokens"):
                                        controller.record_tokens(thinking_text)
                    content = []
                    for index in sorted(blocks):
                        block = blocks[index]
                        raw_input = block.pop("_input_json", "")
                        if block.get("type") == "tool_use" and raw_input:
                            try:
                                block["input"] = json.loads(raw_input)
                            except json.JSONDecodeError:
                                block["input"] = {}
                        content.append(block)
                    payload = {"content": content, "usage": usage}
                else:
                    response = await client.post(endpoint, headers=headers, json=body)
                    response.raise_for_status()
                    payload = response.json()
                llm_calls += 1
                usage = payload.get("usage") or {}
                prompt_tokens += int(usage.get("input_tokens") or 0)
                completion_tokens += int(usage.get("output_tokens") or 0)
                content = payload.get("content") or []
                calls = [item for item in content if item.get("type") == "tool_use"]
                if calls:
                    if round_index >= max_rounds:
                        raise RuntimeError("模型未完成最终汇总")
                    messages.append({"role": "assistant", "content": content})
                    results = []
                    for call in calls:
                        arguments = call.get("input") if isinstance(call.get("input"), dict) else {}
                        name = str(call.get("name") or "")
                        if controller and hasattr(controller, "record_tool_start"):
                            controller.record_tool_start(name, arguments)
                        try:
                            tool_output = registry.execute(name, arguments)
                            if inspect.isawaitable(tool_output):
                                tool_output = await tool_output
                        finally:
                            if controller and hasattr(controller, "record_tool_finish"):
                                controller.record_tool_finish(name, tool_output if "tool_output" in locals() else None)
                        tool_calls_used, tool_prompt_tokens, tool_completion_tokens = tool_usage(
                            tool_output
                        )
                        llm_calls += tool_calls_used
                        prompt_tokens += tool_prompt_tokens
                        completion_tokens += tool_completion_tokens
                        executions.append({"name": name, "arguments": arguments, "output": tool_output})
                        results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": call.get("id"),
                                "content": json.dumps(tool_output, ensure_ascii=False),
                            }
                        )
                    messages.append({"role": "user", "content": results})
                    continue
                answer = "\n".join(
                    str(item.get("text") or "")
                    for item in content
                    if item.get("type") == "text"
                ).strip()
                if not answer:
                    raise RuntimeError("Anthropic 未返回文本结果")
                break
            else:
                raise RuntimeError("工具调用轮次超过上限")
        return PartnerResult(
            text=answer,
            data={
                "summary": answer,
                "agent": agent.name,
                "model": model,
                "tool_executions": executions,
                "mode": "anthropic",
                "latency_ms": round((time.monotonic() - started) * 1000, 2),
            },
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            llm_calls=llm_calls,
        )


class TransportRegistry:
    def __init__(self, additions: dict[str, PartnerTransport] | None = None) -> None:
        self._transports: dict[str, PartnerTransport] = {
            "openai-compatible": OpenAICompatibleTransport(),
            "openai-chat": OpenAICompatibleTransport(),
            "openai-responses": OpenAIResponsesTransport(),
            "anthropic": AnthropicTransport(),
            "aip-rpc": AipSdkTransport(),
        }
        self._transports.update(additions or {})

    def get(self, name: str) -> PartnerTransport:
        if name not in self._transports:
            raise ValueError(f"Unsupported partner transport: {name}")
        return self._transports[name]
