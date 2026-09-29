import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.models import Agent, Invocation, RoutingPolicy, CanvasDoc
from app.schemas import ChatRequest
from app.seed import DEFAULT_WEIGHTS
from app.services.orchestrator import ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry
from app.services.canvas import apply_op, get_or_create_session_canvas
from app.services import discovery, interop
from app.services.agent_search import LIST_AGENTS_SCHEMA


def setup(db, *, external=False, mode=False):
    policy = RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, interop_compatibility=mode,
                           request_timeout_seconds=5, max_attempts=1)
    agent = Agent(id="target", aic="target-aic", name="指定智能体", transport="aip-rpc" if external else "test",
                  usage_mode="external" if external else "both", role="partner", health="online",
                  endpoint_url="https://partner.example/rpc" if external else "")
    inv = Invocation(id="inv", session_id="session", query="测试", status="working")
    db.add_all([policy, agent, inv]); db.commit()
    return policy, agent, inv


@pytest.mark.parametrize("mode", [False, True])
async def test_hosted_mode_chooses_exactly_one_transport(db, monkeypatch, mode):
    policy, agent, inv = setup(db, mode=mode)
    execute = AsyncMock(return_value=PartnerResult(text="ok", data={}))
    async def delivered(caller, target, query, session, timeout, callback):
        execute.assert_not_awaited()
        return await callback()
    wire = AsyncMock(side_effect=delivered)
    monkeypatch.setattr(interop, "invoke_hosted", wire)
    runner = ReliableOrchestrator(db, TransportRegistry({"test": SimpleNamespace(execute=execute)}))
    await runner._invoke(agent, "q", inv, ChatRequest(message="q"), policy, [], caller_aic="caller")
    execute.assert_awaited_once()
    assert wire.await_count == int(mode)


async def test_compatibility_failure_never_falls_back_to_local(db, monkeypatch):
    policy, agent, inv = setup(db, mode=True)
    execute = AsyncMock()
    monkeypatch.setattr(interop, "invoke_hosted", AsyncMock(side_effect=ConnectionError("MQ down")))
    runner = ReliableOrchestrator(db, TransportRegistry({"test": SimpleNamespace(execute=execute)}))
    with pytest.raises(ConnectionError):
        await runner._invoke(agent, "q", inv, ChatRequest(message="q"), policy, [], caller_aic="caller")
    execute.assert_not_awaited()


async def test_direct_registered_partner_also_uses_mq_in_compatibility(db, monkeypatch):
    from app.services import orchestrator
    policy, agent, inv = setup(db, mode=True)
    agent.registration_status = "approved"; db.commit()
    monkeypatch.setattr(orchestrator, "get_settings", lambda: SimpleNamespace(leader_aic="leader-aic"))
    execute=AsyncMock(return_value=PartnerResult(text="ok", data={}))
    async def delivered(caller, target, query, session, timeout, callback):
        assert caller == "leader-aic"
        return await callback()
    wire=AsyncMock(side_effect=delivered)
    monkeypatch.setattr(interop,"invoke_hosted",wire)
    runner=ReliableOrchestrator(db,TransportRegistry({"test":SimpleNamespace(execute=execute)}))
    await runner._invoke(agent,"q",inv,ChatRequest(message="q"),policy,[])
    wire.assert_awaited_once();execute.assert_awaited_once()


@pytest.mark.parametrize("mode", [False, True])
async def test_direct_external_canvas_uses_snapshot_and_applies_once(db, mode):
    policy, agent, inv = setup(db, external=True, mode=mode)
    async def execute(agent, query, timeout, **kwargs):
        assert "画布当前内容" in query
        assert kwargs.get("interop_compatibility", False) == mode
        if mode:
            assert kwargs["caller_aic"] == "caller"
        return PartnerResult(text='```json\n{"name":"canvas_append","parameters":{"content":"外部新增"}}\n```', data={})
    runner = ReliableOrchestrator(db, TransportRegistry({"aip-rpc": SimpleNamespace(execute=execute)}))
    result = await runner._invoke(agent, "新增一段", inv, ChatRequest(message="新增一段", canvas=True), policy, [], caller_aic="caller")
    doc = db.query(CanvasDoc).one()
    assert doc.content.count("外部新增") == 1
    assert len(result.data["canvas"]["applied"]) == 1


async def test_external_canvas_preserves_concurrent_manual_edit(db):
    policy, agent, inv = setup(db, external=True)
    runner = ReliableOrchestrator(db)
    async def execute(*args, **kwargs):
        with runner.session_factory() as cdb:
            doc = get_or_create_session_canvas(cdb, inv.session_id, inv.owner_id)
            apply_op(cdb, doc, editor_id="user", editor_name="用户", op="append", content="手工修改")
        return PartnerResult(text='```json\n{"name":"canvas_append","parameters":{"content":"外部新增"}}\n```', data={})
    runner.transports = TransportRegistry({"aip-rpc": SimpleNamespace(execute=execute)})
    result = await runner._invoke(agent, "q", inv, ChatRequest(message="q", canvas=True), policy, [])
    doc = db.query(CanvasDoc).one()
    assert "手工修改" in doc.content and "外部新增" not in doc.content
    assert result.data["canvas"]["errors"]


async def test_explicit_search_keeps_target_even_with_unrelated_query(db, registered_directory):
    setup(db)
    runner = ReliableOrchestrator(db)
    result = await runner._list_agents({"scope":"local", "aic":"target-aic", "query":"不同的专业"})
    assert [x["agent_id"] for x in result] == ["target"]
    assert result[0]["rank"] == 1
    assert await runner._list_agents({"scope":"local", "name":"不存在", "exact_name":True}) == []


async def test_explicit_dispatch_never_bypasses_offline_or_picks_namesake(db, registered_directory):
    policy, agent, inv = setup(db)
    agent.health="offline"; db.commit()
    runner = ReliableOrchestrator(db)
    dispatch = runner._dispatch_task(inv, ChatRequest(message="q"), policy, [], [])
    result = await dispatch({"agent":agent.aic, "task":"q"})
    assert result["ok"] is False and "不可用" in result["error"]
    agent.health="online"
    db.add(Agent(id="namesake", aic="other", name=agent.name, health="online")); db.commit()
    result = await dispatch({"agent":agent.name, "task":"q"})
    assert result["ok"] is False and len(result["candidates"]) == 2


@pytest.mark.parametrize("args,field,op,value", [
    ({"aic":"aic://1.2.156.3088.TEST"}, "aic", "eq", "1.2.156.3088.TEST"),
    ({"name":"文献"}, "name", "contains", "文献"),
    ({"name":"文献", "exact_name":True}, "name", "eq", "文献"),
    ({"endpoint_url":"https://partner.example/rpc"}, "endPoints.url", "eq", "https://partner.example/rpc"),
])
async def test_adp_structured_search_uses_official_filters(monkeypatch, args, field, op, value):
    from acps_sdk.adp import DiscoveryResponse, DiscoveryResult
    from app.config import get_settings
    captured=[]
    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json=DiscoveryResponse.success(DiscoveryResult(acsMap={})).to_dict())
    real = httpx.AsyncClient
    monkeypatch.setattr(discovery.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(respond), **kw))
    monkeypatch.setattr(discovery, "get_settings", lambda: get_settings().model_copy(update={"adp_discovery_url":"https://directory.example"}))
    await discovery.AdpDiscoveryClient().discover("关键词",10,**args)
    assert captured[0]["type"] == "filtered"
    assert captured[0]["filter"]["conditions"] == [{"field":field, "op":op, "value":value}]


def test_tool_exposes_structured_search():
    props=LIST_AGENTS_SCHEMA["function"]["parameters"]["properties"]
    assert {"aic","name","endpoint_url","query","exact_name","limit"} <= props.keys()


@pytest.mark.parametrize("args", [
    {"aic": "1.2.156.3088.TEST"}, {"name": "指定智能体"},
    {"endpoint_url": "https://partner.example/rpc"},
])
def test_discovery_api_accepts_target_without_freeform_query(args):
    from app.schemas import DiscoveryQuery
    assert DiscoveryQuery(**args).query == ""


async def test_external_prose_does_not_overwrite_canvas(db):
    policy, agent, inv = setup(db, external=True)
    runner = ReliableOrchestrator(db)
    doc = get_or_create_session_canvas(db, inv.session_id, inv.owner_id)
    apply_op(db, doc, editor_id="user", editor_name="用户", op="append", content="用户原文")
    before = doc.content
    result = PartnerResult(text="我已更新画布（但没有编辑指令）", data={})
    await runner._apply_external_canvas_result(agent, inv, result, (doc.id, doc.version, True))
    db.refresh(doc)
    assert doc.content == before
    assert result.data["canvas"]["status"] == "no_operations"


@pytest.mark.parametrize("complete,base_version", [(True, None), (True, 99), (False, 1)])
async def test_external_whole_document_edit_requires_valid_complete_snapshot(db, complete, base_version):
    _, agent, inv = setup(db, external=True)
    runner = ReliableOrchestrator(db)
    doc = get_or_create_session_canvas(db, inv.session_id, inv.owner_id)
    before = doc.content
    op = {"name": "canvas_replace_all", "parameters": {"content": "不应覆盖", "base_version": base_version}}
    result = PartnerResult(text=f"```json\n{json.dumps(op)}\n```", data={})
    await runner._apply_external_canvas_result(agent, inv, result, (doc.id, doc.version, complete))
    db.refresh(doc)
    assert doc.content == before
    assert result.data["canvas"]["status"] == "conflict"


async def test_external_batch_uses_one_snapshot_and_sequential_versions(db):
    _, agent, inv = setup(db, external=True)
    runner = ReliableOrchestrator(db)
    doc = get_or_create_session_canvas(db, inv.session_id, inv.owner_id)
    version = doc.version
    ops = [{"name": "canvas_write_section", "parameters": {
        "section": section, "content": content, "base_version": version,
    }} for section, content in [("第一节", "第一处新增"), ("第二节", "第二处新增")]]
    result = PartnerResult(text="\n".join(f"```json\n{json.dumps(op)}\n```" for op in ops), data={})
    await runner._apply_external_canvas_result(agent, inv, result, (doc.id, version, True))
    db.refresh(doc)
    assert "第一处新增" in doc.content and "第二处新增" in doc.content
    assert doc.version == version + 2
    assert result.data["canvas"]["status"] == "applied"


async def test_targeted_directory_failure_is_not_reported_as_no_match(db, monkeypatch):
    setup(db)
    runner = ReliableOrchestrator(db)
    monkeypatch.setattr(discovery.AdpDiscoveryClient, "discover", AsyncMock(side_effect=discovery.DiscoveryError("ADP unavailable")))
    with pytest.raises(discovery.DiscoveryError):
        await runner._list_agents({"scope": "network", "aic": "unknown-target"})


async def test_exact_endpoint_search_selects_matching_endpoint_not_first(db, monkeypatch):
    setup(db)
    runner = ReliableOrchestrator(db)
    url = "https://partner.example/second-rpc"
    monkeypatch.setattr(discovery.AdpDiscoveryClient, "discover", AsyncMock(return_value={"acsMap": {
        "external-aic": {"name": "多个端点", "endPoints": [
            {"transport": "JSONRPC", "url": "https://partner.example/first-rpc"},
            {"transport": "JSONRPC", "url": url},
        ]},
    }}))
    result = await runner._list_agents({"scope": "network", "endpoint_url": url})
    assert len(result) == 1
    assert result[0]["endpoint_url"] == url
    assert runner._discovered_agents[result[0]["agent_id"]].endpoint_url == url


@pytest.mark.parametrize("external", [False, True])
async def test_official_transport_uses_task_budget_not_short_request_timeout(db, monkeypatch, external):
    from app.services.adaptive_lease import AdaptiveDeadlineController
    policy, agent, inv = setup(db, external=external, mode=True)
    policy.request_timeout_seconds = 2
    controller = AdaptiveDeadlineController("test-budget", hard_deadline_seconds=70)
    execute = AsyncMock(return_value=PartnerResult(text="ok", data={}))
    wire = AsyncMock(return_value=PartnerResult(text="ok", data={}))
    monkeypatch.setattr(interop, "invoke_hosted", wire)
    runner = ReliableOrchestrator(db, TransportRegistry({"aip-rpc" if external else "test": SimpleNamespace(execute=execute)}), controller=controller)
    await runner._invoke(agent, "q", inv, ChatRequest(message="q", hard_deadline_seconds=70), policy, [], caller_aic="caller")
    budget = execute.call_args.args[2] if external else wire.call_args.args[4]
    assert 65 < budget <= 70


async def test_expired_task_never_starts_mq_or_falls_back(db, monkeypatch):
    from app.services.adaptive_lease import AdaptiveDeadlineController, AbsoluteTimeoutError
    policy, agent, inv = setup(db, mode=True)
    controller = AdaptiveDeadlineController("expired", hard_deadline_seconds=1)
    controller.started_at -= 5
    execute, wire = AsyncMock(), AsyncMock()
    monkeypatch.setattr(interop, "invoke_hosted", wire)
    runner = ReliableOrchestrator(db, TransportRegistry({"test": SimpleNamespace(execute=execute)}), controller=controller)
    with pytest.raises(AbsoluteTimeoutError):
        await runner._invoke(agent, "q", inv, ChatRequest(message="q"), policy, [], caller_aic="caller")
    execute.assert_not_awaited()
    wire.assert_not_awaited()
