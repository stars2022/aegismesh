
from app.models import Agent
from app.services.prompt import build_system_prompt


def test_collab_style_directive_injected_for_leader() -> None:
    leader = Agent(id="lead", aic="aic-lead", name="lead", role="leader", transport="openai-compatible")
    base = build_system_prompt(leader, harness=True)
    assert "协作方式指定" not in base

    swarm = build_system_prompt(leader, harness=True, collab_style="swarm")
    assert "协作方式指定" in swarm
    assert "run_swarm_discussion" in swarm

    workflow = build_system_prompt(leader, harness=True, collab_style="workflow")
    assert "串行工作流" in workflow

    partner = Agent(id="p", aic="aic-p", name="p", role="partner", transport="openai-compatible")
    assert "协作方式指定" not in build_system_prompt(partner, harness=True, collab_style="swarm")
