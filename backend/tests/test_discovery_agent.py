from __future__ import annotations

from sqlalchemy import func, select

from app.main import _platform_leader
from app.models import Agent
from app.seed import PLATFORM_AGENT_CATALOG, seed_database


def test_seed_creates_preset_discovery_agent(db) -> None:
    seed_database(db)

    agent = db.get(Agent, "agent_discovery")
    assert agent is not None, "应预置方式三「发现智能体」"
    assert agent.role == "leader"
    assert agent.usage_mode == "both"
    assert agent.active is True
    assert agent.aic == "local:agent_discovery"
    skill_ids = [skill.get("id") for skill in (agent.skills or [])]
    assert "discovery.nl_agent_discovery" in skill_ids
    assert "list_agents" in agent.system_prompt


def test_seed_discovery_agent_idempotent_and_refreshes_fields(db) -> None:
    seed_database(db)
    seed_database(db)

    count = db.scalar(
        select(func.count()).select_from(Agent).where(Agent.id == "agent_discovery")
    )
    assert count == 1

    agent = db.get(Agent, "agent_discovery")
    original_name = PLATFORM_AGENT_CATALOG["agent_discovery"]["name"]
    agent.name = "被改名"
    db.commit()
    seed_database(db)
    assert db.get(Agent, "agent_discovery").name == original_name


def test_platform_leader_prefers_agent_with_public_aic(db) -> None:
    db.add(
        Agent(
            id="agent_discovery",
            aic="local:agent_discovery",
            name="发现智能体",
            role="leader",
            transport="provider",
        )
    )
    db.add(
        Agent(
            id="research_leader",
            aic="1.2.156.3088.1.BUPT.LEAD.TEST",
            name="对外协调者",
            role="leader",
            transport="provider",
        )
    )
    db.commit()

    leader = _platform_leader(db)
    assert leader is not None
    assert leader.id == "research_leader", "平台级入口不能被仅持本地 AIC 的预置智能体抢占"


def test_platform_leader_skips_external_transports(db) -> None:
    db.add(
        Agent(
            id="ext_leader",
            aic="1.2.156.3088.1.BUPT.EXT.01",
            name="外部 leader",
            role="leader",
            transport="aip-rpc",
        )
    )
    db.commit()
    assert _platform_leader(db) is None
