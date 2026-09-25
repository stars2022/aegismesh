from __future__ import annotations

from app.models import Agent
from app.research_catalog import apply_research_catalog


def _agent(agent_id: str, name: str, role: str = "partner") -> Agent:
    return Agent(
        id=agent_id,
        aic=f"local:test:{agent_id}",
        name=name,
        role=role,
        model_provider="test-provider",
        model_name="test-model",
        active=True,
        health="online",
    )


def _legacy_catalog() -> list[Agent]:
    return [
        _agent("research_leader", "旧主智能体", "leader"),
        _agent("docs_overview", "旧文献智能体"),
        _agent("theory_analysis", "旧理论智能体"),
        _agent("empirical_design", "旧实证智能体"),
        _agent("peer_review", "旧评审智能体"),
        _agent("citation_check", "旧引注智能体"),
    ]


def test_research_catalog_consolidates_to_four_agents(db) -> None:
    db.add_all(_legacy_catalog())
    db.commit()

    result = apply_research_catalog(db, prune_retired=True)

    remaining = db.query(Agent).order_by(Agent.id).all()
    assert len(remaining) == 4
    assert {agent.id for agent in remaining} == {
        "research_leader",
        "docs_overview",
        "empirical_design",
        "peer_review",
    }
    assert db.get(Agent, "research_leader").name == "科研智能体协作工作台"
    assert db.get(Agent, "docs_overview").name == "文献检索与知识综述智能体"
    assert db.get(Agent, "empirical_design").name == "研究设计与数据分析智能体"
    assert db.get(Agent, "peer_review").name == "论文评审与学术写作智能体"
    assert result["removed"] == ["theory_analysis", "citation_check"]


def test_research_catalog_without_pruning_deactivates_retired_agents(db) -> None:
    db.add_all(_legacy_catalog())
    db.commit()

    apply_research_catalog(db, prune_retired=False)

    assert db.get(Agent, "theory_analysis").active is False
    assert db.get(Agent, "citation_check").active is False
    assert db.get(Agent, "research_leader").active is True
