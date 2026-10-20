from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app import agent_designer_api as designer
from app.database import get_db
from app.main import app, require_admin
from app.account_models import ModelUsage, QuotaBucket
from app.models import Agent, Invocation, OperationalLog, ProviderConfig
from app.services import model_budget, transport
from app.services.provider_secrets import encrypt_api_key


DEFINITION = {"id": "policy-researcher", "name": "政策研究助手", "role": "partner",
              "description": "检索政策并提供可追溯来源", "system_prompt": "只根据可核验来源整理政策，区分事实与推断，不编造数据。",
              "skills": [{"id": "policy-review", "name": "政策研究", "description": "整理政策证据"}],
              "tools": ["web_search"], "structured_io_enabled": False,
              "input_schema": None, "output_schema": None}


@pytest.fixture
def setup_designer(db, monkeypatch):
    provider = ProviderConfig(id="builder-model", name="模型", active=True, kind="openai-chat",
                              base_url="https://model.example/v1", default_model="configured-model",
                              api_key_ciphertext=encrypt_api_key("private-designer-fixture-key"))
    db.add(provider); db.commit()
    app.dependency_overrides[get_db] = lambda: db
    sent = []
    answer = {"definition": DEFINITION}
    def respond(request):
        sent.append(request)
        assert str(request.url) == "https://model.example/v1/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == "configured-model" and body["max_tokens"] == 4096
        assert "tools" not in body
        assert request.headers["authorization"] == "Bearer private-designer-fixture-key"
        return httpx.Response(200, json={"choices": [{"message": answer.get("message") or {
            "content": json.dumps(answer["definition"], ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 200}})
    original = httpx.AsyncClient
    monkeypatch.setattr(transport.httpx, "AsyncClient", lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(respond)))
    yield TestClient(app), sent, answer
    app.dependency_overrides.pop(get_db, None)
    designer._busy.clear()


def post(client, **changes):
    return client.post('/api/admin/agent-designer/generate', json={
        "provider_id": "builder-model", "requirements": "帮我创建一个政策研究智能体", **changes})


def test_draft_does_not_create_a_business_agent_or_spend_user_quotas(db, setup_designer, monkeypatch):
    client, sent, _ = setup_designer
    forbidden = Mock(side_effect=AssertionError("Admin designer must not consult role/provider budgets"))
    monkeypatch.setattr(model_budget, "get_policy", forbidden)
    monkeypatch.setattr(model_budget, "allowances", forbidden)
    response = post(client)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['application_quota_exempt'] is True
    assert result['draft']['aic'] == '' and result['draft']['usage_mode'] == 'internal'
    assert result['draft']['model_provider'] == 'builder-model'
    assert result['draft']['name'] == DEFINITION['name']
    assert len(sent) == 1 and not forbidden.called
    assert db.scalar(select(func.count()).select_from(Agent)) == 0
    assert db.scalar(select(func.count()).select_from(Invocation)) == 0
    assert db.scalar(select(func.count()).select_from(QuotaBucket)) == 0
    usage = db.scalar(select(ModelUsage))
    assert usage.exempt and usage.status == 'actual'
    assert usage.prompt_tokens == 100 and usage.completion_tokens == 200
    assert usage.owner_id.startswith('admin-designer:') and usage.invocation_id == ''
    audit = db.scalar(select(OperationalLog).where(OperationalLog.action == 'agent_draft_generation'))
    assert audit.outcome == 'success' and audit.detail['application_quota_exempt']
    assert '政策研究' not in json.dumps(audit.detail, ensure_ascii=False)
    assert 'private-designer-fixture-key' not in response.text
    assert model_budget.current_usage_scope() is None


def test_requires_admin_even_with_public_api_key_or_builder_exemption_input(setup_designer):
    client, sent, _ = setup_designer
    override = app.dependency_overrides.pop(require_admin)
    try:
        for headers in ({}, {'X-API-Key': 'test-public-api-key-123456'}):
            response = client.post('/api/admin/agent-designer/generate', headers=headers,
                                   json={'provider_id': 'builder-model', 'requirements': '创建一个智能体'})
            assert response.status_code in {401, 503}
    finally:
        app.dependency_overrides[require_admin] = override
    assert not sent
    assert post(client, quota_exempt=True).status_code == 422
    assert not sent


@pytest.mark.parametrize('extra', [dict(aic='invented'), dict(tools=['create_agent']),
    dict(model_provider='other-provider'), dict(structured_io_enabled=True), dict(role='owner'),
    dict(skills=[{'id': '', 'name': '研究'}]), dict(skills=[{'id': 'same', 'name': '研究'}, {'id': 'same', 'name': '研究'}])])
def test_invalid_or_privilege_bearing_model_output_is_not_saved(db, setup_designer, extra):
    client, sent, answer = setup_designer
    answer['definition'] = {**DEFINITION, **extra}
    response = post(client)
    assert response.status_code == 502
    assert len(sent) == 1
    assert db.scalar(select(func.count()).select_from(Agent)) == 0
    assert db.scalar(select(ModelUsage)).status == 'actual'
    assert db.scalar(select(OperationalLog).where(OperationalLog.action == 'agent_draft_generation')).outcome == 'failed'


def test_duplicate_id_never_overwrites_existing_agent(db, setup_designer):
    client, _, _ = setup_designer
    db.add(Agent(id=DEFINITION['id'], aic='local:existing', name='保留原配置', role='partner'))
    db.commit()
    response = post(client)
    assert response.status_code == 200
    assert response.json()['draft']['id'].startswith(DEFINITION['id'] + '-')
    assert db.get(Agent, DEFINITION['id']).name == '保留原配置'


def test_model_cannot_execute_tools_or_recursively_create_agents(db, setup_designer, monkeypatch):
    client, sent, answer = setup_designer
    answer['message'] = {'tool_calls': [{'id': 'bad', 'function': {
        'name': 'extract_file_content', 'arguments': '{"file_path":".env"}'}}]}
    called = Mock(side_effect=AssertionError('No tool execution permitted'))
    monkeypatch.setattr(transport.ToolRegistry, 'execute', called)
    assert post(client).status_code == 502
    assert len(sent) == 1 and not called.called
    assert db.scalar(select(func.count()).select_from(Agent)) == 0


def test_admin_designer_scope_is_not_inherited_by_normal_runtime(db):
    factory = sessionmaker(bind=db.get_bind())
    with model_budget.usage_scope('normal-owner', 'normal-session', 'call', factory):
        assert not model_budget.current_usage_scope().admin_designer
        with pytest.raises(RuntimeError):
            with model_budget.admin_designer_scope('administrator', 'draft-call', factory):
                assert model_budget.current_usage_scope().admin_designer
                raise RuntimeError('test cleanup')
        assert not model_budget.current_usage_scope().admin_designer
    assert model_budget.current_usage_scope() is None


def test_parallel_duplicate_click_is_rejected_before_model_call(setup_designer):
    client, sent, _ = setup_designer
    designer._busy.add('administrator')
    assert post(client).status_code == 409
    assert not sent


def test_aip_listener_cannot_offer_admin_designer_even_to_admin(setup_designer, monkeypatch):
    client, sent, _ = setup_designer
    monkeypatch.setattr(designer, 'get_settings', lambda: SimpleNamespace(aip_tls_agent_id='docs_overview'))
    assert post(client).status_code == 404
    assert not sent


@pytest.mark.parametrize('definition', ['{"id":"one","id":"two"}', '{}', 'not json'])
def test_bad_json_cannot_be_partially_accepted(definition):
    with pytest.raises(ValueError):
        designer.parse_definition(definition)
