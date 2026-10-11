"""Additive account/ownership/usage tables; importing does not enable login."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base
from .models import utcnow


class UserAccount(Base):
    __tablename__ = "user_accounts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(254), unique=True)
    display_name: Mapped[str] = mapped_column(String(80), default="用户")
    role: Mapped[str] = mapped_column(String(24), default="member")
    password_hash: Mapped[str] = mapped_column(String(128), default="")
    password_salt: Mapped[str] = mapped_column(String(64), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    auth_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AccountIdentity(Base):
    __tablename__ = "account_identities"
    __table_args__ = (UniqueConstraint("provider", "namespace", "subject"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    provider: Mapped[str] = mapped_column(String(24))
    namespace: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(255))


class LoginSession(Base):
    __tablename__ = "login_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    account_id: Mapped[str | None] = mapped_column(ForeignKey("user_accounts.id"), index=True)
    previous_guest_owner: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class AccountChallenge(Base):
    __tablename__ = "account_challenges"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    purpose: Mapped[str] = mapped_column(String(32))
    owner_id: Mapped[str] = mapped_column(String(128))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ConversationHistory(Base):
    """Browser transcript snapshots. Deletion hides history, never task/audit evidence."""
    __tablename__ = "conversation_histories"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class QuotaBucket(Base):
    __tablename__ = "quota_buckets"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    period: Mapped[str] = mapped_column(String(16))
    resource: Mapped[str] = mapped_column(String(24))
    used: Mapped[int] = mapped_column(Integer, default=0)
    reserved: Mapped[int] = mapped_column(Integer, default=0)


class QuotaEntry(Base):
    __tablename__ = "quota_entries"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    session_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    resource: Mapped[str] = mapped_column(String(24))
    period: Mapped[str] = mapped_column(String(16))
    amount: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(24), default="reserved")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    child_calls: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AccountPolicy(Base):
    __tablename__ = "account_policy"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    values: Mapped[dict] = mapped_column(JSON, default=dict)
    lock_version: Mapped[int] = mapped_column(Integer, default=0)


class AccountQuotaOverride(Base):
    __tablename__ = "account_quota_overrides"
    account_id: Mapped[str] = mapped_column(ForeignKey("user_accounts.id"), primary_key=True)
    limits: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ModelUsage(Base):
    __tablename__ = "model_usage"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    invocation_id: Mapped[str] = mapped_column(String(128), index=True)
    session_id: Mapped[str] = mapped_column(String(128), index=True)
    model: Mapped[str] = mapped_column(String(128))
    provider_id: Mapped[str] = mapped_column(String(64), default="default", index=True)
    units: Mapped[int] = mapped_column(Integer)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="reserved")
    exempt: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
