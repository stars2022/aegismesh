"""Explicit discovery constraints shared by tools and the ADP client."""
from __future__ import annotations

LIST_AGENTS_SCHEMA = {
    "type": "function", "function": {
        "name": "list_agents",
        "description": "通过官方发现服务搜索智能体，再按 AIC 关联本地成功率、延迟、反馈等历史评分并排序。本地缓存不独立提供候选，服务失败时不能用旧列表代替。指定 AIC、名称或 AIP 地址时传对应参数，同名使用 AIC/agent_id 消歧；不能用排名替换指定目标。发现不代表调用成功。",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["all", "local", "network"], "default": "all",
                      "description": "all/network=官方发现结果；local=仅保留发现服务返回的本机托管成员。所有范围都查询发现服务"},
            "query": {"type": "string", "description": "任务/能力关键词，用于搜索及候选排名"},
            "aic": {"type": "string", "description": "精确 AIC 身份，可带 aic:// 前缀"},
            "name": {"type": "string", "description": "智能体名称，默认包含匹配"},
            "exact_name": {"type": "boolean", "default": False},
            "endpoint_url": {"type": "string", "description": "精确 AIP HTTPS 地址，只从已知记录和官方目录匹配，不直接访问任意 URL"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 30, "default": 10},
        }, "additionalProperties": False},
    },
}


def search_constraints(arguments: dict) -> dict:
    query = str(arguments.get("query") or "").strip()
    aic = str(arguments.get("aic") or "").strip().removeprefix("aic://")
    endpoint = str(arguments.get("endpoint_url") or "").strip().rstrip("/")
    if not aic and (query.startswith("1.2.156.3088.") or query.startswith("aic://")):
        aic = query.removeprefix("aic://")
    if not endpoint and query.startswith("https://"):
        endpoint = query.rstrip("/")
    if endpoint and not endpoint.startswith("https://"):
        raise ValueError("AIP 地址必须为 HTTPS")
    return {"aic": aic, "name": str(arguments.get("name") or "").strip(),
            "endpoint_url": endpoint, "exact_name": arguments.get("exact_name") is True}


def matches_agent(agent, constraints: dict) -> bool:
    aic, name, endpoint = (constraints[k] for k in ("aic", "name", "endpoint_url"))
    return (not aic or agent.aic == aic) and (
        not name or (agent.name.casefold() == name.casefold() if constraints["exact_name"]
                     else name.casefold() in agent.name.casefold())
    ) and (not endpoint or (agent.endpoint_url or "").rstrip("/") == endpoint)
