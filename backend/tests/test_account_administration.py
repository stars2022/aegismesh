from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from app import account_api, main
from app.account_models import AccountPolicy, AccountQuotaOverride, LoginSession, ModelUsage, QuotaEntry, UserAccount
from app.config import get_settings
from app.database import get_db
from app.models import OperationalLog
from app.services import identity, model_budget, observability, quotas
from app.services.account_policy import allowances, get_policy


@pytest.fixture
def admin(db, monkeypatch):
    cfg = get_settings()
    for key, value in dict(accounts_enabled=True, account_email_enabled=False, quota_mode="enforce",
                           account_owner_email="owner@example.test", account_public_origin="https://testserver",
                           turnstile_enabled=False, account_oauth={}, background_worker_enabled=False).items():
        monkeypatch.setattr(cfg, key, value)
    monkeypatch.setattr(account_api, "mail_ready", lambda: True)
    monkeypatch.setattr(identity, "SessionLocal", lambda: Session(db.bind, expire_on_commit=False))
    fallback = []
    monkeypatch.setattr(observability, "record_admin_event", lambda **kwargs: fallback.append(kwargs))

    def session():
        with Session(db.bind, expire_on_commit=False) as request_db:
            yield request_db

    main.app.dependency_overrides[get_db] = session
    db.add_all([UserAccount(id="reader", email="reader@example.test", display_name="读者"),
                UserAccount(id="other", email="other@example.test", display_name="另一位"),
                UserAccount(id="owner", email="owner@example.test", password_hash="verified-owner-hash")])
    db.commit()
    with TestClient(main.app, base_url="https://testserver") as client:
        yield client, fallback
    main.app.dependency_overrides.pop(get_db, None)


def detail(client, account="reader"):
    response = client.get(f"/api/admin/accounts/users/{account}")
    assert response.status_code == 200, response.text
    return response.json()


def change(client, **fields):
    return client.patch("/api/admin/accounts/users/reader", json={"revision": detail(client)["revision"], "reason": "测试调整", **fields})


def test_paginated_directory_search_filters_and_secret_exclusion(admin, db):
    client, _ = admin
    db.add_all(UserAccount(id=f"u{i:03}", display_name=f"用户{i}", email=f"u{i}@example.test", active=i % 2 == 0) for i in range(121))
    db.add(UserAccount(id="percent", display_name="100%研究", email="percent@example.test"))
    db.commit()
    first = client.get("/api/admin/accounts/users?page=1&page_size=20").json()
    last = client.get("/api/admin/accounts/users?page=7&page_size=20").json()
    assert first["total"] == 125 and len(first["items"]) == 20 and len(last["items"]) == 5
    assert not {r["id"] for r in first["items"]}.intersection(r["id"] for r in last["items"])
    assert client.get("/api/admin/accounts/users", params={"q": "%"}).json()["total"] == 1
    assert client.get("/api/admin/accounts/users?role=owner").json()["items"][0]["id"] == "owner"
    assert client.get("/api/admin/accounts/users?status=disabled").json()["total"] == 60
    response = client.get("/api/admin/accounts")
    assert response.headers["cache-control"] == "no-store"
    assert not any(secret in response.text for secret in ["password_hash", "password_salt", "verified-owner-hash"])
    assert client.get("/api/admin/accounts/users?page_size=1000").status_code == 422


def test_user_changes_are_audited_and_stale_edits_cannot_overwrite(admin, db):
    client, fallback = admin
    before = detail(client)
    response = change(client, role="trusted", display_name="研究老师", limits={"daily_tasks": 7})
    assert response.status_code == 200, response.text
    assert not fallback  # success is recorded once, in the mutation transaction
    db.expire_all()
    assert db.get(UserAccount, "reader").role == "trusted"
    log = db.scalar(select(OperationalLog))
    assert log.detail["policy_changes"]["before"]["role"] == "member"
    assert log.detail["policy_changes"]["after"]["role"] == "trusted"
    assert log.detail["policy_changes"]["after"]["limits"]["daily_tasks"] == 7
    assert detail(client)["audit"][0]["note"] == "测试调整"
    stale = client.patch("/api/admin/accounts/users/reader", json={"revision": before["revision"], "role": "admin"})
    assert stale.status_code == 409
    db.expire_all()
    assert db.get(UserAccount, "reader").role == "trusted"


def test_quota_overrides_are_enforced_and_reset_restores_role(admin, db):
    client, _ = admin
    assert change(client, limits={"daily_tasks": 1, "concurrent_tasks": 1, "monthly_units": 50000,
                                  "provider_monthly_units": {"default": 0}, "exempt": False}).status_code == 200
    db.expire_all()
    quotas.reserve(db, owner="account_reader", entry_id="one")
    with pytest.raises(quotas.QuotaExceeded):
        quotas.reserve(db, owner="account_reader", entry_id="two")
    quotas.settle(db, "one", success=True)
    with pytest.raises(quotas.QuotaExceeded):
        quotas.reserve(db, owner="account_reader", entry_id="three")
    with model_budget.usage_scope("account_reader", "test", "model-call", lambda: Session(db.bind)):
        with pytest.raises(quotas.QuotaExceeded):
            model_budget.reserve_model({"messages": [], "model": "test", "max_tokens": 1})
    assert db.scalar(select(func.count()).select_from(ModelUsage)) == 0
    assert change(client, limits=None).status_code == 200
    db.expire_all()
    assert db.get(AccountQuotaOverride, "reader") is None
    assert allowances(db, "account_reader")["tasks"] == get_policy(db).daily_tasks
    assert db.get(QuotaEntry, "one").status == "completed"  # reset limits never erases billing


def test_owner_and_unknown_fields_are_protected(admin, db):
    client, _ = admin
    assert client.patch("/api/admin/accounts/users/owner", json={"active": False}).status_code == 409
    assert client.post("/api/admin/accounts/users/owner/sessions/revoke", json={"reason": "测试"}).status_code == 409
    for payload in [{"role": "owner"}, {"password_hash": "replacement"}, {"email": "replacement@example.test"},
                    {"limits": {"daily_tasks": -1}}, {"limits": {"provider_monthly_units": {"missing": 10}}},
                    {"limits": {"unrecognized": 1}}]:
        assert change(client, **payload).status_code == 422
    db.expire_all()
    assert db.get(UserAccount, "owner").active and allowances(db, "account_owner")["exempt"]


def test_disabling_and_role_changes_revoke_sessions_and_never_touch_other_users(admin, db):
    client, _ = admin
    for account_id in ["reader", "other"]:
        identity.issue_session(db, account=db.get(UserAccount, account_id))
    assert change(client, active=False).status_code == 200
    db.expire_all()
    assert all(s.revoked for s in db.scalars(select(LoginSession).where(LoginSession.account_id == "reader")))
    assert not db.scalar(select(LoginSession).where(LoginSession.account_id == "other")).revoked
    assert change(client, active=True).status_code == 200
    assert not detail(client)["sessions"]
    identity.issue_session(db, account=db.get(UserAccount, "reader"))
    assert change(client, role="admin").status_code == 200
    assert not detail(client)["sessions"]


def test_session_revoke_requires_ownership_and_is_audited(admin, db):
    client, _ = admin
    _, one = identity.issue_session(db, account=db.get(UserAccount, "reader"))
    _, other = identity.issue_session(db, account=db.get(UserAccount, "other"))
    path = "/api/admin/accounts/users/reader/sessions/revoke"
    assert client.post(path, json={"session_id": other.token_hash, "reason": "测试"}).status_code == 404
    assert client.post(path, json={"session_id": one.token_hash, "reason": "撤销旧设备"}).json()["revoked_sessions"] == 1
    assert detail(client)["audit"][0]["changes"]["revoked_sessions"] == 1


def test_account_and_quota_tabs_patch_independently_and_check_revision(admin, db):
    client, _ = admin
    current = client.get("/api/admin/accounts").json()
    payload = {"section": "accounts", "revision": current["policy_revision"], "reason": "暂停注册", "changes": {"email_enabled": False, "accounts_enabled": False}}
    response = client.patch("/api/admin/accounts/policy", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["policy"]["quota_mode"] == "enforce"
    assert client.get("/api/account/config").json()["public_demo"] is True
    assert client.get("/api/admin/accounts/users").status_code == 200
    payload.update(section="quotas", changes={"guest_turns": 5})
    assert client.patch("/api/admin/accounts/policy", json=payload).status_code == 409
    payload["revision"] = response.json()["policy_revision"]
    assert client.patch("/api/admin/accounts/policy", json={**payload, "changes": {"accounts_enabled": True}}).status_code == 422
    response = client.patch("/api/admin/accounts/policy", json=payload)
    assert response.status_code == 200 and not response.json()["policy"]["accounts_enabled"]


def test_audit_failure_rolls_back_account_and_policy_changes(admin, db):
    client, _ = admin
    def fail_audit(mapper, connection, target):
        raise RuntimeError("simulated audit outage")
    event.listen(OperationalLog, "before_insert", fail_audit)
    try:
        assert change(client, role="admin", limits={"daily_tasks": 1}).status_code == 503
        data = client.get("/api/admin/accounts").json()
        response = client.patch("/api/admin/accounts/policy", json={"section":"quotas", "revision":data["policy_revision"], "changes":{"guest_turns":9}, "reason":"测试"})
        assert response.status_code == 503
    finally:
        event.remove(OperationalLog, "before_insert", fail_audit)
    db.expire_all()
    assert db.get(UserAccount, "reader").role == "member"
    assert db.get(AccountQuotaOverride, "reader") is None
    assert get_policy(db).guest_turns == 3


def test_admin_controls_require_console_auth_and_same_origin(admin):
    client, _ = admin
    assert client.patch("/api/admin/accounts/users/reader", json={"active":False}, headers={"origin":"https://evil.test"}).status_code == 403
    override = main.app.dependency_overrides.pop(main.require_admin)
    try:
        for path in ["/api/admin/accounts", "/api/admin/accounts/users", "/api/admin/accounts/users/reader", "/api/admin/quotas/usage"]:
            assert client.get(path).status_code == 401
        assert client.patch("/api/admin/accounts/users/reader", json={"role":"admin"}).status_code == 401
    finally:
        main.app.dependency_overrides[main.require_admin] = override


def test_usage_directory_filters_and_preserves_provider_records(admin, db):
    client, _ = admin
    db.add_all([ModelUsage(id="a", owner_id="account_reader", invocation_id="call-a", session_id="session-a", model="test", provider_id="default", units=123, status="actual"),
                ModelUsage(id="b", owner_id="account_other", invocation_id="call-b", session_id="session-b", model="test", provider_id="other", units=456, status="estimated"),
                ModelUsage(id="old", owner_id="account_reader", invocation_id="old", session_id="old", model="test", units=999, created_at=identity.now()-timedelta(days=31))])
    db.commit()
    data = client.get("/api/admin/quotas/usage?owner_id=account_reader&provider_id=default").json()
    assert data["total"] == 1 and data["units"] == 123
    assert data["items"][0]["display_name"] == "读者"
    assert client.get("/api/admin/quotas/usage?status=estimated").json()["total"] == 1
