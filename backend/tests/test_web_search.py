from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.models import ProviderConfig
from app.services import web_search as web_search_module
from app.services.web_search import DeepSeekWebSearch, supports_deepseek_search


def provider(base_url: str = "https://api.deepseek.com") -> ProviderConfig:
    return ProviderConfig(
        id="deepseek",
        name="DeepSeek",
        kind="openai-chat",
        base_url=base_url,
        default_model="deepseek-flash",
        active=True,
    )


def test_search_is_only_enabled_for_official_deepseek_endpoint() -> None:
    assert supports_deepseek_search(provider()) is True
    assert supports_deepseek_search(provider("https://models.example.com")) is False


@pytest.mark.asyncio
async def test_deepseek_web_search_returns_structured_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(__import__("json").loads(request.content))
        return httpx.Response(
            200,
            json={
                "usage": {"input_tokens": 12, "output_tokens": 5},
                "content": [
                    {
                        "type": "web_search_tool_result",
                        "content": [
                            {
                                "type": "web_search_result",
                                "url": "https://example.com/report",
                                "title": "报告",
                                "page_age": "2026-09-01",
                            }
                        ],
                    },
                    {
                        "type": "text",
                        "text": "结果",
                        "citations": [
                            {
                                "url": "https://example.com/report",
                                "cited_text": "摘要",
                            }
                        ],
                    },
                ]
            },
        )

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        web_search_module.httpx,
        "AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(web_search_module, "resolve_api_key", lambda _: "secret")
    monkeypatch.setattr(
        web_search_module,
        "get_settings",
        lambda: SimpleNamespace(
            deepseek_search_base_url="https://api.deepseek.com/anthropic/v1",
            deepseek_search_model="deepseek-v4-flash",
            web_search_max_results=8,
            web_search_timeout_seconds=60,
        ),
    )

    result = await DeepSeekWebSearch(provider())({"query": "测试"})

    assert captured["tools"][0]["type"] == "web_search_20250305"
    assert result["sources"] == [
        {
            "url": "https://example.com/report",
            "title": "报告",
            "published_at": "2026-09-01",
            "snippet": "摘要",
            "evidence_status": "search_excerpt",
        }
    ]
    assert result["_usage"] == {
        "llm_calls": 1,
        "prompt_tokens": 12,
        "completion_tokens": 5,
    }
    assert result["evidence"]["sources_with_excerpt"] == 1


@pytest.mark.asyncio
async def test_deepseek_web_search_rejects_prose_only_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        web_search_module.httpx,
        "AsyncClient",
        lambda **_: real_client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"content": [{"type": "text", "text": "猜测"}]})
            )
        ),
    )
    monkeypatch.setattr(web_search_module, "resolve_api_key", lambda _: "secret")
    monkeypatch.setattr(
        web_search_module,
        "get_settings",
        lambda: SimpleNamespace(
            deepseek_search_base_url="https://api.deepseek.com/anthropic/v1",
            deepseek_search_model="deepseek-v4-flash",
            web_search_max_results=8,
            web_search_timeout_seconds=60,
        ),
    )

    with pytest.raises(RuntimeError, match="结构化结果"):
        await DeepSeekWebSearch(provider())({"query": "测试"})
