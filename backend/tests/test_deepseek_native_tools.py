from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import json
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app, delete_provider, prepare_search_config, search_config_read
from app.models import OperationalLog, ProviderConfig, WebSearchConfig
from app.schemas import WebSearchUpdate
from app.services import deepseek_tools, source_pages, web_search
from app.services.model_budget import usage_scope
from app.services.provider_secrets import encrypt_api_key


def provider(key="native-search"):
    return ProviderConfig(id=key, name=key, kind="openai-chat", active=True,
        base_url="https://api.deepseek.com", default_model="ignored-by-native-tools",
        api_key_ciphertext=encrypt_api_key("private-fixture-key"))


def configuration(**changes):
    return WebSearchConfig(id=1, backend="deepseek_native", deepseek_provider_id="native-search",
        timeout_seconds=20, max_results=3, max_queries=changes.get("max_queries", 2))


def successful_search():
    return {"results": [{"url": "https://example.org/paper", "title": "Paper",
        "summary": "Provider search summary", "snippet": "Short snippet", "content": "",
        "date": "2026-10-17T00:00:00Z", "site_name": "Example", "authority": 3,
        "rerank_score": 2.4}]}


def mock_client(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(deepseek_tools.httpx, "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)))


def client(db):
    return deepseek_tools.DeepSeekTools(provider(), sessionmaker(bind=db.get_bind()))


def ledger(db):
    db.expire_all()
    return db.scalars(select(OperationalLog).where(OperationalLog.action == deepseek_tools.ACTION)).all()


@pytest.mark.asyncio
async def test_native_search_is_json_not_a_model_call_and_cache_is_free(db, monkeypatch):
    p = provider()
    config = configuration(max_queries=1)
    db.add_all([p, config]); db.commit()
    sent = []
    def respond(request):
        sent.append(request)
        assert str(request.url) == "https://api.deepseek.com/v1/tools/search"
        assert request.headers["authorization"] == "Bearer private-fixture-key"
        assert "x-api-key" not in request.headers and "anthropic-version" not in request.headers
        assert json.loads(request.content) == {"query": "specific question", "count": 3, "need_content": False}
        return httpx.Response(200, json=successful_search())
    mock_client(monkeypatch, respond)
    cache = {}
    handler = web_search.configured_search(db, None, cache, budget_scope="root")
    with usage_scope("account-owner-fixture", "session-fixture", "call-fixture", sessionmaker(bind=db.get_bind())):
        result = await handler({"query": "specific question"})
    assert result["sources"][0]["evidence_status"] == "search_excerpt"
    assert result["sources"][0]["snippet"] == "Provider search summary"
    assert result["sources"][0]["published_at"] == "2026-10-17T00:00:00Z"
    assert result["_usage"]["llm_calls"] == result["_usage"]["prompt_tokens"] == 0
    assert result["_usage"]["search_requests"] == result["_usage"]["billable_search_requests"] == 1
    assert result["_usage"]["estimated_cost_cny_micros"] == 5000
    child = web_search.configured_search(db, None, cache, budget_scope="child")
    cached = await child({"query": " SPECIFIC  question "})
    assert cached["cached"] and all(value == 0 for value in cached["_usage"].values())
    exhausted = await handler({"query": "different question"})
    assert exhausted["status"] == "budget_exhausted" and len(sent) == 1
    row, = ledger(db)
    assert row.actor == "account-owner-fixture" and row.task_id == "call-fixture"
    assert row.trace_id == "session-fixture" and row.outcome == "success"
    assert "specific question" not in json.dumps(row.detail)
    assert "private-fixture-key" not in json.dumps(row.detail)
    assert "paper" not in json.dumps(row.detail)


@pytest.mark.asyncio
async def test_native_empty_results_are_not_billable_or_invented_evidence(db, monkeypatch):
    mock_client(monkeypatch, lambda _: httpx.Response(200, json={"results": []}))
    native = web_search.DeepSeekNativeWebSearch(provider(), sessionmaker(bind=db.get_bind()))
    result = await native({"query": "empty"})
    assert result["sources"] == []
    assert result["_usage"]["search_requests"] == 1
    assert result["_usage"]["billable_search_requests"] == result["_usage"]["estimated_cost_cny_micros"] == 0
    row, = ledger(db)
    assert row.outcome == "empty" and row.detail["billable"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["", " ", 12, "字" * 129])
async def test_native_invalid_queries_never_dispatch_or_split(db, monkeypatch, query):
    mock_client(monkeypatch, lambda _: pytest.fail("must not send a request"))
    native = web_search.DeepSeekNativeWebSearch(provider(), sessionmaker(bind=db.get_bind()))
    with pytest.raises(ValueError):
        await native({"query": query})
    assert not ledger(db)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 400, 401, 402, 403, 404, 408, 429, 500, 504])
async def test_native_http_failures_are_audited_without_automatic_retry(db, monkeypatch, status):
    sent = []
    def respond(request):
        sent.append(request)
        return httpx.Response(status, json={"error": {"message": "do not disclose private upstream diagnostics"}},
                              headers={"Location": "https://untrusted.example/path"})
    mock_client(monkeypatch, respond)
    with pytest.raises(RuntimeError) as error:
        await client(db).post("search", {"query": "public query"})
    assert "private upstream" not in str(error.value) and len(sent) == 1
    if status == 429:
        assert "按账号" in str(error.value) and "同账号" in str(error.value)
    row, = ledger(db)
    assert row.status_code == status and row.outcome == "failed"
    assert row.detail["billable"] is False and row.detail["estimated_cost_cny_micros"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "cancelled", "malformed", "too_big", "wrong_shape"])
async def test_unknown_outcomes_are_not_reported_as_free(db, monkeypatch, failure):
    def respond(request):
        if failure == "timeout": raise httpx.ReadTimeout("private timeout diagnostic", request=request)
        if failure == "cancelled": raise asyncio.CancelledError()
        if failure == "malformed": return httpx.Response(200, content=b"not-json")
        if failure == "wrong_shape": return httpx.Response(200, json={"content": "model prose is not search"})
        return httpx.Response(200, content=b"x" * (deepseek_tools.MAX_RESPONSE_BYTES + 1))
    mock_client(monkeypatch, respond)
    expected = asyncio.CancelledError if failure == "cancelled" else RuntimeError
    with pytest.raises(expected):
        await client(db).post("search", {"query": "test"})
    row, = ledger(db)
    assert row.outcome == "unknown" and row.detail["billable"] is None
    assert row.detail["estimated_cost_cny_micros"] == 5000


@pytest.mark.asyncio
async def test_daily_admission_is_global_across_keys_and_operations(db, monkeypatch):
    monkeypatch.setattr(deepseek_tools, "get_settings", lambda: SimpleNamespace(deepseek_tools_daily_limit=1))
    sent = []
    def respond(request):
        sent.append(request)
        return httpx.Response(200, json={"results": []})
    mock_client(monkeypatch, respond)
    await client(db).post("search", {"query": "empty counts as an attempt"})
    other_key = deepseek_tools.DeepSeekTools(provider("another-key"), sessionmaker(bind=db.get_bind()))
    with pytest.raises(RuntimeError, match="每日请求上限"):
        await other_key.post("fetch", {"url": "https://example.org/"})
    assert len(sent) == len(ledger(db)) == 1


@pytest.mark.asyncio
async def test_account_rate_limit_is_shared_across_keys_but_search_and_fetch_are_independent(db, monkeypatch):
    stamp = datetime(2026, 10, 17, 2, tzinfo=timezone.utc)
    monkeypatch.setattr(deepseek_tools, "now", lambda: stamp)
    mock_client(monkeypatch, lambda req: httpx.Response(200, json=
        {"content": "page", "title": "page"} if req.url.path.endswith("fetch") else {"results": []}))
    tool = client(db)
    for number in range(5):
        await tool.post("search", {"query": str(number)})
    other = deepseek_tools.DeepSeekTools(provider("same-account-other-key"), sessionmaker(bind=db.get_bind()))
    with pytest.raises(RuntimeError, match="速率保护"):
        await other.post("search", {"query": "six"})
    await other.post("fetch", {"url": "https://example.org/"})
    assert len(ledger(db)) == 6


@pytest.mark.asyncio
async def test_native_fetch_requires_branch_provenance_is_bounded_and_caches_without_billing_twice(db, monkeypatch):
    db.add_all([provider(), configuration()]); db.commit()
    cache = {}
    source_pages.remember_sources(cache, "child", [{"url": "https://example.org/paper"}])
    sent = []
    def respond(request):
        sent.append(request)
        assert str(request.url) == "https://api.deepseek.com/v1/tools/fetch"
        assert json.loads(request.content) == {"url": "https://example.org/paper"}
        return httpx.Response(200, json={"title": "Page title", "content": "untrusted page " * 1000})
    mock_client(monkeypatch, respond)
    monkeypatch.setattr(web_search, "_resolve_public", lambda url: (httpx.URL(url), "93.184.216.34"))
    root = web_search.configured_page_reader(db, cache, "root")
    with pytest.raises(ValueError, match="当前分支"):
        await root({"url": "https://example.org/paper"})
    child = web_search.configured_page_reader(db, cache, "child", max_pages=1)
    first = await child({"url": "https://example.org/paper"})
    assert first["evidence_status"] == "page_excerpt" and first["truncated"]
    assert first["_usage"]["fetch_requests"] == 1
    assert first["_usage"]["estimated_cost_cny_micros"] == 5000
    assert "untrusted page" in first["content"] and len(first["content"]) < 6500
    second = await child({"url": "https://example.org/paper"})
    assert second["cached"] and all(value == 0 for value in second["_usage"].values())
    assert len(sent) == len(ledger(db)) == 1


@pytest.mark.asyncio
async def test_native_fetch_rejects_nonpublic_dns_before_sending_a_paid_request(db, monkeypatch):
    db.add_all([provider(), configuration()]); db.commit()
    cache = {}
    source_pages.remember_sources(cache, "child", [{"url": "https://example.org/paper"}])
    monkeypatch.setattr(web_search, "_resolve_public", lambda _: (_ for _ in ()).throw(ValueError("不得读取内网")))
    mock_client(monkeypatch, lambda _: pytest.fail("no paid fetch"))
    with pytest.raises(ValueError, match="内网"):
        await web_search.configured_page_reader(db, cache, "child")({"url": "https://example.org/paper"})
    assert not ledger(db)


@pytest.mark.asyncio
async def test_native_only_accepts_official_credentials_and_fails_closed_without_audit(db, monkeypatch):
    p = provider(); p.base_url = "https://api.deepseek.com.evil.example"
    mock_client(monkeypatch, lambda _: pytest.fail("must not dispatch"))
    with pytest.raises(RuntimeError, match="官方"):
        await deepseek_tools.DeepSeekTools(p, None).post("search", {"query": "test"})
    with pytest.raises(RuntimeError, match="审计"):
        await deepseek_tools.DeepSeekTools(provider(), None).post("search", {"query": "test"})


def test_native_configuration_is_explicit_protected_and_does_not_replace_existing_backend(db):
    p = provider()
    db.add_all([p, WebSearchConfig(id=1, backend="deepseek", deepseek_provider_id=p.id)]); db.commit()
    draft = prepare_search_config(WebSearchUpdate(backend="deepseek_native", deepseek_provider_id=p.id), db)
    assert draft.backend == "deepseek_native" and db.get(WebSearchConfig, 1).backend == "deepseek"
    assert search_config_read(draft).native_daily_limit == 1000
    db.get(WebSearchConfig, 1).backend = "deepseek_native"; db.commit()
    with pytest.raises(HTTPException) as error:
        delete_provider(p.id, db)
    assert error.value.status_code == 409


def test_native_draft_live_test_reports_request_usage_without_saving(db, monkeypatch):
    db.add_all([provider(), WebSearchConfig(id=1, backend="disabled")]); db.commit()
    mock_client(monkeypatch, lambda _: httpx.Response(200, json=successful_search()))
    app.dependency_overrides[get_db] = lambda: db
    try:
        response = TestClient(app).post("/api/admin/web-search/test", json={
            "backend": "deepseek_native", "deepseek_provider_id": "native-search"})
        assert response.status_code == 200, response.text
        assert response.json()["usage"]["search_requests"] == 1
        assert db.get(WebSearchConfig, 1).backend == "disabled"
        assert len(ledger(db)) == 1
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_deadline_bounds_the_whole_request_and_preserves_unknown_cost(db, monkeypatch):
    async def respond(_):
        await asyncio.sleep(10)
        return httpx.Response(200, json=successful_search())
    mock_client(monkeypatch, respond)
    native = deepseek_tools.DeepSeekTools(provider(), sessionmaker(bind=db.get_bind()), timeout_seconds=0.01)
    with pytest.raises(RuntimeError, match="未自动重试"):
        await native.post("search", {"query": "test"})
    row, = ledger(db)
    assert row.outcome == "unknown" and row.detail["billable"] is None


def test_native_daily_admission_is_atomic_across_independent_connections(tmp_path, monkeypatch):
    monkeypatch.setattr(deepseek_tools, "get_settings", lambda: SimpleNamespace(deepseek_tools_daily_limit=3))
    engine = create_engine(f"sqlite:///{tmp_path / 'admission.db'}", connect_args={"timeout": 5})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    def reserve(index):
        try:
            deepseek_tools.DeepSeekTools(provider(f"key-{index}"), factory)._reserve("search")
            return True
        except RuntimeError as error:
            assert "每日请求上限" in str(error)
            return False
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(reserve, range(8)))
        assert sum(outcomes) == 3
        with factory() as db:
            assert len(ledger(db)) == 3
    finally:
        engine.dispose()
