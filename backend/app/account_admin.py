"""Administrator-only account controls. Mutations and their audit commit together."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.orm import Session

from .account_models import AccountIdentity, AccountPolicy, AccountQuotaOverride, LoginSession, ModelUsage, QuotaEntry, UserAccount
from .config import get_settings
from .database import get_db
from .models import OperationalLog, ProviderConfig
from .services import quotas
from .services.account_policy import AccountLimits, Policy, account_role, get_policy
from .services.identity import now, require_same_origin
from .services.observability import audit_action, safe_text


class AccountUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["member", "trusted", "admin"] | None = None
    active: bool | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    limits: AccountLimits | None = None
    revision: str | None = Field(default=None, min_length=64, max_length=64)
    reason: str = Field(default="后台调整", min_length=1, max_length=200)


class PolicyPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    section: Literal["accounts", "quotas"]
    changes: dict
    revision: str = Field(min_length=64, max_length=64)
    reason: str = Field(min_length=1, max_length=200)


class SessionRevoke(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str | None = Field(default=None, min_length=64, max_length=64)
    reason: str = Field(min_length=1, max_length=200)


def revision(values: dict) -> str:
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def stamp(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat() if value else None


def account_view(account):
    return {"id": account.id, "display_name": account.display_name, "email": account.email,
            "role": account_role(account), "active": account.active, "created_at": stamp(account.created_at)}


def override_values(db, account_id):
    row = db.get(AccountQuotaOverride, account_id)
    return row.limits if row else {}


def account_revision(db, account):
    return revision({**account_view(account), "limits": override_values(db, account.id)})


def role_expression():
    owner = get_settings().account_owner_email.strip().casefold()
    return case((and_(func.lower(UserAccount.email) == owner, UserAccount.password_hash != "", bool(owner)), "owner"),
                (UserAccount.role.in_(["trusted", "admin"]), UserAccount.role), else_="member")


def private_response(response: Response):
    response.headers["Cache-Control"] = "no-store"


def commit_audited(db, request, *, changes, reason):
    """If audit persistence fails, the account/policy edit rolls back too."""
    request_id = getattr(request.state, "audit_request_id", None) or uuid.uuid4().hex
    action = audit_action(request.method, request.url.path)
    reason = safe_text(reason.strip())
    if not reason:
        raise HTTPException(422, "请填写操作原因")
    db.add(OperationalLog(event_key="admin:" + request_id, origin="admin", kind="audit", occurred_at=now(),
        actor=safe_text(getattr(request.state, "audit_actor", "") or "administrator", 120), request_id=request_id,
        action=action, target=request.url.path, summary=safe_text(f"{action} · {reason}", 600),
        status_code=200, outcome="success", level="INFO", duration_ms=0,
        detail={"method": request.method, "path": request.url.path, "note": reason, "policy_changes": changes}))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(503, "管理操作未保存，请稍后重试") from None
    request.state.audit_persisted = True


def lock_policy(db):
    # The same database write lock used by model-budget admission, not a process-local lock.
    if db.bind.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    db.execute(insert(AccountPolicy).values(id=1, values={}, lock_version=0).on_conflict_do_nothing())
    db.execute(update(AccountPolicy).where(AccountPolicy.id == 1).values(lock_version=AccountPolicy.lock_version + 1))
    db.expire_all()


def lock_account(db, account_id):
    changed = db.execute(update(UserAccount).where(UserAccount.id == account_id)
                         .values(auth_version=UserAccount.auth_version + 1)).rowcount
    if not changed:
        raise HTTPException(404, "账号不存在")
    db.expire_all()
    account = db.get(UserAccount, account_id)
    if account_role(account) == "owner":
        raise HTTPException(409, "站点所有者受保护，不能在这里停用、改角色或限制额度")
    return account


def check_provider_ids(db, identifiers):
    known = set(db.scalars(select(ProviderConfig.id))) | {"default"}
    if set(identifiers) - known:
        raise HTTPException(422, "额度配置包含不存在的模型供应商，请刷新后重试")


def model_row(row, names=None):
    return {"id": row.id, "owner_id": row.owner_id, "display_name": (names or {}).get(row.owner_id, row.owner_id),
            "session_id": row.session_id, "invocation_id": row.invocation_id, "provider_id": row.provider_id,
            "model": row.model, "units": row.units, "prompt_tokens": row.prompt_tokens,
            "completion_tokens": row.completion_tokens, "status": row.status,
            "exempt": row.exempt, "created_at": stamp(row.created_at)}


def account_admin_router(require_admin, mail_ready, public_config):
    router = APIRouter(tags=["account-administration"], dependencies=[Depends(require_admin), Depends(private_response)])

    @router.get("/api/admin/accounts")
    def administration(db: Session = Depends(get_db)):
        policy = get_policy(db).model_dump()
        rows = db.scalars(select(UserAccount).order_by(UserAccount.created_at.desc()).limit(100)).all()
        counts = {"total": db.scalar(select(func.count()).select_from(UserAccount)) or 0,
                  "active": db.scalar(select(func.count()).select_from(UserAccount).where(UserAccount.active.is_(True))) or 0}
        return {**public_config(db), "policy": policy, "policy_revision": revision(policy), "mail_configured": mail_ready(),
                "model_providers": [{"id": p.id, "name": p.name, "active": p.active} for p in db.scalars(select(ProviderConfig))],
                "counts": {**counts, "disabled": counts["total"] - counts["active"]},
                "accounts": [account_view(r) for r in rows],
                "model_usage": [model_row(r) for r in db.scalars(select(ModelUsage).order_by(ModelUsage.created_at.desc()).limit(50))],
                "usage": [{"id": e.id, "owner_id": e.owner_id, "session_id": e.session_id, "resource": e.resource,
                           "amount": e.amount, "status": e.status, "prompt_tokens": e.prompt_tokens,
                           "completion_tokens": e.completion_tokens, "child_calls": e.child_calls}
                          for e in db.scalars(select(QuotaEntry).order_by(QuotaEntry.created_at.desc()).limit(50))]}

    @router.get("/api/admin/accounts/users")
    def users(q: str = Query(default="", max_length=128), role: Literal["all", "owner", "member", "trusted", "admin"] = "all",
              status: Literal["all", "active", "disabled"] = "all", page: int = Query(default=1, ge=1, le=100000),
              page_size: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)):
        conditions = []
        if q.strip():
            term = q.strip().casefold()
            conditions.append(or_(func.lower(UserAccount.email).contains(term, autoescape=True),
                                  func.lower(UserAccount.display_name).contains(term, autoescape=True), UserAccount.id.contains(term, autoescape=True)))
        if role != "all":
            conditions.append(role_expression() == role)
        if status != "all":
            conditions.append(UserAccount.active.is_(status == "active"))
        total = db.scalar(select(func.count()).select_from(UserAccount).where(*conditions)) or 0
        rows = db.scalars(select(UserAccount).where(*conditions).order_by(UserAccount.created_at.desc(), UserAccount.id)
                          .offset((page - 1) * page_size).limit(page_size)).all()
        last_login = dict(db.execute(select(LoginSession.account_id, func.max(LoginSession.created_at))
            .where(LoginSession.account_id.in_([r.id for r in rows])).group_by(LoginSession.account_id)).all())
        customized = set(db.scalars(select(AccountQuotaOverride.account_id).where(AccountQuotaOverride.account_id.in_([r.id for r in rows]))))
        return {"items": [{**account_view(r), "last_login_at": stamp(last_login.get(r.id)), "custom_quota": r.id in customized} for r in rows],
                "total": total, "page": page, "page_size": page_size}

    @router.get("/api/admin/accounts/users/{account_id}")
    def user_detail(account_id: str, db: Session = Depends(get_db)):
        account = db.get(UserAccount, account_id)
        if not account:
            raise HTTPException(404, "账号不存在")
        sessions = db.scalars(select(LoginSession).where(LoginSession.account_id == account_id, LoginSession.revoked.is_(False),
            LoginSession.expires_at > now()).order_by(LoginSession.created_at.desc()).limit(100)).all()
        audit = db.scalars(select(OperationalLog).where(OperationalLog.origin == "admin",
            OperationalLog.detail["policy_changes"]["account_id"].as_string() == account_id)
            .order_by(OperationalLog.id.desc()).limit(20)).all()
        return {"account": account_view(account), "revision": account_revision(db, account), "limits": override_values(db, account_id),
                "quota": quotas.snapshot(db, "account_" + account_id),
                "login_methods": (["email"] if account.password_hash else []) + list(db.scalars(select(AccountIdentity.provider).where(AccountIdentity.account_id == account_id))),
                "sessions": [{"id": s.token_hash, "created_at": stamp(s.created_at), "expires_at": stamp(s.expires_at)} for s in sessions],
                "audit": [{"id": a.id, "actor": a.actor, "action": a.action, "created_at": stamp(a.occurred_at),
                           "note": a.detail.get("note", ""), "changes": a.detail.get("policy_changes", {})} for a in audit]}

    @router.patch("/api/admin/accounts/users/{account_id}", dependencies=[Depends(require_same_origin)])
    def update_account(account_id: str, payload: AccountUpdate, request: Request, db: Session = Depends(get_db)):
        if not payload.model_fields_set.intersection({"role", "active", "display_name", "limits"}):
            raise HTTPException(422, "没有需要保存的修改")
        account = lock_account(db, account_id)
        if payload.revision and payload.revision != account_revision(db, account):
            raise HTTPException(409, "账号已被其他管理员修改，请刷新后重试")
        before = {"role": account.role, "active": account.active, "limits": override_values(db, account_id)}
        if payload.role is not None:
            account.role = payload.role
        if payload.active is not None:
            account.active = payload.active
        if payload.display_name is not None:
            if not payload.display_name.strip():
                raise HTTPException(422, "显示名称不能为空")
            account.display_name = payload.display_name.strip()
        if "limits" in payload.model_fields_set:
            values = payload.limits.model_dump(exclude_none=True) if payload.limits else {}
            if not values.get("provider_monthly_units"):
                values.pop("provider_monthly_units", None)
            check_provider_ids(db, values.get("provider_monthly_units", {}))
            row = db.get(AccountQuotaOverride, account_id)
            if values:
                row = row or AccountQuotaOverride(account_id=account_id)
                row.limits = values
                db.add(row)
            elif row:
                db.delete(row)
        revoked = 0
        if not account.active or account.role != before["role"]:
            revoked = db.execute(update(LoginSession).where(LoginSession.account_id == account_id, LoginSession.revoked.is_(False))
                                  .values(revoked=True)).rowcount
        db.flush()
        changes = {"account_id": account_id, "before": before,
                   "after": {"role": account.role, "active": account.active, "limits": override_values(db, account_id)},
                   "display_name_changed": payload.display_name is not None, "revoked_sessions": revoked}
        commit_audited(db, request, changes=changes, reason=payload.reason)
        return {**account_view(account), "revision": account_revision(db, account)}

    @router.post("/api/admin/accounts/users/{account_id}/sessions/revoke", dependencies=[Depends(require_same_origin)])
    def revoke_sessions(account_id: str, payload: SessionRevoke, request: Request, db: Session = Depends(get_db)):
        lock_account(db, account_id)
        conditions = [LoginSession.account_id == account_id, LoginSession.revoked.is_(False), LoginSession.expires_at > now()]
        if payload.session_id:
            conditions.append(LoginSession.token_hash == payload.session_id)
        count = db.execute(update(LoginSession).where(*conditions).values(revoked=True)).rowcount
        if payload.session_id and not count:
            raise HTTPException(404, "登录会话不存在或已失效")
        commit_audited(db, request, changes={"account_id": account_id, "revoked_sessions": count}, reason=payload.reason)
        return {"ok": True, "revoked_sessions": count}

    def save_policy(db, request, policy, before, reason):
        check_provider_ids(db, policy.provider_budgets)
        if policy.accounts_enabled and policy.email_enabled and not mail_ready():
            raise HTTPException(409, "请先配置邮件通道，再启用邮箱账号")
        row = db.get(AccountPolicy, 1)
        row.values = policy.model_dump()
        changed = {key for key in before if before[key] != row.values.get(key)}
        commit_audited(db, request, changes={"before": {k: before[k] for k in changed}, "after": {k: row.values[k] for k in changed}}, reason=reason)
        return {"policy": policy.model_dump(), "policy_revision": revision(policy.model_dump())}

    @router.patch("/api/admin/accounts/policy", dependencies=[Depends(require_same_origin)])
    def patch_policy(payload: PolicyPatch, request: Request, db: Session = Depends(get_db)):
        lock_policy(db)
        before = get_policy(db).model_dump()
        if payload.revision != revision(before):
            raise HTTPException(409, "配置已被其他管理员修改，请刷新后重试")
        allowed = {"accounts_enabled", "email_enabled"}
        if payload.section == "quotas":
            allowed = set(Policy.model_fields) - allowed
        if not payload.changes or set(payload.changes) - allowed:
            raise HTTPException(422, "请只提交当前标签页的设置")
        try:
            policy = Policy(**{**before, **payload.changes})
        except ValidationError:
            raise HTTPException(422, "额度配置超出允许范围") from None
        return save_policy(db, request, policy, before, payload.reason)

    @router.put("/api/admin/accounts/policy", dependencies=[Depends(require_same_origin)])
    def replace_policy(payload: Policy, request: Request, db: Session = Depends(get_db)):
        lock_policy(db)
        return save_policy(db, request, payload, get_policy(db).model_dump(), "完整更新账号及配额策略")

    # Keep the old endpoint, after the literal /policy route to avoid shadowing it.
    router.add_api_route("/api/admin/accounts/{account_id}", update_account, methods=["PATCH"],
                         dependencies=[Depends(require_same_origin)])

    @router.get("/api/admin/quotas/usage")
    def usage(owner_id: str = Query(default="", max_length=128), provider_id: str = Query(default="", max_length=64),
              status: Literal["all", "reserved", "actual", "estimated"] = "all", page: int = Query(default=1, ge=1, le=100000),
              page_size: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db)):
        conditions = [ModelUsage.created_at >= now() - timedelta(days=30)]
        if owner_id:
            conditions.append(ModelUsage.owner_id == owner_id)
        if provider_id:
            conditions.append(ModelUsage.provider_id == provider_id)
        if status != "all":
            conditions.append(ModelUsage.status == status)
        total, units = db.execute(select(func.count(), func.coalesce(func.sum(ModelUsage.units), 0)).where(*conditions)).one()
        rows = db.scalars(select(ModelUsage).where(*conditions).order_by(ModelUsage.created_at.desc(), ModelUsage.id)
                          .offset((page - 1) * page_size).limit(page_size)).all()
        owners = [r.owner_id.removeprefix("account_") for r in rows if r.owner_id.startswith("account_")]
        names = {"account_" + r.id: r.display_name for r in db.scalars(select(UserAccount).where(UserAccount.id.in_(owners)))}
        return {"items": [model_row(r, names) for r in rows], "total": total, "units": units,
                "page": page, "page_size": page_size, "window_days": 30}

    return router
