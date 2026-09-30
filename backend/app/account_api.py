"""Optional account APIs. Real mail/OAuth are opt-in, not demo prerequisites."""
from __future__ import annotations

import hmac
import re
import secrets
import smtplib
import ssl
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .account_models import AccountChallenge, AccountIdentity, LoginSession, UserAccount
from .account_admin import account_admin_router
from .config import get_settings
from .database import get_db
from .services import account_providers, quotas, turnstile
from .services.account_policy import account_role, get_policy
from .services.account_mail import build_account_mail
from .services.admin_auth import AttemptRateLimiter, PasswordVerificationBusy, hash_password, verify_password_or_dummy
from .services.identity import (digest, issue_session, now, require_same_origin,
                                set_session_cookie, unexpired)

attempts = AttemptRateLimiter(limit=8, window_seconds=300)
email_attempts = AttemptRateLimiter(limit=3, window_seconds=300)
OAUTH_COOKIE = "aegismesh_oauth"


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(default="用户", min_length=1, max_length=80)
    turnstile_token: str = Field(default="", max_length=2048)


class EmailOnly(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    turnstile_token: str = Field(default="", max_length=2048)


class Proof(BaseModel):
    token: str = Field(min_length=20, max_length=128)
    password: str | None = Field(default=None, min_length=8, max_length=256)


def email_address(value: str) -> str:
    value = value.strip().casefold()
    if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value):
        raise HTTPException(422, "邮箱格式不正确")
    return value


def enabled(db: Session) -> None:
    if not get_policy(db).accounts_enabled:
        raise HTTPException(503, "账号模块尚未启用，公开 demo 可继续使用")


def email_enabled(db: Session) -> None:
    enabled(db)
    if not get_policy(db).email_enabled:
        raise HTTPException(503, "邮箱登录尚未启用")


def mail_ready() -> bool:
    cfg = get_settings()
    return bool(cfg.account_smtp_host and cfg.account_mail_from
                and 1 <= cfg.account_smtp_port <= 65535
                and bool(cfg.account_smtp_username) == bool(cfg.account_smtp_password)
                and cfg.account_public_origin.startswith("https://"))


def send_mail(email: str, purpose: str, token: str) -> None:
    """No log/outbox token exposure. Tests replace this explicit delivery boundary."""
    cfg = get_settings()
    if not mail_ready():
        raise HTTPException(503, "邮件通道尚未接入")
    message = build_account_mail(sender=cfg.account_mail_from, recipient=email,
                                 origin=cfg.account_public_origin, purpose=purpose, token=token)
    with smtplib.SMTP_SSL(cfg.account_smtp_host, cfg.account_smtp_port, timeout=15, context=ssl.create_default_context()) as smtp:
        if cfg.account_smtp_username:
            smtp.login(cfg.account_smtp_username, cfg.account_smtp_password)
        smtp.send_message(message)


def throttle(request: Request, email: str = "") -> None:
    key = request.client.host if request.client else "unknown"
    if not attempts.allow(key) or (email and not email_attempts.allow(digest(email))):
        raise HTTPException(429, "尝试过于频繁，请稍后重试")


def challenge(db: Session, purpose: str, owner: str, data: dict) -> str:
    token = secrets.token_urlsafe(32)
    db.add(AccountChallenge(token_hash=digest(token), purpose=purpose, owner_id=owner,
                            data=data, expires_at=now() + timedelta(minutes=15)))
    db.commit()
    return token


def consume(db: Session, token: str, purpose: str, owner: str | None = None) -> AccountChallenge:
    query = update(AccountChallenge).where(AccountChallenge.token_hash == digest(token),
            AccountChallenge.purpose == purpose, AccountChallenge.used.is_(False), AccountChallenge.expires_at > now())
    if owner is not None:
        query = query.where(AccountChallenge.owner_id == owner)
    if db.execute(query.values(used=True).execution_options(synchronize_session="fetch")).rowcount != 1:
        db.rollback()
        raise HTTPException(400, "验证已过期、已使用或不属于当前浏览器")
    row = db.get(AccountChallenge, digest(token))
    db.commit()
    return row


def view(account: UserAccount) -> dict:
    return {"id": account.id, "email": account.email, "display_name": account.display_name, "role": account_role(account)}


def current_account(request: Request, db: Session = Depends(get_db)) -> UserAccount:
    enabled(db)
    account = db.get(UserAccount, request.state.account_id) if getattr(request.state, "account_id", None) else None
    if not account or not account.active:
        raise HTTPException(401, "请先登录账号；你仍可使用公开 demo")
    return account


def login_as(db: Session, request: Request, response: Response, account: UserAccount,
             source_session_hash: str | None = None) -> dict:
    if not account.active:
        raise HTTPException(403, "此账号已停用")
    old_hash = getattr(request.state, "login_session_hash", "")
    source = db.get(LoginSession, source_session_hash or old_hash)
    previous = (source.previous_guest_owner if source.account_id else source.owner_id) if source else ""
    db.execute(update(LoginSession).where(LoginSession.token_hash.in_([old_hash, source_session_hash or old_hash])).values(revoked=True))
    token, _ = issue_session(db, account=account, previous_guest_owner=previous)
    set_session_cookie(response, token, account=True)
    request.state.audit_actor = f"account_{account.id}"
    return {"account": view(account), "owner_id": f"account_{account.id}"}


def account_router(require_admin) -> APIRouter:
    router = APIRouter(tags=["accounts"])

    @router.get("/api/account/config")
    def config(db: Session = Depends(get_db)):
        cfg = get_policy(db)
        return {"enabled": cfg.accounts_enabled, "public_demo": True, "login_required": False,
                "email_enabled": cfg.accounts_enabled and cfg.email_enabled,
                "email_registration_ready": cfg.accounts_enabled and cfg.email_enabled and mail_ready(),
                "providers": account_providers.provider_statuses(), "quota_mode": cfg.quota_mode,
                "turnstile": turnstile.public_config() if cfg.accounts_enabled and cfg.email_enabled else {"enabled": False, "site_key": "", "ready": False}}

    @router.get("/api/account/me")
    def me(request: Request, response: Response, db: Session = Depends(get_db)):
        response.headers["Cache-Control"] = "no-store"
        account = db.get(UserAccount, request.state.account_id) if request.state.account_id else None
        return {"owner_id": request.state.browser_owner_id, "account": view(account) if account else None,
                "identities": [{"id": r.id, "provider": r.provider} for r in db.scalars(select(AccountIdentity).where(AccountIdentity.account_id == account.id)).all()] if account else [],
                "quota": quotas.snapshot(db, request.state.browser_owner_id)}

    @router.post("/api/account/register", dependencies=[Depends(require_same_origin)])
    def register(payload: Credentials, request: Request, db: Session = Depends(get_db)):
        email_enabled(db)
        if not mail_ready():
            raise HTTPException(503, "邮件通道尚未接入")
        email = email_address(payload.email)
        throttle(request, email)
        turnstile.verify(payload.turnstile_token, "signup")
        if not db.scalar(select(UserAccount.id).where(UserAccount.email == email)):
            password_hash, password_salt = hash_password(payload.password)
            token = challenge(db, "register", request.state.browser_owner_id,
                              {"email": email, "display_name": payload.display_name,
                               "password_hash": password_hash, "password_salt": password_salt})
            try:
                send_mail(email, "register", token)
            except Exception:
                db.execute(update(AccountChallenge).where(AccountChallenge.token_hash == digest(token)).values(used=True))
                db.commit()
                raise HTTPException(503, "验证邮件暂时无法发送，请稍后重试") from None
        return {"ok": True, "message": "如该邮箱可注册，验证邮件已发送；请在当前浏览器中完成验证。"}

    @router.post("/api/account/verify-email", dependencies=[Depends(require_same_origin)])
    def verify_email(payload: Proof, request: Request, response: Response, db: Session = Depends(get_db)):
        email_enabled(db)
        throttle(request)
        row = consume(db, payload.token, "register", request.state.browser_owner_id)
        account = UserAccount(id=secrets.token_hex(16), **row.data)
        try:
            db.add(account)
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "该邮箱已完成注册，请登录或重置密码") from None
        return login_as(db, request, response, account)

    @router.post("/api/account/login", dependencies=[Depends(require_same_origin)])
    def login(payload: Credentials, request: Request, response: Response, db: Session = Depends(get_db)):
        email_enabled(db)
        email = email_address(payload.email)
        throttle(request)
        turnstile.verify(payload.turnstile_token, "login")
        account = db.scalar(select(UserAccount).where(UserAccount.email == email))
        try:
            valid = verify_password_or_dummy(payload.password, account.password_hash if account else None,
                                             account.password_salt if account else None)
        except PasswordVerificationBusy as exc:
            raise HTTPException(429, str(exc)) from exc
        if not valid or not account or not account.active:
            raise HTTPException(401, "邮箱或密码不正确")
        return login_as(db, request, response, account)

    @router.post("/api/account/password/request-reset", dependencies=[Depends(require_same_origin)])
    def request_reset(payload: EmailOnly, request: Request, db: Session = Depends(get_db)):
        email_enabled(db)
        if not mail_ready():
            raise HTTPException(503, "邮件通道尚未接入")
        email = email_address(payload.email)
        throttle(request, email)
        turnstile.verify(payload.turnstile_token, "reset")
        account = db.scalar(select(UserAccount).where(UserAccount.email == email, UserAccount.active.is_(True)))
        if account:
            token = challenge(db, "reset", request.state.browser_owner_id, {"account_id": account.id})
            try:
                send_mail(email, "reset", token)
            except Exception:
                db.execute(update(AccountChallenge).where(AccountChallenge.token_hash == digest(token)).values(used=True))
                db.commit()
                raise HTTPException(503, "验证邮件暂时无法发送，请稍后重试") from None
        return {"ok": True, "message": "如该邮箱存在，重置邮件已发送。"}

    @router.post("/api/account/password/reset", dependencies=[Depends(require_same_origin)])
    def reset(payload: Proof, request: Request, db: Session = Depends(get_db)):
        email_enabled(db)
        throttle(request)
        if not payload.password:
            raise HTTPException(422, "请填写新密码")
        row = consume(db, payload.token, "reset", request.state.browser_owner_id)
        account = db.get(UserAccount, row.data["account_id"])
        if not account or not account.active:
            raise HTTPException(400, "账号不可用")
        account.password_hash, account.password_salt = hash_password(payload.password)
        db.execute(update(LoginSession).where(LoginSession.account_id == account.id).values(revoked=True))
        db.execute(update(AccountChallenge).where(AccountChallenge.data["account_id"].as_string() == account.id,
                                                  AccountChallenge.purpose == "reset").values(used=True))
        db.commit()
        return {"ok": True, "message": "密码已更新，所有登录会话已退出，请重新登录。"}

    @router.post("/api/account/logout", dependencies=[Depends(require_same_origin)])
    def logout(request: Request, response: Response, all_sessions: bool = False, db: Session = Depends(get_db)):
        enabled(db)
        prior = db.get(LoginSession, request.state.login_session_hash)
        guest = prior.previous_guest_owner if prior and prior.account_id else None
        stmt = update(LoginSession).where(LoginSession.token_hash == request.state.login_session_hash)
        if all_sessions and request.state.account_id:
            stmt = update(LoginSession).where(LoginSession.account_id == request.state.account_id)
        db.execute(stmt.values(revoked=True))
        token, _ = issue_session(db, guest_owner=guest or None)
        set_session_cookie(response, token)
        return {"ok": True}

    @router.get("/api/account/sessions")
    def sessions(request: Request, account: UserAccount = Depends(current_account), db: Session = Depends(get_db)):
        rows = db.scalars(select(LoginSession).where(LoginSession.account_id == account.id,
                          LoginSession.revoked.is_(False), LoginSession.expires_at > now())
                          .order_by(LoginSession.created_at.desc()).limit(50)).all()
        return [{"id": r.token_hash, "current": r.token_hash == request.state.login_session_hash,
                 "created_at": r.created_at.isoformat(), "expires_at": r.expires_at.isoformat()} for r in rows]

    @router.delete("/api/account/sessions/{session_id}", dependencies=[Depends(require_same_origin)])
    def revoke(session_id: str, account: UserAccount = Depends(current_account), db: Session = Depends(get_db)):
        db.execute(update(LoginSession).where(LoginSession.account_id == account.id,
                   LoginSession.token_hash == session_id).values(revoked=True))
        db.commit()
        return {"ok": True}

    @router.post("/api/account/oauth/{provider}/start", dependencies=[Depends(require_same_origin)])
    def oauth_start(provider: str, request: Request, response: Response, link: bool = False, db: Session = Depends(get_db)):
        enabled(db)
        throttle(request)
        try:
            account_providers.provider_config(provider)
        except account_providers.ProviderUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        proof, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
        account = current_account(request, db) if link else None
        state = challenge(db, "oauth:" + provider, request.state.browser_owner_id,
                          {"proof_hash": digest(proof), "nonce": nonce, "verifier": verifier,
                           "link_account": account.id if account else None,
                           "login_session_hash": request.state.login_session_hash})
        response.set_cookie(OAUTH_COOKIE, proof, max_age=900, httponly=True, secure=True, samesite="none", path="/api/account/oauth")
        return {"url": account_providers.authorization_url(provider, state, nonce, verifier)}

    @router.api_route("/api/account/oauth/{provider}/callback", methods=["GET", "POST"])
    async def oauth_callback(provider: str, request: Request, db: Session = Depends(get_db)):
        enabled(db)
        params = await request.form() if request.method == "POST" else request.query_params
        state, code = str(params.get("state") or ""), str(params.get("code") or "")
        if not state or len(state) > 128 or not code or len(code) > 4096:
            raise HTTPException(400, "第三方登录未完成，请重新开始")
        row = db.get(AccountChallenge, digest(state))
        proof = request.cookies.get(OAUTH_COOKIE, "")
        if not row or not proof or not hmac.compare_digest(row.data.get("proof_hash", ""), digest(proof)):
            raise HTTPException(400, "登录浏览器校验失败")
        row = consume(db, state, "oauth:" + provider)
        link_account = row.data.get("link_account")
        prior_login = db.get(LoginSession, row.data["login_session_hash"])
        if not prior_login or prior_login.revoked or not unexpired(prior_login.expires_at) or (link_account and prior_login.account_id != link_account):
            raise HTTPException(403, "原浏览器会话已失效，请重新开始登录或绑定")
        try:
            profile = await account_providers.exchange_identity(provider, code, row.data["nonce"], row.data["verifier"])
        except Exception:
            # Never reflect access tokens, callback codes or provider URLs into logs/UI.
            raise HTTPException(400, "第三方身份验证失败，请重新开始登录") from None
        stmt = select(AccountIdentity).where(AccountIdentity.provider == provider,
                    AccountIdentity.namespace == profile["namespace"], AccountIdentity.subject == profile["subject"])
        identity = db.scalar(stmt)
        if identity and link_account and identity.account_id != link_account:
            raise HTTPException(409, "该第三方身份已绑定其他账号，不能自动合并")
        if not identity:
            try:
                with db.begin_nested():
                    account = db.get(UserAccount, link_account) if link_account else UserAccount(id=secrets.token_hex(16), display_name=profile["display_name"])
                    if not account or (link_account and not account.active):
                        raise HTTPException(403, "账号不可用")
                    db.add(account)
                    db.flush()
                    identity = AccountIdentity(id=secrets.token_hex(16), account_id=account.id,
                                               provider=provider, namespace=profile["namespace"], subject=profile["subject"])
                    db.add(identity)
                    db.flush()
            except IntegrityError:
                identity = db.scalar(stmt)
            db.commit()
        if not identity or (link_account and identity.account_id != link_account):
            raise HTTPException(409, "该第三方身份已绑定其他账号")
        account = db.get(UserAccount, identity.account_id)
        response = RedirectResponse("/?account=welcome", status_code=303)
        login_as(db, request, response, account, source_session_hash=row.data["login_session_hash"])
        response.delete_cookie(OAUTH_COOKIE, path="/api/account/oauth", secure=True, samesite="none")
        return response

    @router.delete("/api/account/identities/{identity_id}", dependencies=[Depends(require_same_origin)])
    def unlink(identity_id: str, account: UserAccount = Depends(current_account), db: Session = Depends(get_db)):
        # Serialize unlink operations before counting remaining methods (including SQLite).
        db.execute(update(UserAccount).where(UserAccount.id == account.id).values(auth_version=UserAccount.auth_version + 1))
        links = db.scalars(select(AccountIdentity).where(AccountIdentity.account_id == account.id)).all()
        identity = next((row for row in links if row.id == identity_id), None)
        if not identity:
            raise HTTPException(404, "登录方式不存在")
        if len(links) <= 1 and not (account.email and account.password_hash):
            raise HTTPException(409, "请至少保留一种可用的登录方式")
        db.delete(identity)
        db.commit()
        return {"ok": True}

    router.include_router(account_admin_router(require_admin, lambda: mail_ready(), config))
    return router
