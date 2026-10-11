from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import DateTime, delete
from sqlalchemy.inspection import inspect
from sqlalchemy.orm import Session

from ..models import (
    Agent,
    BountyBoard,
    BountyWorkItem,
    HostedTask,
    Invocation,
    InvocationFeedback,
    ProbeResult,
    ProviderConfig,
    RouteAttempt,
    RoutingPolicy,
    TraceEvent,
    WebSearchConfig,
)
from ..schemas import WebSearchSettings
from .structured_io import validate_schema


DATA_MODELS = [
    Agent,
    ProviderConfig,
    RoutingPolicy,
    WebSearchConfig,
    Invocation,
    InvocationFeedback,
    RouteAttempt,
    TraceEvent,
    ProbeResult,
    HostedTask,
]


def export_database(db: Session) -> dict[str, Any]:
    tables: dict[str, list[dict[str, Any]]] = {}
    for model in DATA_MODELS:
        mapper = inspect(model)
        rows = db.query(model).all()
        tables[model.__tablename__] = [
            {
                column.key: (
                    getattr(row, column.key).isoformat()
                    if isinstance(getattr(row, column.key), datetime)
                    else getattr(row, column.key)
                )
                for column in mapper.columns
                if not (
                    (model is ProviderConfig and column.key in {"api_key_ciphertext", "api_key_env"})
                    or (model is WebSearchConfig and column.key == "exa_api_key_ciphertext")
                )
            }
            for row in rows
        ]
    return {"format": "aegismesh-database", "version": 1, "tables": tables}


def import_database(db: Session, payload: dict[str, Any], mode: str) -> dict[str, int]:
    if payload.get("format") != "aegismesh-database" or payload.get("version") != 1:
        raise ValueError("数据库文件格式不受支持")
    tables = payload.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("数据库文件缺少 tables")
    if mode == "replace" and not tables.get("routing_policies"):
        raise ValueError("替换导入必须包含路由策略")

    if mode == "replace":
        # Claim tokens are operational state, never restored from a portable
        # JSON export. Delete children explicitly even when SQLite FK checks
        # are off; otherwise an imported root ID can inherit an orphan board.
        db.execute(delete(BountyWorkItem))
        db.execute(delete(BountyBoard))
        for model in reversed(DATA_MODELS):
            db.execute(delete(model))

    counts: dict[str, int] = {}
    try:
        for model in DATA_MODELS:
            table_name = model.__tablename__
            rows = tables.get(table_name, [])
            if not isinstance(rows, list):
                raise ValueError(f"{table_name} 必须是数组")
            mapper = inspect(model)
            columns = {column.key: column for column in mapper.columns}
            for raw in rows:
                if not isinstance(raw, dict):
                    raise ValueError(f"{table_name} 包含无效记录")
                values: dict[str, Any] = {}
                for key, value in raw.items():
                    if model is ProviderConfig and key in {"api_key_ciphertext", "api_key_env"}:
                        continue
                    if model is WebSearchConfig and key == "exa_api_key_ciphertext":
                        continue
                    column = columns.get(key)
                    if column is None:
                        continue
                    if value is not None and isinstance(column.type, DateTime):
                        if not isinstance(value, str):
                            raise ValueError(f"{table_name}.{key} 的时间格式无效")
                        value = datetime.fromisoformat(value)
                    values[key] = value
                if model is WebSearchConfig:
                    if values.get("id") != 1:
                        raise ValueError("web_search_configs.id 必须为 1")
                    validated = WebSearchSettings.model_validate(values).model_dump()
                    # Imported files cannot enable external traffic or install credentials.
                    validated["backend"] = "disabled"
                    existing_search = db.get(WebSearchConfig, 1)
                    if existing_search is None:
                        db.add(WebSearchConfig(id=1, **validated, exa_api_key_ciphertext=""))
                    else:
                        for key, value in validated.items():
                            setattr(existing_search, key, value)
                elif model is Agent:
                    # Import cannot bypass the same contract checks as edits.
                    if "structured_io_enabled" in values and not isinstance(values["structured_io_enabled"], bool):
                        raise ValueError("结构化输入输出开关必须为布尔值")
                    validate_schema(values.get("input_schema"))
                    validate_schema(values.get("output_schema"))
                    for skill in values.get("skills") or []:
                        if not isinstance(skill, dict):
                            raise ValueError("智能体技能必须为对象")
                        validate_schema(skill.get("input_schema"))
                        validate_schema(skill.get("output_schema"))
                    db.merge(model(**values))
                elif model is ProviderConfig:
                    required = {"id", "name", "kind", "base_url", "default_model"}
                    if not required.issubset(values):
                        raise ValueError("provider_configs 缺少必需字段")
                    parts = urlsplit(str(values["base_url"]))
                    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
                        raise ValueError("导入的供应商地址必须是有效的 HTTPS URL")
                    if values["kind"] not in {"openai-chat", "openai-responses", "anthropic"}:
                        raise ValueError("provider_configs.kind 无效")
                    safe_values = {
                        key: values[key]
                        for key in {
                            "id",
                            "name",
                            "kind",
                            "base_url",
                            "default_model",
                            "active",
                        }
                        if key in values
                    }
                    existing = db.get(ProviderConfig, safe_values["id"])
                    if existing is None:
                        safe_values["active"] = False
                        db.add(ProviderConfig(**safe_values, api_key_ciphertext="", api_key_env=""))
                    else:
                        origin_changed = (
                            existing.base_url != safe_values["base_url"]
                            or existing.kind != safe_values["kind"]
                        )
                        for key, value in safe_values.items():
                            if key != "id":
                                setattr(existing, key, value)
                        if origin_changed:
                            existing.api_key_ciphertext = ""
                            existing.api_key_env = ""
                            existing.active = False
                else:
                    db.merge(model(**values))
            counts[table_name] = len(rows)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return counts
