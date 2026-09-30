from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import account_api, main
from app.account_models import AccountChallenge, AccountIdentity, Conversation, LoginSession, QuotaBucket, QuotaEntry, UserAccount
from app.config import get_settings
from app.database import Base, get_db
from app.main import app
from app.models import Agent, CanvasDoc, Invocation
from app.services import identity, quotas
from app.services.admin_auth import AttemptRateLimiter
from app.services.canvas import CanvasError, canvas_id_for, get_or_create_session_canvas
from app.services.orchestrator import ReliableOrchestrator


@pytest.fixture
def client(db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", False)
    monkeypatch.setattr(cfg, "account_email_enabled", False)
    monkeypatch.setattr(cfg, "account_oauth", {})
    monkeypatch.setattr(cfg, "account_public_origin", "")
    monkeypatch.setattr(cfg, "quota_mode", "off")
    monkeypatch.setattr(cfg, "background_worker_enabled", False)
    monkeypatch.setattr(identity, "SessionLocal", lambda: Session(db.bind, expire_on_commit=False))
    monkeypatch.setattr(main, "SessionLocal", lambda: Session(db.bind, expire_on_commit=False))
    monkeypatch.setattr(account_api, "attempts", AttemptRateLimiter(100, 300))
    monkeypatch.setattr(account_api, "email_attempts", AttemptRateLimiter(100, 300))
    app.dependency_overrides[get_db] = lambda: db
    c = TestClient(app, base_url="https://testserver")
    yield c
    c.close()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def mail(monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_email_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://testserver")
    monkeypatch.setattr(account_api, "mail_ready", lambda: True)
    sent = []
    monkeypatch.setattr(account_api, "send_mail", lambda email, purpose, token: sent.append((email, purpose, token)))
    return sent


def test_modules_default_off_demo_still_public(client, db):
    data = client.get("/api/account/config").json()
    assert data["enabled"] is False and data["quota_mode"] == "off"
    assert data["public_demo"] is True and data["login_required"] is False
    assert not any(p["available"] for p in data["providers"])
    assert client.get("/api/demo/session").json()["authenticated"] is True
    assert client.get("/api/agents").status_code == 200
    assert client.post("/api/account/register", json={"email": "new@example.org", "password": "long-password"}).status_code == 503
    for name in ["google", "apple", "huawei", "wechat", "qq"]:
        assert client.post(f"/api/account/oauth/{name}/start", json={}).status_code == 503
    quotas.reserve(db, owner="guest", entry_id="no-charge")
    assert db.get(QuotaEntry, "no-charge") is None


@pytest.mark.parametrize("path,action", [("register", "signup"), ("login", "login"), ("password/request-reset", "reset")])
def test_turnstile_gates_existing_handlers_before_side_effects(client, db, mail, monkeypatch, path, action):
    from app.services import turnstile
    import httpx
    cfg = get_settings()
    for name, value in dict(turnstile_enabled=True, turnstile_site_key="public-sitekey",
                            turnstile_secret="private-test-secret", turnstile_hostnames="testserver").items():
        monkeypatch.setattr(cfg, name, value)
    payload = {"email": "captcha@example.org", "password": "test-long-password"}
    assert client.post("/api/account/" + path, json=payload).status_code == 403
    assert mail == [] and db.scalar(select(AccountChallenge)) is None
    seen = []
    def verify(url, **kwargs):
        seen.append(kwargs)
        return httpx.Response(200, json={"success": True, "action": action, "hostname": "testserver"})
    monkeypatch.setattr(turnstile.httpx, "post", verify)
    response = client.post("/api/account/" + path, json={**payload, "turnstile_token": "valid-token"})
    assert response.status_code == (401 if path == "login" else 200)
    assert seen[0]["data"]["response"] == "valid-token"
    config = client.get("/api/account/config")
    assert config.json()["turnstile"]["ready"] is True
    assert "private-test-secret" not in config.text


@pytest.mark.parametrize("result", [
    {"success": False, "error-codes": ["timeout-or-duplicate"]},
    {"success": True, "action": "login", "hostname": "testserver"},
    {"success": True, "action": "signup", "hostname": "localhost"},
    {"success": "true", "action": "signup", "hostname": "testserver"},
    None,
])
def test_turnstile_rejects_replay_wrong_action_hostname_and_malformed_result(client, mail, monkeypatch, result):
    import httpx
    from app.services import turnstile
    cfg = get_settings()
    for name, value in dict(turnstile_enabled=True, turnstile_site_key="test-key",
                            turnstile_secret="test-secret", turnstile_hostnames="testserver").items():
        monkeypatch.setattr(cfg, name, value)
    monkeypatch.setattr(turnstile.httpx, "post", lambda *a, **k: httpx.Response(200, json=result))
    response = client.post("/api/account/register", json={"email": "captcha@example.org", "password": "test-long-password", "turnstile_token": "invalid-token"})
    assert response.status_code == 403 and mail == []


def test_turnstile_timeout_fails_closed_and_disabled_module_still_public(client, mail, monkeypatch):
    import httpx
    from app.services import turnstile
    cfg = get_settings()
    for name, value in dict(turnstile_enabled=True, turnstile_site_key="test-key",
                            turnstile_secret="test-secret", turnstile_hostnames="testserver").items():
        monkeypatch.setattr(cfg, name, value)
    def timeout(*a, **k):
        raise httpx.ReadTimeout("upstream timeout")
    monkeypatch.setattr(turnstile.httpx, "post", timeout)
    response = client.post("/api/account/register", json={"email": "captcha@example.org", "password": "test-long-password", "turnstile_token": "some-token"})
    assert response.status_code == 403 and mail == []
    monkeypatch.setattr(cfg, "accounts_enabled", False)
    assert client.get("/api/account/config").json()["turnstile"]["enabled"] is False
    assert client.get("/api/demo/session").status_code == 200


def test_public_demo_executes_without_an_account_or_quota_charge(client, db, monkeypatch):
    async def complete(self, request, owner, invocation_id):
        assert owner.startswith("guest_")
        inv = Invocation(id=invocation_id, session_id=request.session_id, owner_id=owner,
                         query=request.message, result_text="公开 demo 正常执行", status="completed")
        self.db.add(inv)
        self.db.commit()
        return inv, [], None
    monkeypatch.setattr(ReliableOrchestrator, "_run_owned", complete)
    response = client.post("/api/demo/chat", json={"message": "hello", "session_id": "public-demo"})
    assert response.status_code == 200, response.text
    assert response.json()["answer"] == "公开 demo 正常执行"
    assert db.scalar(select(UserAccount)) is None and db.scalar(select(QuotaEntry)) is None
    assert db.get(Conversation, "public-demo").owner_id == client.get("/api/demo/session").json()["owner_id"]


def test_same_ip_browsers_and_spoofed_header_cannot_share_canvas(client, db):
    owner = client.get("/api/demo/session").json()["owner_id"]
    assert owner.startswith("guest_")
    first = client.get("/api/canvas/session/shared").json()
    assert client.get("/api/canvas/session/shared", headers={"X-API-Key": "spoof"}).status_code == 200
    with TestClient(app, base_url="https://testserver") as other:
        assert other.get("/api/demo/session").json()["owner_id"] != owner
        assert other.get("/api/canvas/session/shared").status_code == 404
        assert other.get(f"/api/canvas/{first['id']}").status_code == 404
        assert other.post("/api/demo/chat", json={"message": "steal", "session_id": "shared"}).status_code == 404
        assert other.post("/api/demo/chat/stream", json={"message": "steal", "session_id": "shared"}).status_code == 404
    assert db.get(Conversation, "shared").owner_id == owner
    assert db.scalar(select(Invocation).where(Invocation.session_id == "shared")) is None


def test_arbitrary_or_expired_cookie_cannot_select_owner(client, db):
    first = client.get("/api/demo/session").json()["owner_id"]
    cookie = client.cookies.get(identity.SESSION_COOKIE)
    row = db.get(LoginSession, identity.digest(cookie))
    assert row.token_hash != cookie
    row.expires_at = identity.now() - timedelta(seconds=1)
    db.commit()
    second = client.get("/api/demo/session").json()["owner_id"]
    assert first != second
    client.cookies.set(identity.SESSION_COOKIE, "forged-value", domain="testserver.local", path="/")
    assert client.get("/api/demo/session").json()["owner_id"] != first


def test_register_verify_login_rotate_reset_and_logout(client, db, mail):
    guest_owner = client.get("/api/demo/session").json()["owner_id"]
    original_cookie = client.cookies.get(identity.SESSION_COOKIE)
    credentials = {"email": " PERSON@example.org ", "password": "strong-password", "display_name": "测试用户"}
    result = client.post("/api/account/register", json=credentials)
    assert result.status_code == 200, result.text
    assert db.scalar(select(UserAccount)) is None
    token = mail[-1][2]
    assert token not in result.text
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.post("/api/account/verify-email", json={"token": token}).status_code == 400
    verified = client.post("/api/account/verify-email", json={"token": token})
    assert verified.status_code == 200, verified.text
    account_id = verified.json()["account"]["id"]
    owner = verified.json()["owner_id"]
    assert client.post("/api/account/verify-email", json={"token": token}).status_code == 400
    assert client.cookies.get(identity.SESSION_COOKIE) != original_cookie
    assert client.get("/api/account/me").json()["owner_id"] == owner
    assert "strong-password" not in db.get(UserAccount, account_id).password_hash
    saved_cookie = client.cookies.get(identity.SESSION_COOKIE)
    assert client.post("/api/account/logout", json={}).status_code == 200
    assert client.get("/api/account/me").json()["account"] is None
    assert client.get("/api/account/me").json()["owner_id"] == guest_owner
    assert identity.get_login_session(db, saved_cookie) is None
    assert client.post("/api/account/login", json=credentials).status_code == 200
    assert client.get("/api/account/me").json()["owner_id"] == owner
    assert client.post("/api/account/password/request-reset", json={"email": "person@example.org"}).status_code == 200
    reset_token = mail[-1][2]
    assert client.post("/api/account/password/reset", json={"token": reset_token, "password": "new-strong-password"}).status_code == 200
    assert client.get("/api/account/me").json()["account"] is None
    assert client.post("/api/account/login", json=credentials).status_code == 401
    assert client.post("/api/account/login", json={**credentials, "password": "new-strong-password"}).status_code == 200
    assert not db.scalar(select(LoginSession).where(LoginSession.token_hash == identity.digest(saved_cookie))).revoked is False


def test_email_disabled_and_cross_origin_mutations_fail_closed(client, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    assert client.post("/api/account/login", json={"email": "x@y.org", "password": "long-password"}).status_code == 503
    assert client.post("/api/account/logout", json={}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/account/oauth/google/start", json={}, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_oauth_state_browser_binding_replay_and_no_email_merge(client, db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://testserver")
    monkeypatch.setattr(cfg, "account_oauth", {"google": {"enabled": True, "client_id": "test", "client_secret": "server-secret"}})
    db.add(UserAccount(id="email-account", email="same@example.org"))
    db.commit()
    async def fake_exchange(name, code, nonce, verifier):
        assert code == "code" and nonce and verifier
        return {"provider": name, "namespace": "test", "subject": "official-subject", "display_name": "同邮箱用户", "email": "same@example.org"}
    monkeypatch.setattr(account_api.account_providers, "exchange_identity", fake_exchange)
    response = client.post("/api/account/oauth/google/start", json={})
    assert response.status_code == 200, response.text
    assert "server-secret" not in response.text
    params = parse_qs(urlparse(response.json()["url"]).query)
    assert params["code_challenge_method"] == ["S256"] and params["nonce"]
    url = "/api/account/oauth/google/callback?code=code&state=" + params["state"][0]
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(url, follow_redirects=False).status_code == 400
    assert client.get(url, follow_redirects=False).status_code == 303
    assert client.get(url, follow_redirects=False).status_code == 400
    mine = client.get("/api/account/me").json()
    assert mine["account"]["id"] != "email-account"
    assert mine["account"]["email"] is None
    assert db.scalar(select(AccountIdentity)).subject == "official-subject"


def test_oauth_apple_form_post_restores_guest_without_lax_cookie(client, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://testserver")
    monkeypatch.setattr(cfg, "account_oauth", {"apple": {"enabled": True, "client_id": "test", "client_secret": "secret"}})
    async def fake_exchange(*args):
        return {"namespace": "test", "subject": "apple-user", "display_name": "Apple 用户"}
    monkeypatch.setattr(account_api.account_providers, "exchange_identity", fake_exchange)
    guest = client.get("/api/demo/session").json()["owner_id"]
    start = client.post("/api/account/oauth/apple/start", json={})
    params = parse_qs(urlparse(start.json()["url"]).query)
    assert params["response_mode"] == ["form_post"]
    # Cross-site POST does not carry the normal SameSite=Lax login cookie.
    client.cookies.delete(identity.SESSION_COOKIE)
    result = client.post("/api/account/oauth/apple/callback", data={"code": "code", "state": params["state"][0]}, follow_redirects=False)
    assert result.status_code == 303, result.text
    assert client.get("/api/account/me").json()["account"] is not None
    assert client.post("/api/account/logout", json={}).status_code == 200
    assert client.get("/api/account/me").json()["owner_id"] == guest


def test_oauth_explicit_link_unlink_and_revoked_flow(client, db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://testserver")
    monkeypatch.setattr(cfg, "account_oauth", {name: {"enabled": True, "client_id": "test", "client_secret": "secret"} for name in ["google", "qq"]})
    async def fake_exchange(name, code, *_):
        return {"namespace": "test", "subject": code, "display_name": name}
    monkeypatch.setattr(account_api.account_providers, "exchange_identity", fake_exchange)
    def start(name, link=False):
        response = client.post(f"/api/account/oauth/{name}/start?link={str(link).lower()}", json={})
        assert response.status_code == 200, response.text
        return parse_qs(urlparse(response.json()["url"]).query)["state"][0]
    def finish(name, state, subject):
        return client.get(f"/api/account/oauth/{name}/callback", params={"state": state, "code": subject}, follow_redirects=False)
    assert client.post("/api/account/oauth/google/start?link=true", json={}).status_code == 401
    assert finish("google", start("google"), "mine").status_code == 303
    mine = client.get("/api/account/me").json()
    only = mine["identities"][0]["id"]
    assert client.delete(f"/api/account/identities/{only}").status_code == 409
    # Never auto-link a third-party identity belonging to a different account.
    db.add(UserAccount(id="other", display_name="other"))
    db.flush()
    db.add(AccountIdentity(id="taken", account_id="other", provider="qq", namespace="test", subject="taken"))
    db.commit()
    assert finish("qq", start("qq", True), "taken").status_code == 409
    assert finish("qq", start("qq", True), "mine-qq").status_code == 303
    linked = client.get("/api/account/me").json()
    assert linked["account"]["id"] == mine["account"]["id"] and len(linked["identities"]) == 2
    assert client.delete(f"/api/account/identities/{only}").status_code == 200
    remaining = client.get("/api/account/me").json()["identities"][0]["id"]
    assert client.delete(f"/api/account/identities/{remaining}").status_code == 409
    state = start("google", True)
    assert client.post("/api/account/logout", json={}).status_code == 200
    assert finish("google", state, "mine").status_code == 403


def test_group_quota_releases_failures_and_enforces_success_limit(client, db, monkeypatch):
    from app import main
    monkeypatch.setattr(get_settings(), "quota_mode", "enforce")
    monkeypatch.setattr(get_settings(), "quota_daily_tasks", 1)
    db.add(Agent(id="member", aic="local:member", name="member", active=True))
    db.commit()
    group_id = client.post("/api/group-chat", json={"name": "quota", "members": ["member"]}).json()["id"]
    path = f"/api/group-chat/{group_id}/messages"
    async def fail(*args):
        return {"error": "upstream failed"}
    monkeypatch.setattr(main, "_post_group_chat_message", fail)
    assert client.post(path, json={"text": "failure"}).status_code == 200
    assert client.get("/api/account/me").json()["quota"]["tasks"]["used"] == 0
    async def succeed(*args):
        return {"reply": "done"}
    monkeypatch.setattr(main, "_post_group_chat_message", succeed)
    assert client.post(path, json={"text": "success"}).status_code == 200
    assert client.post(path, json={"text": "limited"}).status_code == 429
    assert client.get("/api/account/me").json()["quota"]["concurrency"]["reserved"] == 0


@pytest.mark.asyncio
async def test_root_usage_is_server_keyed_and_child_counts_are_not_double_charged(db, monkeypatch):
    from app.schemas import ChatRequest
    monkeypatch.setattr(get_settings(), "quota_mode", "observe")
    runtime = ReliableOrchestrator(db)
    async def finish(request, owner, invocation_id):
        assert request.root_invocation_id == invocation_id and invocation_id != "spoofed-key"
        inv = Invocation(id=invocation_id, session_id=request.session_id, owner_id=owner, query="q", status="completed",
                         prompt_tokens=20, completion_tokens=10, result_data={"collaborations": [{"id": "a"}, {"id": "b"}]})
        db.add(inv)
        db.commit()
        return inv, [], None
    monkeypatch.setattr(runtime, "_run_owned", finish)
    inv, _, _ = await runtime.run(ChatRequest(message="test", session_id="mine", root_invocation_id="spoofed-key"), "owner")
    entry = db.get(QuotaEntry, inv.id)
    assert entry.status == "completed" and entry.child_calls == 2 and entry.prompt_tokens == 20
    assert quotas.snapshot(db, "owner")["tasks"]["used"] == 1


def test_old_ownerless_canvas_is_not_claimed_by_latest_invocation(db):
    db.add(CanvasDoc(id=canvas_id_for("old"), title="旧文稿", content="keep private", owner_id=""))
    db.add(Invocation(id="attacker-latest", session_id="old", owner_id="attacker", query="claim"))
    db.commit()
    with pytest.raises(CanvasError):
        get_or_create_session_canvas(db, "old", "attacker")
    assert db.get(CanvasDoc, canvas_id_for("old")).owner_id == ""


@pytest.mark.asyncio
async def test_canvas_tool_itself_checks_invocation_owner(db):
    doc = get_or_create_session_canvas(db, "owned", "owner")
    runtime = ReliableOrchestrator(db)
    tools = {name: executor for name, _, executor in runtime._canvas_tools(doc.id, "agent", "Agent", "stranger")}
    with pytest.raises(CanvasError):
        await tools["canvas_read"]({})


def test_group_owner_member_and_active_guards(client, db):
    db.add_all([Agent(id="member", aic="local:member", name="member", active=True),
                Agent(id="disabled", aic="local:disabled", name="disabled", active=False),
                Agent(id="outsider", aic="local:outsider", name="outsider", active=True)])
    db.commit()
    created = client.post("/api/group-chat", json={"name": "test", "members": ["member", "disabled"]})
    assert created.status_code == 200, created.text
    group = created.json()
    assert group["members"] == ["member"]
    assert client.post(f"/api/group-chat/{group['id']}/messages", json={"text": "hi", "mentioned": "outsider"}).status_code == 422
    with TestClient(app, base_url="https://testserver") as other:
        assert other.get(f"/api/group-chat/{group['id']}").status_code == 404
        assert other.post(f"/api/group-chat/{group['id']}/messages", json={"text": "hi"}).status_code == 404


def test_quota_reserve_settle_idempotency_and_cancellation(db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "quota_mode", "enforce")
    monkeypatch.setattr(cfg, "quota_daily_tasks", 2)
    monkeypatch.setattr(cfg, "quota_concurrent_tasks", 1)
    quotas.reserve(db, owner="one", entry_id="a", session_id="s")
    quotas.reserve(db, owner="one", entry_id="a", session_id="s")
    with pytest.raises(quotas.QuotaExceeded):
        quotas.reserve(db, owner="two", entry_id="a", session_id="s")
    with pytest.raises(quotas.QuotaExceeded):
        quotas.reserve(db, owner="one", entry_id="b")
    assert db.get(QuotaEntry, "b") is None
    quotas.settle(db, "a", success=True, prompt_tokens=20, completion_tokens=10, child_calls=6)
    quotas.settle(db, "a", success=False)
    data = quotas.snapshot(db, "one")
    assert data["tasks"]["used"] == 1 and data["tasks"]["reserved"] == 0
    assert data["concurrency"]["reserved"] == 0
    assert db.get(QuotaEntry, "a").child_calls == 6
    quotas.reserve(db, owner="one", entry_id="b")
    quotas.settle(db, "b", success=False)
    assert quotas.snapshot(db, "one")["tasks"]["used"] == 1
    quotas.reserve(db, owner="one", entry_id="c")
    monkeypatch.setattr(cfg, "quota_mode", "off")
    quotas.settle(db, "c", success=True)
    assert quotas.snapshot(db, "one")["tasks"]["reserved"] == 0


def test_quota_observe_never_blocks_and_records_usage(db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "quota_mode", "observe")
    monkeypatch.setattr(cfg, "quota_concurrent_tasks", 1)
    for i in range(3):
        quotas.reserve(db, owner="one", entry_id=str(i))
    assert quotas.snapshot(db, "one")["concurrency"]["reserved"] == 3
    assert quotas.snapshot(db, "one")["tasks"]["remaining"] is None


def test_quota_competing_workers_do_not_overreserve(tmp_path, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "quota_mode", "enforce")
    monkeypatch.setattr(cfg, "quota_concurrent_tasks", 2)
    engine = create_engine(f"sqlite:///{tmp_path}/concurrent.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    def work(index):
        with Session(engine) as session:
            try:
                quotas.reserve(session, owner="shared", entry_id=f"run{index}")
                return True
            except quotas.QuotaExceeded:
                return False
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(work, range(6)))
    assert sum(results) == 2
    with Session(engine) as session:
        assert quotas.snapshot(session, "shared")["concurrency"]["reserved"] == 2


def test_recovery_releases_orphan_and_failed_run_reservations(db, monkeypatch):
    monkeypatch.setattr(get_settings(), "quota_mode", "observe")
    quotas.reserve(db, owner="owner", entry_id="orphan")
    quotas.reserve(db, owner="owner", entry_id="failed")
    db.get(QuotaEntry, "orphan").created_at = identity.now() - timedelta(hours=2)
    db.add(Invocation(id="failed", session_id="s", owner_id="owner", query="q", status="failed"))
    db.commit()
    quotas.recover_reservations(db)
    assert quotas.snapshot(db, "owner")["concurrency"]["reserved"] == 0
