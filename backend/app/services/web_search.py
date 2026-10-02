from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ProviderConfig, WebSearchConfig
from .provider_secrets import decrypt_api_key, resolve_api_key
from .model_budget import metered_post
from .source_pages import remember_sources


WEB_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "检索互联网来源及剩余次数。evidence_status=link_only 仅代表标题/链接命中，不是正文证据；需要内容时用 read_web_page 读取原始来源。search_budget.remaining 为0时停止检索，缺少证据如实标注。",
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
    try:
        parts = urlsplit(provider.base_url)
        return (parts.scheme == "https" and parts.hostname == "api.deepseek.com"
                and parts.port in (None, 443) and not parts.username and not parts.password)
    except ValueError:
        return False


class DeepSeekWebSearch:
    def __init__(
        self,
        provider: ProviderConfig,
        cache: dict[str, dict[str, Any]] | None = None,
        *,
        timeout_seconds: float | None = None,
        max_results: int | None = None,
        model: str | None = None,
        budget_scope: str = "default",
    ) -> None:
        self.provider = provider
        self.cache = cache if cache is not None else {}
        self.timeout_seconds = timeout_seconds
        self.max_results = max_results
        self.model = model
        self.budget_scope = budget_scope

    async def __call__(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query 不能为空")
        if len(query) > 1_000:
            raise ValueError("query 过长")
        cache_key = f"{self.provider.id}:{' '.join(query.casefold().split())}"
        cached = self.cache.get(cache_key)
        if cached is not None:
            remember_sources(self.cache, self.budget_scope, cached.get("sources") or [])
            return {
                **cached,
                "cached": True,
                "_usage": {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0},
            }

        settings = get_settings()
        endpoint = f"{settings.deepseek_search_base_url.rstrip('/')}/messages"
        if not supports_deepseek_search(self.provider) or not supports_deepseek_search(
            ProviderConfig(base_url=endpoint, active=True)
        ):
            raise RuntimeError("DeepSeek 搜索必须使用独立配置的官方 HTTPS 供应商")
        body = {
            "model": self.model or settings.deepseek_search_model,
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
                timeout=self.timeout_seconds or settings.web_search_timeout_seconds,
                follow_redirects=False,
            ) as client:
                response = await metered_post(client, endpoint, headers=headers, json=body, provider_id=self.provider.id)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            raise search_http_error(exc.response.status_code) from exc
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
                if not _public_url(url) or url in seen:
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
                    source["snippet"] = snippets[url][:3000]
                elif isinstance(item.get("snippet"), str) and item["snippet"].strip():
                    source["snippet"] = item["snippet"][:3000]
                sources.append(source)

        if not found_result_block:
            raise RuntimeError("联网检索未返回结构化结果")
        limit = self.max_results or settings.web_search_max_results
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
        result = annotate_evidence(result)
        remember_sources(self.cache, self.budget_scope, result["sources"])
        self.cache[cache_key] = result
        return result


def search_http_error(status: int) -> RuntimeError:
    message = {
        401: "搜索密钥无效，请在后台更新",
        402: "搜索账户额度不足，请检查余额",
        403: "搜索服务拒绝访问，请检查账户权限",
        429: "搜索服务限流，请稍后重试或配置独立密钥",
    }.get(status, f"联网搜索服务返回 HTTP {status}")
    return RuntimeError(message)


def _query(arguments: dict[str, Any]) -> str:
    value = arguments.get("query")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("query 不能为空")
    if len(value) > 1000:
        raise ValueError("query 过长")
    return value.strip()


def _public_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parts = urlsplit(value)
        return bool(parts.scheme in ("http", "https") and parts.hostname
                    and not parts.username and not parts.password)
    except ValueError:
        return False


def annotate_evidence(result: dict[str, Any]) -> dict[str, Any]:
    """Describe returned evidence, without treating unstructured model prose as sources."""
    raw_sources = result.get("sources") or []
    if not isinstance(raw_sources, list):
        raise RuntimeError("检索来源格式无效")
    sources = [{**source, "evidence_status": (
        "search_excerpt" if isinstance(source.get("snippet"), str) and source["snippet"].strip()
        else "link_only"
    )} for source in raw_sources if isinstance(source, dict)]
    excerpts = sum(source["evidence_status"] == "search_excerpt" for source in sources)
    return {**result, "sources": sources, "evidence": {
        "indexed_sources": len(sources), "sources_with_excerpt": excerpts,
        "notice": ("本次未取得可引用来源，不能补造文献或最新消息。" if not sources else
                   "检索返回有限摘录，不等于阅读全文；核实方法、题录或日期须有相应原文证据。" if excerpts else
                   "只取得标题和链接，未取得正文；不能据此补写文献方法、作者或最新事件。"),
    }}


def parse_exa_response(body: str) -> list[dict[str, str]]:
    """Accept MCP JSON or SSE; never promote unstructured model prose to sources."""
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
        for frame in re.split(r"\r?\n\r?\n", body):
            data = "\n".join(line[5:].lstrip() for line in frame.splitlines() if line.startswith("data:"))
            if not data:
                continue
            try:
                candidate = json.loads(data)
            except ValueError:
                continue
            if isinstance(candidate, dict) and candidate.get("id") == 1:
                payload = candidate
                break
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError("Exa 搜索未返回有效 MCP 结果")
    result = payload.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        raise RuntimeError("Exa 搜索失败，请检查额度、密钥或稍后重试")
    structured = result.get("structuredContent")
    items = structured.get("results") if isinstance(structured, dict) else None
    if isinstance(items, list):
        sources = [
            {out_key: item[in_key] for out_key, in_key in (
                ("url", "url"), ("title", "title"), ("published_at", "publishedDate"), ("snippet", "text")
            ) if isinstance(item.get(in_key), str)}
            for item in items if isinstance(item, dict) and _public_url(item.get("url"))
        ]
        if items and not sources:
            raise RuntimeError("Exa 搜索未返回可引用来源")
        for source in sources:
            for field in ("snippet", "title"):
                if field in source:
                    source[field] = source[field][:3000]
        return list({source["url"]: source for source in sources}.values())
    blocks = result.get("content")
    text = "\n".join(block["text"] for block in blocks
                     if isinstance(block, dict) and isinstance(block.get("text"), str)) if isinstance(blocks, list) else ""
    sources = []
    for entry in re.split(r"(?m)^Title: *", text)[1:]:
        lines = entry.splitlines()
        url = next((line[4:].strip() for line in lines if line.startswith("URL:")), "")
        if not _public_url(url) or any(source["url"] == url for source in sources):
            continue
        source = {"title": lines[0].strip(), "url": url}
        published = next((line[10:].strip() for line in lines if line.startswith("Published:")), "")
        if published:
            source["published_at"] = published
        source["snippet"] = "\n".join(line for line in lines[1:]
                                      if not line.startswith(("URL:", "Published:", "Author:"))).strip()[:3000]
        sources.append(source)
    if not sources:
        raise RuntimeError("Exa 搜索未返回可引用来源，不能将普通文本当作检索结果")
    return sources


class ExaWebSearch:
    def __init__(self, config: WebSearchConfig) -> None:
        self.config = config

    async def __call__(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _query(arguments)
        headers = {"Accept": "application/json, text/event-stream", "User-Agent": "AegisMesh/0.1"}
        if self.config.exa_api_key_ciphertext:
            headers["x-api-key"] = decrypt_api_key(self.config.exa_api_key_ciphertext)
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "web_search_exa", "arguments": {
                "query": query, "type": "auto", "numResults": self.config.max_results,
                "livecrawl": "fallback", "contextMaxCharacters": 12000,
            },
        }}
        try:
            async with httpx.AsyncClient(timeout=self.config.timeout_seconds, follow_redirects=False) as client:
                async with client.stream("POST", "https://mcp.exa.ai/mcp", headers=headers, json=payload) as response:
                    response.raise_for_status()
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 512_000:
                            raise RuntimeError("Exa 搜索结果过大，请缩小查询范围")
            sources = parse_exa_response(body.decode("utf-8"))
        except httpx.HTTPStatusError as exc:
            raise search_http_error(exc.response.status_code) from exc
        except (httpx.HTTPError, UnicodeError) as exc:
            raise RuntimeError("Exa 搜索连接失败或超时") from exc
        return {"query": query, "sources": sources[:self.config.max_results],
                "truncated": len(sources) > self.config.max_results,
                "_usage": {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0}}


SearchHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


def configured_search(
    db: Session, inference_provider: ProviderConfig | None,
    cache: dict[str, dict[str, Any]], *, config: WebSearchConfig | None = None,
    budget_scope: str = "default",
    max_queries: int | None = None,
) -> SearchHandler | None:
    if max_queries is not None and (type(max_queries) is not int or not 0 <= max_queries <= 20):
        raise ValueError("任务检索上限无效")
    config = config or db.get(WebSearchConfig, 1)
    legacy = config is None or config.backend == "legacy"
    if legacy:
        if not supports_deepseek_search(inference_provider):
            return None
        handler: SearchHandler = DeepSeekWebSearch(inference_provider, cache, budget_scope=budget_scope)
        if max_queries is None:
            return handler
    elif config.backend == "disabled":
        return None
    elif config.backend == "exa":
        handler = ExaWebSearch(config)
    elif config.backend == "deepseek":
        provider = db.get(ProviderConfig, config.deepseek_provider_id)
        if not supports_deepseek_search(provider):
            async def unavailable(_: dict[str, Any]) -> dict[str, Any]:
                raise RuntimeError("独立 DeepSeek 搜索供应商不可用，请检查后台配置")
            return unavailable
        handler = DeepSeekWebSearch(
            provider,
            timeout_seconds=config.timeout_seconds,
            max_results=config.max_results,
            model=provider.default_model,
        )
    else:
        raise RuntimeError("搜索服务配置无效")
    # A wire/task limit can tighten the saved administrator limit, never raise it.
    limit = config.max_queries if config else 8
    if max_queries is not None:
        limit = min(limit, max_queries)
    backend = config.backend if config else "legacy"
    selected_provider = config.deepseek_provider_id if config and not legacy else inference_provider.id if inference_provider else ""
    max_results = config.max_results if config else get_settings().web_search_max_results

    async def search(arguments: dict[str, Any]) -> dict[str, Any]:
        query = _query(arguments)
        budget = cache.setdefault(f"search:budget:{budget_scope}", {"used": 0})
        def budget_status() -> dict[str, int]:
            return {"used": budget["used"], "limit": limit,
                    "remaining": max(0, limit - budget["used"])}
        key = f"search:{backend}:{selected_provider}:{max_results}:{' '.join(query.casefold().split())}"
        if key in cache:
            remember_sources(cache, budget_scope, cache[key].get("sources") or [])
            return {**cache[key], "cached": True,
                    "search_budget": budget_status(),
                    "_usage": {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0}}
        if budget["used"] >= limit:
            return {"status": "budget_exhausted", "query": query, "sources": [],
                    "message": "当前智能体已用完检索次数，未发起新搜索。请根据已有来源作答，将缺少证据的内容标注为未核实。",
                    "search_budget": budget_status(),
                    "_usage": {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0}}
        budget["used"] += 1
        result = annotate_evidence(await handler({"query": query}))
        remember_sources(cache, budget_scope, result["sources"])
        result["search_backend"] = backend
        cache[key] = result
        return {**result, "search_budget": budget_status()}

    return search
