from __future__ import annotations

import asyncio
import json

import pytest

from app.account_api import mail_ready
from app.config import get_settings
from app.services import observability as logs


@pytest.mark.parametrize("username,password,port,expected", [
    ("resend", "test-secret", 465, True), ("resend", "", 465, False),
    ("", "test-secret", 465, False), ("", "", 465, True),
    ("resend", "test-secret", 0, False), ("resend", "test-secret", 65536, False),
])
def test_mail_readiness_requires_complete_auth_pair(monkeypatch, username, password, port, expected):
    cfg = get_settings()
    for key, value in dict(account_email_enabled=True, account_smtp_host="smtp.example.test",
                           account_mail_from="sender@example.test", account_public_origin="https://example.test",
                           account_smtp_username=username, account_smtp_password=password, account_smtp_port=port).items():
        monkeypatch.setattr(cfg, key, value)
    assert mail_ready() is expected


@pytest.mark.parametrize("path,method,status,label", [
    ("/api/account/register", "POST", 200, "请求邮箱注册验证"),
    ("/api/account/login", "POST", 401, "账号登录"),
    ("/api/account/verify-email", "POST", 200, "验证注册邮箱"),
    ("/api/account/password/reset", "POST", 400, "重置账号密码"),
    ("/api/account/sessions/private-session-hash", "DELETE", 200, "撤销登录设备"),
    ("/api/account/oauth/google/callback", "GET", 400, "第三方登录回调"),
])
def test_account_audit_never_reads_body_or_query(monkeypatch, path, method, status, label):
    captured = []
    monkeypatch.setattr(logs, "record_admin_event", lambda **event: captured.append(event))
    scope = {"type": "http", "path": path, "method": method,
             "query_string": b"token=private-proof&email=private@example.test",
             "headers": [(b"cookie", b"private-cookie")], "state": {"browser_owner_id": "guest_test"}}

    async def handler(scope, receive, send):
        scope["state"]["audit_note"] = "private-error-body"
        if status == 200 and path.endswith("verify-email"):
            scope["state"]["audit_actor"] = "account_verified"
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b"private-result"})

    async def receive():
        raise AssertionError("The audit middleware must not read request bodies")

    async def send(message):
        pass

    asyncio.run(logs.AdminAuditMiddleware(handler)(scope, receive, send))
    assert len(captured) == 1
    row = captured[0]
    assert row["status_code"] == status and row["request_id"]
    assert logs.audit_action(method, row["path"]) == label
    assert row["actor"] == ("account_verified" if path.endswith("verify-email") else "guest_test")
    assert "private" not in json.dumps(row)


def test_resend_credentials_are_redacted_in_diagnostic_fields():
    assert "re_example_secret_1234567890" not in logs.safe_text("upstream re_example_secret_1234567890 failed")
