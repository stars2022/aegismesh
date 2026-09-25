from __future__ import annotations

from sqlalchemy.orm import Session

from sqlalchemy import select

from .models import Agent, PlatformAccess, ProviderConfig, RoutingPolicy
from .research_catalog import apply_research_catalog


DEFAULT_WEIGHTS = {
    "skill": 0.30,
    "reliability": 0.19,
    "feedback": 0.12,
    "latency": 0.12,
    "load": 0.09,
    "health": 0.11,
    "cost": 0.07,
}

def seed_database(db: Session) -> None:
    policy = db.get(RoutingPolicy, 1)
    if not policy:
        db.add(
            RoutingPolicy(
                id=1,
                name="balanced",
                weights=DEFAULT_WEIGHTS,
                failure_threshold=2,
                circuit_cooldown_seconds=30,
                max_attempts=3,
                request_timeout_seconds=60.0,
            )
        )
    else:
        old = dict(policy.weights or {})
        missing = [key for key in DEFAULT_WEIGHTS if key not in old]
        if missing:
            reserved = sum(DEFAULT_WEIGHTS[key] for key in missing)
            total = sum(max(0.0, float(value)) for value in old.values()) or 1.0
            scale = max(0.0, 1.0 - reserved)
            policy.weights = {
                **{key: max(0.0, float(value)) / total * scale for key, value in old.items()},
                **{key: DEFAULT_WEIGHTS[key] for key in missing},
            }

    if not db.get(PlatformAccess, 1):
        db.add(PlatformAccess(id=1))

    if not db.scalars(select(ProviderConfig)).first():
        db.add(
            ProviderConfig(
                id="deepseek",
                name="DeepSeek 官方 API",
                kind="deepseek",
                base_url="https://api.deepseek.com",
                api_key_env="DEEPSEEK_API_KEY",
                default_model="deepseek-flash",
                active=True,
            )
        )

    apply_research_catalog(db)

    pinned = db.scalars(
        select(Agent).where(
            Agent.registration_status == "imported",
            Agent.transport == "aip-rpc",
            Agent.usage_mode == "both",
        )
    ).all()
    for agent in pinned:
        agent.usage_mode = "external"

    db.commit()
