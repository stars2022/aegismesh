"""Opt-in native Search/Fetch. Fixed official origin, bounded I/O, local audit.

The application ledger counts requests, not model tokens. It is not a supplier
invoice: a timed-out or malformed successful reply may still have incurred cost.
No query, URL, credential or fetched content is stored in the admission ledger.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
import json
import time
import uuid
from urllib.parse import urlsplit

import httpx
from sqlalchemy import func, select, update

from ..account_models import AccountPolicy
from ..config import get_settings
from ..models import OperationalLog, ProviderConfig
from .identity import now
from .model_budget import current_usage_scope
from .provider_secrets import resolve_api_key


ACTION = "deepseek_tool_request"
ORIGIN = "https://api.deepseek.com"
MAX_RESPONSE_BYTES = 512 * 1024
PRICE_CNY_MICROS = 5000  # Reference price: CNY 5 / 1000 non-empty HTTP 200s.
MAX_REQUESTS_PER_SECOND = 5  # One conservative shared bucket across all app keys.


def empty_tool_usage() -> dict:
    return {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
            "search_requests": 0, "fetch_requests": 0,
            "billable_search_requests": 0, "billable_fetch_requests": 0,
            "estimated_cost_cny_micros": 0}


def tool_http_error(status: int) -> RuntimeError:
    return RuntimeError({
        400: "DeepSeek 搜索/抓取参数无效，请检查查询长度或网址",
        401: "DeepSeek 搜索密钥无效，请在后台更新",
        402: "DeepSeek 搜索账户余额不足，本次不自动重试",
        403: "DeepSeek 搜索/抓取被安全策略拒绝，不绕过限制",
        404: "DeepSeek 搜索/抓取未取得可用结果，请检查来源或服务状态",
        429: "DeepSeek 搜索/抓取按账号限速，请稍后再试；更换同账号密钥不会提高额度",
    }.get(status, f"DeepSeek 搜索/抓取返回 HTTP {status}，本次未自动重试"))


class DeepSeekTools:
    def __init__(self, provider: ProviderConfig, factory, *, timeout_seconds: float = 30):
        self.provider, self.factory = provider, factory
        self.timeout_seconds = timeout_seconds

    def _reserve(self, operation: str):
        scope = current_usage_scope()
        factory = scope.factory if scope else self.factory
        if factory is None:
            raise RuntimeError("搜索审计未配置，本次未发送付费请求")
        settings = get_settings()
        limit = settings.deepseek_tools_daily_limit
        stamp = now()
        with factory() as db:
            # Same cross-process admission lock as model budgets; never hold
            # this transaction across network I/O. No in-memory key rotation.
            if db.bind.dialect.name == "sqlite":
                from sqlalchemy.dialects.sqlite import insert
            else:
                from sqlalchemy.dialects.postgresql import insert
            db.execute(insert(AccountPolicy).values(id=1, values={}, lock_version=0).on_conflict_do_nothing())
            db.execute(update(AccountPolicy).where(AccountPolicy.id == 1).values(lock_version=AccountPolicy.lock_version + 1))
            base = select(func.count()).select_from(OperationalLog).where(
                OperationalLog.origin == "admin", OperationalLog.kind == "audit",
                OperationalLog.action == ACTION)
            start = stamp.replace(hour=0, minute=0, second=0, microsecond=0)
            if db.scalar(base.where(OperationalLog.occurred_at >= start)) >= limit:
                raise RuntimeError("DeepSeek 原生搜索/抓取已达全站每日请求上限，本次未发送；可由管理员调整 DEEPSEEK_TOOLS_DAILY_LIMIT")
            # Search and Fetch have independent upstream limits. The key is
            # the operation, NOT provider_id/API key: keys may share an account.
            if db.scalar(base.where(OperationalLog.occurred_at >= stamp - timedelta(seconds=1),
                                    OperationalLog.target == f"{ORIGIN}/v1/tools/{operation}")) >= MAX_REQUESTS_PER_SECOND:
                raise RuntimeError("DeepSeek 原生工具已达账号级请求速率保护，本次未发送，请稍后再试")
            key = f"deepseek-tools:{uuid.uuid4().hex}"
            db.add(OperationalLog(event_key=key, origin="admin", kind="audit", occurred_at=stamp,
                actor=scope.owner[:120] if scope else "admin:search-test",
                task_id=scope.invocation[:255] if scope else "",
                trace_id=scope.session[:255] if scope else "", action=ACTION,
                target=f"{ORIGIN}/v1/tools/{operation}", outcome="reserved", level="INFO",
                summary=f"DeepSeek {operation} 请求已预留，结果待确认",
                detail={"provider_id": self.provider.id, "operation": operation, "requests": 1,
                        "billable": None, "reference_cost_cny_micros": PRICE_CNY_MICROS,
                        "billing_basis": "nonempty_http_200", "daily_attempt_limit": limit}))
            db.commit()  # Audit/admission failure is fail-closed, before dispatch.
        return factory, key

    @staticmethod
    def _settle(ticket, *, status: int | None, billable: bool | None, duration_ms: float):
        factory, key = ticket
        with factory() as db:
            row = db.scalar(select(OperationalLog).where(OperationalLog.event_key == key))
            if row is None:
                raise RuntimeError("搜索审计预留记录缺失，请检查服务状态")
            row.status_code = status
            row.duration_ms = duration_ms
            row.outcome = "unknown" if billable is None else "success" if billable else "empty" if status == 200 else "failed"
            row.summary = f"DeepSeek {row.detail['operation']} 请求：{row.outcome}"
            row.detail = {**row.detail, "billable": billable,
                          "estimated_cost_cny_micros": PRICE_CNY_MICROS if billable is not False else 0,
                          "cost_is_estimate": True}
            db.commit()

    async def post(self, operation: str, body: dict) -> tuple[dict, dict]:
        if operation not in {"search", "fetch"}:
            raise ValueError("未知 DeepSeek 工具")
        try:
            p = urlsplit(self.provider.base_url)
            official = (self.provider.active and p.scheme == "https" and p.hostname == "api.deepseek.com"
                        and p.port in (None, 443) and not p.username and not p.password)
        except ValueError:
            official = False
        if not official:
            raise RuntimeError("原生搜索必须绑定 DeepSeek 官方 HTTPS 供应商")
        key = resolve_api_key(self.provider)
        ticket = self._reserve(operation)
        started, status, billable = time.monotonic(), None, None
        try:
            # No model request, redirects, environment proxy, implicit retries,
            # user cookies, or provider credentials sent to a result URL.
            async with asyncio.timeout(self.timeout_seconds):
                async with httpx.AsyncClient(timeout=self.timeout_seconds, follow_redirects=False, trust_env=False) as client:
                    async with client.stream("POST", f"{ORIGIN}/v1/tools/{operation}",
                            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                     "Accept-Encoding": "identity"}, json=body) as response:
                        status = response.status_code
                        if status != 200:
                            billable = False
                            raise tool_http_error(status)
                        if response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                            raise RuntimeError("DeepSeek 工具返回了不支持的压缩响应，未完整读取；结果未知")
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(chunk) > MAX_RESPONSE_BYTES - len(data):
                                raise RuntimeError("DeepSeek 工具结果过大，未完整读取；可能已产生费用")
                            data.extend(chunk)
            payload = json.loads(data)
            value = payload.get("results" if operation == "search" else "content") if isinstance(payload, dict) else None
            if not isinstance(value, list if operation == "search" else str):
                raise RuntimeError("DeepSeek 工具返回格式无效，未取得可用证据")
            billable = bool(value if operation == "search" else value.strip())
            usage = empty_tool_usage()
            usage[f"{operation}_requests"] = 1
            usage[f"billable_{operation}_requests"] = int(billable)
            usage["estimated_cost_cny_micros"] = PRICE_CNY_MICROS if billable else 0
            return payload, usage
        except (httpx.HTTPError, TimeoutError, ValueError) as exc:
            raise RuntimeError("DeepSeek 工具连接失败或响应无效，未自动重试；结果未知时可能已产生费用") from exc
        finally:
            self._settle(ticket, status=status, billable=billable,
                         duration_ms=round((time.monotonic() - started) * 1000, 2))
