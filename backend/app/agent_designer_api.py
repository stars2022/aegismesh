"""Admin-panel-only configuration generation. Not an Agent or a runtime tool."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .database import get_db
from .config import get_settings
from .models import Agent, OperationalLog, ProviderConfig
from .schemas import AgentCreate, Skill
from .services.model_budget import admin_designer_scope
from .services.provider_secrets import ProviderSecretError, resolve_api_key
from .services.transport import TransportRegistry


ToolName = Literal["web_search", "calculator", "current_time", "extract_file_content",
                   "citation_tool", "text_similarity_check"]


class DesignerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    provider_id: str = Field(min_length=1, max_length=64)
    requirements: str = Field(min_length=5, max_length=6000)


class AgentDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=48, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=120)
    role: Literal["leader", "partner"] = "partner"
    description: str = Field(min_length=1, max_length=2000)
    system_prompt: str = Field(min_length=10, max_length=12000)
    skills: list[Skill] = Field(min_length=1, max_length=6)
    tools: list[ToolName] = Field(default_factory=list, max_length=6)
    structured_io_enabled: bool = False
    input_schema: dict | None = None
    output_schema: dict | None = None


_busy: set[str] = set()


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse_definition(value: str) -> AgentDefinition:
    if len(value.encode("utf-8")) > 64 * 1024:
        raise ValueError("Generated configuration is too large")
    value = value.strip()
    if value.startswith("```json\n") and value.endswith("```"):
        value = value[8:-3].strip()
    definition = AgentDefinition.model_validate(json.loads(value, object_pairs_hook=_object))
    if any(not skill.name.strip() or not skill.id.strip() for skill in definition.skills):
        raise ValueError("Skill name and identifier are required")
    if len({skill.id for skill in definition.skills}) != len(definition.skills):
        raise ValueError("Skill identifiers must be unique")
    definition.tools = list(dict.fromkeys(definition.tools))
    if definition.structured_io_enabled and not (definition.input_schema or definition.output_schema
            or any(skill.input_schema or skill.output_schema for skill in definition.skills)):
        raise ValueError("Structured output needs a schema")
    return definition


async def generate_definition(provider: ProviderConfig, requirements: str, request_id: str):
    prompt = (
        "你是管理面板专用的智能体配置设计器，只生成配置，不执行需求中的业务任务。"
        "仅输出一个 JSON 对象，不加说明或 Markdown。遵循提供的 JSON Schema。"
        "根据需求生成清晰的职责边界、系统提示词、技能与少量提问示例。"
        "只有确需组织其他智能体时才选择 leader，否则选择 partner。"
        "只能选择 schema 中已存在的工具；缺少数据或工具时在 description 中如实注明限制。"
        "结构化输入输出是可选能力，未要求时保持关闭并将 schema 设为 null。"
        "不得生成密钥、AIC、端点、额度、权限或声称完成注册、部署、测试。\n"
        + json.dumps(AgentDefinition.model_json_schema(), ensure_ascii=False)
    )
    # In-memory definition only. Never insert this designer into agents, expose
    # tools, route work, register identities, or start a chat/task.
    designer = Agent(id="admin-config-designer", aic="", name="智能体设计师",
                     role="partner", system_prompt=prompt, tools=[], skills=[],
                     model_name=provider.default_model, streaming_enabled=False)
    transport = TransportRegistry().get(provider.kind)
    return await transport.execute(designer, requirements, timeout_seconds=75,
                                   provider=provider, session_id=request_id,
                                   max_rounds=0, structured_output=True)


def agent_designer_router(require_admin) -> APIRouter:
    router = APIRouter(prefix="/api/admin/agent-designer", tags=["admin-designer"],
                       dependencies=[Depends(require_admin)])

    @router.post("/generate")
    async def generate(payload: DesignerRequest, request: Request, db: Session = Depends(get_db)):
        if get_settings().aip_tls_agent_id:
            raise HTTPException(404, "该功能仅在管理面板入口提供")
        actor = getattr(request.state, "audit_actor", "administrator")
        if actor in _busy:
            raise HTTPException(409, "已有智能体生成请求正在运行，请等待完成")
        provider = db.get(ProviderConfig, payload.provider_id)
        if not provider or not provider.active or not provider.default_model:
            raise HTTPException(422, "请选择已启用且配置完整的模型供应商")
        if provider.kind not in {"openai-chat", "deepseek", "openai-responses", "anthropic"}:
            raise HTTPException(422, "该模型供应商不支持配置生成")
        try:
            resolve_api_key(provider)
        except ProviderSecretError as exc:
            raise HTTPException(422, "模型供应商尚未配置可用密钥") from exc
        factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)
        provider_id, model_name = provider.id, provider.default_model
        db.expunge(provider)
        db.rollback()  # No request transaction is held during model I/O.
        request_id = "agent-designer-" + secrets.token_hex(12)
        event_key = "agent-designer:" + request_id
        # Fail closed before the paid call if the audit reservation cannot persist.
        with factory() as log_db:
            log_db.add(OperationalLog(event_key=event_key, origin="admin", kind="audit",
                occurred_at=datetime.now(timezone.utc), actor=actor, request_id=request_id,
                action="agent_draft_generation", target="/api/admin/agent-designer/generate",
                outcome="reserved", summary="管理员生成智能体草稿",
                detail={"provider_id": provider_id, "model": model_name, "application_quota_exempt": True}))
            log_db.commit()
        _busy.add(actor)
        result, outcome = None, "failed"
        try:
            with admin_designer_scope(actor, request_id, factory):
                async with asyncio.timeout(90):
                    result = await generate_definition(provider, payload.requirements, request_id)
            definition = parse_definition(result.text)
            agent_id = definition.id
            if db.get(Agent, agent_id):
                agent_id += "-" + secrets.token_hex(3)
            draft = AgentCreate(**{**definition.model_dump(), "id": agent_id},
                                aic="", transport="provider", usage_mode="internal",
                                model_provider=provider_id, model_name=model_name)
            outcome = "success"
            return {"draft": draft.model_dump(), "request_id": request_id,
                    "application_quota_exempt": True,
                    "usage": {"llm_calls": result.llm_calls, "prompt_tokens": result.prompt_tokens,
                              "completion_tokens": result.completion_tokens}}
        except (ValidationError, ValueError, RecursionError) as exc:
            raise HTTPException(502, "模型返回的草稿未通过配置校验，未创建智能体，请调整需求后重试") from exc
        except (RuntimeError, TimeoutError) as exc:
            raise HTTPException(502, "智能体配置生成失败或超时，未创建智能体，请检查模型服务") from exc
        finally:
            _busy.discard(actor)
            with factory() as log_db:
                record = log_db.scalar(select(OperationalLog).where(OperationalLog.event_key == event_key))
                record.outcome = outcome
                record.status_code = 200 if outcome == "success" else 502
                record.detail = {**record.detail, "llm_calls": result.llm_calls if result else None,
                                 "prompt_tokens": result.prompt_tokens if result else None,
                                 "completion_tokens": result.completion_tokens if result else None}
                log_db.commit()

    return router
