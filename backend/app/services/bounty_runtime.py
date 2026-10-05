"""Event-bounded self-claim cooperation layered over the existing model runtime."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import inspect
import time
import uuid

from .bounty import BOUNTY_SCHEMAS, BountyStore, SUMMARY_INSTRUCTIONS, WORKER_INSTRUCTIONS
from .prompt import fence_untrusted
from .tools import ToolRegistry


async def run_bounty(o, invocation, leader, ranked, eligible, request, policy, history):
    from .orchestrator import AgentTaskLease, HOSTED_TRANSPORTS, MAX_CALL_CHAIN_DEPTH, NoEligibleAgentError
    from .interop import registered_hosted_identity
    from .quotas import QuotaExceeded

    chain = [*request.delegation_path, leader.id]
    if len(chain) >= MAX_CALL_CHAIN_DEPTH:
        raise NoEligibleAgentError("自主认领已达到调用链深度上限。")
    # Ranking admits a bounded capability pool; it never assigns a work item.
    pool = [c.agent for c in eligible if c.agent.id not in chain
            and c.agent.aic not in o.blocked_aics and c.agent.transport in HOSTED_TRANSPORTS
            and o._coordination_capable(c.agent)
            and (not policy.interop_compatibility or registered_hosted_identity(c.agent))]
    pool = pool[:min(request.max_partners, policy.bounty_max_workers, 5)]
    if not pool:
        raise NoEligibleAgentError("没有可参与自主认领的本站托管执行智能体；不会擅自调用外部智能体。")

    started = time.monotonic()
    remaining = o.controller.absolute_deadline_seconds - (time.monotonic() - o.controller.started_at)
    invocation.selected_agent_id, invocation.status = leader.id, "working"
    o._event(invocation, "BOUNTY_STARTED", {"workers":[a.id for a in pool], "maxItems":policy.bounty_max_items})
    o.db.commit()
    store = BountyStore(o.session_factory, invocation.id, invocation.owner_id, [a.id for a in pool], leader.id,
        max_items=min(policy.bounty_max_items, 12), lease_seconds=min(policy.bounty_lease_seconds, 600),
        deadline_at=datetime.now(timezone.utc) + timedelta(seconds=max(0, remaining)))
    store.create()
    collaborations, tasks = [], []
    halt_event, halt_waiter = asyncio.Event(), None
    leader_lease = AgentTaskLease(leader.id, o.session_factory)
    usage = {"llm_calls":0, "prompt_tokens":0, "completion_tokens":0}
    halt = {"reason":""}

    def stop_on_uncaught_failure(task):
        if not task.cancelled() and (error := task.exception()) is not None:
            halt["reason"] = halt["reason"] or o._safe_error_message(error)
            halt_event.set()

    def persist():
        o._check_storage_state()
        snapshot = store.snapshot(leader.id, full=True)
        invocation.result_data = {**(invocation.result_data or {}), "mode":"bounty", "bounty":snapshot}
        o._persist_collaborations(invocation, collaborations)
        return snapshot

    def add_usage(result):
        for key in usage:
            usage[key] += getattr(result, key, 0)

    def board_registry(agent, *, summary=False):
        registry = ToolRegistry()
        registry._tools.clear()
        if not summary:
            base = o._runtime_registry(o._provider_for(agent), search_scope=f"{invocation.id}:bounty:{agent.id}")
            # Domain execution is impossible before a valid lease. No hidden
            # model-only work is trusted: only tool-submitted results are merged.
            for name, (schema, executor) in base._tools.items():
                def guard(fn):
                    async def execute(args):
                        if halt["reason"] or not store.has_claim(agent.id):
                            raise RuntimeError("当前没有有效认领，不能执行新的领域工具")
                        value = fn(args)
                        return await value if inspect.isawaitable(value) else value
                    return execute
                registry.register(name, schema, guard(executor))
        handlers = {
            "read_bounty_board": lambda args: store.snapshot(agent.id),
            "propose_bounty": lambda args: store.propose(agent.id, args),
            "claim_bounty": lambda args: store.claim(agent.id, args),
            "submit_bounty": lambda args: store.submit(agent.id, args),
            "review_bounty": lambda args: store.review(agent.id, args),
            "share_bounty_finding": lambda args: store.share(agent.id, args),
        }
        for name in (["read_bounty_board","review_bounty"] if summary else BOUNTY_SCHEMAS):
            def bind(tool_name, fn):
                async def execute(args):
                    if halt["reason"] and tool_name in {"propose_bounty","claim_bounty"}:
                        return {"ok":False, "finalize":True, "error":"本轮已停止新工作"}
                    value = fn(args)
                    result = await value if inspect.isawaitable(value) else value
                    snapshot = persist()
                    o._event(invocation, "BOUNTY_" + tool_name.upper(), {
                        "agentId":agent.id, "itemId":args.get("item_id") or result.get("item_id"),
                        "ok":result.get("ok", True)})
                    o.db.commit()
                    await o._emit_event("bounty_update", {"bounty":snapshot, "invocation_id":invocation.id,
                                                          "session_id":invocation.session_id})
                    return result
                return execute
            registry.register(name, BOUNTY_SCHEMAS[name], bind(name, handlers[name]))
        return registry

    async def worker(agent):
        lease = AgentTaskLease(agent.id, o.session_factory)
        entry = {"task_id":"bounty_worker_" + uuid.uuid4().hex, "invocation_id":invocation.id,
                 "session_id":invocation.session_id, "owner_id":invocation.owner_id,
                 "agent_id":agent.id, "agent_name":agent.name, "caller_id":leader.id,
                 "call_chain":[*chain,agent.id], "task":"根据共同目标自行提出、认领并复核工作",
                 "status":"running", "started_at":time.time(), "tools":[], "result_collected":False}
        collaborations.append(entry)
        persist()
        try:
            if not store.enabled() or halt["reason"]:
                entry.update(status="failed", error="本轮已停止新工作，本成员未开始执行")
                return
            lease.acquire(o.db)
            invocation.attempt_count += 1
            o.db.commit()
            await o._emit_event("subagent_start", entry)
            registry = board_registry(agent)
            o.controller.record_waiting_subagent()

            async def progress(delta):
                o.controller.record_subagent_progress(entry["task_id"], "generating", has_new_data=True)
                await o._emit_event("subagent_delta", {"task_id":entry["task_id"], "agent_id":agent.id,
                    "agent_name":agent.name, "delta":delta})

            result = await o._invoke(agent, request.message, invocation,
                request.model_copy(update={"agent_id":agent.id, "canvas":False, "collab_style":"auto"}),
                # New members receive the current user goal/attachments, not
                # an automatic copy of the user's old conversation transcript.
                policy, [{"role":"system", "content":WORKER_INSTRUCTIONS}],
                harness=True, tool_registry=registry, max_rounds=min(12, o.coordination_tool_rounds),
                extra_tool_names=tuple(BOUNTY_SCHEMAS), on_text_override=progress,
                caller_aic=leader.aic if policy.interop_compatibility else None,
                collaboration_task_id=entry["task_id"])
            add_usage(result)
            entry.update(status="completed", result=result.text, result_data=result.data,
                         result_collected=True, latency_ms=round((time.time()-entry["started_at"])*1000,2))
            o._record_success(agent, entry["latency_ms"])
        except asyncio.CancelledError:
            entry.update(status="failed", error="本轮已中断，未重投任务")
            raise
        except Exception as exc:
            o._abort_storage_failure(exc)
            error = o._safe_error_message(exc)
            entry.update(status="failed", error=error)
            # A model/runtime failure does not cause another identity to retry it.
            halt["reason"] = error
            halt_event.set()
            if not isinstance(exc, QuotaExceeded):
                o._record_failure(agent, policy)
        finally:
            try:
                if not o._storage_failed:
                    store.abandon(agent.id, "成员已结束但没有有效提交，未重投任务")
            finally:
                lease.release()
            if not o._storage_failed:
                persist()
                await o._emit_event("subagent_done", entry)

    try:
        leader_lease.acquire(o.db)
        persist()
        tasks = [asyncio.create_task(worker(agent)) for agent in pool]
        for task in tasks:
            task.add_done_callback(stop_on_uncaught_failure)
        group = asyncio.gather(*tasks, return_exceptions=True)
        halt_waiter = asyncio.create_task(halt_event.wait())
        await asyncio.wait([group, halt_waiter], return_when=asyncio.FIRST_COMPLETED)
        if halt_event.is_set():
            # A failed provider/budget must not leave sibling tool loops making
            # additional model requests. Preserve any already-issued receipts.
            for task in tasks:
                if not task.done():
                    task.cancel()
        outcomes = await group
        for outcome in outcomes:
            if isinstance(outcome, BaseException) and not isinstance(outcome, asyncio.CancelledError):
                raise outcome
        o._check_storage_state()
        snapshot = persist()
        submitted = [item for item in snapshot["items"] if item["status"] in {"submitted","accepted"}]
        if submitted and not halt["reason"] and store.enabled():
            o.controller.record_synthesizing()
            registry = board_registry(leader, summary=True)
            summary = await o._invoke(leader, request.message, invocation,
                request.model_copy(update={"canvas":False, "collab_style":"auto"}), policy,
                [*history, {"role":"system", "content":SUMMARY_INSTRUCTIONS},
                 {"role":"user", "content":fence_untrusted("待复核的任务板成果", str(snapshot))}],
                harness=True, tool_registry=registry, extra_tool_names=("read_bounty_board","review_bounty"),
                max_rounds=min(o.coordination_tool_rounds, policy.bounty_max_items + 3), stream_output=True)
            add_usage(summary)
            invocation.result_text = summary.text
        else:
            # No additional model spend after a runtime failure or module switch.
            reports = "\n\n".join(f"{item['title']}（尚未独立核实）：\n{item['result']}" for item in submitted)
            invocation.result_text = (reports + "\n\n" if reports else "") + (
                "自主认领本轮未完整完成。" + (halt["reason"] or "未取得可复核提交，或模块已关闭。"))
        store.close()
        snapshot = persist()
        accepted = [t for t in snapshot["items"] if t["status"] == "accepted"]
        unfinished = [t for t in snapshot["items"] if t["status"] != "accepted"]
        snapshot.update(partial=bool(unfinished or halt["reason"] or not accepted),
                        review_kind="agent_review_not_independent_fact_verification",
                        priority_credits={a.id:sum(t["priority"] for t in accepted if t["claimed_by"] == a.id) for a in pool})
        invocation.status = "completed" if submitted else "failed"
        invocation.result_data = {**(invocation.result_data or {}), "mode":"bounty", "bounty":snapshot,
                                  "collaborations":deepcopy(collaborations), "context":o._context_info(history)}
        for key in usage:
            setattr(invocation, key, getattr(invocation, key) + usage[key])
        invocation.total_latency_ms = round((time.monotonic()-started)*1000,2)
        invocation.finished_at = datetime.now(timezone.utc)
        o._event(invocation, "TASK_COMPLETED" if submitted else "TASK_FAILED", {
            "mode":"bounty", "accepted":len(accepted), "partial":snapshot["partial"]})
        o.db.commit()
        return invocation, ranked, leader
    finally:
        if halt_waiter is not None:
            halt_waiter.cancel()
            await asyncio.gather(halt_waiter, return_exceptions=True)
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        try:
            if not o._storage_failed:
                store.close()
                # Preserve the final board on cancellation/timeout, too.
                snapshot = store.snapshot(leader.id, full=True)
                previous = (invocation.result_data or {}).get("bounty", {})
                invocation.result_data = {**(invocation.result_data or {}), "bounty":{
                    **previous, **snapshot, "partial":previous.get("partial", True)}}
                o._persist_collaborations(invocation, collaborations)
        finally:
            leader_lease.release()
