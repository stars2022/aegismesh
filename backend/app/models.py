from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    aic: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(24), default="partner")
    description: Mapped[str] = mapped_column(Text, default="")
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    endpoint_url: Mapped[str] = mapped_column(String(512), default="")
    transport: Mapped[str] = mapped_column(String(32), default="openai-compatible")
    usage_mode: Mapped[str] = mapped_column(String(16), default="both")
    streaming_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    notification_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    group_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    health: Mapped[str] = mapped_column(String(24), default="unknown")
    input_modes: Mapped[list[str]] = mapped_column(JSON, default=list)
    output_modes: Mapped[list[str]] = mapped_column(JSON, default=list)
    security_schemes: Mapped[list[str]] = mapped_column(JSON, default=list)
    skills: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    tools: Mapped[list[str]] = mapped_column(JSON, default=list)
    model_provider: Mapped[str] = mapped_column(String(80), default="")
    model_name: Mapped[str] = mapped_column(String(120), default="")
    estimated_cost_per_1k: Mapped[float] = mapped_column(Float, default=0.0)
    avg_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    feedback_positive_count: Mapped[int] = mapped_column(Integer, default=0)
    feedback_negative_count: Mapped[int] = mapped_column(Integer, default=0)
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    active_tasks: Mapped[int] = mapped_column(Integer, default=0)
    queued_tasks: Mapped[int] = mapped_column(Integer, default=0)
    circuit_state: Mapped[str] = mapped_column(String(24), default="closed")
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    circuit_open_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    registration_status: Mapped[str] = mapped_column(String(24), default="local")
    registration_agent_id: Mapped[str] = mapped_column(String(64), default="")
    registration_message: Mapped[str] = mapped_column(Text, default="")
    registration_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    eab_key_id: Mapped[str] = mapped_column(String(128), default="")
    eab_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    certificate_issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class AdminAccount(Base):
    __tablename__ = "admin_accounts"

    username: Mapped[str] = mapped_column(String(80), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    password_salt: Mapped[str] = mapped_column(String(64))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class OperationalLog(Base):
    """Local, redacted read model. Never part of the official AMP forwarding path."""
    __tablename__ = "operational_logs"
    __table_args__ = (Index("ix_operational_logs_time_id", "occurred_at", "id"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_key: Mapped[str] = mapped_column(String(128), unique=True)
    origin: Mapped[str] = mapped_column(String(16), index=True)  # amp / admin
    kind: Mapped[str] = mapped_column(String(24), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    indexed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    level: Mapped[str] = mapped_column(String(16), default="INFO")
    outcome: Mapped[str] = mapped_column(String(16), default="unknown", index=True)
    aic: Mapped[str] = mapped_column(String(255), default="", index=True)
    caller_aic: Mapped[str] = mapped_column(String(255), default="", index=True)
    callee_aic: Mapped[str] = mapped_column(String(255), default="", index=True)
    task_id: Mapped[str] = mapped_column(String(255), default="", index=True)
    trace_id: Mapped[str] = mapped_column(String(255), default="", index=True)
    message_id: Mapped[str] = mapped_column(String(255), default="", index=True)
    request_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    actor: Mapped[str] = mapped_column(String(120), default="", index=True)
    action: Mapped[str] = mapped_column(String(120), default="")
    target: Mapped[str] = mapped_column(String(512), default="")
    summary: Mapped[str] = mapped_column(String(600), default="")
    status_code: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[float | None] = mapped_column(Float)
    source_file: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class LogIngestCursor(Base):
    __tablename__ = "log_ingest_cursors"

    source_file: Mapped[str] = mapped_column(String(120), primary_key=True)
    identity: Mapped[str] = mapped_column(String(80), default="")
    byte_offset: Mapped[int] = mapped_column(Integer, default=0)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    checkpoint: Mapped[str] = mapped_column(String(64), default="")
    skipping_line: Mapped[bool] = mapped_column(Boolean, default=False)
    invalid_lines: Mapped[int] = mapped_column(Integer, default=0)
    expired_lines: Mapped[int] = mapped_column(Integer, default=0)
    rotations: Mapped[int] = mapped_column(Integer, default=0)
    rotation_gaps: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(String(120), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PlatformAccess(Base):
    __tablename__ = "platform_access"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    api_key_hash: Mapped[str] = mapped_column(String(128), default="")
    api_key_salt: Mapped[str] = mapped_column(String(64), default="")
    demo_password_hash: Mapped[str] = mapped_column(String(128), default="")
    demo_password_salt: Mapped[str] = mapped_column(String(64), default="")
    demo_session_secret: Mapped[str] = mapped_column(String(128), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class ProviderConfig(Base):
    __tablename__ = "provider_configs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    kind: Mapped[str] = mapped_column(String(32))
    base_url: Mapped[str] = mapped_column(String(512))
    api_key_ciphertext: Mapped[str] = mapped_column(Text, default="")
    api_key_env: Mapped[str] = mapped_column(String(120), default="")
    default_model: Mapped[str] = mapped_column(String(120), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class WebSearchConfig(Base):
    __tablename__ = "web_search_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    # Preserve pre-upgrade behavior until an administrator explicitly opts in.
    backend: Mapped[str] = mapped_column(String(24), default="legacy")
    deepseek_provider_id: Mapped[str] = mapped_column(String(64), default="")
    exa_api_key_ciphertext: Mapped[str] = mapped_column(Text, default="")
    timeout_seconds: Mapped[float] = mapped_column(Float, default=30.0)
    max_results: Mapped[int] = mapped_column(Integer, default=5)
    max_queries: Mapped[int] = mapped_column(Integer, default=8)


class RoutingPolicy(Base):
    __tablename__ = "routing_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    name: Mapped[str] = mapped_column(String(80), default="balanced")
    interop_compatibility: Mapped[bool] = mapped_column(Boolean, default=False)
    external_delegation_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    weights: Mapped[dict[str, float]] = mapped_column(JSON)
    failure_threshold: Mapped[int] = mapped_column(Integer, default=2)
    circuit_cooldown_seconds: Mapped[int] = mapped_column(Integer, default=30)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    request_timeout_seconds: Mapped[float] = mapped_column(Float, default=60.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Invocation(Base):
    __tablename__ = "invocations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(128), index=True)
    owner_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    query: Mapped[str] = mapped_column(Text)
    requested_skill: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(32), default="routing")
    selected_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    result_text: Mapped[str | None] = mapped_column(Text)
    result_data: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    total_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    attempts: Mapped[list["RouteAttempt"]] = relationship(
        back_populates="invocation", cascade="all, delete-orphan"
    )
    events: Mapped[list["TraceEvent"]] = relationship(
        back_populates="invocation", cascade="all, delete-orphan"
    )


class InvocationFeedback(Base):
    __tablename__ = "invocation_feedback"

    invocation_id: Mapped[str] = mapped_column(
        ForeignKey("invocations.id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    owner_id: Mapped[str] = mapped_column(String(128), index=True)
    rating: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class RouteAttempt(Base):
    __tablename__ = "route_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invocation_id: Mapped[str] = mapped_column(ForeignKey("invocations.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    rank: Mapped[int] = mapped_column(Integer)
    score: Mapped[float] = mapped_column(Float)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(32), default="candidate")
    latency_ms: Mapped[float | None] = mapped_column(Float)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    invocation: Mapped[Invocation] = relationship(back_populates="attempts")


class TraceEvent(Base):
    __tablename__ = "trace_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invocation_id: Mapped[str] = mapped_column(ForeignKey("invocations.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(48))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    invocation: Mapped[Invocation] = relationship(back_populates="events")


class ProbeResult(Base):
    __tablename__ = "probe_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    status: Mapped[str] = mapped_column(String(24))
    latency_ms: Mapped[float | None] = mapped_column(Float)
    acs_valid: Mapped[bool] = mapped_column(Boolean, default=False)
    aip_reachable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    compatibility_score: Mapped[float] = mapped_column(Float, default=0)
    findings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class HostedTask(Base):
    __tablename__ = "hosted_tasks"

    task_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    external_task_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    owner_peer_aic: Mapped[str] = mapped_column(String(255), default="", index=True)
    session_id: Mapped[str] = mapped_column(String(128), index=True)
    state: Mapped[str] = mapped_column(String(32), default="accepted")
    query: Mapped[str] = mapped_column(Text, default="")
    result_text: Mapped[str] = mapped_column(Text, default="")
    result_data: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    command_history: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    state_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AipNotification(Base):
    __tablename__ = "aip_notifications"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    owner_peer_aic: Mapped[str] = mapped_column(String(255), default="", index=True)
    task_id: Mapped[str] = mapped_column(String(128), index=True)
    url: Mapped[str] = mapped_column(String(512))
    token: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GroupChat(Base):
    __tablename__ = "group_chats"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    name: Mapped[str] = mapped_column(String(120))
    host_agent_id: Mapped[str] = mapped_column(String(64), default="")
    members: Mapped[list[str]] = mapped_column(JSON, default=list)
    transport: Mapped[str] = mapped_column(String(16), default="local")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GroupChatMessage(Base):
    __tablename__ = "group_chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[str] = mapped_column(String(64), index=True)
    sender_id: Mapped[str] = mapped_column(String(128), default="")
    sender_name: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[str] = mapped_column(String(16), default="agent")
    msg_type: Mapped[str] = mapped_column(String(16), default="chat")
    nickname: Mapped[str] = mapped_column(String(120), default="")
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CanvasDoc(Base):
    __tablename__ = "canvas_docs"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    title: Mapped[str] = mapped_column(String(160), default="未命名画布")
    content: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class CanvasRevision(Base):
    __tablename__ = "canvas_revisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    canvas_id: Mapped[str] = mapped_column(String(80), index=True)
    version: Mapped[int] = mapped_column(Integer)
    editor_id: Mapped[str] = mapped_column(String(128), default="")
    editor_name: Mapped[str] = mapped_column(String(120), default="")
    op: Mapped[str] = mapped_column(String(32), default="write_section")
    summary: Mapped[str] = mapped_column(String(255), default="")
    content_after: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
