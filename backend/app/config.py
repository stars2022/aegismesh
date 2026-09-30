from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "AegisMesh"
    database_url: str = "sqlite:///./backend/data/aegismesh.db"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    public_api_key: str = ""
    admin_auth_enabled: bool = True
    admin_session_secret: str = ""
    admin_session_hours: int = 12
    admin_cookie_secure: bool = False
    # Staged modules: the public demo never requires a user account.
    accounts_enabled: bool = False
    account_email_enabled: bool = False
    account_session_days: int = Field(default=30, ge=1, le=90)
    guest_session_days: int = Field(default=180, ge=1, le=365)
    account_public_origin: str = ""
    account_smtp_host: str = ""
    account_smtp_port: int = 465
    account_smtp_username: str = ""
    account_smtp_password: str = ""
    account_mail_from: str = ""
    turnstile_enabled: bool = False
    turnstile_site_key: str = ""
    turnstile_secret: str = ""
    turnstile_hostnames: str = ""
    # Only a verified email account can receive this operator exemption.
    account_owner_email: str = ""
    # Provider credentials stay server-side. Nothing is enabled just by adding a key.
    account_oauth: dict[str, dict[str, str | bool]] = {}
    quota_mode: str = Field(default="off", pattern="^(off|observe|enforce)$")
    quota_daily_tasks: int = Field(default=100, ge=1)
    quota_concurrent_tasks: int = Field(default=3, ge=1)
    quota_daily_upload_bytes: int = Field(default=104857600, ge=1)
    quota_guest_turns: int = Field(default=3, ge=1, le=100)
    # Application budget units: input tokens + 4 * output tokens (cached input discounted).
    quota_member_monthly_units: int = Field(default=1600000, ge=1000)
    quota_public_monthly_units: int = Field(default=160000000, ge=1000)
    quota_model_output_tokens: int = Field(default=4096, ge=512, le=16384)
    provider_encryption_key: str = ""
    provider_secret_env_bindings: dict[str, str] = {}
    llm_api_base: str = "https://api.deepseek.com"
    llm_api_key: str = ""
    llm_model: str = "deepseek-chat"
    llm_enabled: bool = False
    openai_api_base: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    openai_model: str = "gpt-5-mini"
    anthropic_api_base: str = "https://api.anthropic.com/v1"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5"
    deepseek_search_base_url: str = "https://api.deepseek.com/anthropic/v1"
    deepseek_search_model: str = "deepseek-v4-flash"
    web_search_max_results: int = 8
    web_search_timeout_seconds: float = 60.0
    idle_watchdog_timeout_seconds: float = 60.0
    # Per-agent tool rounds; total time/cycle/dispatch caps still apply.
    coordination_tool_rounds: int = Field(default=24, ge=1, le=64)
    partner_tool_rounds: int = Field(default=12, ge=1, le=32)
    max_dispatches_per_coordinator: int = Field(default=16, ge=1, le=32)
    max_dispatches_per_task: int = Field(default=64, ge=1, le=128)
    leader_aic: str = ""
    aip_poll_interval_seconds: float = 0.8
    aip_task_timeout_seconds: float = Field(default=600.0, ge=1.0, le=1800.0)
    aip_identity_binding_enabled: bool = False
    aip_ca_file: str = ""
    aip_cert_file: str = ""
    aip_key_file: str = ""
    aip_tls_certfile: str = ""
    aip_tls_keyfile: str = ""
    aip_tls_client_ca_file: str = ""
    aip_tls_port: int = 0
    # Each distinct hosted AIC needs its own TLS authority (host + port).
    aip_agent_public_urls: dict[str, str] = {}
    aip_agent_versions: dict[str, str] = {}
    # Superseded identities remain in the official registry/history, but must
    # not be rediscovered as callable external agents by this deployment.
    aip_retired_aics: list[str] = []
    aip_tls_agent_id: str = ""
    # Set by scripts.serve after certificate validation, never by an HTTP header.
    aip_tls_local_aic: str = ""
    aip_notification_allowed_origins: list[str] = []
    aip_group_mq_url: str = ""
    public_base_url: str = ""
    aip_group_mq_host: str = ""
    aip_group_mq_port: int = 5671
    aip_group_mq_vhost: str = "acps"
    aip_group_mq_user: str = ""
    aip_group_mq_password: str = ""
    aip_group_discussion_timeout_seconds: float = 120.0
    aip_group_partner_enabled: bool = False
    aip_group_partner_agent_id: str = ""
    aip_group_auth_url: str = ""
    # Only the API worker owns inbox consumers; the mTLS worker must not compete.
    aip_group_listener_worker: bool = True
    # Dedicated TLS listeners serve requests, not duplicate probes/AMP heartbeats.
    background_worker_enabled: bool = True
    registry_api_url: str = "https://wt.ioa.pub/registry-server/api/v1"
    registry_atr_url: str = "https://wt.ioa.pub/registry"
    registry_username: str = ""
    registry_password: str = ""
    registry_timeout_seconds: float = 15.0
    public_base_url: str = ""
    platform_rpc_url: str = ""
    ca_server_url: str = "https://wt.ioa.pub/ca-server/acps-atr-v2"
    ca_account_key_file: str = ""
    certs_dir: str = "data/certs"
    adp_discovery_url: str = "https://wt.ioa.pub/discovery"
    adp_timeout_seconds: float = 10.0
    probe_interval_seconds: int = 30
    amp_log_dir: str = "logs"
    amp_kafka_brokers: str = "wt.ioa.pub:19092"
    amp_heartbeat_interval_seconds: float = 15.0
    log_indexer_enabled: bool = True
    log_index_interval_seconds: float = Field(default=5.0, ge=1, le=300)
    log_retention_days: int = Field(default=7, ge=1, le=365)
    log_max_records: int = Field(default=100000, ge=1000, le=1000000)
    audit_retention_days: int = Field(default=90, ge=1, le=3650)
    audit_max_records: int = Field(default=50000, ge=1000, le=1000000)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("cors_origins", "aip_notification_allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
