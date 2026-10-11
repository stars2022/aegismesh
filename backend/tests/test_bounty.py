from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import inspect
import threading

import httpx
import pytest
from sqlalchemy import create_engine, select, text, update
from sqlalchemy.orm import sessionmaker

from app.models import Agent, BountyBoard, BountyWorkItem, Invocation, ProviderConfig, RoutingPolicy
from app.database import Base
from app.schemas import ChatRequest, PolicyUpdate
from app.seed import DEFAULT_WEIGHTS
from app.services.bounty import BountyStore
from app.services.orchestrator import NoEligibleAgentError, ReliableOrchestrator
from app.services.transport import PartnerResult, TransportRegistry


@pytest.fixture
def board(db):
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, bounty_enabled=True))
    db.add(Invocation(id="private-inv", session_id="private-session", owner_id="guest_bounty", query="计算与核验", status="working"))
    db.commit()
    store = BountyStore(sessionmaker(bind=db.get_bind(), expire_on_commit=False),
                        "private-inv", "guest_bounty", ["a","b"], "leader", max_items=4)
    store.create()
    return store


async def proposed(board, text="计算2+3", actor="a"):
    return (await board.propose(actor, {"title":text, "task":text, "acceptance":"提供可复核计算过程"}))["item_id"]


async def submitted(board, actor="a"):
    item = await proposed(board, actor=actor)
    claim = await board.claim(actor, {"item_id":item})
    args = {"item_id":item, "claim_token":claim["claim_token"], "result":"2+3=5", "evidence":["整数加法：2+3=5"]}
    assert (await board.submit(actor, args))["ok"]
    return item, args


async def test_bounty_workers_compete_atomically(board):
    item = await proposed(board)
    replies = await asyncio.gather(board.claim("a", {"item_id":item}), board.claim("b", {"item_id":item}))
    assert sum(reply["ok"] for reply in replies) == 1
    assert board.snapshot("leader")["items"][0]["status"] == "claimed"
    assert "claim_token" not in board.snapshot("b")["items"][0]


async def test_bounty_claim_across_store_instances(board):
    other = BountyStore(board.factory, board.invocation_id, board.owner_id, ["a","b"], "leader")
    item = await proposed(board)
    replies = await asyncio.gather(board.claim("a", {"item_id":item}), other.claim("b", {"item_id":item}))
    assert sum(reply["ok"] for reply in replies) == 1


async def test_bounty_duplicate_does_not_consume_a_slot(board):
    one = await proposed(board, "计算 2 + 3")
    two = await proposed(board, "计算2+3", actor="b")
    assert one == two
    assert board.snapshot("leader")["published_count"] == 1


async def test_bounty_item_cap_is_hard(board, db):
    db.execute(update(BountyBoard).values(max_items=1))
    db.commit()
    await proposed(board)
    rejected = await board.propose("b", {"title":"另一题", "task":"另一题", "acceptance":"核验"})
    assert rejected["finalize"] and not rejected["ok"]
    assert len(board.snapshot("leader")["items"]) == 1


async def test_bounty_lease_token_and_actor_are_fenced(board):
    item = await proposed(board)
    claim = await board.claim("a", {"item_id":item})
    args = {"item_id":item, "claim_token":claim["claim_token"], "result":"结果", "evidence":["检查"]}
    assert not (await board.submit("b", args))["ok"]
    assert not (await board.submit("a", {**args,"claim_token":"forged"}))["ok"]
    assert (await board.submit("a", args))["ok"]
    assert not (await board.submit("a", args))["ok"]


async def test_bounty_expired_claim_is_never_reopened(board, db):
    item = await proposed(board)
    claim = await board.claim("a", {"item_id":item})
    db.execute(update(BountyWorkItem).where(BountyWorkItem.id == item).values(
        lease_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)))
    db.commit()
    assert not board.has_claim("a")
    assert not (await board.submit("a", {"item_id":item,"claim_token":claim["claim_token"],
        "result":"过期提交","evidence":["检查"]}))["ok"]
    assert not (await board.claim("b", {"item_id":item}))["ok"]
    assert board.snapshot("leader")["items"][0]["status"] == "expired"


async def test_bounty_cannot_self_review_or_accept_twice(board):
    item, _ = await submitted(board)
    args = {"item_id":item,"accepted":True,"note":"核验加法与验收条件一致"}
    assert not (await board.review("a", args))["ok"]
    assert (await board.review("b", args))["ok"]
    assert not (await board.review("leader", args))["ok"]
    assert board.snapshot("leader")["items"][0]["reviewed_by"] == "b"


async def test_bounty_disabled_module_drains_claims_but_blocks_new_work(board, db):
    item = await proposed(board)
    claim = await board.claim("a", {"item_id":item})
    db.execute(update(RoutingPolicy).values(bounty_enabled=False))
    db.commit()
    assert board.snapshot("leader")["finalize"]
    with pytest.raises(ValueError, match="已关闭"):
        await board.propose("b", {"title":"新题","task":"新题","acceptance":"核验"})
    with pytest.raises(ValueError, match="已关闭"):
        await board.claim("b", {"item_id":item})
    assert (await board.submit("a", {"item_id":item,"claim_token":claim["claim_token"],
        "result":"已在途的成果","evidence":["检查"]}))["ok"]


async def test_bounty_closed_root_and_wrong_principal_cannot_write(board, db):
    with pytest.raises(ValueError, match="无权"):
        board.snapshot("outsider")
    other = BountyStore(board.factory, board.invocation_id, "guest_other", ["a"], "leader")
    with pytest.raises(ValueError, match="无权"):
        other.snapshot("a")
    db.execute(update(Invocation).where(Invocation.id == board.invocation_id).values(status="completed"))
    db.commit()
    with pytest.raises(ValueError, match="已结束"):
        await proposed(board)


async def test_bounty_scope_does_not_accept_item_from_another_board(board, db):
    db.add(Invocation(id="other-inv", session_id="other-session", owner_id="guest_bounty", query="另一题", status="working"))
    db.commit()
    other = BountyStore(board.factory, "other-inv", board.owner_id, ["a"], "leader")
    other.create()
    item = await proposed(other)
    assert not (await board.claim("a", {"item_id":item}))["ok"]


async def test_bounty_each_worker_has_at_most_two_claims(board):
    for index in range(2):
        item = await proposed(board, f"不同计算{index}")
        assert (await board.claim("a", {"item_id":item}))["ok"]
    third = await proposed(board, "第三项")
    reply = await board.claim("a", {"item_id":third})
    assert not reply["ok"] and reply["finalize"]


async def test_bounty_evidence_and_types_are_not_optional(board):
    item = await proposed(board)
    claim = await board.claim("a", {"item_id":item})
    with pytest.raises(ValueError, match="1—8"):
        await board.submit("a", {"item_id":item,"claim_token":claim["claim_token"],"result":"已完成","evidence":[]})
    with pytest.raises(ValueError, match="布尔"):
        await board.review("b", {"item_id":item,"accepted":"false","note":"失败"})
    with pytest.raises(ValueError, match="整数"):
        await board.propose("a", {"title":"题","task":"题","acceptance":"核验","priority":True})


async def test_bounty_shared_findings_are_unverified_and_bounded(board):
    for _ in range(24):
        assert (await board.share("a", {"kind":"hypothesis","content":"待核验的推断"}))["ok"]
    assert not (await board.share("b", {"kind":"failure","content":"额外记录"}))["ok"]
    assert all(not entry["verified"] for entry in board.snapshot("leader")["findings"])


def test_bounty_policy_defaults_and_bounds():
    policy = PolicyUpdate(name="balanced", weights=DEFAULT_WEIGHTS, failure_threshold=2,
                          circuit_cooldown_seconds=30, max_attempts=3, request_timeout_seconds=60)
    assert not policy.bounty_enabled
    for key, value in [("bounty_max_workers",6),("bounty_max_items",13),("bounty_lease_seconds",601)]:
        with pytest.raises(ValueError):
            PolicyUpdate.model_validate({**policy.model_dump(),key:value})
    assert ChatRequest(message="自主协作",mode="bounty").mode == "bounty"


def test_bounty_schema_upgrade_is_additive_and_keeps_existing_policy(tmp_path, monkeypatch):
    import app.main as main
    engine = create_engine(f"sqlite:///{tmp_path}/old.db")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as db:
        db.add(RoutingPolicy(id=1,weights=DEFAULT_WEIGHTS,request_timeout_seconds=123))
        db.commit()
    with engine.begin() as connection:
        for field in ["bounty_enabled","bounty_max_workers","bounty_max_items","bounty_lease_seconds"]:
            connection.execute(text(f"ALTER TABLE routing_policies DROP COLUMN {field}"))
    monkeypatch.setattr(main, "engine", engine)
    try:
        main.initialize_schema()
        main.initialize_schema()
        with sessionmaker(bind=engine)() as db:
            policy = db.get(RoutingPolicy,1)
            assert not policy.bounty_enabled and policy.request_timeout_seconds == 123
            assert (policy.bounty_max_workers,policy.bounty_max_items,policy.bounty_lease_seconds) == (3,6,120)
    finally:
        engine.dispose()


def test_bounty_runtime_config_reflects_admin_switch(db):
    from app.main import chat_runtime_config, update_policy
    from starlette.requests import Request
    db.add(RoutingPolicy(id=1,weights=DEFAULT_WEIGHTS,bounty_enabled=False))
    db.commit()
    assert not chat_runtime_config(db)["bounty_enabled"]
    request = Request({"type":"http","client":("127.0.0.1",1234),"headers":[]})
    payload = PolicyUpdate(name="balanced",weights=DEFAULT_WEIGHTS,failure_threshold=2,
        circuit_cooldown_seconds=30,max_attempts=3,request_timeout_seconds=60,bounty_enabled=True,
        bounty_max_workers=2,bounty_max_items=4,bounty_lease_seconds=90)
    response = update_policy(payload,db,request)
    assert response.bounty_enabled and chat_runtime_config(db)["bounty_enabled"]
    assert db.get(RoutingPolicy,1).bounty_lease_seconds == 90


class BountyFixtureTransport:
    def __init__(self, *, fail=False, block=False):
        self.called, self.schemas, self.preclaim_denied = [], [], []
        self.fail, self.block = fail, block
        self.claimed, self.release = asyncio.Event(), asyncio.Event()
        self.model_sent = []
        self.histories = {}

    async def execute(self, agent, query, timeout_seconds, *, tool_registry, extra_tool_names=(), **kwargs):
        from app.services.model_budget import reserve_model, settle_model
        self.called.append(agent.id)
        self.histories[agent.id] = kwargs.get("history", [])
        self.schemas.append(tool_registry.schemas([*(agent.tools or []),*extra_tool_names]))
        ticket = reserve_model({"model":"fixture","messages":[{"role":"user","content":query}],"max_tokens":32}, provider_id="bounty-fixture")
        self.model_sent.append(agent.id)

        async def call(name, args):
            value = tool_registry.execute(name, args)
            value = await value if inspect.isawaitable(value) else value
            return value["result"] if value.get("ok") else value

        try:
            if self.fail:
                response = httpx.Response(429, request=httpx.Request("POST","https://fixture.invalid/model"))
                raise httpx.HTTPStatusError("fixture model HTTP 429", request=response.request, response=response)
            if agent.role == "leader":
                snapshot = await call("read_bounty_board", {})
                assert "dispatch_task" not in tool_registry._tools
                for item in snapshot["items"]:
                    if item["status"] == "submitted":
                        assert (await call("review_bounty", {"item_id":item["id"],"accepted":True,"note":"根据加法证据复核"}))["ok"]
            else:
                self.preclaim_denied.append(not (await call("calculator", {"expression":"2+3"}))["ok"])
                await call("read_bounty_board", {})
                item = (await call("propose_bounty", {"title":agent.id,"task":f"计算 {agent.id} 的 2+3",
                    "acceptance":"可复核加法过程"}))["item_id"]
                claim = await call("claim_bounty", {"item_id":item})
                self.claimed.set()
                if self.block:
                    await self.release.wait()
                assert (await call("calculator", {"expression":"2+3"})) == 5
                assert (await call("submit_bounty", {"item_id":item,"claim_token":claim["claim_token"],
                    "result":"2+3=5","evidence":["calculator 实际输出 5"]}))["ok"]
            settle_model(ticket, {"prompt_tokens":30,"completion_tokens":5})
            ticket = None
            return PartnerResult("协作结果：5", {}, llm_calls=1, prompt_tokens=30, completion_tokens=5)
        finally:
            if ticket:
                settle_model(ticket, None)


def runtime(db, *, enabled=True, fail=False, block=False, workers=2):
    from app.account_models import AccountPolicy
    db.add(AccountPolicy(id=1, values={"accounts_enabled":True, "quota_mode":"enforce"}))
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, bounty_enabled=enabled, request_timeout_seconds=2,
                         bounty_max_workers=workers, bounty_max_items=6, bounty_lease_seconds=10))
    db.add(ProviderConfig(id="fixture",name="fixture",kind="openai-chat",base_url="https://fixture.invalid",default_model="fixture"))
    for agent_id, role in [("leader","leader"),("worker-a","partner"),("worker-b","partner")]:
        db.add(Agent(id=agent_id,aic="local:"+agent_id,name=agent_id,role=role,transport="provider",
                     model_provider="fixture",health="online",input_modes=["text/plain"],output_modes=["application/json"],
                     tools=["calculator"],skills=[{"id":"math","name":"计算"}]))
    db.commit()
    transport = BountyFixtureTransport(fail=fail, block=block)
    return ReliableOrchestrator(db, TransportRegistry({"openai-chat":transport})), transport


async def test_bounty_runtime_workers_choose_and_leader_only_reviews(db):
    from app.account_models import ModelUsage
    o, transport = runtime(db)
    inv, _, leader = await o.run(ChatRequest(message="分别计算并核验2+3",agent_id="leader",mode="bounty"), owner_id="guest_bounty")
    assert inv.status == "completed" and leader.id == "leader"
    assert transport.called == ["worker-a","worker-b","leader"]
    assert all(transport.preclaim_denied)
    assert all(t["status"] == "accepted" for t in inv.result_data["bounty"]["items"])
    assert not inv.result_data["bounty"]["partial"]
    assert inv.result_data["bounty"]["closed"]
    assert len(inv.result_data["collaborations"]) == 2
    assert all(a.active_tasks == 0 for a in db.scalars(select(Agent)))
    usage = list(db.scalars(select(ModelUsage)))
    assert len(usage) == 3 and all(u.status == "actual" and u.owner_id == "guest_bounty"
        and u.session_id == inv.session_id and u.invocation_id == inv.id for u in usage)
    assert any(event.event_type == "BOUNTY_CLAIM_BOUNTY" for event in inv.events)
    for schemas in transport.schemas:
        names = {schema["function"]["name"] for schema in schemas}
        assert {"read_bounty_board","review_bounty"} <= names
        assert "dispatch_task" not in names
    from app.account_models import QuotaEntry
    entry = db.get(QuotaEntry, inv.id)
    assert entry.owner_id == "guest_bounty" and entry.child_calls == 2
    assert all(not entry.exempt for entry in usage)


@pytest.mark.parametrize("invalid_output", [False, True])
async def test_bounty_optional_structured_output_belongs_only_to_leader(db, monkeypatch, invalid_output):
    import json
    o, transport = runtime(db)
    leader = db.get(Agent, "leader")
    leader.structured_io_enabled = True
    leader.output_schema = {"type":"object", "properties":{"summary":{"type":"string"}},
                            "required":["summary"], "additionalProperties":False}
    db.commit()
    execute = transport.execute

    async def checked(agent, *args, **kwargs):
        if agent.role == "leader":
            assert kwargs["structured_output"] is True
        else:
            assert "structured_output" not in kwargs and "structured_request" not in kwargs
        result = await execute(agent, *args, **kwargs)
        if agent.role == "leader":
            result.text = "invalid JSON" if invalid_output else json.dumps({"summary":"2+3=5"})
        return result

    monkeypatch.setattr(transport, "execute", checked)
    inv, _, _ = await o.run(ChatRequest(message="核验加法", agent_id="leader", mode="bounty", structured_io=True))
    assert inv.status == ("failed" if invalid_output else "completed"), inv.result_text
    assert transport.called.count("leader") == 1
    assert inv.llm_calls == 3 and inv.prompt_tokens == 90 and inv.completion_tokens == 15
    assert inv.result_data["structured_io"]["status"] == ("rejected" if invalid_output else "validated")
    if not invalid_output:
        assert inv.result_data["structured_output"] == {"summary":"2+3=5"}
    else:
        assert not any(event.event_type == "TASK_COMPLETED" for event in inv.events)
    assert inv.result_data["bounty"]["closed"]
    assert all(agent.active_tasks == 0 for agent in db.scalars(select(Agent)))


async def test_bounty_disabled_before_run_never_calls_a_model(db):
    o, transport = runtime(db, enabled=False)
    with pytest.raises(NoEligibleAgentError, match="尚未启用"):
        await o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty"))
    assert not transport.called
    assert not db.scalar(select(BountyBoard.invocation_id))


async def test_bounty_canvas_is_not_silently_ignored(db):
    o, transport = runtime(db)
    with pytest.raises(NoEligibleAgentError, match="共享画布"):
        await o.run(ChatRequest(message="修改文稿",agent_id="leader",mode="bounty",canvas=True))
    assert not transport.called


async def test_bounty_new_workers_do_not_receive_old_user_transcript(db, monkeypatch):
    o, transport = runtime(db)
    monkeypatch.setattr(o, "_session_history", lambda *_: [{"role":"user","content":"旧会话私密原文"}])
    inv, _, _ = await o.run(ChatRequest(message="计算本轮2+3",agent_id="leader",mode="bounty"))
    assert inv.status == "completed"
    assert all("旧会话私密原文" not in str(transport.histories[member]) for member in ["worker-a","worker-b"])
    assert "旧会话私密原文" in str(transport.histories["leader"])


async def test_bounty_unsupported_external_worker_is_not_called(db):
    o, transport = runtime(db)
    for agent in db.scalars(select(Agent).where(Agent.role == "partner")):
        agent.transport = "aip-rpc"
    db.commit()
    with pytest.raises(NoEligibleAgentError, match="本站托管"):
        await o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty"))
    assert not transport.called


async def test_bounty_model_429_never_retries_or_changes_identity(db):
    o, transport = runtime(db, fail=True)
    inv, _, _ = await o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty"))
    assert inv.status == "failed"
    assert len(transport.called) == len(set(transport.called))
    assert "leader" not in transport.called
    assert inv.result_data["bounty"]["closed"]
    assert inv.result_data["bounty"]["partial"]
    assert all(a.active_tasks == 0 for a in db.scalars(select(Agent)))


async def test_bounty_provider_failure_stops_sibling_tool_loops(db, monkeypatch):
    o, transport = runtime(db, block=True)
    execute = transport.execute
    async def failing_sibling(agent, query, timeout, **kwargs):
        if agent.id == "worker-b":
            await transport.claimed.wait()
            response = httpx.Response(429,request=httpx.Request("POST","https://fixture.invalid/model"))
            raise httpx.HTTPStatusError("fixture HTTP 429", request=response.request,response=response)
        return await execute(agent, query, timeout, **kwargs)
    monkeypatch.setattr(transport, "execute", failing_sibling)
    inv, _, _ = await asyncio.wait_for(o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty")),1)
    assert inv.status == "failed" and not transport.release.is_set()
    assert "leader" not in transport.called and inv.result_data["bounty"]["closed"]
    assert all(a.active_tasks == 0 for a in db.scalars(select(Agent)))


async def test_bounty_cancel_releases_all_leases_and_keeps_evidence(db):
    o, transport = runtime(db, block=True)
    task = asyncio.create_task(o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty")))
    await asyncio.wait_for(transport.claimed.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    db.expire_all()
    assert all(a.active_tasks == 0 for a in db.scalars(select(Agent)))
    assert db.scalar(select(BountyBoard.closed))
    assert not db.scalar(select(BountyWorkItem.id).where(BountyWorkItem.status == "claimed"))
    inv = db.scalar(select(Invocation))
    assert inv.result_data["bounty"]["closed"]


async def test_bounty_compatible_mode_uses_existing_authenticated_delivery(db, monkeypatch):
    import app.services.interop as interop
    o, transport = runtime(db)
    db.get(RoutingPolicy,1).interop_compatibility = True
    for agent in db.scalars(select(Agent)):
        agent.aic, agent.registration_status = "registered-"+agent.id, "approved"
    db.commit()
    seen = []
    async def delivery(caller, agent, query, session_id, timeout, execute):
        seen.append((caller, agent.aic, session_id))
        return await execute()
    monkeypatch.setattr(interop, "invoke_hosted", delivery)
    inv, _, _ = await o.run(ChatRequest(message="计算",agent_id="leader",mode="bounty"))
    assert {(caller,callee) for caller,callee,_ in seen if callee.startswith("registered-worker")} == {
        ("registered-leader","registered-worker-a"),("registered-leader","registered-worker-b")}
    assert all(session == inv.session_id for _,_,session in seen)
    assert inv.status == "completed"


async def test_bounty_disable_during_execution_drains_without_new_summary(db):
    o, transport = runtime(db, block=True)
    task = asyncio.create_task(o.run(ChatRequest(message="计算", agent_id="leader",mode="bounty"), owner_id="guest_bounty"))
    await asyncio.wait_for(transport.claimed.wait(), 1)
    db.execute(update(RoutingPolicy).values(bounty_enabled=False))
    db.commit()
    transport.release.set()
    inv, _, _ = await task
    assert "leader" not in transport.called
    assert inv.status == "completed" and inv.result_data["bounty"]["partial"]
    assert any(item["status"] == "submitted" for item in inv.result_data["bounty"]["items"])
    assert all(a.active_tasks == 0 and a.failure_count == 0 for a in db.scalars(select(Agent)))


async def test_bounty_model_provider_budget_remains_enforced(db):
    from app.account_models import AccountPolicy, ModelUsage
    o, transport = runtime(db)
    policy = db.get(AccountPolicy, 1)
    policy.values = {**policy.values, "provider_budgets":{
        "bounty-fixture":{"monthly_units":1000, "output_tokens":512}}}
    db.commit()
    inv, _, _ = await o.run(ChatRequest(message="计算", agent_id="leader",mode="bounty"), owner_id="guest_bounty")
    assert inv.status == "failed"
    assert not transport.model_sent and not db.scalar(select(ModelUsage.id))
    assert db.get(AccountPolicy, 1).values["quota_mode"] == "enforce"
    assert all(a.active_tasks == 0 and a.failure_count == 0 for a in db.scalars(select(Agent)))


def test_bounty_restart_closes_dead_board_but_preserves_live_peer(db, monkeypatch):
    from app.services import runtime_recovery
    db.add(RoutingPolicy(id=1, weights=DEFAULT_WEIGHTS, bounty_enabled=True))
    factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)
    for inv_id in ["dead","live"]:
        db.add(Invocation(id=inv_id, session_id=inv_id, owner_id="guest_bounty",query="计算",status="working",
                          result_data={"_runtime":{"alive":inv_id == "live"}}))
    db.commit()
    for inv_id in ["dead","live"]:
        store = BountyStore(factory, inv_id, "guest_bounty", ["a","b"], "leader")
        store.create()
        item = asyncio.run(proposed(store))
        asyncio.run(store.claim("a", {"item_id":item}))
        db.get(Invocation, inv_id).result_data = {
            "_runtime":{"alive":inv_id == "live"}, "bounty":store.snapshot("leader")}
        db.commit()
    monkeypatch.setattr(runtime_recovery, "runtime_is_live", lambda marker: marker["alive"])
    assert runtime_recovery.recover_interrupted_runtime(db) == (1, 0)
    db.expire_all()
    assert db.get(BountyBoard,"dead").closed
    assert not db.get(BountyBoard,"live").closed
    data = db.get(Invocation, "dead").result_data["bounty"]
    assert data["closed"] and data["partial"] and data["items"][0]["status"] == "cancelled"
    assert "claim_token" not in data["items"][0]
    assert db.get(Invocation,"live").result_data["bounty"]["items"][0]["status"] == "claimed"


async def test_bounty_storage_failure_closes_board_without_replay(board, db):
    from app.services.persistence import StorageFailure
    item = await proposed(board)
    await board.claim("a", {"item_id":item})
    db.get(Invocation, board.invocation_id).result_data = {"bounty":board.snapshot("leader")}
    db.commit()
    inv, _, _ = ReliableOrchestrator(db)._finish_storage_failure(board.invocation_id, StorageFailure("database_busy"))
    assert inv.status == "failed" and inv.result_data["storage_error"] == "database_busy"
    assert inv.result_data["bounty"]["closed"]
    assert inv.result_data["bounty"]["items"][0]["status"] == "cancelled"
    assert board.snapshot("leader")["items"][0]["status"] == "cancelled"


async def test_bounty_json_replace_does_not_leave_live_claims(board, db):
    from app.services.database_transfer import export_database, import_database
    item = await proposed(board)
    await board.claim("a", {"item_id":item})
    payload = export_database(db)
    assert "bounty_boards" not in payload["tables"] and "bounty_work_items" not in payload["tables"]
    import_database(db, payload, "replace")
    assert not db.scalar(select(BountyBoard.invocation_id))
    assert not db.scalar(select(BountyWorkItem.id))


@pytest.mark.parametrize("operation", ["duplicate", "same_item", "same_worker_limit"])
def test_bounty_multi_process_style_competing_claims(tmp_path, operation):
    engine = create_engine(f"sqlite:///{tmp_path}/bounty.db", connect_args={"check_same_thread":False, "timeout":5})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.execute(text("PRAGMA journal_mode=WAL"))
        db.add_all([RoutingPolicy(id=1,weights=DEFAULT_WEIGHTS,bounty_enabled=True),
            Invocation(id="concurrent", session_id="concurrent",owner_id="guest_bounty",query="计算",status="working")])
        db.commit()
    store = BountyStore(factory,"concurrent","guest_bounty",["a","b","c"],"leader",max_items=4)
    store.create()
    items = [asyncio.run(proposed(store, f"计算{index}")) for index in range(3)] if operation != "duplicate" else []
    start = threading.Barrier(3)
    def compete(index):
        member = BountyStore(factory,"concurrent","guest_bounty",["a","b","c"],"leader")
        start.wait(timeout=5)
        if operation == "duplicate":
            return asyncio.run(member.propose("abc"[index], {"title":"同一任务","task":"计算2+3","acceptance":"核验"}))
        return asyncio.run(member.claim("a" if operation == "same_worker_limit" else "abc"[index],
            {"item_id":items[index] if operation == "same_worker_limit" else items[0]}))
    try:
        with ThreadPoolExecutor(max_workers=3) as executor:
            replies = list(executor.map(compete, range(3)))
        snapshot = store.snapshot("leader")
        if operation == "duplicate":
            assert len({reply["item_id"] for reply in replies}) == 1
            assert snapshot["published_count"] == 1
        else:
            assert sum(reply["ok"] for reply in replies) == (2 if operation == "same_worker_limit" else 1)
    finally:
        engine.dispose()
