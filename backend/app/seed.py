from __future__ import annotations

from sqlalchemy.orm import Session

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

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

# 平台级预置智能体（非科研目录）：随首次启动创建，字段随启动同步刷新
PLATFORM_AGENT_CATALOG: dict[str, dict] = {
    "agent_discovery": {
        "name": "智能体发现助手",
        "role": "leader",
        "description": (
            "方式三「发现智能体」：用自然语言描述需求，即可在本地注册表与全网发现（ADP）中"
            "检索候选智能体，按质量评分输出推荐名单，并给出智能体与技能的组合建议。"
        ),
        "system_prompt": (
            "你是智能体发现助手（方式三：发现智能体）。用户用自然语言描述需求时：\n"
            "1. 先提炼能力关键词并调用 list_agents 检索候选（默认 scope=all，兼顾本地注册表与全网 ADP 发现；"
            "用户只关心本平台调度池时用 scope=local，只关心外部接入时用 scope=network）；\n"
            "2. 依据返回的质量评分与资格说明筛选，严禁虚构不存在的候选；\n"
            "3. 输出固定三段：【需求解析】提取的能力关键词；【推荐名单】各候选的名称、质量评分、来源"
            "（本地/全网）、健康状态与推荐理由；【组合建议】首选的智能体与技能组合及其覆盖的需求项、"
            "备选组合、未覆盖的需求项与接入建议（外部候选可先导入本平台调度池再派发任务）；\n"
            "4. 全网发现不可用或检索为空时如实说明，并给出改写查询的关键词建议。"
        ),
        "skills": [
            {
                "id": "discovery.nl_agent_discovery",
                "name": "自然语言智能体发现与组队建议",
                "description": (
                    "以自然语言接收任务需求，检索本地注册表与全网发现（ADP）中的智能体，"
                    "输出带质量评分的推荐名单与智能体/技能组合建议。"
                ),
                "version": "1.0.0",
                "tags": ["智能体发现", "自然语言检索", "能力匹配", "组队建议", "ADP发现", "智能体推荐"],
                "examples": [
                    "帮我找能完成文献检索和论文评审的智能体组合",
                    "我要做一个数据分析项目，推荐合适的智能体团队",
                ],
                "input_modes": ["text/plain", "application/json"],
                "output_modes": ["text/markdown", "application/json"],
            }
        ],
        "tools": [],
    },
}

def _apply_seed(db: Session) -> None:
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

    for agent_id, definition in PLATFORM_AGENT_CATALOG.items():
        agent = db.get(Agent, agent_id)
        if agent is None:
            db.add(
                Agent(
                    id=agent_id,
                    aic=f"local:{agent_id}",
                    health="healthy",
                    transport="provider",
                    model_provider="deepseek",
                    model_name="deepseek-flash",
                    active=True,
                    usage_mode="both",
                    registration_status="local",
                    **definition,
                )
            )
        else:
            for field, value in definition.items():
                setattr(agent, field, value)
            agent.active = True

    pinned = db.scalars(
        select(Agent).where(
            Agent.registration_status == "imported",
            Agent.transport == "aip-rpc",
            Agent.usage_mode == "both",
        )
    ).all()
    for agent in pinned:
        agent.usage_mode = "external"

def seed_database(db: Session) -> None:
    """Apply the catalog safely when multiple service processes start together.

    The public API and mTLS API share one database and may be restarted at the
    same time. Both can observe an empty seed row before either transaction has
    committed. Let the database pick the winner, then retry the losing
    transaction against the newly committed rows instead of crashing startup.
    """
    for attempt in range(2):
        try:
            _apply_seed(db)
            db.commit()
            return
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
