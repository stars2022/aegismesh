from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import time
import uuid
import re
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Annotated, Any

logger = logging.getLogger(__name__)

from .services.task_manager import task_manager, BackgroundTaskRecord
from .services.adaptive_lease import AdaptiveDeadlineController, TASK_PROFILES

import httpx
from pathlib import Path
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import desc, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from acps_sdk.aip.aip_notification_model import NotificationStartRequest
from acps_sdk.aip.aip_stream_model import StreamRequest as StreamRequestModel
from acps_sdk.aip.aip_identity import AipIdentityError, assert_sender_matches_peer
from acps_sdk.aip.aip_peer_cert import AipPeerCertificateMiddleware, get_request_peer_aic
from acps_sdk.aip.aip_rpc_model import RpcRequest
from acps_sdk.aip.aip_rpc_server import CommandHandlers, handle_rpc_request

from .config import get_settings
from .database import Base, SessionLocal, engine, get_db
from .models import (
    AdminAccount,
    Agent,
    GroupChat,
    GroupChatMessage,
    HostedTask,
    Invocation,
    InvocationFeedback,
    OperationalLog,
    PlatformAccess,
    ProbeResult,
    ProviderConfig,
    RouteAttempt,
    RoutingPolicy,
    TraceEvent,
    WebSearchConfig,
)
from .schemas import (
    AgentCreate,
    AgentRead,
    AgentUpdate,
    AdminLogin,
    AccessUpdate,
    Attachment,
    CandidateScore,
    CanvasUpdate,
    ChatRequest,
    ChatResponse,
    DiscoveryQuery,
    DiscoveryImportRequest,
    DemoLogin,
    GroupChatCreate,
    GroupChatMessageIn,
    FeedbackRead,
    FeedbackRequest,
    DatabaseImportPayload,
    PolicyRead,
    PolicyUpdate,
    ProbeRead,
    ProviderCreate,
    ProviderRead,
    RegistrationRequest,
    ProviderUpdate,
    TraceRead,
    UploadResponse,
    WebSearchRead,
    WebSearchUpdate,
)
from .seed import seed_database
from .services.tools import ToolRegistry
from .account_api import account_router
from .services.identity import IdentityMiddleware, ConversationOwnershipError, bind_conversation
from .services import quotas
from .services.web_search import configured_search, supports_deepseek_search
from .services.transport import TransportRegistry
from .services.orchestrator import NoEligibleAgentError, ReliableOrchestrator
from .services.runtime_recovery import INTERRUPTED_MESSAGE, recover_interrupted_runtime
from .services.aip_group_partner import start_partner_listener
from .services.probe import AgentProbe, probe_loop
from .services.acs import LOCAL_AIC_PREFIX, build_acs, public_aic
from .services.hosted_aip import HostedAipService
from .services.certificates import CertificateError, issue_certificate
from .services.aip_tls import public_aip_base
from .services.registration import RegistryClient, RegistrationError, validate_registration_acs
from .services.discovery import AdpDiscoveryClient, DiscoveryError, health_from_alive_map
from .services.discovery_pool import discovery_candidates, rank_discovery
from .services.amp_service import amp_service
from .services.observability import AdminAuditMiddleware, LogQuery, index_loop, index_status, list_logs, log_read, query_conditions, safe_text
from .services.admin_auth import (
    AttemptRateLimiter,
    COOKIE_NAME,
    DEMO_COOKIE_NAME,
    PasswordVerificationBusy,
    create_session_token,
    hash_password,
    read_session_token,
    verify_password,
    verify_password_or_dummy,
)
from .services.database_transfer import export_database, import_database
from .services.provider_secrets import (
    ProviderSecretError,
    encrypt_api_key,
    resolve_api_key,
    validate_secret_reference,
)


settings = get_settings()
DbSession = Annotated[Session, Depends(get_db)]
login_attempts = AttemptRateLimiter(limit=5, window_seconds=60)
login_source_attempts = AttemptRateLimiter(limit=5, window_seconds=60)
api_key_attempts = AttemptRateLimiter(limit=30, window_seconds=60)


def initialize_schema() -> None:
    """Run additive migrations once before starting a multi-worker release."""
    Base.metadata.create_all(engine)
    if engine.dialect.name == "sqlite":
        with engine.begin() as connection:
            table_names = set(inspect(connection).get_table_names())
            if "agents" in table_names:
                columns = {item["name"] for item in inspect(connection).get_columns("agents")}
                migrations = {
                    "endpoint_url": "ALTER TABLE agents ADD COLUMN endpoint_url VARCHAR(512) DEFAULT ''",
                    "transport": "ALTER TABLE agents ADD COLUMN transport VARCHAR(32) DEFAULT 'openai-compatible'",
                    "system_prompt": "ALTER TABLE agents ADD COLUMN system_prompt TEXT DEFAULT ''",
                    "usage_mode": "ALTER TABLE agents ADD COLUMN usage_mode VARCHAR(16) DEFAULT 'both'",
                    "streaming_enabled": "ALTER TABLE agents ADD COLUMN streaming_enabled BOOLEAN DEFAULT 1",
                    "notification_enabled": "ALTER TABLE agents ADD COLUMN notification_enabled BOOLEAN DEFAULT 0",
                    "group_enabled": "ALTER TABLE agents ADD COLUMN group_enabled BOOLEAN DEFAULT 0",
                    "registration_status": "ALTER TABLE agents ADD COLUMN registration_status VARCHAR(24) DEFAULT 'local'",
                    "registration_agent_id": "ALTER TABLE agents ADD COLUMN registration_agent_id VARCHAR(64) DEFAULT ''",
                    "registration_message": "ALTER TABLE agents ADD COLUMN registration_message TEXT DEFAULT ''",
                    "registration_synced_at": "ALTER TABLE agents ADD COLUMN registration_synced_at DATETIME",
                    "eab_key_id": "ALTER TABLE agents ADD COLUMN eab_key_id VARCHAR(128) DEFAULT ''",
                    "eab_expires_at": "ALTER TABLE agents ADD COLUMN eab_expires_at DATETIME",
                    "certificate_issued_at": "ALTER TABLE agents ADD COLUMN certificate_issued_at DATETIME",
                    "model_provider": "ALTER TABLE agents ADD COLUMN model_provider VARCHAR(80) DEFAULT ''",
                    "model_name": "ALTER TABLE agents ADD COLUMN model_name VARCHAR(120) DEFAULT ''",
                    "tools": "ALTER TABLE agents ADD COLUMN tools JSON DEFAULT '[]'",
                    "feedback_positive_count": "ALTER TABLE agents ADD COLUMN feedback_positive_count INTEGER DEFAULT 0",
                    "feedback_negative_count": "ALTER TABLE agents ADD COLUMN feedback_negative_count INTEGER DEFAULT 0",
                }
                for column, statement in migrations.items():
                    if column not in columns:
                        connection.execute(text(statement))

            if "provider_configs" in table_names:
                p_columns = {item["name"] for item in inspect(connection).get_columns("provider_configs")}
                p_migrations = {
                    "kind": "ALTER TABLE provider_configs ADD COLUMN kind VARCHAR(32) DEFAULT 'openai-chat'",
                    "base_url": "ALTER TABLE provider_configs ADD COLUMN base_url VARCHAR(512) DEFAULT ''",
                    "api_key_ciphertext": "ALTER TABLE provider_configs ADD COLUMN api_key_ciphertext TEXT DEFAULT ''",
                    "api_key_env": "ALTER TABLE provider_configs ADD COLUMN api_key_env VARCHAR(120) DEFAULT ''",
                    "default_model": "ALTER TABLE provider_configs ADD COLUMN default_model VARCHAR(120) DEFAULT ''",
                    "active": "ALTER TABLE provider_configs ADD COLUMN active BOOLEAN DEFAULT 1",
                }
                for column, statement in p_migrations.items():
                    if column not in p_columns:
                        connection.execute(text(statement))

            if "hosted_tasks" in table_names:
                hosted_columns = {
                    item["name"] for item in inspect(connection).get_columns("hosted_tasks")
                }
                if "owner_peer_aic" not in hosted_columns:
                    connection.execute(
                        text(
                            "ALTER TABLE hosted_tasks ADD COLUMN owner_peer_aic "
                            "VARCHAR(255) DEFAULT ''"
                        )
                    )
                if "external_task_id" not in hosted_columns:
                    connection.execute(
                        text(
                            "ALTER TABLE hosted_tasks ADD COLUMN external_task_id "
                            "VARCHAR(128) DEFAULT ''"
                        )
                    )
            if "aip_notifications" in table_names:
                notification_columns = {
                    item["name"] for item in inspect(connection).get_columns("aip_notifications")
                }
                if "owner_peer_aic" not in notification_columns:
                    connection.execute(
                        text(
                            "ALTER TABLE aip_notifications ADD COLUMN owner_peer_aic "
                            "VARCHAR(255) DEFAULT ''"
                        )
                    )
            if "invocations" in table_names:
                invocation_columns = {
                    item["name"] for item in inspect(connection).get_columns("invocations")
                }
                if "owner_id" not in invocation_columns:
                    connection.execute(
                        text("ALTER TABLE invocations ADD COLUMN owner_id VARCHAR(128) DEFAULT ''")
                    )
    with engine.begin() as connection:
        if "user_accounts" in inspect(connection).get_table_names():
            if "role" not in {c["name"] for c in inspect(connection).get_columns("user_accounts")}:
                connection.execute(text("ALTER TABLE user_accounts ADD COLUMN role VARCHAR(24) DEFAULT 'member'"))
        if "model_usage" in inspect(connection).get_table_names():
            if "provider_id" not in {c["name"] for c in inspect(connection).get_columns("model_usage")}:
                connection.execute(text("ALTER TABLE model_usage ADD COLUMN provider_id VARCHAR(64) DEFAULT 'default'"))
        if "group_chats" in inspect(connection).get_table_names():
            if "owner_id" not in {c["name"] for c in inspect(connection).get_columns("group_chats")}:
                connection.execute(text("ALTER TABLE group_chats ADD COLUMN owner_id VARCHAR(128) DEFAULT ''"))
        if "routing_policies" in inspect(connection).get_table_names():
            if "interop_compatibility" not in {c["name"] for c in inspect(connection).get_columns("routing_policies")}:
                connection.execute(text("ALTER TABLE routing_policies ADD COLUMN interop_compatibility BOOLEAN DEFAULT 0"))
            if "external_delegation_enabled" not in {c["name"] for c in inspect(connection).get_columns("routing_policies")}:
                connection.execute(text("ALTER TABLE routing_policies ADD COLUMN external_delegation_enabled BOOLEAN DEFAULT 0"))
            routing_columns = {c["name"] for c in inspect(connection).get_columns("routing_policies")}
            for column, declaration in {
                "bounty_enabled": "BOOLEAN DEFAULT 0",
                "bounty_max_workers": "INTEGER DEFAULT 3",
                "bounty_max_items": "INTEGER DEFAULT 6",
                "bounty_lease_seconds": "INTEGER DEFAULT 120",
            }.items():
                if column not in routing_columns:
                    connection.execute(text(f"ALTER TABLE routing_policies ADD COLUMN {column} {declaration}"))
        if "canvas_docs" in inspect(connection).get_table_names():
            canvas_columns = {
                item["name"] for item in inspect(connection).get_columns("canvas_docs")
            }
            if "owner_id" not in canvas_columns:
                connection.execute(text(
                    "ALTER TABLE canvas_docs ADD COLUMN owner_id VARCHAR(128) DEFAULT ''"
                ))
@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_schema()
    with SessionLocal() as db:
        if settings.background_worker_enabled:
            seed_database(db)
            recover_interrupted_runtime(db)
        agents = db.scalars(select(Agent).where(Agent.active == True)).all()
        for ag in agents:
            if public_aic(ag):
                amp_service.register_aic(ag.aic)
        leader_agent = db.scalar(select(Agent).where(Agent.role == "leader"))
        if settings.aip_tls_local_aic:
            amp_service.update_aic(settings.aip_tls_local_aic)
        elif leader_agent and leader_agent.aic:
            amp_service.update_aic(leader_agent.aic)
    if settings.background_worker_enabled:
        await amp_service.start()
    task = asyncio.create_task(probe_loop(SessionLocal, settings.probe_interval_seconds)) if settings.background_worker_enabled else None
    group_partner_task = await start_partner_listener() if settings.background_worker_enabled else None
    log_index_task = asyncio.create_task(index_loop(), name="local-log-index") if settings.background_worker_enabled and settings.log_indexer_enabled else None
    yield
    from .services.hosted_aip import stop_hosted_tasks
    await stop_hosted_tasks()
    if settings.background_worker_enabled:
        await amp_service.stop()
    if task:
        task.cancel()
    if log_index_task:
        log_index_task.cancel()
        with suppress(asyncio.CancelledError):
            await log_index_task
    if group_partner_task:
        group_partner_task.cancel()
        with suppress(asyncio.CancelledError):
            await group_partner_task
    if task:
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title="AegisMesh Open API",
    version="0.1.0",
    description="AIP-compatible quality-aware routing, failover and observability runtime.",
    lifespan=lifespan,
)
app.add_middleware(AdminAuditMiddleware)
app.add_middleware(IdentityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if settings.aip_identity_binding_enabled:
    app.add_middleware(AipPeerCertificateMiddleware)


@app.exception_handler(StarletteHTTPException)
async def audited_http_exception(request: Request, exc: StarletteHTTPException):
    # Keep the normal response contract; only retain a short server diagnostic.
    # Structured validation errors can include submitted values and are not copied.
    if getattr(request.state, "audit_request_id", None) and isinstance(exc.detail, str):
        request.state.audit_note = safe_text(exc.detail)
    return await http_exception_handler(request, exc)


@app.exception_handler(ConversationOwnershipError)
async def ownership_error(request: Request, exc: ConversationOwnershipError):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(quotas.QuotaExceeded)
async def quota_error(request: Request, exc: quotas.QuotaExceeded):
    return JSONResponse({"detail": str(exc)}, status_code=429)


def require_inbound_identity(request: Request, sender_id: str | None) -> str:
    """Require a verified peer certificate and bind its AIC to the request sender."""
    if not settings.aip_identity_binding_enabled:
        raise HTTPException(status_code=503, detail="AIP 对端身份绑定尚未启用")
    peer_aic = get_request_peer_aic(request)
    if not peer_aic:
        raise HTTPException(status_code=401, detail="缺少对端证书身份")
    try:
        assert_sender_matches_peer(sender_id, peer_aic)
    except AipIdentityError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return peer_aic


def require_hosted_aip_runtime() -> None:
    if not (
        settings.aip_identity_binding_enabled
        and settings.aip_tls_certfile
        and settings.aip_tls_keyfile
        and settings.aip_tls_client_ca_file
        and settings.aip_tls_port
    ):
        raise HTTPException(status_code=503, detail="托管 AIP mTLS 监听尚未安全配置")


def hosted_public_rpc_url(agent: Agent) -> str:
    require_hosted_aip_runtime()
    try:
        base_url = public_aip_base(settings, agent.id)
    except CertificateError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return f"{base_url}/aip/{agent.id}/rpc"


def require_api_key(
    request: Request,
    db: Session = Depends(get_db),
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    access = db.get(PlatformAccess, 1)
    configured = bool(settings.public_api_key or (access and access.api_key_hash))
    if not configured:
        raise HTTPException(status_code=503, detail="开放 API Key 尚未配置")
    attempt_key = f"api:{request.client.host if request.client else 'unknown'}"
    if not api_key_attempts.allow(attempt_key):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后重试")
    try:
        valid = bool(
            x_api_key
            and (
                (settings.public_api_key and hmac.compare_digest(x_api_key, settings.public_api_key))
                or (
                    access
                    and access.api_key_hash
                    and verify_password(x_api_key, access.api_key_hash, access.api_key_salt)
                )
            )
        )
    except PasswordVerificationBusy as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    if not valid:
        raise HTTPException(status_code=401, detail="API Key 无效")
    api_key_attempts.reset(attempt_key)
    request.state.owner_id = f"api_{hashlib.sha256(x_api_key.encode()).hexdigest()[:24]}"


def authenticated_admin(request: Request, db: Session) -> AdminAccount | None:
    if not settings.admin_auth_enabled:
        return None
    username = read_session_token(
        request.cookies.get(COOKIE_NAME, ""), settings.admin_session_secret
    )
    account = db.get(AdminAccount, username) if username else None
    if account and account.active:
        request.state.audit_actor = account.username
        return account
    return None


def require_admin(request: Request, db: Session = Depends(get_db)) -> None:
    if not settings.admin_auth_enabled or not settings.admin_session_secret:
        raise HTTPException(status_code=503, detail="管理后台尚未完成安全初始化")
    if authenticated_admin(request, db) is None:
        raise HTTPException(status_code=401, detail="请登录管理后台")


def demo_is_authenticated(request: Request, db: Session) -> bool:
    access = db.get(PlatformAccess, 1)
    if not access or not access.demo_password_hash:
        return True
    principal = read_session_token(
        request.cookies.get(DEMO_COOKIE_NAME, ""), access.demo_session_secret
    )
    return bool(principal and (principal == "demo" or principal.startswith("demo:")))


def require_demo(request: Request, db: Session = Depends(get_db)) -> None:
    if not demo_is_authenticated(request, db):
        raise HTTPException(status_code=401, detail="请输入访问密码")


def require_demo_or_admin(request: Request, db: Session = Depends(get_db)) -> None:
    if authenticated_admin(request, db) is not None:
        return
    if not demo_is_authenticated(request, db):
        raise HTTPException(status_code=401, detail="请登录管理后台或输入访问密码")


def require_admin_or_api_key(
    request: Request,
    db: Session = Depends(get_db),
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    if authenticated_admin(request, db) is not None:
        return
    require_api_key(request, db, x_api_key=x_api_key)


def require_demo_or_admin_or_api_key(
    request: Request,
    db: Session = Depends(get_db),
    x_api_key: Annotated[str | None, Header()] = None,
) -> None:
    if x_api_key:
        require_api_key(request, db, x_api_key=x_api_key)
        return
    if authenticated_admin(request, db) is not None:
        return
    if demo_is_authenticated(request, db):
        return
    raise HTTPException(status_code=401, detail="请登录管理后台或输入访问密码")


app.include_router(account_router(require_admin))


def agent_to_read(agent: Agent) -> AgentRead:
    values = {column.name: getattr(agent, column.name) for column in Agent.__table__.columns}
    values["aic"] = public_aic(agent)
    if not values.get("model_name") and values.get("model_provider"):
        values["model_name"] = "deepseek-flash" if values["model_provider"] == "deepseek" else values["model_provider"]
    valid_transports = {"provider", "openai-compatible", "openai-responses", "anthropic", "aip-rpc"}
    if values.get("transport") not in valid_transports:
        values["transport"] = "aip-rpc"
    return AgentRead.model_validate(values)


def provider_to_read(provider: ProviderConfig) -> ProviderRead:
    return ProviderRead(
        id=provider.id,
        name=provider.name,
        kind=provider.kind,
        base_url=provider.base_url,
        api_key_env=provider.api_key_env,
        default_model=provider.default_model,
        active=provider.active,
        key_configured=bool(provider.api_key_ciphertext or provider.api_key_env),
        updated_at=provider.updated_at,
    )


def trace_to_read(invocation: Invocation, db: Session) -> TraceRead:
    attempts = list(
        db.scalars(
            select(RouteAttempt)
            .where(RouteAttempt.invocation_id == invocation.id)
            .order_by(RouteAttempt.id)
        ).all()
    )
    events = list(
        db.scalars(
            select(TraceEvent)
            .where(TraceEvent.invocation_id == invocation.id)
            .order_by(TraceEvent.id)
        ).all()
    )
    return TraceRead(
        id=invocation.id,
        session_id=invocation.session_id,
        query=invocation.query,
        status=invocation.status,
        selected_agent_id=invocation.selected_agent_id,
        result_text=invocation.result_text,
        result_data=invocation.result_data,
        total_latency_ms=invocation.total_latency_ms,
        attempt_count=invocation.attempt_count,
        llm_calls=invocation.llm_calls,
        prompt_tokens=invocation.prompt_tokens,
        completion_tokens=invocation.completion_tokens,
        created_at=invocation.created_at,
        finished_at=invocation.finished_at,
        attempts=[
            {
                "agent_id": item.agent_id,
                "rank": item.rank,
                "score": item.score,
                "state": item.state,
                "latency_ms": item.latency_ms,
                "error": item.error,
                "breakdown": item.score_breakdown,
            }
            for item in attempts
        ],
        events=[
            {"type": item.event_type, "detail": item.detail, "created_at": item.created_at}
            for item in events
        ],
    )


@app.get("/api/health", tags=["system"])
def health() -> dict:
    return {"status": "ok", "service": settings.app_name, "time": datetime.now(timezone.utc)}


@app.get("/api/admin/session", tags=["admin-auth"])
def admin_session(request: Request, db: DbSession) -> dict:
    account = authenticated_admin(request, db)
    return {
        "enabled": settings.admin_auth_enabled,
        "authenticated": account is not None,
        "username": account.username if account else None,
    }


@app.post("/api/admin/login", tags=["admin-auth"])
def admin_login(payload: AdminLogin, response: Response, request: Request, db: DbSession) -> dict:
    if not settings.admin_auth_enabled:
        raise HTTPException(status_code=503, detail="管理后台认证已禁用，拒绝管理员访问")
    if not settings.admin_session_secret:
        raise HTTPException(status_code=503, detail="后台会话密钥未配置")
    source = request.client.host if request.client else "unknown"
    source_key = f"admin-source:{source}"
    attempt_key = f"admin:{source}:{payload.username.lower()}"
    if not login_source_attempts.allow(source_key) or not login_attempts.allow(attempt_key):
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后重试")
    account = db.get(AdminAccount, payload.username)
    try:
        password_matches = verify_password_or_dummy(
            payload.password,
            account.password_hash if account else None,
            account.password_salt if account else None,
        )
        valid = bool(account and account.active and password_matches)
    except PasswordVerificationBusy as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    if not valid:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    login_source_attempts.reset(source_key)
    login_attempts.reset(attempt_key)
    max_age = max(1, settings.admin_session_hours) * 3600
    request.state.audit_actor = account.username
    response.set_cookie(
        COOKIE_NAME,
        create_session_token(account.username, settings.admin_session_secret, max_age),
        max_age=max_age,
        httponly=True,
        secure=settings.admin_cookie_secure,
        samesite="strict",
        path="/",
    )
    return {"enabled": True, "authenticated": True, "username": account.username}


@app.post("/api/admin/logout", tags=["admin-auth"])
def admin_logout(response: Response, request: Request, db: DbSession) -> dict:
    authenticated_admin(request, db)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get(
    "/api/admin/access",
    dependencies=[Depends(require_admin)],
    tags=["admin-auth"],
)
def get_access_settings(db: DbSession) -> dict:
    access = db.get(PlatformAccess, 1)
    assert access is not None
    return {
        "api_key_configured": bool(settings.public_api_key or access.api_key_hash),
        "api_key_from_environment": bool(settings.public_api_key),
        "demo_password_enabled": bool(access.demo_password_hash),
    }


@app.put(
    "/api/admin/access",
    dependencies=[Depends(require_admin)],
    tags=["admin-auth"],
)
def update_access_settings(payload: AccessUpdate, db: DbSession) -> dict:
    access = db.get(PlatformAccess, 1)
    assert access is not None
    if payload.api_key is not None:
        access.api_key_hash, access.api_key_salt = hash_password(payload.api_key)
    elif payload.clear_api_key:
        access.api_key_hash = ""
        access.api_key_salt = ""
    if payload.demo_password is not None:
        access.demo_password_hash, access.demo_password_salt = hash_password(
            payload.demo_password
        )
        access.demo_session_secret = secrets.token_urlsafe(48)
    elif payload.clear_demo_password:
        access.demo_password_hash = ""
        access.demo_password_salt = ""
        access.demo_session_secret = ""
    db.commit()
    return get_access_settings(db)


@app.get(
    "/api/admin/database/export",
    dependencies=[Depends(require_admin)],
    tags=["admin-data"],
)
def database_export(db: DbSession) -> JSONResponse:
    return JSONResponse(
        export_database(db),
        headers={"Content-Disposition": "attachment; filename=aegismesh-database.json"},
    )


@app.post(
    "/api/admin/database/import",
    dependencies=[Depends(require_admin)],
    tags=["admin-data"],
)
def database_import(payload: DatabaseImportPayload, db: DbSession) -> dict:
    try:
        counts = import_database(db, payload.data, payload.mode)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail="数据库导入失败") from exc
    return {"imported": counts, "mode": payload.mode}


@app.get("/api/demo/session", tags=["demo-auth"])
def demo_session(request: Request, response: Response, db: DbSession) -> dict:
    access = db.get(PlatformAccess, 1)
    enabled = bool(access and access.demo_password_hash)
    response.headers["Cache-Control"] = "no-store"
    return {"enabled": enabled, "authenticated": demo_is_authenticated(request, db),
            "owner_id": request.state.browser_owner_id}


@app.post("/api/demo/login", tags=["demo-auth"])
def demo_login(payload: DemoLogin, response: Response, request: Request, db: DbSession) -> dict:
    access = db.get(PlatformAccess, 1)
    if not access or not access.demo_password_hash:
        return {"enabled": False, "authenticated": True}
    attempt_key = f"demo:{request.client.host if request.client else 'unknown'}"
    if not login_attempts.allow(attempt_key):
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后重试")
    try:
        valid = verify_password(
            payload.password, access.demo_password_hash, access.demo_password_salt
        )
    except PasswordVerificationBusy as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    if not valid:
        raise HTTPException(status_code=401, detail="访问密码错误")
    login_attempts.reset(attempt_key)
    max_age = 30 * 24 * 3600
    response.set_cookie(
        DEMO_COOKIE_NAME,
        create_session_token(
            f"demo:{secrets.token_urlsafe(24)}", access.demo_session_secret, max_age
        ),
        max_age=max_age,
        httponly=True,
        secure=settings.admin_cookie_secure,
        samesite="strict",
        path="/",
    )
    return {"enabled": True, "authenticated": True}


@app.post("/api/demo/logout", tags=["demo-auth"])
def demo_logout(response: Response) -> dict:
    response.delete_cookie(DEMO_COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get("/api/dashboard", dependencies=[Depends(require_admin)], tags=["admin"])
def dashboard(db: DbSession) -> dict:
    agents = list(db.scalars(select(Agent)).all())
    invocation_count = db.scalar(select(func.count()).select_from(Invocation)) or 0
    completed = (
        db.scalar(select(func.count()).select_from(Invocation).where(Invocation.status == "completed"))
        or 0
    )
    avg_latency = db.scalar(select(func.avg(Invocation.total_latency_ms))) or 0
    failovers = (
        db.scalar(
            select(func.count()).select_from(TraceEvent).where(TraceEvent.event_type == "FAILOVER_STARTED")
        )
        or 0
    )
    latest_probe_ids = select(func.max(ProbeResult.id)).group_by(ProbeResult.agent_id)
    latest_probes = list(
        db.scalars(select(ProbeResult).where(ProbeResult.id.in_(latest_probe_ids))).all()
    )
    recent = list(
        db.scalars(select(Invocation).order_by(desc(Invocation.created_at)).limit(12)).all()
    )
    partner_agents = [agent for agent in agents if agent.role == "partner"]
    agent_usage = {
        agent.id: db.scalar(
            select(func.count()).select_from(RouteAttempt).where(
                RouteAttempt.agent_id == agent.id,
                RouteAttempt.state == "completed",
            )
        )
        or 0
        for agent in partner_agents
    }
    return {
        "agents": len(agents),
        "online_agents": sum(agent.health == "online" and agent.active for agent in agents),
        "requests": invocation_count,
        "success_rate": round(completed / invocation_count * 100, 1) if invocation_count else None,
        "avg_latency_ms": round(float(avg_latency), 1),
        "failovers": failovers,
        "active_tasks": sum(agent.active_tasks for agent in agents),
        "probe_health": {
            "healthy": sum(item.status == "healthy" for item in latest_probes),
            "degraded": sum(item.status != "healthy" for item in latest_probes),
        },
        "roles": {
            "leaders": sum(agent.role == "leader" for agent in agents),
            "partners": sum(agent.role == "partner" for agent in agents),
        },
        "agent_usage": [
            {"id": agent.id, "name": agent.name, "count": agent_usage[agent.id]}
            for agent in sorted(partner_agents, key=lambda item: agent_usage[item.id], reverse=True)
        ],
        "recent_activity": [
            {
                "id": item.id,
                "status": item.status,
                "latency_ms": item.total_latency_ms,
                "attempts": item.attempt_count,
                "created_at": item.created_at,
            }
            for item in reversed(recent)
        ],
    }


@app.get("/api/agents", response_model=list[AgentRead], dependencies=[Depends(require_demo_or_admin)], tags=["agents"])
def list_agents(db: DbSession) -> list[AgentRead]:
    return [agent_to_read(agent) for agent in db.scalars(select(Agent).order_by(Agent.name)).all()]


@app.get("/api/chat/config", dependencies=[Depends(require_demo_or_admin)], tags=["chat"])
def chat_runtime_config(db: DbSession) -> dict:
    orchestrator = ReliableOrchestrator(db)
    leader = orchestrator._usable_leader()
    return {"interop_compatibility": bool(orchestrator._routing_policy().interop_compatibility),
            "bounty_enabled": bool(orchestrator._routing_policy().bounty_enabled),
            "default_coordinator_id": leader.id if leader else None}


@app.post("/api/agents", response_model=AgentRead, status_code=201, dependencies=[Depends(require_admin)], tags=["agents"])
def create_agent(payload: AgentCreate, db: DbSession) -> AgentRead:
    if db.get(Agent, payload.id):
        raise HTTPException(status_code=409, detail="Agent id already exists")
    values = payload.model_dump()
    is_local = not payload.aic
    values["aic"] = payload.aic or f"{LOCAL_AIC_PREFIX}{payload.id}"
    values["registration_status"] = "local" if is_local else "imported"
    if is_local:
        values["usage_mode"] = "internal"
    if payload.aic and db.scalar(select(Agent).where(Agent.aic == payload.aic)):
        raise HTTPException(status_code=409, detail="该 AIC 已被其他智能体使用")
    values["skills"] = [skill.model_dump() for skill in payload.skills]
    values["health"] = "unknown"
    agent = Agent(**values)
    db.add(agent)
    db.commit()
    return agent_to_read(agent)


@app.patch("/api/agents/{agent_id}", response_model=AgentRead, dependencies=[Depends(require_admin)], tags=["agents"])
def update_agent(agent_id: str, payload: AgentUpdate, db: DbSession) -> AgentRead:
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    changes = payload.model_dump(exclude_unset=True)
    if not public_aic(agent) and changes.get("usage_mode") in {"both", "external"}:
        raise HTTPException(status_code=409, detail="完成可信验证后才能对外提供服务")
    if "skills" in changes:
        changes["skills"] = [skill.model_dump() if hasattr(skill, "model_dump") else skill for skill in changes["skills"]]
    for key, value in changes.items():
        setattr(agent, key, value)
    db.commit()
    return agent_to_read(agent)


@app.delete("/api/agents/{agent_id}", status_code=204, dependencies=[Depends(require_admin)], tags=["agents"])
def delete_agent(agent_id: str, db: DbSession) -> Response:
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    db.delete(agent)
    db.commit()
    return Response(status_code=204)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


@app.post("/api/agents/{agent_id}/registration", response_model=AgentRead, dependencies=[Depends(require_admin)], tags=["registration"])
async def register_agent(
    agent_id: str,
    payload: RegistrationRequest,
    request: Request,
    db: DbSession,
) -> AgentRead:
    """提交智能体到可信注册服务并进入审核（创建或更新草稿后 submit）。"""
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    client = RegistryClient()
    if not client.configured():
        raise HTTPException(status_code=503, detail="注册服务未配置（REGISTRY_API_URL / REGISTRY_USERNAME / REGISTRY_PASSWORD）")
    if agent.registration_status == "imported":
        raise HTTPException(status_code=409, detail="该智能体已接入可信 AIC")
    if agent.transport == "aip-rpc":
        rpc_url = payload.rpc_url or agent.endpoint_url
        if not rpc_url:
            raise HTTPException(status_code=422, detail="外部 AIP 智能体缺少 RPC 地址")
    else:
        rpc_url = hosted_public_rpc_url(agent)
    acs = build_acs(agent, rpc_url)
    try:
        validate_registration_acs(acs)
        if agent.registration_agent_id:
            await client.update_agent(agent.registration_agent_id, agent.name, "1.0.0", agent.description, acs)
        else:
            agent.registration_agent_id = await client.save_agent(agent.name, "1.0.0", agent.description, acs)
        await client.submit(agent.registration_agent_id)
        agent.registration_status = "pending"
        agent.registration_message = ""
    except RegistrationError as exc:
        agent.registration_message = str(exc)[:500]
        request.state.audit_note = str(exc)
        db.commit()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    agent.registration_synced_at = _now_utc()
    db.commit()
    return agent_to_read(agent)


@app.post("/api/agents/{agent_id}/registration/sync", response_model=AgentRead, dependencies=[Depends(require_admin)], tags=["registration"])
async def sync_registration(agent_id: str, db: DbSession) -> AgentRead:
    """从注册服务拉取审核状态并回写。"""
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not agent.registration_agent_id:
        raise HTTPException(status_code=409, detail="该智能体尚未提交注册")
    client = RegistryClient()
    try:
        detail = await client.detail(agent.registration_agent_id)
    except RegistrationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    remote_status = str(
        detail.get("approval_status")
        or detail.get("approvalStatus")
        or detail.get("status")
        or ""
    )
    agent.registration_status = RegistryClient.map_status(remote_status)
    remote_aic = str(detail.get("aic") or "").strip().upper()
    if not remote_aic:
        embedded_acs = detail.get("acs")
        if isinstance(embedded_acs, str):
            try:
                embedded_acs = json.loads(embedded_acs)
            except json.JSONDecodeError:
                embedded_acs = None
        if isinstance(embedded_acs, dict):
            remote_aic = str(embedded_acs.get("aic") or "").strip().upper()
    if agent.registration_status == "approved" and remote_aic:
        from acps_sdk.aic import validate_aic_format

        valid, _ = validate_aic_format(remote_aic)
        if valid:
            conflict = db.scalar(
                select(Agent).where(Agent.aic == remote_aic, Agent.id != agent.id)
            )
            if conflict:
                raise HTTPException(status_code=409, detail="注册服务返回的 AIC 已被占用")
            agent.aic = remote_aic
            if agent.transport != "aip-rpc":
                agent.usage_mode = "both"
            amp_service.register_aic(agent.aic)
    comments = detail.get("comments") or detail.get("processComments")
    agent.registration_message = (str(comments) if comments else f"注册服务状态：{remote_status or '未知'}")[:500]
    agent.registration_synced_at = _now_utc()
    db.commit()
    return agent_to_read(agent)


@app.post("/api/agents/{agent_id}/eab", dependencies=[Depends(require_admin)], tags=["registration"])
async def fetch_eab_credential(agent_id: str, db: DbSession) -> dict:
    """向注册服务申请一次性 EAB 凭据（用于 ACME 账户绑定）。"""
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not public_aic(agent):
        raise HTTPException(status_code=409, detail="智能体通过可信审核后才能申请证书")
    client = RegistryClient()
    try:
        credential = await client.fetch_eab(agent.aic)
    except RegistrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    agent.eab_key_id = credential.key_id
    agent.eab_expires_at = _parse_iso_datetime(credential.expires_at)
    db.commit()
    return {"keyId": credential.key_id, "macKey": credential.mac_key, "aic": credential.aic, "expiresAt": credential.expires_at}


@app.post("/api/agents/{agent_id}/certificate", dependencies=[Depends(require_admin)], tags=["registration"])
async def issue_agent_certificate(agent_id: str, db: DbSession, usage: str = "clientAuth") -> dict:
    """签发并校验指定用途的证书，校验失败时不替换正在使用的文件。"""
    if usage not in {"clientAuth", "serverAuth"}:
        raise HTTPException(status_code=422, detail="usage 必须为 clientAuth 或 serverAuth")
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if not public_aic(agent):
        raise HTTPException(status_code=409, detail="智能体通过可信审核后才能签发证书")
    from urllib.parse import urlsplit
    hostname = urlsplit(hosted_public_rpc_url(agent)).hostname if usage == "serverAuth" else None
    client = RegistryClient()
    try:
        credential = await client.fetch_eab(agent.aic)
        agent.eab_key_id = credential.key_id
        agent.eab_expires_at = _parse_iso_datetime(credential.expires_at)
        issued = await issue_certificate(agent.aic, {"keyId": credential.key_id, "macKey": credential.mac_key}, usage,
                                         server_hostname=hostname)
    except RegistrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except CertificateError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    agent.certificate_issued_at = _now_utc()
    db.commit()
    return {
        "aic": issued.aic,
        "certPath": issued.cert_path,
        "keyPath": issued.key_path,
        "trustBundlePath": issued.trust_bundle_path,
    }
@app.get(
    "/api/providers",
    response_model=list[ProviderRead],
    dependencies=[Depends(require_admin)],
    tags=["providers"],
)
def list_providers(db: DbSession) -> list[ProviderRead]:
    providers = db.scalars(select(ProviderConfig).order_by(ProviderConfig.name)).all()
    return [provider_to_read(provider) for provider in providers]


@app.post(
    "/api/providers",
    response_model=ProviderRead,
    status_code=201,
    dependencies=[Depends(require_admin)],
    tags=["providers"],
)
def create_provider(payload: ProviderCreate, db: DbSession) -> ProviderRead:
    if db.get(ProviderConfig, payload.id):
        raise HTTPException(status_code=409, detail="供应商标识已存在")
    values = payload.model_dump(exclude={"api_key"})
    provider = ProviderConfig(**values)
    try:
        validate_secret_reference(provider.api_key_env, provider.base_url)
    except ProviderSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.api_key:
        try:
            provider.api_key_ciphertext = encrypt_api_key(payload.api_key)
        except ProviderSecretError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not provider.api_key_ciphertext and not provider.api_key_env:
        raise HTTPException(status_code=422, detail="请输入密钥或环境变量名")
    db.add(provider)
    db.commit()
    return provider_to_read(provider)


@app.patch(
    "/api/providers/{provider_id}",
    response_model=ProviderRead,
    dependencies=[Depends(require_admin)],
    tags=["providers"],
)
def update_provider(provider_id: str, payload: ProviderUpdate, db: DbSession) -> ProviderRead:
    provider = db.get(ProviderConfig, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="供应商不存在")
    old_base_url = provider.base_url
    old_kind = provider.kind
    changes = payload.model_dump(exclude_unset=True, exclude={"api_key", "clear_api_key"})
    for key, value in changes.items():
        setattr(provider, key, value)
    if provider.base_url != old_base_url or provider.kind != old_kind:
        provider.api_key_ciphertext = ""
        if "api_key_env" not in changes:
            provider.api_key_env = ""
    try:
        validate_secret_reference(provider.api_key_env, provider.base_url)
    except ProviderSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.api_key:
        try:
            provider.api_key_ciphertext = encrypt_api_key(payload.api_key)
        except ProviderSecretError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    elif payload.clear_api_key:
        provider.api_key_ciphertext = ""
    if not provider.api_key_ciphertext and not provider.api_key_env:
        raise HTTPException(status_code=422, detail="请输入密钥或环境变量名")
    db.commit()
    return provider_to_read(provider)


@app.delete(
    "/api/providers/{provider_id}",
    status_code=204,
    dependencies=[Depends(require_admin)],
    tags=["providers"],
)
def delete_provider(provider_id: str, db: DbSession) -> Response:
    provider = db.get(ProviderConfig, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="供应商不存在")
    referenced = db.scalar(select(func.count()).select_from(Agent).where(Agent.model_provider == provider_id)) or 0
    if referenced:
        raise HTTPException(status_code=409, detail="供应商仍被智能体使用")
    search = db.get(WebSearchConfig, 1)
    if search and search.backend == "deepseek" and search.deepseek_provider_id == provider_id:
        raise HTTPException(status_code=409, detail="供应商仍被联网搜索使用，请先更改搜索设置")
    db.delete(provider)
    db.commit()
    return Response(status_code=204)


@app.post(
    "/api/providers/{provider_id}/test",
    dependencies=[Depends(require_admin)],
    tags=["providers"],
)
async def test_provider(provider_id: str, db: DbSession) -> dict:
    provider = db.get(ProviderConfig, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="供应商不存在")
    try:
        api_key = resolve_api_key(provider)
        headers = (
            {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
            if provider.kind == "anthropic"
            else {"Authorization": f"Bearer {api_key}"}
        )
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{provider.base_url.rstrip('/')}/models", headers=headers)
        response.raise_for_status()
        latency = round((time.monotonic() - started) * 1000, 2)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="连接测试失败") from exc
    return {"ok": True, "latency_ms": latency}


def search_config_read(config: WebSearchConfig | None) -> WebSearchRead:
    if config is None:
        return WebSearchRead()
    return WebSearchRead(**WebSearchRead.model_validate(config).model_dump(exclude={"exa_key_configured"}),
                         exa_key_configured=bool(config.exa_api_key_ciphertext))


def prepare_search_config(payload: WebSearchUpdate, db: Session) -> WebSearchConfig:
    old = db.get(WebSearchConfig, 1)
    config = WebSearchConfig(
        id=1,
        **payload.model_dump(exclude={"exa_api_key", "clear_exa_api_key"}),
        exa_api_key_ciphertext=old.exa_api_key_ciphertext if old else "",
    )
    if payload.exa_api_key and payload.clear_exa_api_key:
        raise HTTPException(status_code=422, detail="不能同时更新和清除 Exa 密钥")
    try:
        if payload.exa_api_key and payload.exa_api_key.strip():
            config.exa_api_key_ciphertext = encrypt_api_key(payload.exa_api_key.strip())
        elif payload.clear_exa_api_key:
            config.exa_api_key_ciphertext = ""
        if config.backend == "deepseek":
            provider = db.get(ProviderConfig, config.deepseek_provider_id)
            if not supports_deepseek_search(provider):
                raise HTTPException(status_code=422, detail="请选择启用且地址为 api.deepseek.com 的独立供应商")
            resolve_api_key(provider)
    except ProviderSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return config


@app.get("/api/admin/web-search", response_model=WebSearchRead, dependencies=[Depends(require_admin)], tags=["search"])
def read_search_settings(db: DbSession) -> WebSearchRead:
    return search_config_read(db.get(WebSearchConfig, 1))


@app.put("/api/admin/web-search", response_model=WebSearchRead, dependencies=[Depends(require_admin)], tags=["search"])
def update_search_settings(payload: WebSearchUpdate, db: DbSession) -> WebSearchRead:
    config = db.merge(prepare_search_config(payload, db))
    db.commit()
    return search_config_read(config)


@app.post("/api/admin/web-search/test", dependencies=[Depends(require_admin)], tags=["search"])
async def test_search_settings(payload: WebSearchUpdate, db: DbSession) -> dict:
    # Test the draft without saving or changing the active configuration.
    if payload.backend not in ("exa", "deepseek"):
        raise HTTPException(status_code=422, detail="请先选择 Exa 或 DeepSeek 进行真实检索测试")
    config = prepare_search_config(payload, db)
    handler = configured_search(db, None, {}, config=config)
    started = time.monotonic()
    try:
        result = await handler({"query": "OpenCode web search official documentation"})
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "latency_ms": round((time.monotonic() - started) * 1000),
            "backend": payload.backend, "sources": result["sources"], "usage": result.get("_usage", {})}


@app.get("/api/policy", response_model=PolicyRead, dependencies=[Depends(require_admin)], tags=["routing"])
def get_policy(db: DbSession) -> PolicyRead:
    policy = db.get(RoutingPolicy, 1)
    assert policy is not None
    return PolicyRead.model_validate(policy)


@app.get("/api/interop/status", dependencies=[Depends(require_admin)], tags=["routing"])
def interop_status(db: DbSession) -> dict:
    from .services.interop import ready_partners
    required = {a.aic for a in db.scalars(select(Agent)).all()
                if a.active and a.transport != "aip-rpc" and a.registration_status == "approved"}
    policy = db.get(RoutingPolicy, 1)
    return {"enabled": settings.aip_group_partner_enabled,
            "listener_worker": settings.aip_group_listener_worker,
            "expected_partners": len(required), "ready_partners": len(required & ready_partners),
            "ready": bool(required) and required.issubset(ready_partners),
            "interop_compatibility": bool(policy and policy.interop_compatibility),
            "external_delegation_enabled": bool(policy and policy.external_delegation_enabled)}


@app.put("/api/policy", response_model=PolicyRead, dependencies=[Depends(require_admin)], tags=["routing"])
def update_policy(payload: PolicyUpdate, db: DbSession, request: Request) -> PolicyRead:
    if payload.interop_compatibility:
        from .services.interop import compatibility_prerequisites, ready_partners
        try:
            compatibility_prerequisites()
            required = {a.aic for a in db.scalars(select(Agent)).all()
                        if a.active and a.transport != "aip-rpc" and a.registration_status == "approved"}
            if not required or not required.issubset(ready_partners):
                raise RuntimeError("已注册托管智能体的 MQ Partner 尚未全部连接成功")
        except (RuntimeError, OSError) as exc:
            raise HTTPException(status_code=422, detail=f"兼容模式未就绪：{exc}") from exc
    if abs(sum(payload.weights.values()) - 1) > 0.001:
        raise HTTPException(status_code=422, detail="Routing weights must sum to 1")
    policy = db.get(RoutingPolicy, 1)
    assert policy is not None
    request.state.audit_policy_changes = {
        key: {"before": getattr(policy, key), "after": value}
        for key, value in payload.model_dump(exclude_unset=True).items()
        if key in {"interop_compatibility", "external_delegation_enabled", "bounty_enabled", "bounty_max_workers", "bounty_max_items", "bounty_lease_seconds", "weights", "failure_threshold", "circuit_cooldown_seconds", "max_attempts", "request_timeout_seconds"}
        and getattr(policy, key) != value
    }
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(policy, key, value)
    db.commit()
    return PolicyRead.model_validate(policy)


@app.post("/api/chat", response_model=ChatResponse, dependencies=[Depends(require_api_key)], tags=["runtime"])
async def chat(payload: ChatRequest, db: DbSession, request: Request) -> ChatResponse:
    is_admin = bool(authenticated_admin(request, db))
    controller = AdaptiveDeadlineController(
        task_id=f"sync_{uuid.uuid4().hex[:12]}",
        profile_name=payload.task_profile,
        hard_deadline_seconds=payload.hard_deadline_seconds,
        is_admin=is_admin,
        expected_tokens=payload.expected_output_tokens,
    )
    orchestrator = ReliableOrchestrator(db, controller=controller)
    try:
        invocation, ranked, selected = await orchestrator.run(
            payload, owner_id=extract_user_id(request)
        )
    except NoEligibleAgentError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    return _chat_response(invocation, ranked, selected, db)


def _chat_response(invocation, ranked, selected, db: Session) -> ChatResponse:
    return ChatResponse(
        invocation_id=invocation.id,
        session_id=invocation.session_id,
        status=invocation.status,
        answer=invocation.result_text or "",
        selected_agent=agent_to_read(selected) if selected else None,
        candidates=[
            CandidateScore(
                agent_id=item.agent.id,
                agent_name=item.agent.name,
                eligible=item.eligible,
                score=item.score,
                rank=item.rank,
                breakdown=item.breakdown,
                reasons=item.reasons,
                weights=item.weights,
            )
            for item in ranked
        ],
        failover_count=db.scalar(
            select(func.count()).select_from(TraceEvent).where(
                TraceEvent.invocation_id == invocation.id,
                TraceEvent.event_type == "FAILOVER_STARTED",
            )
        ) or 0,
        latency_ms=invocation.total_latency_ms,
        usage={
            "llm_calls": invocation.llm_calls,
            "prompt_tokens": invocation.prompt_tokens,
            "completion_tokens": invocation.completion_tokens,
        },
        result_data=invocation.result_data,
    )


def extract_user_id(request: Request) -> str:
    owner = getattr(request.state, "owner_id", None)
    if not owner:
        raise HTTPException(401, "身份尚未初始化，请刷新页面")
    return owner


def extract_canvas_user_id(request: Request) -> str:
    """Canvas browser ownership must not be selected by an unverified API header."""
    return request.state.browser_owner_id


@app.get("/api/chat/sessions/{session_id}/activity", dependencies=[Depends(require_demo_or_admin_or_api_key)], tags=["runtime"])
def session_activity(session_id: str, request: Request, db: DbSession,
                     before: str | None = None, limit: int = Query(default=30, ge=1, le=100)) -> dict:
    from .services.session_activity import activity_data
    # Public demo access must not make an arbitrary API header an identity.
    if request.headers.get("X-API-Key"):
        require_api_key(request, db, x_api_key=request.headers["X-API-Key"])
    # Session IDs are correlation keys, never authorization. An admin looking
    # at the chat UI also sees only records owned by this authenticated client.
    owner = extract_user_id(request)
    query = select(Invocation).where(Invocation.session_id == session_id, Invocation.owner_id == owner)
    if before:
        cursor = db.get(Invocation, before)
        if not cursor or cursor.session_id != session_id or cursor.owner_id != owner:
            raise HTTPException(status_code=404, detail="会话记录不存在")
        query = query.where((Invocation.created_at < cursor.created_at) |
                            ((Invocation.created_at == cursor.created_at) & (Invocation.id < cursor.id)))
    rows = list(db.scalars(query.order_by(Invocation.created_at.desc(), Invocation.id.desc()).limit(limit + 1)))
    items = []
    for inv in rows[:limit]:
        result = _chat_response(inv, [], db.get(Agent, inv.selected_agent_id) if inv.selected_agent_id else None, db)
        result.result_data = activity_data(db, inv)
        items.append(result.model_dump(mode="json"))
    return {"session_id": session_id, "items": items, "next_before": rows[limit - 1].id if len(rows) > limit else None}


@app.post(
    "/api/invocations/{invocation_id}/feedback",
    response_model=FeedbackRead,
    dependencies=[Depends(require_demo_or_admin_or_api_key)],
    tags=["feedback"],
)
def submit_invocation_feedback(
    invocation_id: str,
    payload: FeedbackRequest,
    request: Request,
    db: DbSession,
) -> FeedbackRead:
    invocation = db.get(Invocation, invocation_id)
    owner_id = extract_user_id(request)
    is_admin = authenticated_admin(request, db) is not None
    if not invocation or (
        not is_admin
        and (not invocation.owner_id or invocation.owner_id != owner_id)
    ):
        raise HTTPException(status_code=404, detail="任务不存在")
    if invocation.status != "completed" or not invocation.selected_agent_id:
        raise HTTPException(status_code=409, detail="任务完成后才能评价")
    agent = db.get(Agent, invocation.selected_agent_id)
    if not agent:
        raise HTTPException(status_code=409, detail="当次路由的智能体已不存在")

    feedback = db.get(InvocationFeedback, invocation_id)
    previous_rating = feedback.rating if feedback else None
    if previous_rating and previous_rating != payload.rating:
        if previous_rating == "positive":
            agent.feedback_positive_count = max(0, (agent.feedback_positive_count or 0) - 1)
        else:
            agent.feedback_negative_count = max(0, (agent.feedback_negative_count or 0) - 1)
    if not feedback:
        feedback = InvocationFeedback(
            invocation_id=invocation_id,
            agent_id=agent.id,
            owner_id=invocation.owner_id or owner_id,
            rating=payload.rating,
        )
        db.add(feedback)
    if previous_rating != payload.rating:
        if payload.rating == "positive":
            agent.feedback_positive_count = (agent.feedback_positive_count or 0) + 1
        else:
            agent.feedback_negative_count = (agent.feedback_negative_count or 0) + 1
    feedback.rating = payload.rating
    feedback.updated_at = _now_utc()
    db.commit()
    return FeedbackRead(
        invocation_id=invocation_id,
        agent_id=agent.id,
        rating=payload.rating,
        positive_count=agent.feedback_positive_count or 0,
        negative_count=agent.feedback_negative_count or 0,
    )


async def _launch_chat_task(payload: ChatRequest, user_id: str, is_admin: bool = False) -> BackgroundTaskRecord:
    session_id = payload.session_id or f"ses-{uuid.uuid4().hex}"
    payload.session_id = session_id
    with SessionLocal() as db:
        bind_conversation(db, session_id, user_id)
    task_id = f"task_{uuid.uuid4().hex[:12]}"
    controller = AdaptiveDeadlineController(
        task_id=task_id,
        profile_name=payload.task_profile,
        hard_deadline_seconds=payload.hard_deadline_seconds,
        is_admin=is_admin,
        expected_tokens=payload.expected_output_tokens,
    )
    record = await task_manager.create_task(
        user_id=user_id,
        session_id=session_id,
        agent_id=payload.agent_id,
        task_id=task_id,
        controller=controller,
    )

    async def on_text(delta: str) -> None:
        controller.record_tokens(delta)
        await task_manager.publish_event(record.task_id, {"type": "delta", "text": delta})

    async def on_event(event_type: str, data: dict[str, Any]) -> None:
        await task_manager.publish_event(record.task_id, {"type": event_type, "data": data})

    async def execute() -> None:
        await task_manager.publish_event(
            record.task_id,
            {
                "type": "status",
                "status": "routing",
                "task_id": record.task_id,
                "session_id": session_id,
            },
        )
        try:
            with SessionLocal() as db:
                invocation, ranked, selected = await ReliableOrchestrator(
                    db, stream_callback=on_text, event_callback=on_event, controller=controller
                ).run(payload, owner_id=user_id)
                response = _chat_response(invocation, ranked, selected, db)
                if invocation.status == "failed":
                    await task_manager.fail_task(
                        record.task_id, response.answer or "任务执行失败"
                    )
                else:
                    await task_manager.complete_task(
                        record.task_id, response.model_dump(mode="json")
                    )
        except NoEligibleAgentError as exc:
            await task_manager.fail_task(record.task_id, str(exc))
        except asyncio.CancelledError:
            logger.info("Task %s cancelled", record.task_id)
            with suppress(Exception):
                await task_manager.fail_task(record.task_id, "任务已被取消或中断")
                with SessionLocal() as db:
                    inv = db.scalars(
                        select(Invocation)
                        .where(Invocation.session_id == session_id, Invocation.owner_id == user_id, Invocation.status == "working")
                        .order_by(Invocation.created_at.desc())
                    ).first()
                    if inv:
                        inv.status = "failed"
                        inv.finished_at = datetime.now(timezone.utc)
                        inv.result_text = "任务已被取消或中断"
                        db.add(
                            TraceEvent(
                                invocation=inv,
                                event_type="TASK_CANCELLED",
                                detail={"taskId": record.task_id},
                            )
                        )
                        db.commit()
        except Exception as exc:
            logger.exception("Chat background execution failed for task %s", record.task_id)
            err_msg = str(exc).strip()
            await task_manager.fail_task(
                record.task_id,
                f"任务执行失败：{err_msg}" if err_msg else "任务执行失败，请联系管理员。",
            )

    task = asyncio.create_task(execute())
    task_manager.attach_asyncio_task(record.task_id, task)
    return record


async def _stream_task_events(
    task_id: str, user_id: str, from_index: int = 0, heartbeat_seconds: float = 15.0
):
    stream = task_manager.subscribe(
        task_id, user_id, from_index=from_index, include_index=True
    )
    pending = asyncio.create_task(anext(stream))
    try:
        while True:
            try:
                index, event = await asyncio.wait_for(
                    asyncio.shield(pending), timeout=heartbeat_seconds
                )
            except asyncio.TimeoutError:
                # SSE comments keep idle connections open without consuming a
                # replay cursor or appearing as assistant text in the client.
                yield ": keep-alive\n\n"
                continue
            except StopAsyncIteration:
                return
            yield f"id: {index}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") in {"result", "error"}:
                return
            pending = asyncio.create_task(anext(stream))
    finally:
        if not pending.done():
            pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await stream.aclose()


@app.post("/api/chat/stream", dependencies=[Depends(require_api_key)], tags=["runtime"])
async def chat_stream(payload: ChatRequest, request: Request, db: Session = Depends(get_db)) -> StreamingResponse:
    user_id = extract_user_id(request)
    is_admin = bool(authenticated_admin(request, db))
    record = await _launch_chat_task(payload, user_id, is_admin=is_admin)
    return StreamingResponse(
        _stream_task_events(record.task_id, user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Task-Id": record.task_id,
        },
    )


@app.get("/api/tasks/active", dependencies=[Depends(require_api_key)], tags=["runtime"])
async def get_active_task(session_id: str, request: Request) -> dict[str, Any]:
    user_id = extract_user_id(request)
    task = await task_manager.get_active_task(user_id, session_id)
    if not task:
        return {"active": False}
    return {"active": True, "task": task.to_summary()}


@app.get("/api/tasks/{task_id}/stream", dependencies=[Depends(require_api_key)], tags=["runtime"])
async def reconnect_task_stream(task_id: str, request: Request, from_index: int = 0) -> StreamingResponse:
    user_id = extract_user_id(request)
    task = await task_manager.get_task(task_id, user_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found or access denied")
    return StreamingResponse(
        _stream_task_events(task_id, user_id, from_index=max(0, from_index)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Task-Id": task_id,
        },
    )


@app.post("/api/tasks/{task_id}/cancel", dependencies=[Depends(require_api_key)], tags=["runtime"])
async def cancel_task(task_id: str, request: Request) -> dict[str, Any]:
    user_id = extract_user_id(request)
    cancelled = await task_manager.cancel_task(task_id, user_id)
    return {"ok": cancelled}


@app.post(
    "/api/demo/chat",
    response_model=ChatResponse,
    dependencies=[Depends(require_demo)],
    tags=["demo"],
)
async def demo_chat(payload: ChatRequest, db: DbSession, request: Request) -> ChatResponse:
    return await chat(payload, db, request=request)


def _group_transport_for(members: list[str], db: Session) -> str:
    has_external = any(
        (agent := db.get(Agent, m)) is not None and agent.transport == "aip-rpc"
        for m in members
    )
    if has_external and (settings.aip_group_mq_host or settings.aip_group_mq_url):
        return "aip-mq"
    return "local"


async def run_group_agent_reply(db: Session, agent: Agent, prompt: str, timeout: float, group_session_id: str) -> str:
    """本地传输执行群发言：托管模型走各自传输层，外部 aip-rpc 走点对点 RPC。"""
    provider = db.get(ProviderConfig, agent.model_provider) if agent.transport == "provider" else None
    registry = TransportRegistry()
    transport = registry.get(provider.kind if provider else agent.transport)
    kwargs: dict[str, Any] = {"session_id": group_session_id}
    if provider:
        kwargs["provider"] = provider
    kwargs["tool_registry"] = ToolRegistry()
    policy = db.get(RoutingPolicy, 1)
    if policy and policy.interop_compatibility:
        if agent.transport != "aip-rpc" and agent.aic != settings.leader_aic:
            from .services.interop import invoke_hosted
            result = await invoke_hosted(settings.leader_aic, agent, prompt, group_session_id, timeout,
                                        lambda: transport.execute(agent, prompt, timeout, **kwargs))
            return result.text
        if agent.transport == "aip-rpc":
            kwargs.update(caller_aic=settings.leader_aic, interop_compatibility=True)
    result = await transport.execute(agent, prompt, timeout, **kwargs)
    return result.text


def _group_members_row(group: GroupChat, db: Session) -> str:
    rows = []
    for m in group.members:
        agent = db.get(Agent, m)
        rows.append(f"- {agent.name if agent else m}（ID: {m}，专长: {(agent.description or '领域专家')[:60] if agent else '领域专家'}）")
    return "\n".join(rows) or "-（暂无成员）"


def _group_history_text(group_id: str, db: Session, limit: int = 14) -> str:
    rows = list(
        db.scalars(
            select(GroupChatMessage)
            .where(GroupChatMessage.group_id == group_id)
            .order_by(GroupChatMessage.id.desc())
            .limit(limit)
        ).all()
    )
    return "\n\n".join(
        f"【{row.nickname or row.sender_name or row.sender_id}】: {row.content}" for row in reversed(rows)
    ) or "（暂无历史发言）"


@app.get("/api/canvas/{canvas_id}", dependencies=[Depends(require_demo)], tags=["canvas"])
def get_canvas(canvas_id: str, request: Request, db: DbSession) -> dict:
    from .models import CanvasDoc
    from .services.canvas import history as canvas_history_rows

    doc = db.get(CanvasDoc, canvas_id)
    if not doc or doc.owner_id != extract_canvas_user_id(request):
        raise HTTPException(status_code=404, detail="画布不存在")
    return {
        "id": doc.id,
        "title": doc.title,
        "content": doc.content,
        "version": doc.version,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "revisions": canvas_history_rows(db, canvas_id, limit=30),
    }


@app.get("/api/canvas/{canvas_id}/revisions/{version}", dependencies=[Depends(require_demo)], tags=["canvas"])
def get_canvas_revision(canvas_id: str, version: int, request: Request, db: DbSession) -> dict:
    from .models import CanvasDoc, CanvasRevision

    doc = db.get(CanvasDoc, canvas_id)
    if not doc or doc.owner_id != extract_canvas_user_id(request):
        raise HTTPException(status_code=404, detail="画布不存在")
    revision = db.query(CanvasRevision).filter(
        CanvasRevision.canvas_id == canvas_id, CanvasRevision.version == version
    ).first()
    if not revision:
        raise HTTPException(status_code=404, detail="该版本无可用快照")
    return {"version": revision.version, "content": revision.content_after, "summary": revision.summary}


@app.get("/api/canvas/session/{session_id}", dependencies=[Depends(require_demo)], tags=["canvas"])
def get_session_canvas(session_id: str, request: Request, db: DbSession) -> dict:
    from .services.canvas import CanvasError, get_or_create_session_canvas, history as canvas_history_rows

    try:
        doc = get_or_create_session_canvas(db, session_id, extract_canvas_user_id(request))
    except CanvasError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "id": doc.id,
        "title": doc.title,
        "content": doc.content,
        "version": doc.version,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "revisions": canvas_history_rows(db, doc.id, limit=30),
    }


@app.put("/api/canvas/session/{session_id}", dependencies=[Depends(require_demo)], tags=["canvas"])
def update_session_canvas(
    session_id: str, payload: CanvasUpdate, request: Request, db: DbSession
) -> dict:
    from .services.canvas import (
        CanvasError, get_or_create_session_canvas, history as canvas_history_rows,
        replace_document,
    )

    owner_id = extract_canvas_user_id(request)
    try:
        doc = get_or_create_session_canvas(db, session_id, owner_id)
        doc = replace_document(
            db, doc, content=payload.content,
            base_version=payload.base_version, owner_id=owner_id,
        )
    except CanvasError as exc:
        code = 409 if "版本" in str(exc) else 404
        raise HTTPException(status_code=code, detail=str(exc)) from exc
    return {
        "id": doc.id,
        "title": doc.title,
        "content": doc.content,
        "version": doc.version,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "revisions": canvas_history_rows(db, doc.id, limit=30),
    }


@app.post("/api/group-chat", dependencies=[Depends(require_demo)], tags=["group-chat"])
def create_group_chat(payload: GroupChatCreate, request: Request, db: DbSession) -> dict:
    members = list(dict.fromkeys(m for m in payload.members if (a := db.get(Agent, m)) and a.active))
    if not members:
        raise HTTPException(status_code=422, detail="群成员中没有任何有效智能体")
    transport = _group_transport_for(members, db)
    group_id = f"group-{uuid.uuid4().hex[:10]}"
    group = GroupChat(
        id=group_id,
        owner_id=extract_canvas_user_id(request),
        name=payload.name.strip()[:120] or "群聊",
        host_agent_id=payload.host_agent_id if payload.host_agent_id in members else "",
        members=members,
        transport=transport,
    )
    db.add(group)
    db.commit()
    return {"id": group.id, "name": group.name, "transport": group.transport, "members": members}


@app.get("/api/group-chat/{group_id}", dependencies=[Depends(require_demo)], tags=["group-chat"])
def get_group_chat(group_id: str, request: Request, db: DbSession) -> dict:
    group = db.get(GroupChat, group_id)
    if not group or not group.owner_id or group.owner_id != extract_canvas_user_id(request):
        raise HTTPException(status_code=404, detail="群聊不存在")
    messages = list(
        db.scalars(
            select(GroupChatMessage)
            .where(GroupChatMessage.group_id == group_id)
            .order_by(GroupChatMessage.id)
        ).all()
    )
    return {
        "id": group.id,
        "name": group.name,
        "host_agent_id": group.host_agent_id,
        "members": group.members,
        "transport": group.transport,
        "messages": [
            {
                "sender_id": m.sender_id,
                "sender_name": m.sender_name,
                "role": m.role,
                "msg_type": m.msg_type,
                "nickname": m.nickname,
                "content": m.content,
                "created_at": m.created_at.isoformat(),
            }
            for m in messages
        ],
    }


@app.post("/api/group-chat/{group_id}/messages", dependencies=[Depends(require_demo)], tags=["group-chat"])
async def post_group_chat_message(group_id: str, payload: GroupChatMessageIn, request: Request, db: DbSession) -> dict:
    group = db.get(GroupChat, group_id)
    owner = extract_canvas_user_id(request)
    if not group or not group.owner_id or group.owner_id != owner:
        raise HTTPException(404, "群聊不存在")
    quota_id = f"group:{uuid.uuid4().hex}"
    quotas.reserve(db, owner=owner, entry_id=quota_id, session_id=group_id)
    try:
        result = await _post_group_chat_message(group_id, payload, request, db)
        quotas.settle(db, quota_id, success=not result.get("error"))
        return result
    except BaseException:
        db.rollback()
        quotas.settle(db, quota_id, success=False)
        raise


async def _post_group_chat_message(group_id: str, payload: GroupChatMessageIn, request: Request, db: DbSession) -> dict:
    group = db.get(GroupChat, group_id)
    if not group or not group.owner_id or group.owner_id != extract_canvas_user_id(request):
        raise HTTPException(status_code=404, detail="群聊不存在")
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="消息不能为空")

    target_id = payload.mentioned or group.host_agent_id or (group.members[0] if group.members else "")
    target_agent = db.get(Agent, target_id) if target_id else None
    if not target_agent or not target_agent.active or target_id not in group.members:
        raise HTTPException(422, "只能派发给本群已启用的智能体成员")

    user_nick = "群主 (用户)" if not group.host_agent_id else "我 (群成员)"
    db.add(
        GroupChatMessage(
            group_id=group_id, sender_id="user", sender_name="用户",
            role="user", msg_type="chat", nickname=user_nick, content=text,
        )
    )
    db.commit()

    if target_agent is None:
        db.commit()
        return {"reply": None, "agent_id": None, "agent_name": None, "transport": group.transport}

    is_host = target_id == group.host_agent_id
    valid_names = "、".join(
        (agent.name if (agent := db.get(Agent, m)) else m)
        for m in group.members
    )
    prompt = (
        f"【AIP 国标规范·智能体多方协作群聊】\n"
        f"你正在参与群聊「{group.name}」。\n"
        f"你的身份：{target_agent.name}（角色：{'本群主持人' if is_host else '受邀群成员'}）。\n"
        f"群内所有智能体成员（仅限以下真实成员）：\n{_group_members_row(group, db)}\n\n"
        f"【核心协作与输出规范（必须严格遵守）】：\n"
        f"1. 真实工作群沟通（仅限沟通短语）：群聊公开回复必须像人类专家在微信工作群/Slack/飞书协作一样简明干练（控制在 50~120 字以内）。聊天气泡内只允许输出人类沟通短语（如确认诉求、交接工作、告知进度、@下一棒），严禁在主聊天气泡内直接罗列大篇幅方案正文、长清单、复杂表格或多级标题。\n"
        f"2. 实质方案全部放入黑板（对齐 GB/T 43444-2023 与 GB/T 7714-2015 国家标准）：所有实质性的工作交付物（如详细研究方案、计量方程、因果推断设计、数据提取表、文献综述、代码等），必须且只能放入以下 blackboard 代码块中：\n"
        f"```blackboard:交付物标题\n"
        f"这里放置完整的详细方案、表格、数据或代码...\n"
        f"```\n"
        f"若涉及学术文献，必须严格遵循国家标准《GB/T 7714-2015》著录规范（包含序号、责任者、题名、出版项与 DOI 溯源标识）。系统会自动将黑板内容提取沉淀到右侧【黑板】资产库并核验国标流水号，保持群聊主气泡清爽整洁。\n"
        f"3. 严禁幻觉 @：你只能 @ 本群真实存在的成员（当前仅限：{valid_names}）。绝对严禁 @ 未入群的角色（严禁出现 @research_leader 或任何未在群成员列表中的假想负责人）。如需向群主汇报且未指定主持人，直接以文字回复群主即可。\n"
        f"4. {'作为主持人，你负责统筹协调：直接解答疑问、拆解任务并艾特对应专家，或面向全群总结。' if is_host else '作为受邀专家，请针对艾特你的问题或主持人的委派，给出专业解答。'}\n\n"
        f"【群聊历史公开记录】：\n{_group_history_text(group_id, db)}\n\n"
        f"请作为「{target_agent.name}」在群聊中发表你的公开回复："
    )

    reply_text = ""
    error_note = ""
    policy = db.get(RoutingPolicy, 1)
    if policy and policy.interop_compatibility:
        try:
            reply_text = await run_group_agent_reply(db, target_agent, prompt, 90.0, group_id)
        except Exception as exc:
            error_note = str(exc)
    elif group.transport == "aip-mq" and target_agent.transport == "aip-rpc":
        if not settings.leader_aic:
            error_note = "未配置 LEADER_AIC，无法使用国标 MQ 群组"
        else:
            partners = [
                ExternalPartner(aic=agent.aic, name=agent.name, rpc_url=agent.endpoint_url)
                for m in group.members
                if (agent := db.get(Agent, m)) is not None and agent.active and agent.transport == "aip-rpc" and agent.endpoint_url
            ]
            session = None
            try:
                session = await get_mq_session(f"group:{group_id}", settings.leader_aic, partners)
                reply_text = await session.send_and_collect(
                    prompt,
                    session_id=group_id,
                    target_aic=target_agent.aic if target_agent.transport == "aip-rpc" else None,
                    timeout_seconds=90.0,
                )
            except (AipGroupBridgeError, asyncio.TimeoutError) as exc:
                error_note = f"国标 MQ 群组异常：{exc}"
            except Exception as exc:
                error_note = f"国标 MQ 群组异常：{exc}"
            finally:
                if session:
                    await session.close()
    else:
        try:
            reply_text = await run_group_agent_reply(db, target_agent, prompt, 90.0, group_id)
        except Exception as exc:
            error_note = str(exc)

    if error_note:
        db.add(
            GroupChatMessage(
                group_id=group_id, sender_id="system", sender_name="系统",
                role="system", msg_type="error", nickname="系统",
                content=f"⚠️ [{target_agent.name}] 发言失败：{error_note[:300]}",
            )
        )
        db.commit()
        return {"reply": None, "agent_id": target_id, "agent_name": target_agent.name, "transport": group.transport, "error": error_note[:300]}

    reply_text = reply_text.strip()
    db.add(
        GroupChatMessage(
            group_id=group_id, sender_id=target_agent.id, sender_name=target_agent.name,
            role="agent", msg_type="chat",
            nickname=f"@{target_agent.name.replace('智能体', '').strip() or target_agent.id}专家",
            content=reply_text[:8000],
        )
    )
    db.commit()
    return {"reply": reply_text, "agent_id": target_agent.id, "agent_name": target_agent.name, "transport": group.transport}


@app.post(
    "/api/demo/chat/stream",
    dependencies=[Depends(require_demo)],
    tags=["demo"],
)
async def demo_chat_stream(payload: ChatRequest, request: Request) -> StreamingResponse:
    user_id = extract_user_id(request)
    record = await _launch_chat_task(payload, user_id, is_admin=False)
    return StreamingResponse(
        _stream_task_events(record.task_id, user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Task-Id": record.task_id,
        },
    )


@app.get("/api/demo/tasks/active", dependencies=[Depends(require_demo)], tags=["demo"])
async def demo_get_active_task(session_id: str, request: Request, db: DbSession) -> dict[str, Any]:
    user_id = extract_user_id(request)
    task = await task_manager.get_active_task(user_id, session_id)
    if not task:
        latest = db.scalar(
            select(Invocation)
            .where(Invocation.owner_id == user_id, Invocation.session_id == session_id)
            .order_by(Invocation.created_at.desc())
        )
        if latest and latest.status == "failed" and (latest.result_data or {}).get("interrupted"):
            return {
                "active": False,
                "interrupted": {
                    "invocation_id": latest.id,
                    "message": INTERRUPTED_MESSAGE,
                    "partial_result": (latest.result_data or {}).get("interrupted_partial") or "",
                },
            }
        return {"active": False}
    return {"active": True, "task": task.to_summary()}


@app.get("/api/demo/tasks/{task_id}/stream", dependencies=[Depends(require_demo)], tags=["demo"])
async def demo_reconnect_task_stream(task_id: str, request: Request, from_index: int = 0) -> StreamingResponse:
    user_id = extract_user_id(request)
    task = await task_manager.get_task(task_id, user_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found or access denied")
    return StreamingResponse(
        _stream_task_events(task_id, user_id, from_index=max(0, from_index)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Task-Id": task_id,
        },
    )


@app.post("/api/demo/tasks/{task_id}/cancel", dependencies=[Depends(require_demo)], tags=["demo"])
async def demo_cancel_task(task_id: str, request: Request) -> dict[str, Any]:
    user_id = extract_user_id(request)
    cancelled = await task_manager.cancel_task(task_id, user_id)
    return {"ok": cancelled}


def get_uploads_dir() -> Path:
    settings = get_settings()
    if settings.database_url.startswith("sqlite:"):
        database_path = make_url(settings.database_url).database
        base_dir = Path(database_path).parent if database_path and database_path != ":memory:" else Path("data")
    else:
        base_dir = Path("backend/data") if Path("backend/data").exists() else Path("data")
    uploads_dir = base_dir / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    return uploads_dir


@app.post(
    "/api/upload",
    response_model=UploadResponse,
    dependencies=[Depends(require_demo_or_admin_or_api_key)],
    tags=["runtime"],
)
async def upload_file(request: Request, db: DbSession, file: UploadFile = File(...)) -> UploadResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="未提供有效文件名")

    uploads_dir = get_uploads_dir()
    file_id = secrets.token_hex(8)
    clean_name = Path(file.filename).name.replace(" ", "_")
    safe_name = f"{file_id}_{clean_name}"
    dest_path = uploads_dir / safe_name

    content = await file.read(30 * 1024 * 1024 + 1)
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件大小超出 30MB 限制")

    quota_id = f"upload:{file_id}"
    quotas.reserve(db, owner=extract_user_id(request), entry_id=quota_id, resource="upload_bytes", amount=max(1, len(content)))
    try:
        dest_path.write_bytes(content)
    except BaseException:
        quotas.settle(db, quota_id, success=False)
        raise
    quotas.settle(db, quota_id, success=True)

    content_type = file.content_type or "application/octet-stream"
    ext = dest_path.suffix.lower()
    is_image = content_type.startswith("image/") or ext in {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
        ".svg",
        ".bmp",
    }

    extracted_text_preview = None
    extracted_text = None
    text_length = 0

    if not is_image:
        try:
            tool_res = ToolRegistry().execute(
                "extract_file_content", {"file_path": str(dest_path), "max_chars": 20000}
            )
            if tool_res.get("ok"):
                inner = tool_res.get("result") if isinstance(tool_res.get("result"), dict) else {}
                extracted_text = inner.get("content", "")
                text_length = inner.get("char_count", len(extracted_text))
                extracted_text_preview = extracted_text[:500] if extracted_text else None
        except Exception as e:
            logger.warning("Could not extract text from uploaded file %s: %s", clean_name, e)

    file_url = f"/api/uploads/{safe_name}"
    return UploadResponse(
        ok=True,
        file_id=file_id,
        filename=clean_name,
        content_type=content_type,
        size=len(content),
        url=file_url,
        is_image=is_image,
        extracted_text_preview=extracted_text_preview,
        extracted_text=extracted_text,
        text_length=text_length,
    )


@app.get(
    "/api/uploads/{filename:path}",
    tags=["runtime"],
)
async def get_uploaded_file(filename: str) -> FileResponse:
    uploads_dir = get_uploads_dir().resolve()
    safe_path = (uploads_dir / filename).resolve()
    if not safe_path.is_relative_to(uploads_dir):
        raise HTTPException(status_code=400, detail="非法文件路径")
    if not safe_path.exists() or not safe_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    # Uploaded HTML/SVG must not become scripts running under the account origin.
    image_types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}
    image_type = image_types.get(safe_path.suffix.lower())
    return FileResponse(safe_path, media_type=image_type or "application/octet-stream",
                        filename=None if image_type else safe_path.name,
                        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
                                 "Cache-Control": "private, no-store"})



@app.post("/api/discovery/search", dependencies=[Depends(require_demo_or_admin_or_api_key)], tags=["discovery"])
async def discover_agents(payload: DiscoveryQuery, db: DbSession) -> dict:
    try:
        result = await AdpDiscoveryClient().discover(
            query=payload.query,
            limit=payload.limit,
            session_id=payload.session_id,
            recent_turns=payload.recent_turns,
            aic=payload.aic, name=payload.name, endpoint_url=payload.endpoint_url,
            exact_name=payload.exact_name,
        )
        from .services.agent_search import search_constraints
        candidates = discovery_candidates(db, result, search_constraints(payload.model_dump()))
        result["candidates"] = rank_discovery(db, candidates, payload.query)
        return result
    except DiscoveryError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


_discovery_feed_cache: dict[tuple[str, int], dict[str, Any]] = {}


@app.get("/api/discovery/feed", dependencies=[Depends(require_demo_or_admin_or_api_key)], tags=["discovery"])
async def get_discovery_feed(db: DbSession, refresh: bool = False, limit: int = 30, query: str = "") -> list[dict[str, Any]]:
    now = time.monotonic()
    query = query.strip()[:2000] or "智能体"
    limit = max(1, min(limit, 50))
    key = (query, limit)
    cached = _discovery_feed_cache.get(key)
    fresh = False
    if not refresh and cached and now - cached["timestamp"] < 60.0:
        res = cached["response"]
    else:
        try:
            res = await AdpDiscoveryClient().discover(query=query, limit=limit)
        except DiscoveryError as exc:
            # Never report a stale cache as a successful refreshed discovery.
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if len(_discovery_feed_cache) >= 32 and key not in _discovery_feed_cache:
            _discovery_feed_cache.pop(next(iter(_discovery_feed_cache)))
        cached = {"timestamp": now, "response": res, "checked_at": datetime.now(timezone.utc).isoformat()}
        _discovery_feed_cache[key] = cached
        fresh = True
    try:
        acs_map = res.get("acsMap") or {}
        alive_map = res.get("aliveMap") or {}
        scores = {item["aic"]: item for item in rank_discovery(db, discovery_candidates(db, res), query)}
        items = []
        for aic, data in acs_map.items():
            if not isinstance(data, dict):
                continue
            skills = data.get("skills") or []
            endpoints = data.get("endPoints") or []
            provider = data.get("provider") or {}
            entity_meta = data.get("entityMeta") or {}
            provider_ctx = entity_meta.get("provider_context") if isinstance(entity_meta, dict) else {}
            org = ""
            if isinstance(provider, dict) and provider.get("organization"):
                org = str(provider["organization"])
            elif isinstance(provider_ctx, dict) and (provider_ctx.get("school") or provider_ctx.get("team")):
                school = provider_ctx.get("school", "")
                team = provider_ctx.get("team", "")
                org = f"{school} · {team}" if (school and team) else (school or team)

            transport = "HTTP_JSON"
            endpoint_url = ""
            if endpoints and isinstance(endpoints[0], dict):
                endpoint_url = str(endpoints[0].get("url") or "")
                transport = str(endpoints[0].get("transport") or ("AMQPS" if "amqps://" in endpoint_url else "HTTP_JSON"))

            capabilities = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
            message_queue = capabilities.get("messageQueue") or []
            group_declared = bool(message_queue) or any(
                isinstance(item, dict) and str(item.get("url") or "").startswith("amqps://")
                for item in endpoints
            )
            items.append({
                "aic": aic,
                "name": data.get("name") or aic,
                "description": data.get("description") or "",
                "active": bool(data.get("active", True)),
                "organization": org,
                "endpoint_url": endpoint_url,
                "transport": transport,
                "skills": skills,
                "security_schemes": list(data.get("securitySchemes", {}).keys()) if isinstance(data.get("securitySchemes"), dict) else ["mtls"],
                "streaming": bool((data.get("capabilities") or {}).get("streaming")),
                "notification": bool(capabilities.get("notification")),
                "group": group_declared,
                "alive": (alive_map.get(aic) or {}).get("alive") if isinstance(alive_map.get(aic), dict) else None,
                "raw_acs": data,
                "is_external": True,
                "cache_state": "fresh" if fresh else "cached",
                "discovered_at": cached["checked_at"],
                "score": scores.get(aic),
            })
        items.sort(key=lambda item: (
            not bool((item["score"] or {}).get("eligible")),
            (item["score"] or {}).get("rank") or 9999, item["aic"],
        ))
        return items
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"获取全网发现智能体失败: {exc}") from exc


@app.post("/api/discovery/import", response_model=AgentRead, status_code=201, dependencies=[Depends(require_admin)], tags=["discovery"])
def import_discovered_agent(payload: DiscoveryImportRequest, db: DbSession) -> AgentRead:
    existing = db.scalar(select(Agent).where(Agent.aic == payload.aic))
    if existing:
        raise HTTPException(status_code=409, detail=f"该智能体 (AIC: {payload.aic}) 已在系统中导入")

    clean_name = re.sub(r"[^a-zA-Z0-9_]", "_", payload.name.strip().lower()).strip("_") or "ext"
    suffix = payload.aic.replace(".", "_")[-6:].lower()
    candidate_id = f"ext_{clean_name[:16]}_{suffix}"
    counter = 1
    while db.get(Agent, candidate_id):
        candidate_id = f"ext_{clean_name[:12]}_{suffix}_{counter}"
        counter += 1

    agent = Agent(
        id=candidate_id,
        aic=payload.aic,
        name=payload.name,
        description=payload.description or f"通过 ADP 发现服务导入的外部智能体 (AIC: {payload.aic})",
        role="partner",
        transport="aip-rpc",
        endpoint_url=payload.endpoint or payload.endpoint_mtls or "",
        skills=payload.skills,
        input_modes=["text/plain", "application/json"],
        output_modes=["application/json", "text/markdown", "text/plain"],
        health=health_from_alive_map({payload.aic: {"alive": payload.alive}} if payload.alive is not None else {}, payload.aic),
        registration_status="imported",
        usage_mode="external",
        streaming_enabled=bool(payload.streaming) if payload.streaming is not None else False,
        notification_enabled=bool(payload.notification) if payload.notification is not None else False,
        group_enabled=bool(payload.group) if payload.group is not None else False,
        model_provider="",
    )
    db.add(agent)
    db.commit()
    return agent_to_read(agent)


@app.get("/api/admin/logs/status", dependencies=[Depends(require_admin)], tags=["observability"])
def logs_status(db: DbSession, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return index_status(db)


@app.get("/api/admin/logs/export", dependencies=[Depends(require_admin)], tags=["observability"])
def logs_export(db: DbSession, query: Annotated[LogQuery, Query()]) -> Response:
    # Export is a bounded, redacted snapshot, not a download of the raw AMP file.
    conditions = query_conditions(query)
    total = db.scalar(select(func.count()).select_from(OperationalLog).where(*conditions)) or 0
    rows = db.scalars(select(OperationalLog).where(*conditions).order_by(OperationalLog.occurred_at.desc(), OperationalLog.id.desc()).limit(2000)).all()
    metadata = {"export_type": "aegismesh-redacted-logs", "total_matching": total, "exported": len(rows),
                "truncated": total > len(rows), "platform_receipt": "not_observed"}
    content = "\n".join(json.dumps(item, ensure_ascii=False) for item in [metadata, *[log_read(row, detail=True) for row in rows]]) + "\n"
    return Response(content, media_type="application/x-ndjson", headers={
        "Content-Disposition": 'attachment; filename="aegismesh-redacted-logs.jsonl"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })


@app.get("/api/admin/logs", dependencies=[Depends(require_admin)], tags=["observability"])
def logs_list(db: DbSession, response: Response, query: Annotated[LogQuery, Query()]) -> dict:
    response.headers["Cache-Control"] = "no-store"
    try:
        return list_logs(db, query)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/admin/logs/{log_id}", dependencies=[Depends(require_admin)], tags=["observability"])
def logs_detail(log_id: int, db: DbSession, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    row = db.get(OperationalLog, log_id)
    if not row:
        raise HTTPException(status_code=404, detail="记录不存在或已超出本地保留范围")
    return log_read(row, detail=True)


@app.get("/api/invocations", response_model=list[TraceRead], dependencies=[Depends(require_admin)], tags=["observability"])
def list_invocations(db: DbSession, limit: int = 50, offset: int = 0) -> list[TraceRead]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    invocations = db.scalars(
        select(Invocation).order_by(desc(Invocation.created_at)).offset(offset).limit(limit)
    ).all()
    return [trace_to_read(invocation, db) for invocation in invocations]


@app.get("/api/invocations/{invocation_id}", response_model=TraceRead, dependencies=[Depends(require_admin)], tags=["observability"])
def get_invocation(invocation_id: str, db: DbSession) -> TraceRead:
    invocation = db.get(Invocation, invocation_id)
    if not invocation:
        raise HTTPException(status_code=404, detail="Invocation not found")
    return trace_to_read(invocation, db)


@app.get("/api/probes", response_model=list[ProbeRead], dependencies=[Depends(require_admin)], tags=["probes"])
def list_probes(db: DbSession, limit: int = 100) -> list[ProbeRead]:
    rows = db.scalars(select(ProbeResult).order_by(desc(ProbeResult.created_at)).limit(min(limit, 200))).all()
    return [ProbeRead.model_validate(row) for row in rows]


@app.post("/api/probes/run", response_model=list[ProbeRead], dependencies=[Depends(require_admin)], tags=["probes"])
async def run_probes(db: DbSession) -> list[ProbeRead]:
    probe = AgentProbe()
    agents = list(db.scalars(select(Agent).where(Agent.active.is_(True))).all())
    results = [await probe.run_for_agent(db, agent) for agent in agents]
    return [ProbeRead.model_validate(row) for row in results]


@app.post("/api/probes/{agent_id}", response_model=ProbeRead, dependencies=[Depends(require_admin)], tags=["probes"])
async def run_agent_probe(agent_id: str, db: DbSession) -> ProbeRead:
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    result = await AgentProbe().run_for_agent(db, agent)
    return ProbeRead.model_validate(result)


@app.get("/api/agents/{agent_id}/acs", dependencies=[Depends(require_api_key)], tags=["acps"])
def get_agent_acs(agent_id: str, request: Request, db: DbSession) -> dict:
    agent = db.get(Agent, agent_id)
    if not agent or agent.usage_mode == "internal" or not public_aic(agent):
        raise HTTPException(status_code=404, detail="Agent not found")
    rpc_url = (
        agent.endpoint_url
        if agent.transport == "aip-rpc"
        else hosted_public_rpc_url(agent)
    )
    return build_acs(agent, rpc_url)


@app.get("/api/agents/{agent_id}/acs-preview", dependencies=[Depends(require_admin)], tags=["acps"])
def preview_agent_acs(agent_id: str, request: Request, db: DbSession) -> dict:
    agent = db.get(Agent, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    hosted_rpc_url = (
        hosted_public_rpc_url(agent)
        if agent.transport != "aip-rpc"
        else agent.endpoint_url
    )
    rpc_url = agent.endpoint_url if agent.transport == "aip-rpc" else hosted_rpc_url
    return {
        "acs": build_acs(agent, rpc_url),
        "target_registry": settings.registry_api_url,
        "registry_username": settings.registry_username,
        "public_rpc_url": rpc_url,
    }



def _platform_leader(db: Session) -> Agent | None:
    """平台对外的协调型智能体：取第一个持有公开 AIC 且非外接传输的 leader。"""
    leaders = db.scalars(select(Agent).where(Agent.role == "leader").order_by(Agent.id)).all()
    for candidate in leaders:
        if public_aic(candidate) and candidate.transport != "aip-rpc":
            return candidate
    return None


@app.get("/.well-known/acs.json", tags=["acps"])
def platform_acs(request: Request, db: DbSession) -> dict:
    leader = _platform_leader(db)
    if not leader:
        raise HTTPException(status_code=404, detail="Leader not configured")
    rpc_url = (hosted_public_rpc_url(leader) if leader.id in settings.aip_agent_public_urls
               else settings.platform_rpc_url or f"{_public_base_url(request)}:8443/aip/platform/rpc")
    return build_acs(leader, rpc_url)


@app.post("/aip/platform/rpc", tags=["aip"])
async def platform_rpc(request: Request, db: DbSession):
    """平台级 AIP RPC 入口：对外代表协调型智能体受理国标任务（含探活兼容）。"""
    leader = _platform_leader(db)
    if not leader:
        raise HTTPException(status_code=404, detail="Platform leader not configured")
    require_hosted_aip_runtime()
    require_listener_identity(leader)
    try:
        payload = await request.json()
    except (json.JSONDecodeError, Exception) as exc:
        raise HTTPException(status_code=400, detail="AIP 请求格式无效") from exc

    # 兼容官方探针/探活请求（method="get" / "ping" 或 taskId="probe" / "ping"）
    if isinstance(payload, dict):
        method = str(payload.get("method") or "").lower()
        params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        if method in {"get", "ping"} or params.get("taskId") in {"probe", "ping"}:
            return {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "result": {
                    "taskId": params.get("taskId") or "probe",
                    "status": {"state": "Completed", "progress": 1.0},
                    "dataItems": [{"type": "text", "text": f"Platform {leader.name} is ready"}],
                },
            }

    try:
        rpc_request = RpcRequest.model_validate(payload)
    except PydanticValidationError as exc:
        raise HTTPException(status_code=400, detail="AIP 请求格式无效") from exc
    peer_aic = require_inbound_identity(request, rpc_request.params.command.senderId)
    service = HostedAipService(db, leader, owner_peer_aic=peer_aic, background=True)
    t0 = time.monotonic()
    status_code = 200
    task_id = rpc_request.params.command.taskId or f"task_{int(t0 * 1000)}"
    try:
        return await handle_rpc_request(
            request,
            CommandHandlers(),
            local_aic=leader.aic,
            identity_binding_enabled=True,
            dispatch_request=service.dispatch,
        )
    except Exception:
        status_code = 500
        raise
    finally:
        duration_ms = int((time.monotonic() - t0) * 1000)
        asyncio.create_task(
            amp_service.record_access(
                caller_aic=peer_aic,
                callee_aic=leader.aic,
                reporter_aic=leader.aic,
                task_id=task_id,
                route="/aip/platform/rpc",
                url="/aip/platform/rpc",
                status_code=status_code,
                duration_ms=duration_ms,
                session_id=rpc_request.params.command.sessionId,
            )
        )


def require_listener_identity(agent: Agent) -> None:
    if settings.aip_tls_local_aic and settings.aip_tls_local_aic != agent.aic:
        raise HTTPException(status_code=421, detail="目标智能体与当前 TLS 入口证书身份不一致")


def _hosted_partner(agent_id: str, db: Session) -> Agent:
    agent = db.get(Agent, agent_id)
    if not agent:
        agent = db.scalar(select(Agent).where(Agent.aic == agent_id))
    if not agent or agent.transport == "aip-rpc" or agent.usage_mode == "internal" or not public_aic(agent):
        raise HTTPException(status_code=404, detail="Hosted Agent not found")
    require_listener_identity(agent)
    return agent


@app.post("/aip/{agent_id}/rpc", tags=["aip"])
async def hosted_partner_rpc(agent_id: str, request: Request, db: DbSession):
    agent = _hosted_partner(agent_id, db)
    require_hosted_aip_runtime()
    try:
        payload = await request.json()
    except (json.JSONDecodeError, Exception) as exc:
        raise HTTPException(status_code=400, detail="AIP 请求格式无效") from exc

    # 兼容官方探针/探活请求（method="get" / "ping" 或 taskId="probe" / "ping"）
    if isinstance(payload, dict):
        method = str(payload.get("method") or "").lower()
        params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        if method in {"get", "ping"} or params.get("taskId") in {"probe", "ping"}:
            return {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "result": {
                    "taskId": params.get("taskId") or "probe",
                    "status": {"state": "Completed", "progress": 1.0},
                    "dataItems": [{"type": "text", "text": f"Agent {agent.name} is ready"}],
                },
            }

    try:
        rpc_request = RpcRequest.model_validate(payload)
    except PydanticValidationError as exc:
        raise HTTPException(status_code=400, detail="AIP 请求格式无效") from exc
    peer_aic = require_inbound_identity(request, rpc_request.params.command.senderId)
    service = HostedAipService(db, agent, owner_peer_aic=peer_aic, background=True)
    t0 = time.monotonic()
    status_code = 200
    task_id = rpc_request.params.command.taskId or f"task_{int(t0 * 1000)}"
    try:
        return await handle_rpc_request(
            request,
            CommandHandlers(),
            local_aic=agent.aic,
            identity_binding_enabled=True,
            dispatch_request=service.dispatch,
        )
    except Exception:
        status_code = 500
        raise
    finally:
        duration_ms = int((time.monotonic() - t0) * 1000)
        asyncio.create_task(
            amp_service.record_access(
                caller_aic=peer_aic,
                callee_aic=agent.aic,
                reporter_aic=agent.aic,
                task_id=task_id,
                route=f"/aip/{agent_id}/rpc",
                url=f"/aip/{agent_id}/rpc",
                status_code=status_code,
                duration_ms=duration_ms,
                session_id=rpc_request.params.command.sessionId,
            )
        )


@app.post("/api/aip/notifications/callback", tags=["aip"])
async def aip_notification_callback(request: Request) -> dict[str, bool]:
    """Partner push target. The shared token is the authorization."""
    from .services.aip_notify import notification_inbox

    token = request.headers.get("X-ACPs-AIP-Notification-Token", "")
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="通知正文无法解析") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="通知正文无法解析")
    task_id = str(payload.get("taskId") or "")
    if not notification_inbox.accept(task_id, token, payload):
        raise HTTPException(status_code=401, detail="通知令牌无效")
    return {"ok": True}


@app.post("/aip/{agent_id}/stream", tags=["aip"])
async def hosted_partner_stream(agent_id: str, request: Request, db: DbSession):
    agent = _hosted_partner(agent_id, db)
    if not agent.streaming_enabled:
        raise HTTPException(status_code=409, detail="该智能体未启用流式输出")
    require_hosted_aip_runtime()
    try:
        payload = await request.json()
        stream_request = StreamRequestModel.model_validate(payload)
    except (json.JSONDecodeError, PydanticValidationError) as exc:
        raise HTTPException(status_code=400, detail="AIP 流式请求格式无效") from exc
    peer_aic = require_inbound_identity(request, stream_request.params.message.senderId)
    service = HostedAipService(db, agent, owner_peer_aic=peer_aic)
    return StreamingResponse(
        service.sse_stream(payload),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/aip/{agent_id}/notification/{action}", tags=["aip"])
async def hosted_partner_notification(agent_id: str, action: str, request: Request, db: DbSession):
    agent = _hosted_partner(agent_id, db)
    if action not in {"set", "get", "delete", "start"}:
        raise HTTPException(status_code=404, detail="Unsupported notification action")
    require_hosted_aip_runtime()
    payload = await request.json()
    if action == "start":
        start_request = NotificationStartRequest.model_validate(payload)
        peer_aic = require_inbound_identity(request, start_request.params.message.senderId)
    else:
        peer_aic = get_request_peer_aic(request)
        if not peer_aic:
            raise HTTPException(status_code=401, detail="缺少对端证书身份")
    service = HostedAipService(db, agent, owner_peer_aic=peer_aic)
    return await service.handle_notification(action, payload)
