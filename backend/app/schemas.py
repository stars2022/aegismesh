from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _valid_http_url(value: str) -> bool:
    parts = urlsplit(value)
    return parts.scheme in {"http", "https"} and bool(parts.netloc)


class Skill(BaseModel):
    id: str
    name: str
    description: str = ""
    version: str = "1.0.0"
    system_prompt: str = ""
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)
    input_modes: list[str] = Field(default_factory=lambda: ["text/plain"])
    output_modes: list[str] = Field(default_factory=lambda: ["application/json"])


class AgentBase(BaseModel):
    aic: str = ""
    name: str
    role: Literal["leader", "partner"] = "partner"
    description: str = ""
    system_prompt: str = ""
    endpoint_url: str = ""
    transport: Literal["provider", "openai-compatible", "openai-responses", "anthropic", "aip-rpc"] = "provider"
    usage_mode: Literal["both", "internal", "external"] = "both"
    streaming_enabled: bool = True
    notification_enabled: bool = False
    group_enabled: bool = False
    active: bool = True
    health: str = "unknown"
    input_modes: list[str] = Field(default_factory=lambda: ["text/plain"])
    output_modes: list[str] = Field(default_factory=lambda: ["application/json"])
    security_schemes: list[str] = Field(default_factory=list)
    skills: list[Skill] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    model_provider: str = ""
    model_name: str = ""
    estimated_cost_per_1k: float = 0.0

    @field_validator("aic")
    @classmethod
    def validate_aic(cls, value: str) -> str:
        from acps_sdk.aic import validate_aic_format

        value = value.strip().upper()
        if not value:
            return ""
        valid, error = validate_aic_format(value)
        if not valid:
            raise ValueError(error)
        return value


class AgentCreate(AgentBase):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def reject_blank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("名称不能为空白")
        return value

    @field_validator("endpoint_url")
    @classmethod
    def validate_endpoint_url(cls, value: str) -> str:
        if value and not _valid_http_url(value):
            raise ValueError("端点地址必须是有效的 http(s) URL")
        return value

    @model_validator(mode="after")
    def validate_transport_requirements(self) -> AgentCreate:
        if self.transport == "aip-rpc" and not self.endpoint_url:
            raise ValueError("AIP 智能体必须填写 AIP 端点地址")
        if self.transport == "provider" and not self.model_provider:
            raise ValueError("托管模型智能体必须选择模型供应商")
        return self


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    endpoint_url: str | None = None
    transport: Literal["provider", "openai-compatible", "openai-responses", "anthropic", "aip-rpc"] | None = None
    usage_mode: Literal["both", "internal", "external"] | None = None
    streaming_enabled: bool | None = None
    notification_enabled: bool | None = None
    group_enabled: bool | None = None
    active: bool | None = None
    input_modes: list[str] | None = None
    output_modes: list[str] | None = None
    security_schemes: list[str] | None = None
    skills: list[Skill] | None = None
    tools: list[str] | None = None
    model_provider: str | None = None
    model_name: str | None = None
    estimated_cost_per_1k: float | None = None

    @field_validator("endpoint_url")
    @classmethod
    def validate_endpoint_url(cls, value: str | None) -> str | None:
        if value and not _valid_http_url(value):
            raise ValueError("端点地址必须是有效的 http(s) URL")
        return value


class AgentRead(AgentBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    registration_status: str
    registration_agent_id: str
    registration_message: str
    registration_synced_at: datetime | None
    eab_key_id: str
    eab_expires_at: datetime | None
    certificate_issued_at: datetime | None
    avg_latency_ms: float
    success_count: int
    failure_count: int
    feedback_positive_count: int
    feedback_negative_count: int
    request_count: int
    active_tasks: int
    queued_tasks: int
    circuit_state: str
    consecutive_failures: int
    circuit_open_until: datetime | None
    updated_at: datetime


class PolicyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    weights: dict[str, float]
    failure_threshold: int
    circuit_cooldown_seconds: int
    max_attempts: int
    request_timeout_seconds: float


class PolicyUpdate(PolicyRead):
    pass


class FeedbackRequest(BaseModel):
    rating: Literal["positive", "negative"]


class FeedbackRead(BaseModel):
    invocation_id: str
    agent_id: str
    rating: Literal["positive", "negative"]
    positive_count: int
    negative_count: int


class Attachment(BaseModel):
    file_id: str
    filename: str
    content_type: str = "text/plain"
    size: int = 0
    url: str | None = None
    is_image: bool = False
    extracted_text: str | None = None
    text_length: int = 0


class UploadResponse(BaseModel):
    ok: bool = True
    file_id: str
    filename: str
    content_type: str
    size: int
    url: str
    is_image: bool = False
    extracted_text_preview: str | None = None
    extracted_text: str | None = None
    text_length: int = 0


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=50_000)
    attachments: list[Attachment] = Field(default_factory=list)
    session_id: str | None = None
    agent_id: str | None = Field(default=None, max_length=64)
    requested_skill: str | None = None
    input_mode: str = "text/plain"
    output_mode: str = "application/json"
    required_security: str | None = None
    required_transport: str | None = None
    mode: Literal["route", "collaborate"] = "route"
    max_partners: int = Field(default=2, ge=2, le=5)
    interface: Literal["api", "harness"] = "api"
    delegation_depth: int = Field(default=0, ge=0)
    delegation_path: list[str] = Field(default_factory=list)
    root_invocation_id: str | None = None
    hard_deadline_seconds: float | None = Field(default=None, ge=0.05, le=1800.0)
    task_profile: Literal["standard", "research"] = "standard"
    expected_output_tokens: int | None = Field(default=None, ge=1, le=64000)

    @model_validator(mode="after")
    def validate_delegation_lineage(self) -> ChatRequest:
        MAX_DELEGATION_DEPTH = 3
        if self.delegation_depth > MAX_DELEGATION_DEPTH:
            raise ValueError(f"Exceeded maximum delegation depth (max depth is {MAX_DELEGATION_DEPTH})")
        if len(self.delegation_path) != len(set(self.delegation_path)):
            raise ValueError("Circular delegation detected in delegation_path")
        if self.agent_id and self.agent_id in self.delegation_path:
            raise ValueError(f"Circular delegation detected: agent '{self.agent_id}' already in delegation_path")
        return self



class RegistrationRequest(BaseModel):
    rpc_url: str | None = Field(default=None, max_length=512)


class DiscoveryQuery(BaseModel):
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=5, ge=1, le=50)
    session_id: str | None = Field(default=None, max_length=128)
    recent_turns: list[str] = Field(default_factory=list, max_length=8)


class DiscoveryImportRequest(BaseModel):
    aic: str = Field(min_length=3, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=4096)
    endpoint: str | None = Field(default=None, max_length=512)
    endpoint_mtls: str | None = Field(default=None, max_length=512)
    transport: str = Field(default="aip", max_length=32)
    skills: list[dict] = Field(default_factory=list)
    streaming: bool | None = None
    notification: bool | None = None
    alive: bool | None = None
    group: bool | None = None



class AdminLogin(BaseModel):
    username: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=256)


class AccessUpdate(BaseModel):
    api_key: str | None = Field(default=None, min_length=16, max_length=256)
    clear_api_key: bool = False
    demo_password: str | None = Field(default=None, min_length=8, max_length=256)
    clear_demo_password: bool = False


class DemoLogin(BaseModel):
    password: str = Field(min_length=8, max_length=256)


class ProviderCreate(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["openai-chat", "openai-responses", "anthropic"]
    base_url: str = Field(min_length=8, max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    api_key_env: str = Field(default="", max_length=120, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$|^$")
    default_model: str = Field(min_length=1, max_length=120)
    active: bool = True


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: Literal["openai-chat", "openai-responses", "anthropic"] | None = None
    base_url: str | None = Field(default=None, min_length=8, max_length=512)
    api_key: str | None = Field(default=None, max_length=512)
    clear_api_key: bool = False
    api_key_env: str | None = Field(default=None, max_length=120, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$|^$")
    default_model: str | None = Field(default=None, min_length=1, max_length=120)
    active: bool | None = None


class ProviderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: str
    base_url: str
    api_key_env: str
    default_model: str
    active: bool
    key_configured: bool
    updated_at: datetime


class DatabaseImportPayload(BaseModel):
    mode: Literal["merge", "replace"] = "merge"
    data: dict[str, Any]


class CandidateScore(BaseModel):
    agent_id: str
    agent_name: str
    eligible: bool
    score: float
    rank: int | None = None
    breakdown: dict[str, float]
    reasons: list[str]
    weights: dict[str, float] = Field(default_factory=dict)


class ChatResponse(BaseModel):
    invocation_id: str
    session_id: str
    status: str
    answer: str
    selected_agent: AgentRead | None
    candidates: list[CandidateScore]
    failover_count: int
    latency_ms: float
    usage: dict[str, int]
    result_data: dict[str, Any] | None = None


class TraceRead(BaseModel):
    id: str
    session_id: str
    query: str
    status: str
    selected_agent_id: str | None
    result_text: str | None = None
    result_data: dict[str, Any] | None = None
    total_latency_ms: float
    attempt_count: int
    llm_calls: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    created_at: datetime
    finished_at: datetime | None
    attempts: list[dict[str, Any]]
    events: list[dict[str, Any]]


class ProbeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agent_id: str
    status: str
    latency_ms: float | None
    acs_valid: bool
    aip_reachable: bool | None
    compatibility_score: float
    findings: list[dict[str, Any]]
    snapshot: dict[str, Any]
    created_at: datetime
