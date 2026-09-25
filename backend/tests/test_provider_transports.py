from __future__ import annotations

from types import SimpleNamespace

import httpx

from app.models import Agent
from app.services import transport as transport_module
from app.services.transport import AnthropicTransport, OpenAIResponsesTransport


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class FakeClient:
    def __init__(self, responses: list[dict]) -> None:
        self.responses = responses

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def post(self, *_args, **_kwargs) -> FakeResponse:
        return FakeResponse(self.responses.pop(0))


async def test_openai_responses_text(monkeypatch) -> None:
    responses = [{"output_text": "完成", "output": [], "usage": {"input_tokens": 3, "output_tokens": 2}}]
    monkeypatch.setattr(transport_module.httpx, "AsyncClient", lambda **_: FakeClient(responses))
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            openai_api_key="key", openai_api_base="https://api.openai.com/v1", openai_model="gpt"
        ),
    )
    agent = Agent(id="openai", aic="aic-openai", name="OpenAI", model_name="gpt")

    result = await OpenAIResponsesTransport().execute(agent, "任务", 5)

    assert result.text == "完成"
    assert result.prompt_tokens == 3
    assert result.completion_tokens == 2


async def test_anthropic_tool_call(monkeypatch) -> None:
    responses = [
        {
            "content": [{"type": "tool_use", "id": "tool-1", "name": "calculator", "input": {"expression": "2+3"}}],
            "usage": {"input_tokens": 4, "output_tokens": 1},
        },
        {
            "content": [{"type": "text", "text": "结果是 5"}],
            "usage": {"input_tokens": 2, "output_tokens": 3},
        },
    ]
    monkeypatch.setattr(transport_module.httpx, "AsyncClient", lambda **_: FakeClient(responses))
    monkeypatch.setattr(
        transport_module,
        "get_settings",
        lambda: SimpleNamespace(
            anthropic_api_key="key", anthropic_api_base="https://api.anthropic.com/v1", anthropic_model="claude"
        ),
    )
    agent = Agent(
        id="anthropic", aic="aic-anthropic", name="Anthropic", model_name="claude", tools=["calculator"]
    )

    result = await AnthropicTransport().execute(agent, "计算", 5)

    assert result.text == "结果是 5"
    assert result.llm_calls == 2
    assert result.data["tool_executions"][0]["output"]["result"] == 5


async def test_openai_responses_stream(monkeypatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=(
                'data: {"type":"response.output_text.delta","delta":"正在"}\n\n'
                'data: {"type":"response.output_text.delta","delta":"处理"}\n\n'
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2},"output":[]}}\n\n'
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
            openai_api_key="key", openai_api_base="https://api.openai.com/v1", openai_model="gpt"
        ),
    )
    agent = Agent(id="openai-stream", aic="aic-openai-stream", name="OpenAI", streaming_enabled=True)
    deltas: list[str] = []

    result = await OpenAIResponsesTransport().execute(agent, "任务", 5, on_text=deltas.append)

    assert deltas == ["正在", "处理"]
    assert result.text == "正在处理"


async def test_anthropic_stream(monkeypatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=(
                'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"流式"}}\n\n'
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完成"}}\n\n'
                'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'
                'data: {"type":"message_stop"}\n\n'
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
            anthropic_api_key="key", anthropic_api_base="https://api.anthropic.com/v1", anthropic_model="claude"
        ),
    )
    agent = Agent(id="anthropic-stream", aic="aic-anthropic-stream", name="Anthropic", streaming_enabled=True)
    deltas: list[str] = []

    result = await AnthropicTransport().execute(agent, "任务", 5, on_text=deltas.append)

    assert deltas == ["流式", "完成"]
    assert result.text == "流式完成"
