from __future__ import annotations

import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.database import get_db
from app.main import app, prepare_search_config, update_search_settings, delete_provider, require_admin
from app.models import ProviderConfig, WebSearchConfig
from app.schemas import WebSearchUpdate
from app.services import web_search
from app.services.database_transfer import export_database, import_database
from app.services.orchestrator import ReliableOrchestrator
from app.services.provider_secrets import encrypt_api_key, decrypt_api_key


def search_config(**changes):
    return WebSearchConfig(id=1, **{
        "backend": "exa", "deepseek_provider_id": "", "exa_api_key_ciphertext": "",
        "timeout_seconds": 25, "max_results": 2, "max_queries": 2, **changes,
    })


def provider(provider_id="model", base_url="https://opencode.ai/zen/go/v1", **changes):
    return ProviderConfig(id=provider_id, name=provider_id, base_url=base_url, kind="openai-chat",
                          active=True, default_model="test", **changes)


def exa_payload():
    return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text":
        "Title: 官方资料\nURL: https://example.org/report\nPublished: 2026-09-29\nAuthor: N/A\nHighlights:\n可靠资料\n\n"
        "Title: 重复\nURL: https://example.org/report\n重复\n\n"
        "Title: 无效\nURL: javascript:alert(1)\n"}]}}


@pytest.mark.parametrize("sse", [False, True])
def test_parse_exa_json_and_sse(sse):
    body = json.dumps(exa_payload())
    if sse:
        body = ': ping\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ' + body + '\n\n'
    sources = web_search.parse_exa_response(body)
    assert sources == [{"title": "官方资料", "url": "https://example.org/report",
                        "published_at": "2026-09-29", "snippet": "Highlights:\n可靠资料"}]


@pytest.mark.parametrize("result", [
    {"isError": True, "content": [{"text": "secret backend error"}]},
    {"content": [{"text": "猜测而非真实检索"}]},
    {"structuredContent": {"results": [{"url": "javascript:alert(1)"}]}},
])
def test_exa_never_treats_errors_or_prose_as_sources(result):
    with pytest.raises(RuntimeError) as error:
        web_search.parse_exa_response(json.dumps({"result": result}))
    assert "secret" not in str(error.value)


def test_exa_structured_results_and_empty_search():
    assert web_search.parse_exa_response(json.dumps({"result": {"structuredContent": {"results": []}}})) == []
    sources = web_search.parse_exa_response(json.dumps({"result": {"structuredContent": {"results": [
        {"url": "https://example.org", "title": "title", "text": "x" * 5000},
    ]}}}))
    assert len(sources[0]["snippet"]) == 3000


@pytest.mark.parametrize("base_url", ["http://api.deepseek.com", "https://api.deepseek.com.evil.test",
                                      "https://api.deepseek.com:444", "https://name@api.deepseek.com"])
def test_deepseek_search_rejects_untrusted_origins(base_url):
    assert not web_search.supports_deepseek_search(provider(base_url=base_url))


@pytest.mark.asyncio
async def test_exa_is_independent_cached_and_bounded(db, monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        assert request.url == "https://mcp.exa.ai/mcp"
        assert "authorization" not in request.headers and "x-api-key" not in request.headers
        assert request.headers["user-agent"] == "AegisMesh/0.1"
        assert json.loads(request.content)["params"]["name"] == "web_search_exa"
        return httpx.Response(200, json=exa_payload())
    client = httpx.AsyncClient
    monkeypatch.setattr(web_search.httpx, "AsyncClient", lambda **_: client(transport=httpx.MockTransport(respond)))
    model = provider(api_key_ciphertext=encrypt_api_key("model-key-never-send-to-search"))
    db.add_all([model, search_config()])
    db.commit()
    cache = {}
    search = web_search.configured_search(db, model, cache)
    first = await search({"query": "test query"})
    second = await search({"query": " TEST   QUERY "})
    assert first["sources"] == second["sources"]
    assert second["cached"] and len(calls) == 1
    await web_search.configured_search(db, model, cache)({"query": "second query"})
    exhausted = await search({"query": "third query"})
    assert exhausted["status"] == "budget_exhausted"
    assert exhausted["sources"] == []
    assert exhausted["search_budget"] == {"used": 2, "limit": 2, "remaining": 0}
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_search_budget_is_per_branch_but_successful_sources_are_shared(db, monkeypatch):
    db.add(search_config(max_queries=1))
    db.commit()
    calls = AsyncMock(side_effect=lambda args: {"query": args["query"], "sources": [{"url": "https://example.org"}]})
    monkeypatch.setattr(web_search.ExaWebSearch, "__call__", calls)
    cache = {}
    parent = web_search.configured_search(db, provider(), cache, budget_scope="root")
    child = web_search.configured_search(db, provider(), cache, budget_scope="root:child")
    await parent({"query": "parent search"})
    assert (await parent({"query": "extra search"}))["status"] == "budget_exhausted"
    reused = await child({"query": "parent search"})
    assert reused["cached"] and reused["search_budget"]["remaining"] == 1
    result = await child({"query": "child search"})
    assert result["search_budget"] == {"used": 1, "limit": 1, "remaining": 0}
    assert calls.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("status,message", [(401, "密钥无效"), (402, "额度不足"), (429, "限流"), (500, "HTTP 500")])
async def test_search_errors_are_actionable_and_do_not_echo_body(monkeypatch, status, message):
    client = httpx.AsyncClient
    monkeypatch.setattr(web_search.httpx, "AsyncClient", lambda **_: client(transport=httpx.MockTransport(
        lambda _: httpx.Response(status, text="secret internal upstream response"))))
    with pytest.raises(RuntimeError, match=message) as error:
        await web_search.ExaWebSearch(search_config())({"query": "test"})
    assert "secret" not in str(error.value)


@pytest.mark.asyncio
async def test_exa_only_uses_its_own_encrypted_key(monkeypatch):
    client = httpx.AsyncClient
    def respond(request):
        assert request.headers["x-api-key"] == "exa-only-secret"
        assert "authorization" not in request.headers
        return httpx.Response(200, json=exa_payload())
    monkeypatch.setattr(web_search.httpx, "AsyncClient", lambda **_: client(transport=httpx.MockTransport(respond)))
    await web_search.ExaWebSearch(search_config(exa_api_key_ciphertext=encrypt_api_key("exa-only-secret")))({"query": "test"})


@pytest.mark.asyncio
async def test_deepseek_uses_selected_provider_not_inference_key(db, monkeypatch):
    model = provider()
    ds = provider("search-ds", "https://api.deepseek.com", api_key_ciphertext=encrypt_api_key("ds-search-only"))
    db.add_all([model, ds, search_config(backend="deepseek", deepseek_provider_id=ds.id)])
    db.commit()
    seen = []
    async def search(self, arguments):
        seen.append(self.provider.id)
        return {"query": arguments["query"], "sources": []}
    monkeypatch.setattr(web_search.DeepSeekWebSearch, "__call__", search)
    await web_search.configured_search(db, model, {})({"query": "test"})
    assert seen == [ds.id]
    ds.base_url = "https://opencode.ai/zen/go/v1"
    db.commit()
    with pytest.raises(RuntimeError, match="不可用"):
        await web_search.configured_search(db, model, {})({"query": "test"})
    assert seen == ["search-ds"]


def test_legacy_preserved_until_explicitly_configured(db):
    ds = provider("ds", "https://api.deepseek.com")
    assert isinstance(web_search.configured_search(db, ds, {}), web_search.DeepSeekWebSearch)
    assert web_search.configured_search(db, provider(), {}) is None
    db.add(search_config(backend="disabled"))
    db.commit()
    assert web_search.configured_search(db, ds, {}) is None


def test_orchestrator_registers_search_for_opencode(db):
    db.add(search_config())
    db.commit()
    registry = ReliableOrchestrator(db)._runtime_registry(provider())
    assert registry.schemas(["web_search"])[0]["function"]["name"] == "web_search"


def test_settings_preserve_encrypt_and_clear_key(db):
    first = update_search_settings(WebSearchUpdate(backend="exa", exa_api_key="search-secret"), db)
    assert first.exa_key_configured and "search-secret" not in first.model_dump_json()
    ciphertext = db.get(WebSearchConfig, 1).exa_api_key_ciphertext
    assert decrypt_api_key(ciphertext) == "search-secret"
    update_search_settings(WebSearchUpdate(backend="exa", max_results=3), db)
    assert db.get(WebSearchConfig, 1).exa_api_key_ciphertext == ciphertext
    update_search_settings(WebSearchUpdate(backend="exa", clear_exa_api_key=True), db)
    assert not db.get(WebSearchConfig, 1).exa_api_key_ciphertext


def test_cannot_bind_opencode_to_deepseek_search(db):
    db.add(provider())
    db.commit()
    with pytest.raises(HTTPException, match="DeepSeek|deepseek"):
        prepare_search_config(WebSearchUpdate(backend="deepseek", deepseek_provider_id="model"), db)
    assert db.get(WebSearchConfig, 1) is None


def test_bound_search_provider_cannot_be_deleted(db):
    ds = provider("ds", "https://api.deepseek.com")
    db.add_all([ds, search_config(backend="deepseek", deepseek_provider_id=ds.id)])
    db.commit()
    with pytest.raises(HTTPException) as error:
        delete_provider(ds.id, db)
    assert error.value.status_code == 409


def test_draft_test_does_not_save_configuration(db, monkeypatch):
    db.add(search_config(backend="disabled"))
    db.commit()
    mocked = AsyncMock(return_value={"sources": [{"url": "https://example.org", "title": "Result"}]})
    monkeypatch.setattr(web_search.ExaWebSearch, "__call__", mocked)
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app)
        result = client.post("/api/admin/web-search/test", json={"backend": "exa"})
        assert result.status_code == 200, result.text
        assert result.json()["sources"][0]["url"] == "https://example.org"
        assert db.get(WebSearchConfig, 1).backend == "disabled"
        assert client.put("/api/admin/web-search", json={"backend": "exa", "max_queries": 0}).status_code == 422
        assert client.get("/api/admin/web-search").json()["backend"] == "disabled"
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_export_never_contains_search_secret_and_import_is_disabled(db):
    db.add(search_config(exa_api_key_ciphertext=encrypt_api_key("secret")))
    db.commit()
    exported = export_database(db)
    assert "exa_api_key_ciphertext" not in exported["tables"]["web_search_configs"][0]
    exported["tables"]["web_search_configs"][0]["exa_api_key_ciphertext"] = "untrusted"
    import_database(db, exported, "merge")
    config = db.get(WebSearchConfig, 1)
    assert config.backend == "disabled"
    assert decrypt_api_key(config.exa_api_key_ciphertext) == "secret"


def test_search_settings_and_live_test_require_administrator(db):
    override = app.dependency_overrides.pop(require_admin)
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app)
        assert client.get("/api/admin/web-search").status_code == 401
        assert client.put("/api/admin/web-search", json={"backend": "exa"}).status_code == 401
        assert client.post("/api/admin/web-search/test", json={"backend": "exa"}).status_code == 401
    finally:
        app.dependency_overrides[require_admin] = override
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_failed_searches_also_consume_the_execution_budget(db, monkeypatch):
    db.add(search_config(max_queries=1))
    db.commit()
    failure = AsyncMock(side_effect=RuntimeError("搜索服务限流"))
    monkeypatch.setattr(web_search.ExaWebSearch, "__call__", failure)
    search = web_search.configured_search(db, provider(), {})
    with pytest.raises(RuntimeError, match="限流"):
        await search({"query": "test"})
    exhausted = await search({"query": "test"})
    assert exhausted["status"] == "budget_exhausted"
    assert exhausted["search_budget"]["remaining"] == 0
    failure.assert_awaited_once()
