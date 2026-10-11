"""Bounded, peer-scoped execution of tasks received through official AIP.

The wire envelope is transport metadata, never model-provided tool arguments.
It can only restrict the server's limits; it does not grant identity or access.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import math
import time

from sqlalchemy import select

from ..config import get_settings
from ..models import Agent, HostedTask, RoutingPolicy
from ..schemas import ChatRequest
from .orchestrator import MAX_CALL_CHAIN_DEPTH, ReliableOrchestrator
from .transport import PartnerResult
from .structured_io import read_wire_request


EXECUTION_KIND = "aegismesh.aip-execution.v1"


@dataclass(frozen=True)
class AipExecutionContext:
    # Ancestors followed by the currently executing agent, all canonical AICs.
    chain: tuple[str, ...]
    deadline: float
    trace_id: str
    upstream_aic: str = ""
    tool_limits: dict[str, int] | None = None

    def remaining(self) -> float:
        remaining = self.deadline - time.time()
        if remaining <= 0:
            raise TimeoutError("AIP 任务已达到上游总时限，未发起新的调用")
        return remaining

    def outgoing(self, caller_aic: str) -> dict:
        if not self.chain or self.chain[-1] != caller_aic:
            raise ValueError("AIP 调用链与真实发送方不一致")
        if len(self.chain) >= MAX_CALL_CHAIN_DEPTH:
            raise ValueError("AIP 调用链已达到最大深度")
        self.remaining()
        data = {"kind": EXECUTION_KIND, "chain": list(self.chain),
                "deadline": self.deadline, "trace_id": self.trace_id}
        if self.tool_limits is not None:
            data["tool_limits"] = dict(self.tool_limits)
        return data

    @classmethod
    def from_task(cls, task: HostedTask, agent: Agent) -> AipExecutionContext:
        now = time.time()
        deadline = now + get_settings().aip_task_timeout_seconds
        documents = []
        command = (task.command_history or [{}])[0]
        for item in command.get("dataItems") or []:
            data = item.get("data")
            if item.get("type") == "data" and isinstance(data, dict) and data.get("kind") == EXECUTION_KIND:
                documents.append(data)
        if not documents:
            trace = task.session_id or task.external_task_id
            if len(trace) > 128:
                trace = "aip-" + hashlib.sha256(trace.encode()).hexdigest()
            return cls((agent.aic,), deadline, trace,
                       task.owner_peer_aic)
        if len(documents) != 1:
            raise ValueError("重复的 AIP 执行上下文")
        data = documents[0]
        chain = data.get("chain")
        supplied_deadline = data.get("deadline")
        trace = data.get("trace_id")
        if (not isinstance(chain, list) or not chain or len(chain) >= MAX_CALL_CHAIN_DEPTH
                or any(not isinstance(aic, str) or not aic or len(aic) > 255 for aic in chain)
                or len(set(chain)) != len(chain) or agent.aic in chain):
            raise ValueError("AIP 调用链包含循环或超出最大深度")
        if not task.owner_peer_aic or chain[-1] != task.owner_peer_aic:
            raise ValueError("AIP 调用链发送方不匹配已认证身份")
        if (isinstance(supplied_deadline, bool) or not isinstance(supplied_deadline, (int, float))
                or not math.isfinite(supplied_deadline)):
            raise ValueError("无效的 AIP 总时限")
        if not isinstance(trace, str) or not trace or len(trace) > 128:
            raise ValueError("无效的 AIP 追踪标识")
        limits = data.get("tool_limits")
        maxima = {"web_search": 20, "read_web_page": 2}
        if limits is not None and (not isinstance(limits, dict)
                or any(key not in maxima or type(value) is not int
                       or not 0 <= value <= maxima[key] for key, value in limits.items())):
            raise ValueError("无效的 AIP 任务工具预算")
        context = cls(tuple(chain) + (agent.aic,), min(deadline, supplied_deadline),
                      trace, task.owner_peer_aic, dict(limits) if limits is not None else None)
        context.remaining()
        return context


class InboundAipOrchestrator(ReliableOrchestrator):
    """Reuse normal coordination/tools; cross-agent edges must be official RPC.

TLS workers deliberately do not own MQ consumers. They use ADP's live HTTPS
endpoint instead of trying an in-process delivery binding or falling back to a
local model. Normal UI orchestration and its compatibility switch are unchanged.
"""
    allow_coordination_fallback = False

    def __init__(self, db, context: AipExecutionContext, **kwargs):
        super().__init__(db, **kwargs)
        self.aip_context = context
        self.blocked_aics = {*context.chain, context.upstream_aic} - {""}
        self.external_delegation_enabled = bool(super()._routing_policy().external_delegation_enabled)

    def _runtime_registry(self, provider, *, search_scope="default", **kwargs):
        limits = self.aip_context.tool_limits or {}
        return super()._runtime_registry(provider, search_scope=search_scope,
                                         search_limit=limits.get("web_search"),
                                         page_limit=limits.get("read_web_page"))

    def _coordination_capable(self, agent: Agent) -> bool:
        return (self.external_delegation_enabled and len(self.aip_context.chain) < MAX_CALL_CHAIN_DEPTH
                and super()._coordination_capable(agent))

    def _routing_policy(self) -> RoutingPolicy:
        stored = super()._routing_policy()
        policy = RoutingPolicy(**{c.name: deepcopy(getattr(stored, c.name))
                                  for c in RoutingPolicy.__table__.columns})
        policy.interop_compatibility = True  # Detached, task-scoped; never persisted.
        return policy

    async def _invoke(self, agent, query, invocation, request, policy, history,
                      *, caller_aic=None, **kwargs):
        remaining = self.aip_context.remaining()
        if caller_aic is None:
            if agent.aic != self.aip_context.chain[-1]:
                raise ValueError("AIP 入站任务只能执行其已认证的目标智能体")
            # This agent has already received its real network request. Running
            # its model is not another cross-agent call or a self-call for credit.
            kwargs["_mq_delivered"] = True
            if self.aip_context.tool_limits:
                history = [*history, {"role": "system", "content":
                    "本任务服务端硬工具预算（不是建议）：" + str(self.aip_context.tool_limits)
                    + "。用尽后不再发起请求，直接根据已取得的证据简洁作答；不得重复尝试被拦住的调用。"}]
            if agent.role == "leader" and not self._coordination_capable(agent):
                history = [*history, {"role": "system", "content":
                    "本次外部任务未开放子智能体派发（管理员开关关闭或已达调用深度上限）。"
                    "请使用当前实际可用的领域工具自行完成；不要要求用户开放权限，"
                    "不得声称已派发其他智能体。已配置的 web_search 可以正常使用。"}]
            return await super()._invoke(agent, query, invocation, request, policy, history,
                                         caller_aic=None, **kwargs)

        if not self.external_delegation_enabled:
            raise ValueError("管理员已关闭外部协调任务的子智能体派发")
        if agent.aic in self.blocked_aics:
            raise ValueError("禁止回调当前智能体或调用链上游")
        if caller_aic != self.aip_context.chain[-1]:
            raise ValueError("派发者必须是当前已认证的协调智能体")
        candidate = self._discovered_agents.get(agent.id)
        if candidate is None or candidate.aic != agent.aic or not candidate.endpoint_url.startswith("https://"):
            raise RuntimeError("官方发现服务未提供可信 HTTPS AIP 端点，不回退本地直调")
        controller = kwargs.get("controller") or self.controller
        if controller:
            remaining = min(remaining, controller.absolute_deadline_seconds
                            - (time.monotonic() - controller.started_at))
            controller.record_waiting_subagent()
        if remaining <= 0:
            raise TimeoutError("AIP 子调用已无剩余执行时间")
        result = await asyncio.wait_for(self.transports.get("aip-rpc").execute(
            candidate, query, remaining, history=history,
            session_id=self.aip_context.trace_id, caller_aic=caller_aic,
            interop_compatibility=True, controller=controller,
            execution_context=self.aip_context.outgoing(caller_aic)), timeout=remaining)
        result.data = {**(result.data or {}), "interop": {
            "transport": "aip-rpc", "caller_aic": caller_aic,
            "callee_aic": agent.aic, "task_id": (result.data or {}).get("task_id"),
            "trace_id": self.aip_context.trace_id,
        }}
        return result


async def execute_inbound_task(db, agent: Agent, task: HostedTask, *, on_text=None) -> PartnerResult:
    context = AipExecutionContext.from_task(task, agent)
    if agent.transport == "aip-rpc":
        raise ValueError("AIP 入站入口不能把目标再次转发给自身")
    # Peer + target + wire session isolation: remote session IDs can never open
    # a user's chat/canvas or another peer's history via the shared tool registry.
    scope = f"{agent.aic}\0{task.owner_peer_aic}\0{task.session_id or task.external_task_id}"
    session = "aip-" + hashlib.sha256(scope.encode()).hexdigest()[:40]
    by_aic = {a.aic: a.id for a in db.scalars(select(Agent)).all()}
    ancestors = [by_aic.get(aic, aic) for aic in context.chain[:-1]]
    request = ChatRequest(message=task.query, session_id=session, agent_id=agent.id,
                          interface="harness",
                          delegation_path=ancestors, delegation_depth=len(ancestors),
                          hard_deadline_seconds=context.remaining(), task_profile="research",
                          **read_wire_request((task.command_history or [{}])[0]))
    owner = "aip:" + hashlib.sha256(f"{agent.aic}\0{task.owner_peer_aic}".encode()).hexdigest()
    orchestrator = InboundAipOrchestrator(db, context, stream_callback=on_text)
    invocation, _, _ = await orchestrator.run(request, owner_id=owner)
    if invocation.status != "completed":
        raise RuntimeError(invocation.result_text or "AIP 入站执行未完成")
    return PartnerResult(text=invocation.result_text or "", data={
        **(invocation.result_data or {}), "invocation_id": invocation.id,
        "aip_execution": {"chain": list(context.chain), "trace_id": context.trace_id,
                          "deadline": context.deadline, "transport_policy": "official-only"},
    }, prompt_tokens=invocation.prompt_tokens, completion_tokens=invocation.completion_tokens,
        llm_calls=invocation.llm_calls)
