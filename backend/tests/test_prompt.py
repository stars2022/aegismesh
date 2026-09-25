from app.models import Agent
from app.services.prompt import build_system_prompt


def test_regular_api_uses_only_authored_system_prompt() -> None:
    agent = Agent(id="one", aic="aic-one", name="One", system_prompt="只使用这段提示词")

    assert build_system_prompt(agent) == "只使用这段提示词"


def test_harness_adds_ordered_runtime_guidance() -> None:
    agent = Agent(
        id="one",
        aic="aic-one",
        name="One",
        system_prompt="分析任务",
        skills=[{"id": "analysis", "name": "分析"}],
        tools=["calculator"],
    )

    prompt = build_system_prompt(agent, harness=True)

    assert prompt.index("## 身份") < prompt.index("## 系统提示词")
    assert prompt.index("## 系统提示词") < prompt.index("## 工具执行")
    assert "分析任务" in prompt
    assert "calculator" in prompt
    assert "交付" in prompt
    assert "未核实" in prompt
    assert "dispatch_task" not in prompt


def test_harness_injects_leader_runtime_tools() -> None:
    agent = Agent(
        id="leader",
        aic="aic-leader",
        name="Leader",
        role="leader",
        system_prompt="协调任务",
        tools=[],
    )

    prompt = build_system_prompt(agent, harness=True)

    assert "list_agents" in prompt
    assert "dispatch_task" in prompt
    assert "fetch_session_history" in prompt
    assert "直接回答" in prompt
    assert "当前未提供工具" not in prompt
