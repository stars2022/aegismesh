from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import httpx

from ..config import get_settings
from ..models import ProviderConfig
from .provider_secrets import resolve_api_key


WEB_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "检索互联网中的最新信息，返回可引用的来源。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要检索的完整查询"}
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}


def supports_deepseek_search(provider: ProviderConfig | None) -> bool:
    if not provider or not provider.active:
        return False
    hostname = (urlsplit(provider.base_url).hostname or "").lower()
    return hostname == "api.deepseek.com"


class DeepSeekWebSearch:
    def __init__(
        self,
        provider: ProviderConfig,
        cache: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.provider = provider
        self.cache = cache if cache is not None else {}

    async def __call__(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query 不能为空")
        if len(query) > 1_000:
            raise ValueError("query 过长")
        cache_key = f"{self.provider.id}:{' '.join(query.casefold().split())}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {
                **cached,
                "cached": True,
                "_usage": {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0},
            }

        settings = get_settings()
        endpoint = f"{settings.deepseek_search_base_url.rstrip('/')}/messages"
        body = {
            "model": settings.deepseek_search_model,
            "max_tokens": 4096,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"Search the web for: {query.strip()}"}
                    ],
                }
            ],
            "tools": [
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": 5,
                }
            ],
        }
        api_key = resolve_api_key(self.provider)
        headers = {
            "x-api-key": api_key,
            "Authorization": f"Bearer {api_key}",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        try:
            async with httpx.AsyncClient(
                timeout=settings.web_search_timeout_seconds,
                follow_redirects=False,
            ) as client:
                response = await client.post(endpoint, headers=headers, json=body)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError("联网检索服务调用失败") from exc

        blocks = payload.get("content") if isinstance(payload, dict) else None
        if not isinstance(blocks, list):
            raise RuntimeError("联网检索未返回结构化结果")

        snippets: dict[str, str] = {}
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            for citation in block.get("citations") or []:
                if not isinstance(citation, dict):
                    continue
                url = citation.get("url")
                text = citation.get("cited_text")
                if isinstance(url, str) and isinstance(text, str) and url not in snippets:
                    snippets[url] = text

        sources: list[dict[str, str]] = []
        seen: set[str] = set()
        found_result_block = False
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "web_search_tool_result":
                continue
            found_result_block = True
            for item in block.get("content") or []:
                if not isinstance(item, dict) or item.get("type") != "web_search_result":
                    continue
                url = item.get("url")
                if not isinstance(url, str) or not url or url in seen:
                    continue
                seen.add(url)
                source = {"url": url}
                for source_key, item_key in (
                    ("title", "title"),
                    ("published_at", "page_age"),
                ):
                    value = item.get(item_key)
                    if isinstance(value, str) and value:
                        source[source_key] = value
                if snippets.get(url):
                    source["snippet"] = snippets[url]
                sources.append(source)

        if not found_result_block:
            raise RuntimeError("联网检索未返回结构化结果")
        limit = settings.web_search_max_results
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        result = {
            "query": query.strip(),
            "sources": sources[:limit],
            "truncated": len(sources) > limit,
            "_usage": {
                "llm_calls": 1,
                "prompt_tokens": int(usage.get("input_tokens") or 0),
                "completion_tokens": int(usage.get("output_tokens") or 0),
            },
        }
        self.cache[cache_key] = result
        return result
