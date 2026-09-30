"""Optional daily quotas. Atomic reservations; retries never charge a run twice."""
from __future__ import annotations

import hashlib
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..account_models import QuotaBucket, QuotaEntry
from ..config import get_settings
from .identity import now
from .account_policy import allowances, get_policy
from datetime import timedelta, timezone


class QuotaExceeded(ValueError):
    pass


def _bucket(db: Session, owner: str, period: str, resource: str) -> str:
    key = hashlib.sha256(f"{owner}\0{period}\0{resource}".encode()).hexdigest()
    if not db.get(QuotaBucket, key):
        try:
            with db.begin_nested():
                db.add(QuotaBucket(id=key, owner_id=owner, period=period, resource=resource))
                db.flush()
        except IntegrityError:
            pass
    return key


def reserve(db: Session, *, owner: str, entry_id: str, session_id: str = "",
            resource: str = "tasks", amount: int = 1) -> None:
    cfg = get_policy(db)
    if cfg.quota_mode == "off":
        return
    if amount < 1 or resource not in {"tasks", "upload_bytes"}:
        raise ValueError("配额预留参数无效")
    existing = db.get(QuotaEntry, entry_id)
    if existing:
        if (existing.owner_id, existing.session_id, existing.resource, existing.amount) != (owner, session_id, resource, amount):
            raise QuotaExceeded("计量标识已被另一项操作占用")
        return
    limits = allowances(db, owner)
    period = "lifetime" if resource == "tasks" and limits["task_period"] == "lifetime" else now().date().isoformat()
    try:
        with db.begin_nested():
            # Insert the idempotency key BEFORE changing counters.
            db.add(QuotaEntry(id=entry_id, owner_id=owner, session_id=session_id,
                              resource=resource, period=period, amount=amount))
            db.flush()
            limit = limits["tasks"] if resource == "tasks" else limits["upload_bytes"]
            dimensions = [(period, resource, amount, limit)]
            if resource == "tasks":
                dimensions.append(("active", "tasks", 1, limits["concurrency"]))
            for bucket_period, bucket_resource, count, cap in dimensions:
                key = _bucket(db, owner, bucket_period, bucket_resource)
                stmt = update(QuotaBucket).where(QuotaBucket.id == key)
                if cfg.quota_mode == "enforce" and not limits["exempt"]:
                    stmt = stmt.where(QuotaBucket.used + QuotaBucket.reserved + count <= cap)
                changed = db.execute(stmt.values(reserved=QuotaBucket.reserved + count)).rowcount
                if changed != 1:
                    raise QuotaExceeded("访客体验已达上限，请登录后继续" if period == "lifetime" and bucket_period == period else "当前配额不足或并发任务已达上限，请稍后重试")
    except IntegrityError:
        # Another worker won the same key. Validate instead of double-reserving.
        db.expire_all()
        existing = db.get(QuotaEntry, entry_id)
        if not existing or (existing.owner_id, existing.session_id, existing.resource, existing.amount) != (owner, session_id, resource, amount):
            raise QuotaExceeded("计量标识冲突") from None
    db.commit()


def settle(db: Session, entry_id: str, *, success: bool, prompt_tokens: int = 0,
           completion_tokens: int = 0, child_calls: int = 0) -> None:
    # Settle an existing reservation even when an operator has since disabled quotas.
    entry = db.get(QuotaEntry, entry_id)
    if not entry:
        return
    changed = db.execute(update(QuotaEntry).where(QuotaEntry.id == entry_id, QuotaEntry.status == "reserved").values(
        status="completed" if success else "released", finished_at=now(),
        prompt_tokens=max(0, prompt_tokens), completion_tokens=max(0, completion_tokens),
        child_calls=max(0, child_calls))).rowcount
    if changed:
        key = _bucket(db, entry.owner_id, entry.period, entry.resource)
        db.execute(update(QuotaBucket).where(QuotaBucket.id == key).values(
            reserved=QuotaBucket.reserved - entry.amount,
            used=QuotaBucket.used + (entry.amount if success else 0)))
        if entry.resource == "tasks":
            active = _bucket(db, entry.owner_id, "active", "tasks")
            db.execute(update(QuotaBucket).where(QuotaBucket.id == active).values(reserved=QuotaBucket.reserved - 1))
    db.commit()


def snapshot(db: Session, owner: str) -> dict:
    cfg = get_policy(db)
    limits = allowances(db, owner)
    period = now().date().isoformat()
    task_period = "lifetime" if limits["task_period"] == "lifetime" else period
    rows = db.scalars(select(QuotaBucket).where(QuotaBucket.owner_id == owner, QuotaBucket.period.in_([period, task_period, "active"]))).all()
    lookup = {(r.period, r.resource): r for r in rows}
    def item(p, resource, cap):
        row = lookup.get((p, resource))
        used, reserved = (row.used, row.reserved) if row else (0, 0)
        return {"used": used, "reserved": reserved, "limit": cap,
                "remaining": max(0, cap - used - reserved) if cfg.quota_mode == "enforce" and not limits["exempt"] else None}
    from .model_budget import usage_snapshot
    return {"mode": cfg.quota_mode, "period": period, "timezone": "UTC",
            "role": limits["role"], "exempt": limits["exempt"], "task_period": limits["task_period"],
            "tasks": item(task_period, "tasks", limits["tasks"]),
            "concurrency": item("active", "tasks", limits["concurrency"]),
            "upload_bytes": item(period, "upload_bytes", limits["upload_bytes"]),
            "model_budget": usage_snapshot(db, owner),
            "note": "轮次按成功根任务计数。模型消耗含子调用、重试及失败前已产生的用量；不重复扣轮次。"}


def recover_reservations(db: Session) -> None:
    from ..models import Invocation
    for entry in db.scalars(select(QuotaEntry).where(QuotaEntry.status == "reserved")).all():
        inv = db.get(Invocation, entry.id) if entry.resource == "tasks" else None
        if inv and inv.status in {"completed", "failed", "cancelled"}:
            settle(db, entry.id, success=inv.status == "completed", prompt_tokens=inv.prompt_tokens,
                   completion_tokens=inv.completion_tokens,
                   child_calls=len((inv.result_data or {}).get("collaborations") or []))
        elif not inv and entry.created_at.replace(tzinfo=entry.created_at.tzinfo or timezone.utc) < now() - timedelta(hours=1):
            settle(db, entry.id, success=False)
