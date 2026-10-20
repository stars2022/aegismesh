"""Per-request model budgets. No prompts, credentials or response text in the ledger.

Reserve a conservative byte-based input bound plus a bounded output before dispatch.
Reconcile provider usage when complete; unknown/cancelled responses retain the estimate.
These are application units, not a substitute for the upstream billing ledger.
"""
from __future__ import annotations

import json
import math
import secrets
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import timedelta
from typing import Callable

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..account_models import AccountPolicy, ModelUsage
from ..models import ProviderConfig
from .account_policy import allowances, get_policy, provider_allowance
from .identity import now
from .quotas import QuotaExceeded


@dataclass(frozen=True)
class Scope:
    owner: str
    session: str
    invocation: str
    factory: Callable[[], Session]
    admin_designer: bool = False


_scope: ContextVar[Scope | None] = ContextVar("model_budget_scope", default=None)


def current_usage_scope() -> Scope | None:
    """Trusted request attribution for non-token tool ledgers, never tool input."""
    return _scope.get()


@contextmanager
def usage_scope(owner: str, session: str, invocation: str, factory):
    token = _scope.set(Scope(owner, session, invocation, factory))
    try:
        yield
    finally:
        _scope.reset(token)


@contextmanager
def admin_designer_scope(actor: str, request_id: str, factory):
    """Server-only scope for the authenticated admin designer, never wire input.

    Separate principal and exempt ledger rows keep these calls out of account,
    role and shared-provider budgets without disabling accounting or upstream limits.
    """
    token = _scope.set(Scope(f"admin-designer:{actor}"[:128], request_id, "", factory, True))
    try:
        yield
    finally:
        _scope.reset(token)


WINDOWS = (("five_hours", timedelta(hours=5), 0.2), ("week", timedelta(days=7), 0.5),
           ("month", timedelta(days=30), 1.0))


def _used(db, *, owner=None, since=None, public=False, provider=None):
    stmt = select(func.coalesce(func.sum(ModelUsage.units), 0)).where(ModelUsage.created_at >= since)
    if owner is not None:
        stmt = stmt.where(ModelUsage.owner_id == owner)
    if public:
        stmt = stmt.where(ModelUsage.exempt.is_(False))
    if provider is not None:
        stmt = stmt.where(ModelUsage.provider_id == provider)
    return int(db.scalar(stmt) or 0)


def usage_snapshot(db: Session, owner: str) -> dict:
    limits = allowances(db, owner)
    policy = get_policy(db)
    stamp = now()
    provider_ids = set(policy.provider_budgets) | set(limits["provider_units"]) | set(db.scalars(select(ModelUsage.provider_id).where(ModelUsage.owner_id == owner)).all())
    provider_names = {p.id: p.name for p in db.scalars(select(ProviderConfig)).all()}
    return {"unit": "输入 Token + 4 × 输出 Token（命中缓存按 2%）", "rolling": True,
            "providers": [{"id": key, "name": provider_names.get(key, key),
                           "used": _used(db, owner=owner, provider=key, since=stamp - timedelta(days=30)),
                           "limit": provider_allowance(limits, policy, key)} for key in sorted(provider_ids)],
            "windows": {key: {"used": _used(db, owner=owner, since=stamp - window),
                              "limit": int(limits["model_units"] * ratio)} for key, window, ratio in WINDOWS}}


def reserve_model(body: dict, *, output_key="max_tokens", provider_id="default"):
    scope = _scope.get()
    if scope is None:
        return None
    with scope.factory() as db:
        if scope.admin_designer:
            # A request bound, not a role quota. Audit even when account quotas
            # are disabled, and never change the existing AccountPolicy.
            body[output_key] = max(1, min(int(body.get(output_key) or 4096), 4096))
            estimated = len(json.dumps(body, ensure_ascii=False).encode("utf-8")) + 512 + 4 * body[output_key]
            row = ModelUsage(id=secrets.token_hex(16), owner_id=scope.owner,
                             session_id=scope.session, invocation_id="",
                             model=str(body.get("model") or "")[:128], provider_id=provider_id,
                             units=estimated, exempt=True, created_at=now())
            db.add(row)
            db.commit()
            return scope.factory, row.id
        policy = get_policy(db)
        if policy.quota_mode == "off":
            return None
        limits = allowances(db, scope.owner)
        provider = policy.provider_budgets.get(provider_id)
        # Always bound output when metering is enabled, including the exempt owner.
        max_output = provider.output_tokens if provider else policy.model_output_tokens
        cap = min(int(body.get(output_key) or max_output), max_output)
        body[output_key] = max(1, cap)
        input_bytes = len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 512
        estimated = input_bytes + 4 * body[output_key]
        # Serialize admission across API/mTLS processes, not just this event loop.
        if db.get(AccountPolicy, 1) is None:
            from sqlalchemy.dialects.sqlite import insert
            if db.bind.dialect.name == "sqlite":
                db.execute(insert(AccountPolicy).values(id=1, values={}, lock_version=0).on_conflict_do_nothing())
            else:
                from sqlalchemy.dialects.postgresql import insert as pg_insert
                db.execute(pg_insert(AccountPolicy).values(id=1, values={}, lock_version=0).on_conflict_do_nothing())
        db.execute(update(AccountPolicy).where(AccountPolicy.id == 1).values(lock_version=AccountPolicy.lock_version + 1))
        stamp = now()
        if policy.quota_mode == "enforce" and not limits["exempt"]:
            for key, window, ratio in WINDOWS:
                if _used(db, owner=scope.owner, since=stamp - window) + estimated > int(limits["model_units"] * ratio):
                    raise QuotaExceeded("模型用量已达到当前时间窗口额度，请在用量页面查看；本次未发送新的模型请求")
                if _used(db, public=True, since=stamp - window) + estimated > int(policy.public_monthly_units * ratio):
                    raise QuotaExceeded("公开体验的共享模型额度暂时用尽，请稍后再试")
                if provider or provider_id in limits["provider_units"]:
                    role_cap = provider_allowance(limits, policy, provider_id)
                    if (_used(db, owner=scope.owner, provider=provider_id, since=stamp - window) + estimated > int(role_cap * ratio)
                            or (provider and _used(db, public=True, provider=provider_id, since=stamp - window) + estimated > int(provider.monthly_units * ratio))):
                        raise QuotaExceeded("当前模型供应商的可用额度不足，请稍后重试或联系管理员调整")
        row = ModelUsage(id=secrets.token_hex(16), owner_id=scope.owner, session_id=scope.session,
                         invocation_id=scope.invocation, model=str(body.get("model") or "")[:128],
                         provider_id=provider_id, units=estimated, exempt=limits["exempt"], created_at=stamp)
        db.add(row)
        db.commit()
        return scope.factory, row.id


def _count(value):
    return max(0, int(value)) if isinstance(value, (int, float)) and math.isfinite(value) else 0


def settle_model(ticket, usage: dict | None):
    if ticket is None:
        return
    factory, entry_id = ticket
    values = {"status": "estimated"}
    if isinstance(usage, dict) and (("prompt_tokens" in usage and "completion_tokens" in usage) or
                                    ("input_tokens" in usage and "output_tokens" in usage)):
        prompt = _count(usage.get("prompt_tokens", usage.get("input_tokens")))
        output = _count(usage.get("completion_tokens", usage.get("output_tokens")))
        cached = _count(usage.get("prompt_cache_hit_tokens", (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)))
        if "input_tokens" in usage:
            # Anthropic reports cached tokens separately; Responses includes them in input_tokens.
            separate_cached = _count(usage.get("cache_read_input_tokens"))
            prompt += separate_cached + _count(usage.get("cache_creation_input_tokens"))
            cached = separate_cached or _count((usage.get("input_tokens_details") or {}).get("cached_tokens"))
        cached = min(prompt, cached)
        values = {"status": "actual", "prompt_tokens": prompt, "completion_tokens": output,
                  "units": prompt - cached + math.ceil(cached * 0.02) + output * 4}
    with factory() as db:
        db.execute(update(ModelUsage).where(ModelUsage.id == entry_id, ModelUsage.status == "reserved").values(**values))
        db.commit()


def recover_terminal_model_reservations(db):
    """Close orphaned tickets without refunding potentially incurred model cost."""
    from ..models import Invocation
    terminal = select(Invocation.id).where(Invocation.status.in_(["completed", "failed", "cancelled"]))
    return db.execute(update(ModelUsage).where(
        ModelUsage.status == "reserved", ModelUsage.invocation_id.in_(terminal),
    ).values(status="estimated")).rowcount


async def metered_post(client, endpoint, *, json, headers, output_key="max_tokens", provider_id="default", **kwargs):
    ticket = reserve_model(json, output_key=output_key, provider_id=provider_id)
    usage = None
    try:
        response = await client.post(endpoint, json=json, headers=headers, **kwargs)
        if ticket and response.is_success:
            try:
                usage = response.json().get("usage")
            except (ValueError, AttributeError):
                pass
        return response
    finally:
        settle_model(ticket, usage)


class MeteredResponse:
    def __init__(self, response):
        self.response, self.usage, self.complete = response, {}, False

    def __getattr__(self, name):
        return getattr(self.response, name)

    async def aiter_lines(self):
        async for line in self.response.aiter_lines():
            if line.startswith("data:"):
                try:
                    event = json.loads(line[5:].strip())
                    for part in (event, event.get("message"), event.get("response")):
                        if isinstance(part, dict) and isinstance(part.get("usage"), dict):
                            self.usage.update(part["usage"])
                except (ValueError, AttributeError):
                    pass
            yield line
        self.complete = True


@asynccontextmanager
async def metered_stream(client, endpoint, *, json, headers, output_key="max_tokens", provider_id="default"):
    ticket = reserve_model(json, output_key=output_key, provider_id=provider_id)
    wrapped = None
    try:
        async with client.stream("POST", endpoint, json=json, headers=headers) as response:
            wrapped = MeteredResponse(response)
            yield wrapped
    finally:
        settle_model(ticket, wrapped.usage if wrapped and wrapped.complete else None)
