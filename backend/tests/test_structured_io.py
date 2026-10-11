from copy import deepcopy
import json

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.models import Agent, Invocation, RoutingPolicy
from app.schemas import AgentCreate, AgentUpdate, ChatRequest, Skill
from app.services.orchestrator import ReliableOrchestrator
from app.seed import DEFAULT_WEIGHTS
from app.services.structured_io import (
    StructuredInputError, StructuredOutputError, parse_output,
    input_message, read_wire_request, resolve_contract, validate_data, validate_schema, wire_request,
)
from app.services.transport import PartnerResult, TransportRegistry, build_aip_start_command


INPUT = {"type": "object", "properties": {"topic": {"type": "string", "minLength": 1},
         "limit": {"type": "integer", "minimum": 1, "maximum": 5}},
         "required": ["topic"], "additionalProperties": False}
OUTPUT = {"type": "object", "properties": {"summary": {"type": "string"},
          "sources": {"type": "array", "items": {"type": "object", "properties": {
              "title": {"type": "string"}, "year": {"type": ["integer", "null"]}},
              "required": ["title", "year"], "additionalProperties": False}, "maxItems": 5}},
          "required": ["summary", "sources"], "additionalProperties": False}
VALID = {"summary": "待核实的资料", "sources": [{"title": "文献", "year": None}]}


def configured_agent(db):
    agent = Agent(id="structured", aic="local:structured", name="结构化测试", transport="fixture",
                  health="online", input_modes=["text/plain", "application/json"],
                  output_modes=["application/json"], structured_io_enabled=True,
                  input_schema=deepcopy(INPUT), output_schema=deepcopy(OUTPUT), skills=[])
    db.add(agent)
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, failure_threshold=2,
                         circuit_cooldown_seconds=30, max_attempts=1, request_timeout_seconds=2))
    db.commit()
    return agent


class FixtureTransport:
    def __init__(self, text=None, hook=None):
        self.text = text if text is not None else json.dumps(VALID, ensure_ascii=False)
        self.calls = []
        self.hook = hook

    async def execute(self, agent, query, timeout_seconds, **kwargs):
        self.calls.append((query, kwargs))
        if self.hook:
            self.hook()
        if kwargs.get("on_text"):
            await kwargs["on_text"](self.text)
        return PartnerResult(self.text, {"fixture": True}, prompt_tokens=11, completion_tokens=7, llm_calls=1)


def runner(db, transport, **kwargs):
    return ReliableOrchestrator(db, TransportRegistry({"fixture": transport}), **kwargs)


def task(**changes):
    return ChatRequest(message="查文献", agent_id="structured", structured_io=True,
                       input_data={"topic": "科学研究"}, **changes)


def test_old_requests_and_agents_are_opted_out():
    assert not ChatRequest(message="普通聊天").structured_io
    assert not AgentCreate(id="a", name="a", transport="openai-compatible").structured_io_enabled
    assert "_io_contract" not in ChatRequest.model_json_schema()["properties"]
    assert AgentUpdate(name="changed").model_dump(exclude_unset=True) == {"name": "changed"}
    with pytest.raises(ValidationError):
        AgentUpdate(structured_io_enabled=None)


@pytest.mark.parametrize("schema", [
    {"type": "array"}, {"type": "object", "$ref": "https://example.com/schema"},
    {"type": "object", "$ref": "#"}, {"type": "object", "allOf": []},
    {"type": "object", "properties": {"name": {"type": "string", "pattern": "(a+)+$"}}},
    {"type": "object", "required": "name"}, {"type": "object", "unknown": True},
    {"type": "object", "$schema": "http://json-schema.org/draft-07/schema#"},
])
def test_unsafe_or_invalid_schemas_are_rejected_everywhere(schema):
    with pytest.raises(ValueError): validate_schema(schema)
    with pytest.raises(ValidationError): AgentUpdate(output_schema=schema)
    with pytest.raises(ValidationError): Skill(id="test", name="test", input_schema=schema)


def test_schema_and_data_work_is_bounded():
    with pytest.raises(ValueError): validate_schema({"type": "object", "description": "x" * 17000})
    with pytest.raises(ValueError): validate_schema({"type": "object", "properties": {
        f"p{i}": {"type": "string"} for i in range(130)}})
    schema = {"type": "object"}
    nested = schema
    for _ in range(10):
        nested["properties"] = {"child": {"type": "object"}}
        nested = nested["properties"]["child"]
    with pytest.raises(ValueError): validate_schema(schema)
    with pytest.raises(ValueError): validate_data({"topic": "x" * 33000}, INPUT, "输入")
    with pytest.raises(ValueError): validate_data({"topic": float("nan")}, INPUT, "输入")


@pytest.mark.parametrize("value", [{}, {"topic": 3}, {"topic": "a", "limit": True},
                                    {"topic": "a", "limit": 9}, {"topic": "a", "unexpected": "secret"}])
def test_invalid_input_reports_constraints_without_values(value):
    with pytest.raises(ValueError) as error: validate_data(value, INPUT, "输入")
    assert "secret" not in str(error.value)


def test_nested_output_and_single_fenced_json_are_validated():
    assert parse_output(json.dumps(VALID), OUTPUT) == VALID
    assert parse_output("```json\n" + json.dumps(VALID) + "\n```", OUTPUT) == VALID
    with pytest.raises(StructuredOutputError): parse_output('{"summary":"a","sources":[{"title":"x","year":"2026"}]}', OUTPUT)


@pytest.mark.parametrize("text", ["普通回复", '[1,2]', '解释：{"summary":"a","sources":[]}',
                                   '{"summary":"a","summary":"b","sources":[]}',
                                   '{"summary":NaN,"sources":[]}', '{"summary":Infinity,"sources":[]}',
                                   '{"summary":"a","sources":[]} extra', '{"summary":"a"}'])
def test_non_json_duplicate_nonfinite_or_incomplete_outputs_fail(text):
    with pytest.raises(StructuredOutputError): parse_output(text, OUTPUT)


def test_schema_selection_is_explicit_and_skill_overrides_inherit(db):
    agent = configured_agent(db)
    skill_input = {"type": "object", "properties": {"number": {"type": "integer"}}, "required": ["number"]}
    agent.skills = [{"id": "numbers", "name": "numbers", "input_schema": skill_input}]
    db.commit()
    contract = resolve_contract(db, ChatRequest(message="a", agent_id=agent.id,
        structured_io=True, requested_skill="numbers", input_data={"number": 2}))
    assert contract.input_schema == skill_input and contract.output_schema == OUTPUT
    assert resolve_contract(db, ChatRequest(message="普通", agent_id=agent.id)) is None
    with pytest.raises(StructuredInputError): resolve_contract(db, ChatRequest(message="a", structured_io=True))
    with pytest.raises(StructuredInputError): resolve_contract(db, task(requested_skill="missing"))
    with pytest.raises(StructuredInputError): resolve_contract(db, task(canvas=True))
    with pytest.raises(StructuredInputError): resolve_contract(db, ChatRequest(message="a", input_data={}))
    agent.structured_io_enabled = False
    db.commit()
    assert resolve_contract(db, ChatRequest(message="普通", agent_id=agent.id)) is None
    with pytest.raises(StructuredInputError): resolve_contract(db, task())


async def test_invalid_input_does_not_start_task_reserve_quota_or_call_provider(db, monkeypatch):
    configured_agent(db)
    transport = FixtureTransport()
    from app.services import quotas
    def forbidden(*args, **kwargs): raise AssertionError("quota reservation must not occur")
    monkeypatch.setattr(quotas, "reserve", forbidden)
    with pytest.raises(StructuredInputError):
        await runner(db, transport).run(ChatRequest(message="a", agent_id="structured",
                                                   structured_io=True, input_data={}), owner_id="test-owner")
    assert not transport.calls
    assert db.scalar(select(func.count()).select_from(Invocation)) == 0


async def test_opt_in_returns_validated_object_without_partial_deltas(db):
    configured_agent(db)
    transport = FixtureTransport()
    deltas = []
    async def on_text(text): deltas.append(text)
    inv, _, _ = await runner(db, transport, stream_callback=on_text).run(task())
    assert inv.status == "completed"
    assert inv.result_data["structured_output"] == VALID
    assert inv.result_data["structured_io"]["status"] == "validated"
    assert json.loads(inv.result_text) == VALID
    assert inv.prompt_tokens == 11 and inv.completion_tokens == 7
    assert not deltas
    assert '"topic":"科学研究"' in transport.calls[0][0]
    assert any("JSON Schema" in item["content"] for item in transport.calls[0][1]["history"])
    assert any(event.event_type == "STRUCTURED_OUTPUT_VALIDATED" for event in inv.events)


async def test_invalid_output_is_failed_not_retried_and_keeps_billable_usage(db):
    configured_agent(db)
    transport = FixtureTransport("not json")
    inv, _, _ = await runner(db, transport).run(task())
    assert inv.status == "failed"
    assert len(transport.calls) == 1
    assert inv.result_data["structured_io"]["status"] == "rejected"
    assert "structured_output" not in inv.result_data
    assert inv.llm_calls == 1 and inv.prompt_tokens == 11 and inv.completion_tokens == 7
    assert not any(event.event_type == "TASK_COMPLETED" for event in inv.events)


async def test_coordinator_format_error_does_not_trigger_paid_fallback(db):
    agent = configured_agent(db)
    agent.role = "leader"
    db.commit()
    transport = FixtureTransport("invalid JSON")
    orchestrator = runner(db, transport)
    orchestrator.allow_coordination_fallback = True
    inv, _, _ = await orchestrator.run(task())
    assert inv.status == "failed" and len(transport.calls) == 1
    assert inv.llm_calls == 1 and inv.prompt_tokens == 11
    assert not any(event.event_type == "SELF_EXECUTION_FALLBACK" for event in inv.events)


async def test_structured_coordinator_transport_failure_does_not_start_fallback(db):
    agent = configured_agent(db)
    agent.role = "leader"
    db.commit()
    calls = []
    class FailedTransport:
        async def execute(self, *args, **kwargs):
            calls.append(True)
            raise ConnectionError("fixture network failure")
    inv, _, _ = await runner(db, FailedTransport()).run(task())
    assert inv.status == "failed" and len(calls) == 1
    assert not any(event.event_type == "SELF_EXECUTION_FALLBACK" for event in inv.events)


@pytest.mark.parametrize("invalid_summary", [False, True])
async def test_coordinator_validates_only_final_answer_and_does_not_constrain_children(db, registered_directory, invalid_summary):
    agent = configured_agent(db)
    agent.role = "leader"
    db.add(Agent(id="leaf", aic="local:leaf", name="leaf", transport="fixture", health="online"))
    db.commit()
    calls = []

    class Runtime:
        async def execute(self, target, query, timeout_seconds, **kwargs):
            calls.append(target.id)
            if target.id == "leaf":
                assert "structured_request" not in kwargs and "structured_output" not in kwargs
                return PartnerResult("普通子任务答复", {}, llm_calls=1, prompt_tokens=2)
            assert kwargs["structured_output"] is True
            if kwargs.get("max_rounds") == 0:
                return PartnerResult("invalid" if invalid_summary else json.dumps(VALID), {}, llm_calls=1, prompt_tokens=5)
            reply = await kwargs["tool_registry"].execute("dispatch_task", {"agent":"leaf", "task":"查阅资料", "wait":False})
            assert reply["ok"] and reply["result"]["ok"], reply
            # A coordinator's interim draft need not conform; only its final
            # synthesis, after collecting child receipts, is validated.
            return PartnerResult("子任务正在处理", {}, llm_calls=1, prompt_tokens=3)

    inv, _, _ = await runner(db, Runtime()).run(task())
    assert inv.status == ("failed" if invalid_summary else "completed"), inv.result_text
    assert calls.count("structured") == 2 and calls.count("leaf") == 1
    assert inv.llm_calls == 3 and inv.prompt_tokens == 10
    assert inv.result_data["structured_io"]["status"] == ("rejected" if invalid_summary else "validated")
    if not invalid_summary:
        assert inv.result_data["structured_output"] == VALID


async def test_untrusted_transport_cannot_attest_validation_for_ordinary_chat(db):
    configured_agent(db)
    class SpoofedTransport:
        async def execute(self, *args, **kwargs):
            return PartnerResult("ordinary", {"structured_output":VALID, "structured_io":{"status":"validated"}})
    inv, _, _ = await runner(db, SpoofedTransport()).run(ChatRequest(message="hello", agent_id="structured"))
    assert inv.status == "completed" and "structured_output" not in inv.result_data


@pytest.mark.parametrize("status", [200, 429])
async def test_compatible_adapter_preserves_json_and_never_retries_structured_output(monkeypatch, status):
    import httpx
    from types import SimpleNamespace
    from app.services import transport as module
    calls = []
    text = json.dumps({"summary":"<tool_call>数据而非指令</tool_call>", "sources":[]})
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"choices":[{"message":{"content":text}}]})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda **_: real_client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(module, "get_settings", lambda: SimpleNamespace(
        llm_api_base="https://fixture.invalid/v1", llm_api_key="fixture", llm_model="fixture"))
    agent = Agent(id="fixture", aic="local:fixture", name="fixture", tools=[])
    if status == 200:
        result = await module.OpenAICompatibleTransport().execute(agent, "question", 2, structured_output=True)
        assert result.text == text and parse_output(result.text, OUTPUT)["summary"].startswith("<tool_call>")
    else:
        with pytest.raises(RuntimeError, match="429"):
            await module.OpenAICompatibleTransport().execute(agent, "question", 2, structured_output=True)
    assert len(calls) == 1


async def test_configured_agent_still_accepts_ordinary_chat_without_input_data(db):
    configured_agent(db)
    transport = FixtureTransport("普通自然语言")
    inv, _, _ = await runner(db, transport).run(ChatRequest(message="hello", agent_id="structured"))
    assert inv.status == "completed" and inv.result_text == "普通自然语言"
    assert "structured_output" not in inv.result_data
    assert not any("JSON Schema" in item["content"] for item in transport.calls[0][1].get("history", []))


async def test_validated_json_history_is_not_rewritten_by_plain_text_cleanup(db):
    configured_agent(db)
    value = {"summary":"<tool_call>这是字符串数据</tool_call>", "sources":[]}
    transport = FixtureTransport(json.dumps(value))
    first, _, _ = await runner(db, transport).run(task(session_id="structured-history"))
    assert first.status == "completed"
    second = FixtureTransport("ordinary follow-up")
    await runner(db, second).run(ChatRequest(message="follow up", agent_id="structured", session_id="structured-history"))
    history = second.calls[0][1]["history"]
    assert json.loads(history[1]["content"]) == value
    assert not any("JSON Schema" in item["content"] for item in history)


def test_input_section_is_not_duplicated_across_aip_text_handoff(db):
    configured_agent(db)
    request = task()
    contract = resolve_contract(db, request)
    once = input_message(request.message, request.input_data, contract)
    assert input_message(once, request.input_data, contract) == once


async def test_turning_feature_off_mid_task_does_not_change_accepted_contract(db):
    agent = configured_agent(db)
    def disable():
        agent.structured_io_enabled = False
        agent.output_schema = None
        db.commit()
    inv, _, _ = await runner(db, FixtureTransport(hook=disable)).run(task())
    assert inv.status == "completed" and inv.result_data["structured_output"] == VALID
    with pytest.raises(StructuredInputError): resolve_contract(db, task())
    ordinary, _, _ = await runner(db, FixtureTransport("normal")).run(ChatRequest(message="普通", agent_id=agent.id))
    assert ordinary.status == "completed"


def test_aip_wire_is_opt_in_and_uses_standard_structured_data_items():
    request = task()
    command = build_aip_start_command("caller", "session", "question", [], structured_request=wire_request(request))
    payload = command.model_dump(mode="json", exclude_none=True)
    restored = read_wire_request(payload)
    assert restored == {"structured_io": True, "input_data": request.input_data, "requested_skill": None}
    assert read_wire_request({"dataItems": [{"type": "text", "text": "normal"}]}) == {}
    assert wire_request(ChatRequest(message="normal")) is None
    with pytest.raises(StructuredInputError): read_wire_request({"dataItems": payload["dataItems"] * 2})
    malicious = deepcopy(payload)
    malicious["dataItems"][-1]["data"]["output_schema"] = {"type": "object"}
    with pytest.raises(StructuredInputError): read_wire_request(malicious)


def test_portable_backup_round_trip_validates_contracts_and_accepts_legacy_records(db):
    from app.services.database_transfer import export_database, import_database
    agent = configured_agent(db)
    exported = export_database(db)
    db.delete(agent)
    db.commit()
    import_database(db, exported, "merge")
    restored = db.get(Agent, "structured")
    assert restored.structured_io_enabled and restored.input_schema == INPUT
    legacy = deepcopy(exported)
    row = legacy["tables"]["agents"][0]
    row.update(id="legacy", aic="local:legacy")
    for name in ("structured_io_enabled", "input_schema", "output_schema"):
        row.pop(name)
    import_database(db, legacy, "merge")
    assert not db.get(Agent, "legacy").structured_io_enabled
    invalid = deepcopy(exported)
    invalid["tables"]["agents"][0]["output_schema"] = {"type": "object", "$ref": "https://example.com"}
    with pytest.raises(ValueError): import_database(db, invalid, "merge")
    assert db.get(Agent, "structured").output_schema == OUTPUT


def test_additive_migration_leaves_existing_agents_opted_out(monkeypatch):
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.orm import Session
    from app.database import Base
    import app.main as main
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(Agent(id="before", aic="local:before", name="旧智能体"))
        db.commit()
    with engine.begin() as connection:
        for name in ("structured_io_enabled", "input_schema", "output_schema"):
            connection.execute(text(f"ALTER TABLE agents DROP COLUMN {name}"))
    monkeypatch.setattr(main, "engine", engine)
    main.initialize_schema()
    main.initialize_schema()  # upgrade must be idempotent
    assert {"structured_io_enabled", "input_schema", "output_schema"}.issubset(
        {column["name"] for column in inspect(engine).get_columns("agents")})
    with Session(engine) as db:
        restored = db.get(Agent, "before")
        assert not restored.structured_io_enabled
        assert restored.input_schema is None and restored.output_schema is None


async def test_background_input_preflight_runs_before_task_creation(db, monkeypatch):
    from sqlalchemy.orm import sessionmaker
    import app.main as main
    configured_agent(db)
    monkeypatch.setattr(main, "SessionLocal", sessionmaker(bind=db.get_bind()))
    async def forbidden(*args, **kwargs): raise AssertionError("background task must not be created")
    monkeypatch.setattr(main.task_manager, "create_task", forbidden)
    with pytest.raises(StructuredInputError):
        await main._launch_chat_task(ChatRequest(message="a", agent_id="structured",
                                                 structured_io=True, input_data={}), "test-owner")


@pytest.mark.parametrize("path", ["/api/chat", "/api/chat/stream"])
def test_http_invalid_input_is_422_and_creates_no_invocation(db, monkeypatch, path):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker
    from app.database import get_db
    import app.main as main
    configured_agent(db)
    monkeypatch.setattr(main, "SessionLocal", sessionmaker(bind=db.get_bind()))
    async def forbidden(*args, **kwargs): raise AssertionError("background task must not be created")
    monkeypatch.setattr(main.task_manager, "create_task", forbidden)
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(main.app, headers={"X-API-Key":"test-public-api-key-123456"})
        response = client.post(path, json={"message":"topic", "agent_id":"structured", "structured_io":True, "input_data":{}})
        assert response.status_code == 422, response.text
        assert "缺少必填字段" in response.json()["detail"]
        assert db.scalar(select(func.count()).select_from(Invocation)) == 0
    finally:
        main.app.dependency_overrides.pop(get_db, None)


async def test_background_accepted_contract_survives_capability_change(db):
    agent = configured_agent(db)
    request = task()
    # Private state is assigned by server preflight, never accepted from JSON.
    request._io_contract = resolve_contract(db, request)
    agent.structured_io_enabled = False
    agent.output_schema = None
    db.commit()
    inv, _, _ = await runner(db, FixtureTransport()).run(request)
    assert inv.status == "completed" and inv.result_data["structured_output"] == VALID


async def test_public_response_exposes_only_validated_success(db):
    import app.main as main
    configured_agent(db)
    inv, ranked, selected = await runner(db, FixtureTransport()).run(task())
    response = main._chat_response(inv, ranked, selected, db)
    assert response.structured_output == VALID
    inv.status = "failed"
    assert main._chat_response(inv, ranked, selected, db).structured_output is None
    inv.status = "completed"
    inv.result_data = {"structured_output": VALID}
    assert main._chat_response(inv, ranked, selected, db).structured_output is None
