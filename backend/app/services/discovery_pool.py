"""ADP owns candidate membership; local records supply observations and runtime identity."""
from __future__ import annotations

import hashlib
from copy import deepcopy

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Agent, RoutingPolicy
from .agent_search import matches_agent
from .discovery import health_from_alive_map
from .router import QualityRouter, RoutingRequirements

PUBLIC_FIELDS = (
    "name", "description", "endpoint_url", "skills", "input_modes", "output_modes",
    "security_schemes", "streaming_enabled", "notification_enabled", "group_enabled", "health",
)


def discovery_candidates(db: Session, response: dict, constraints: dict | None = None) -> list[Agent]:
    local = {a.aic: a for a in db.scalars(select(Agent)).all()}
    candidates = []
    for aic, acs in (response.get("acsMap") or {}).items():
        if not aic or not isinstance(acs, dict):
            continue
        endpoints = [e for e in (acs.get("endPoints") or []) if isinstance(e, dict)
                     and str(e.get("url") or "").startswith("https://")
                     and str(e.get("transport") or "").upper() in {"JSONRPC", "HTTP_JSON", "AIP"}]
        if constraints and constraints.get("endpoint_url"):
            endpoints = [e for e in endpoints if e["url"].rstrip("/") == constraints["endpoint_url"]]
        stored = local.get(aic)
        if not endpoints and (not stored or stored.transport == "aip-rpc"):
            continue
        if constraints and constraints.get("endpoint_url") and not endpoints:
            continue
        if stored:
            # Detached scoring view: directory refresh must not change credentials,
            # locally configured tools, admin switches, or historical observations.
            candidate = Agent(**{c.name: deepcopy(getattr(stored, c.name)) for c in Agent.__table__.columns})
        else:
            candidate = Agent(
                id="adp_" + hashlib.sha256(aic.encode()).hexdigest()[:12], aic=aic,
                role="partner", transport="aip-rpc", usage_mode="external", active=True,
                tools=[], model_provider="", model_name="", registration_status="discovered",
                estimated_cost_per_1k=0.0, avg_latency_ms=0.0, success_count=0, failure_count=0,
                feedback_positive_count=0, feedback_negative_count=0, request_count=0,
                active_tasks=0, queued_tasks=0, circuit_state="closed", consecutive_failures=0,
            )
        candidate.name = str(acs.get("name") or aic)
        candidate.description = str(acs.get("description") or "")
        candidate.skills = acs.get("skills") or []
        candidate.input_modes = acs.get("defaultInputModes") or acs.get("inputModes") or ["text/plain", "application/json"]
        candidate.output_modes = acs.get("defaultOutputModes") or acs.get("outputModes") or ["application/json", "text/markdown", "text/plain"]
        candidate.endpoint_url = endpoints[0]["url"] if endpoints else ""
        security = acs.get("securitySchemes") or {}
        candidate.security_schemes = list(security) if security else list({
            key for e in endpoints for item in (e.get("security") or []) if isinstance(item, dict) for key in item
        })
        capabilities = acs.get("capabilities") or {}
        if candidate.transport == "aip-rpc":
            candidate.streaming_enabled = bool(capabilities.get("streaming"))
            candidate.notification_enabled = bool(capabilities.get("notification"))
            candidate.group_enabled = bool(capabilities.get("messageQueue"))
        candidate.active = candidate.active is not False and bool(acs.get("active", True))
        candidate.health = health_from_alive_map(response.get("aliveMap"), aic)
        candidate._discovery_verified = True
        candidate._local_history = stored is not None
        if not constraints or matches_agent(candidate, constraints):
            candidates.append(candidate)
    return candidates


def remember_selected_candidate(db: Session, candidate: Agent) -> Agent:
    """Keep local scores across calls without promoting cached rows into discovery results."""
    stored = db.scalar(select(Agent).where(Agent.aic == candidate.aic))
    if stored is None:
        db.add(candidate)
        db.commit()
        return candidate
    if stored.transport == "aip-rpc":
        for field in PUBLIC_FIELDS:
            setattr(stored, field, deepcopy(getattr(candidate, field)))
        db.commit()
    return stored


def rank_discovery(db: Session, candidates: list[Agent], query: str, blocked: list[str] | None = None) -> list[dict]:
    policy = db.get(RoutingPolicy, 1)
    if policy is None:
        raise RuntimeError("路由评分策略尚未初始化")
    blocked = set(blocked or [])
    ranked = QualityRouter().rank(candidates, policy, RoutingRequirements(query=query or "智能体协作"))
    return [{
        "agent_id": s.agent.id, "aic": s.agent.aic, "name": s.agent.name, "role": s.agent.role,
        "description": (s.agent.description or "")[:200],
        "skills": [i.get("name") for i in (s.agent.skills or [])][:5],
        "health": s.agent.health, "endpoint_url": s.agent.endpoint_url,
        "source": "adp_network", "score_source": "local_history",
        "has_local_history": bool(getattr(s.agent, "_local_history", False)),
        "is_pinned": s.agent.registration_status == "imported",
        "in_call_chain": s.agent.id in blocked,
        "callable": s.eligible and s.agent.id not in blocked, "eligible": s.eligible,
        "match_score": round(s.score, 1), "rank": s.rank,
        "score_note": "；".join(s.reasons[:3]),
        "history": {"calls": s.agent.request_count or 0, "successes": s.agent.success_count or 0,
                    "failures": s.agent.failure_count or 0, "avg_latency_ms": s.agent.avg_latency_ms or 0,
                    "positive_feedback": s.agent.feedback_positive_count or 0,
                    "negative_feedback": s.agent.feedback_negative_count or 0},
    } for s in ranked]
