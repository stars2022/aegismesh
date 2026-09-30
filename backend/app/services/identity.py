"""Stable principals, independent of optional account login and chat IDs."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from ..account_models import Conversation, LoginSession, UserAccount
from ..config import get_settings
from ..database import SessionLocal
from ..models import CanvasDoc, Invocation, PlatformAccess
from .admin_auth import DEMO_COOKIE_NAME, read_session_token

SESSION_COOKIE = "aegismesh_identity"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def now() -> datetime:
    return datetime.now(timezone.utc)


def unexpired(value: datetime) -> bool:
    return value.replace(tzinfo=value.tzinfo or timezone.utc) > now()


def get_login_session(db: Session, token: str) -> LoginSession | None:
    if not token or len(token) > 128:
        return None
    row = db.get(LoginSession, digest(token))
    if not row or row.revoked or not unexpired(row.expires_at):
        return None
    if row.account_id:
        account = db.get(UserAccount, row.account_id)
        if not account or not account.active:
            return None
    return row


def issue_session(db: Session, *, account: UserAccount | None = None,
                  guest_owner: str | None = None, previous_guest_owner: str = "") -> tuple[str, LoginSession]:
    settings = get_settings()
    token = secrets.token_urlsafe(32)
    row = LoginSession(
        token_hash=digest(token),
        owner_id=f"account_{account.id}" if account else guest_owner or f"guest_{secrets.token_hex(24)}",
        account_id=account.id if account else None,
        previous_guest_owner=previous_guest_owner,
        expires_at=now() + timedelta(days=settings.account_session_days if account else settings.guest_session_days),
    )
    db.add(row)
    db.commit()
    return token, row


def set_session_cookie(response: Response, token: str, *, account: bool = False) -> None:
    cfg = get_settings()
    response.set_cookie(SESSION_COOKIE, token, httponly=True,
                        secure=account or cfg.admin_cookie_secure or cfg.account_public_origin.startswith("https://"), samesite="lax", path="/",
                        max_age=86400 * (cfg.account_session_days if account else cfg.guest_session_days))
    response.headers["Cache-Control"] = "no-store"


def require_same_origin(request: Request) -> None:
    """Browser mutations must originate here; absent Origin is allowed for non-browser clients."""
    origin = request.headers.get("origin")
    expected = get_settings().account_public_origin.rstrip("/") or str(request.base_url).rstrip("/")
    if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin.rstrip("/") != expected):
        raise HTTPException(403, "请求来源不匹配")


class IdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # AIP remains authenticated by its certificate, never by browser cookies.
        browser_path = request.url.path.startswith(("/api/demo/", "/api/account", "/api/canvas/",
                                                   "/api/group-chat", "/api/chat", "/api/tasks/", "/api/invocations/", "/api/upload",
                                                   "/api/discovery/", "/api/agents"))
        if not browser_path:
            return await call_next(request)
        if request.headers.get("x-api-key") and request.url.path.startswith(("/api/chat", "/api/tasks/", "/api/invocations/")):
            # These API guards set owner_id only AFTER validating the key. Avoid
            # allocating a new browser session for every stateless API request.
            return await call_next(request)
        new_token = None
        with SessionLocal() as db:
            row = get_login_session(db, request.cookies.get(SESSION_COOKIE, ""))
            if not row:
                # Only a VALID old password-protected demo cookie proves old ownership.
                # Shared IPs, arbitrary headers and latest invocations never do.
                legacy = request.cookies.get(DEMO_COOKIE_NAME, "")
                access = db.get(PlatformAccess, 1)
                principal = read_session_token(legacy, access.demo_session_secret) if legacy and access and access.demo_session_secret else None
                old_owner = f"demo_{digest(legacy)[:24]}" if principal and principal.startswith("demo:") else None
                new_token, row = issue_session(db, guest_owner=old_owner)
            request.state.owner_id = row.owner_id
            request.state.browser_owner_id = row.owner_id
            request.state.login_session_hash = row.token_hash
            request.state.account_id = row.account_id
        response = await call_next(request)
        # Login/logout rotates the cookie itself. Do not overwrite it after the handler.
        if new_token and not any(h.startswith(SESSION_COOKIE + "=") for h in response.headers.getlist("set-cookie")):
            set_session_cookie(response, new_token)
        return response


class ConversationOwnershipError(ValueError):
    pass


def bind_conversation(db: Session, session_id: str, owner_id: str) -> Conversation | None:
    """Bind before inserting a new invocation; old ambiguous/unowned data fails closed."""
    if not owner_id:  # trusted in-process callers have no browser identity
        return None
    if not session_id or len(session_id) > 128:
        raise ConversationOwnershipError("会话标识无效")
    existing = db.get(Conversation, session_id)
    if existing:
        if existing.owner_id != owner_id:
            raise ConversationOwnershipError("会话不存在或无权访问")
        return existing
    owners = set(db.scalars(select(Invocation.owner_id).where(Invocation.session_id == session_id)).all())
    from .canvas import canvas_id_for
    canvas = db.get(CanvasDoc, canvas_id_for(session_id))
    if (owners and owners != {owner_id}) or (canvas and canvas.owner_id != owner_id):
        raise ConversationOwnershipError("旧会话归属不明或无权访问，请新建会话；旧数据保留待迁移")
    row = Conversation(id=session_id, owner_id=owner_id)
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        row = db.get(Conversation, session_id)
        if not row or row.owner_id != owner_id:
            raise ConversationOwnershipError("会话不存在或无权访问") from None
    db.commit()
    return row
