"""Server-owned switches and role allowances, never supplied by a chat request."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..account_models import AccountPolicy, AccountQuotaOverride, UserAccount
from ..config import get_settings
from ..database import SessionLocal


Role = Literal["guest", "member", "trusted", "admin", "service"]


class AccountLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    daily_tasks: int | None = Field(default=None, ge=0, le=10000)
    concurrent_tasks: int | None = Field(default=None, ge=0, le=32)
    daily_upload_bytes: int | None = Field(default=None, ge=0, le=1073741824)
    monthly_units: int | None = Field(default=None, ge=0, le=1000000000)
    exempt: bool | None = None
    provider_monthly_units: dict[str, Annotated[int, Field(ge=0, le=1000000000)]] = Field(default_factory=dict, max_length=100)


class RoleLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    daily_tasks: int = Field(default=20, ge=1, le=10000)
    concurrent_tasks: int = Field(default=2, ge=1, le=32)
    daily_upload_bytes: int = Field(default=104857600, ge=1024, le=1073741824)
    monthly_units: int = Field(default=1600000, ge=1000, le=1000000000)
    exempt: bool = False


class ProviderBudget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    monthly_units: int = Field(default=160000000, ge=1000, le=2000000000)
    output_tokens: int = Field(default=4096, ge=512, le=16384)
    role_monthly_units: dict[Role, Annotated[int, Field(ge=1000, le=1000000000)]] = Field(default_factory=dict)


class Policy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accounts_enabled: bool = False
    email_enabled: bool = False
    quota_mode: Literal["off", "observe", "enforce"] = "off"
    daily_tasks: int = Field(default=20, ge=1, le=10000)
    concurrent_tasks: int = Field(default=2, ge=1, le=32)
    daily_upload_bytes: int = Field(default=104857600, ge=1024, le=1073741824)
    guest_turns: int = Field(default=3, ge=1, le=100)
    member_monthly_units: int = Field(default=1600000, ge=1000, le=1000000000)
    public_monthly_units: int = Field(default=160000000, ge=1000, le=2000000000)
    model_output_tokens: int = Field(default=4096, ge=512, le=16384)
    roles: dict[Role, RoleLimits] = Field(default_factory=dict)
    provider_budgets: dict[str, ProviderBudget] = Field(default_factory=dict, max_length=100)


def get_policy(db: Session | None = None) -> Policy:
    if db is None:
        with SessionLocal() as own:
            return get_policy(own)
    cfg = get_settings()
    values = dict(accounts_enabled=cfg.accounts_enabled, email_enabled=cfg.account_email_enabled,
                  quota_mode=cfg.quota_mode, daily_tasks=cfg.quota_daily_tasks,
                  concurrent_tasks=cfg.quota_concurrent_tasks, daily_upload_bytes=cfg.quota_daily_upload_bytes,
                  guest_turns=cfg.quota_guest_turns, member_monthly_units=cfg.quota_member_monthly_units,
                  public_monthly_units=cfg.quota_public_monthly_units, model_output_tokens=cfg.quota_model_output_tokens)
    row = db.get(AccountPolicy, 1)
    return Policy(**{**values, **(row.values if row else {})})


def account_role(account: UserAccount) -> str:
    owner_email = get_settings().account_owner_email.strip().casefold()
    # Email is only set on successful verification, never from an OAuth profile.
    if owner_email and account.email and account.password_hash and account.email.casefold() == owner_email:
        return "owner"
    return account.role if account.role in {"member", "trusted", "admin"} else "member"


def owner_role(db: Session, owner: str) -> str:
    if owner.startswith("account_"):
        account = db.get(UserAccount, owner.removeprefix("account_"))
        return account_role(account) if account and account.active else "guest"
    return "guest" if owner.startswith(("guest_", "demo_")) else "service"


def allowances(db: Session, owner: str) -> dict:
    policy = get_policy(db)
    role = owner_role(db, owner)
    multiplier = 3 if role == "trusted" else 1
    result = {"role": role, "exempt": role in {"owner", "admin"},
            "tasks": policy.guest_turns if role == "guest" and policy.accounts_enabled else policy.daily_tasks * multiplier,
            "task_period": "lifetime" if role == "guest" and policy.accounts_enabled else "daily",
            "concurrency": 1 if role == "guest" else policy.concurrent_tasks,
            "upload_bytes": policy.daily_upload_bytes * multiplier,
            "model_units": min(160000, policy.member_monthly_units) if role == "guest" else policy.member_monthly_units * multiplier}
    custom = policy.roles.get(role)
    if custom:
        result.update(tasks=policy.guest_turns if result["task_period"] == "lifetime" else custom.daily_tasks,
                      concurrency=custom.concurrent_tasks, upload_bytes=custom.daily_upload_bytes,
                      model_units=custom.monthly_units, exempt=custom.exempt)
    result["provider_units"] = {}
    if owner.startswith("account_") and role not in {"owner", "guest"}:
        override = db.get(AccountQuotaOverride, owner.removeprefix("account_"))
        if override:
            values = AccountLimits(**override.limits).model_dump(exclude_none=True)
            for source, target in {"daily_tasks": "tasks", "concurrent_tasks": "concurrency",
                                   "daily_upload_bytes": "upload_bytes", "monthly_units": "model_units",
                                   "exempt": "exempt", "provider_monthly_units": "provider_units"}.items():
                if source in values:
                    result[target] = values[source]
    return result


def provider_allowance(limits: dict, policy: Policy, provider_id: str) -> int:
    if provider_id in limits.get("provider_units", {}):
        return limits["provider_units"][provider_id]
    provider = policy.provider_budgets.get(provider_id)
    return provider.role_monthly_units.get(limits["role"], limits["model_units"]) if provider else limits["model_units"]
