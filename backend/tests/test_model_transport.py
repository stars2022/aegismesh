from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.models import Agent
from app.services import transport as transport_module
from app.services.tools import ToolRegistry
from app.services.transport import OpenAICompatibleTransport


@pytest.mark.asyncio
async def test_openai_compatible_transport_tracks_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(__import__("json").loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "已完成分析。"}}],
                "usage": {"prompt_tokens": 42, "completion_tokens": 8},
            },
        )

    mock_transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=mock_transport),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
        ),
    )
    agent = Agent(
        id="model-agent",
        aic="aic-model-agent",
        name="Model Agent",
        role="partner",
        description="分析任务",
        skills=[{"id": "analysis", "name": "分析"}],
        tools=["database"],
        model_name="deepseek-chat",
    )

    result = await OpenAICompatibleTransport().execute(agent, "分析销售数据", 5)

    assert captured["model"] == "deepseek-chat"
    assert result.text == "已完成分析。"
    assert result.prompt_tokens == 42
    assert result.completion_tokens == 8
    assert result.llm_calls == 1


@pytest.mark.asyncio
async def test_openai_compatible_transport_streams_deltas(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=(
                'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n'
                'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n'
                'data: [DONE]\n\n'
            ),
            headers={"content-type": "text/event-stream"},
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
        ),
    )
    agent = Agent(
        id="stream-model-agent",
        aic="aic-stream-model-agent",
        name="Stream Model Agent",
        model_name="deepseek-chat",
        streaming_enabled=True,
        tools=[],
    )
    deltas: list[str] = []

    result = await OpenAICompatibleTransport().execute(
        agent, "开始", 5, on_text=deltas.append
    )

    assert deltas == ["第一段", "第二段"]
    assert result.text == "第一段第二段"
    assert result.prompt_tokens == 5
    assert result.completion_tokens == 3


@pytest.mark.asyncio
async def test_leader_receives_coordination_tools_without_harness_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(__import__("json").loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "完成"}}], "usage": {}},
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
        ),
    )
    registry = ToolRegistry()
    for name in ("list_agents", "dispatch_task"):
        registry.register(
            name,
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": name,
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            lambda _arguments: {},
        )
    agent = Agent(
        id="leader",
        aic="aic-leader",
        name="Leader",
        role="leader",
        system_prompt="用户编写的提示词",
        tools=[],
    )

    await OpenAICompatibleTransport().execute(
        agent,
        "开始",
        5,
        harness=False,
        tool_registry=registry,
    )

    assert captured["messages"][0]["content"] == "用户编写的提示词"
    assert [item["function"]["name"] for item in captured["tools"]] == [
        "list_agents",
        "dispatch_task",
    ]


@pytest.mark.asyncio
async def test_openai_compatible_transport_synthesis_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        body = __import__("json").loads(request.content)
        # Call 1: model requests a tool call
        if call_count == 1:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "tool_calls": [
                                    {
                                        "id": "call-1",
                                        "type": "function",
                                        "function": {
                                            "name": "web_search",
                                            "arguments": '{"query":"华为 财报"}',
                                        },
                                    }
                                ]
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                },
            )
        # Call 2: max_rounds reached, model outputs unexecuted DSML calls instead of summary
        if call_count == 2:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '我发现有2025年年度报告的链接。<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">华为 2025 销售收入</｜｜DSML｜｜ parameter>'
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 15, "completion_tokens": 8},
                },
            )
        # Call 3: dedicated synthesis call
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "### 华为公司研究综述\n\n根据公开财报，2024年华为实现全球销售收入超过7000亿元，研发投入占比保持在20%以上。"
                        }
                    }
                ],
                "usage": {"prompt_tokens": 30, "completion_tokens": 20},
            },
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
        ),
    )
    registry = ToolRegistry()
    registry.register(
        "web_search",
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "联网搜索",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
            },
        },
        lambda _args: {"results": [{"title": "华为2024年报", "snippet": "收入稳健增长"}]},
    )
    agent = Agent(
        id="docs_overview",
        aic="aic-docs",
        name="Docs Overview",
        role="partner",
        tools=["web_search"],
    )

    result = await OpenAICompatibleTransport().execute(
        agent,
        "检索华为最新资料并综述",
        5,
        tool_registry=registry,
        max_rounds=1,
    )

    assert call_count == 3
    assert "华为公司研究综述" in result.text
    assert "DSML" not in result.text
    assert len(result.data["tool_executions"]) == 1


@pytest.mark.asyncio
async def test_openai_compatible_transport_streams_reasoning_content_to_controller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.adaptive_deadline import AdaptiveDeadlineController, ProgressPhase

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=(
                'data: {"choices":[{"delta":{"reasoning_content":"让我先仔细思考一下这个问题..."}}]}\n\n'
                'data: {"choices":[{"delta":{"reasoning_content":"进行深入逻辑推导与阶段性分析。"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"这是最终严谨的结论。"}}]}\n\n'
                'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":25}}\n\n'
                'data: [DONE]\n\n'
            ),
            headers={"content-type": "text/event-stream"},
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
            idle_watchdog_timeout_seconds=60.0,
        ),
    )
    agent = Agent(
        id="reasoning-model-agent",
        aic="aic-reasoning-agent",
        name="Reasoning Agent",
        model_name="deepseek-reasoner",
        streaming_enabled=True,
        tools=[],
    )

    controller = AdaptiveDeadlineController("reasoning-task", profile_name="standard")
    assert controller.phase == ProgressPhase.WAITING_FIRST_TOKEN

    deltas: list[str] = []
    result = await OpenAICompatibleTransport().execute(
        agent,
        "思考并回答",
        5,
        on_text=lambda delta: deltas.append(delta),
        controller=controller,
    )

    # Controller received reasoning tokens and transitioned out of waiting
    assert controller.total_tokens > 0
    assert controller.phase == ProgressPhase.GENERATING
    # Answer content is captured
    assert "这是最终严谨的结论。" in result.text
    # Reasoning content is preserved in message data
    assert "让我先仔细思考一下" in (result.data.get("reasoning_content") or "")


@pytest.mark.asyncio
async def test_openai_compatible_transport_tool_calls_with_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.adaptive_deadline import AdaptiveDeadlineController, ProgressPhase

    rounds = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal rounds
        rounds += 1
        if rounds == 1:
            # First round: Model reasons and emits a tool call (no content)
            return httpx.Response(
                200,
                text=(
                    'data: {"choices":[{"delta":{"reasoning_content":"我需要调用计算器计算表达式..."}}]}\n\n'
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"calculator","arguments":"{\\"expression\\": \\"2+2\\"}"}}]}}]}\n\n'
                    'data: [DONE]\n\n'
                ),
                headers={"content-type": "text/event-stream"},
            )
        else:
            # Second round: Model produces final answer
            return httpx.Response(
                200,
                text=(
                    'data: {"choices":[{"delta":{"content":"计算结果为 4。"}}]}\n\n'
                    'data: [DONE]\n\n'
                ),
                headers={"content-type": "text/event-stream"},
            )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            llm_api_base="https://model.example/v1",
            llm_api_key="test-key",
            llm_model="fallback-model",
            idle_watchdog_timeout_seconds=60.0,
        ),
    )
    agent = Agent(
        id="calc-agent",
        aic="aic-calc-agent",
        name="Calc Agent",
        model_name="deepseek-reasoner",
        streaming_enabled=True,
        tools=["calculator"],
    )

    registry = ToolRegistry()
    controller = AdaptiveDeadlineController("tool-reasoning-task", profile_name="standard")

    result = await OpenAICompatibleTransport().execute(
        agent,
        "2+2等于几",
        5,
        tool_registry=registry,
        on_text=lambda _: None,
        controller=controller,
    )

    assert "计算结果为 4。" in result.text
    assert len(result.data.get("tool_executions", [])) == 1
    assert result.data["tool_executions"][0]["name"] == "calculator"


@pytest.mark.asyncio
async def test_openai_responses_transport_streams_reasoning_to_controller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.adaptive_deadline import AdaptiveDeadlineController, ProgressPhase
    from app.services.transport import OpenAIResponsesTransport

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=(
                'event: response.reasoning.delta\ndata: {"type":"response.reasoning.delta","delta":"开始深入推导思考..."}\n\n'
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"最终分析结果已产出。"}\n\n'
                'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":15}}}\n\n'
            ),
            headers={"content-type": "text/event-stream"},
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        transport_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            openai_api_base="https://api.openai.com/v1",
            openai_api_key="test-openai-key",
            openai_model="gpt-4o",
        ),
    )
    agent = Agent(
        id="responses-agent",
        aic="aic-responses-agent",
        name="Responses Agent",
        streaming_enabled=True,
        tools=[],
    )

    controller = AdaptiveDeadlineController("responses-task", profile_name="standard")
    result = await OpenAIResponsesTransport().execute(
        agent,
        "测试 Responses 思考流",
        5,
        on_text=lambda _: None,
        controller=controller,
    )

    assert "最终分析结果已产出。" in result.text
    assert controller.total_tokens > 0
    assert controller.phase == ProgressPhase.GENERATING


