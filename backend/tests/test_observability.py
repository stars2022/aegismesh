from __future__ import annotations

import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.database import SessionLocal
from app.main import app, require_admin, settings
from app.models import AdminAccount, LogIngestCursor, OperationalLog
from app.services import observability as logs
from app.services.admin_auth import COOKIE_NAME, create_session_token


def record(kind="access", log_id="log-1", **updates):
    value = {"schema_version": "1.0", "log_type": kind, "log_id": log_id, "timestamp": logs.utcnow().isoformat(),
             "aic": "reporter-AIC", "correlation_id": "task-1", "trace_id": "trace-1", "body": {
                 "request": {"method": "POST", "route": "/rpc", "url": "https://host.example/rpc"},
                 "response": {"statusCode": 200}, "caller": {"aic": "caller-AIC"},
                 "callee": {"aic": "callee-AIC"}, "durationMs": 52.0}}
    value.update(updates)
    return value


def line(value):
    return json.dumps(value).encode() + b"\n"


def ingest(db, directory):
    assert logs.index_once(sessionmaker(bind=db.get_bind()), directory)
    db.expire_all()


def add(db, value):
    data = logs.normalize_amp(value, value["log_type"], f"amp_{value['log_type']}_aegismesh.jsonl", line(value))
    row = OperationalLog(**data)
    db.add(row)
    db.commit()
    return row


def test_allowlisted_amp_details_redact_credentials_and_drop_payloads():
    value = record()
    value["body"]["request"].update(url="https://user:password@example.com/rpc?api_key=private#token", headers={"Authorization": "secret-header"}, body="private-user-text")
    value["body"].update(error={"code": 401, "message": "Bearer hidden-token api_key=hidden-key", "stackTrace": "private-stack", "data": {"password": "private-value"}}, payload="private-agent-payload")
    value["attributes"] = {"secret": "private-top-attributes"}
    result = logs.normalize_amp(value, "access", "amp_access_aegismesh.jsonl", line(value))
    rendered = json.dumps(result, default=str)
    for secret in ("hidden-token", "hidden-key", "secret-header", "private-user-text", "private-stack", "private-value", "private-agent-payload", "private-top-attributes", "user:password"):
        assert secret not in rendered
    assert result["detail"]["body"]["request"]["url"] == "https://example.com/rpc"
    assert result["outcome"] == "error"
    assert result["caller_aic"] == "caller-AIC"
    assert result["task_id"] == "task-1"


def test_diagnostics_redact_quoted_credentials_and_remain_searchable(db):
    value = record(body={"error": {"message": 'upstream unavailable {"api_key": "quoted-secret", "password": "second-secret"}'}})
    row = add(db, value)
    assert "quoted-secret" not in json.dumps(logs.log_read(row, detail=True))
    assert "second-secret" not in json.dumps(logs.log_read(row, detail=True))
    assert logs.list_logs(db, logs.LogQuery(q="upstream unavailable"))["total"] == 1
    error = logs.normalize_amp(record("system", severity_number=17, body={"message": "service unavailable"}), "system", "amp_system_aegismesh.jsonl", b"")
    assert error["outcome"] == "error"


@pytest.mark.parametrize("event,expected", [("send", "success"), ("receive", "success"), ("ack", "success"), ("nack", "error"), ("timeout", "error")])
def test_message_events_are_local_edges_not_platform_receipts(event, expected):
    value = record("message", body={"eventType": event, "system": "rabbitmq", "messageId": "message-1", "payload": {"text": "not-indexed"}})
    result = logs.normalize_amp(value, "message", "amp_message_aegismesh.jsonl", line(value))
    assert result["outcome"] == expected
    assert result["message_id"] == "message-1"
    assert "payload" not in result["detail"]["body"]


def test_index_is_incremental_idempotent_and_does_not_change_spool(db, tmp_path):
    path = tmp_path / "amp_access_aegismesh.jsonl"
    data = line(record())
    path.write_bytes(data + data)
    before = path.read_bytes()
    ingest(db, tmp_path)
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 1
    assert path.read_bytes() == before
    state = db.get(LogIngestCursor, path.name)
    assert state.byte_offset == len(before)
    assert state.invalid_lines == 0


def test_partial_and_malformed_lines_do_not_break_ingestion(db, tmp_path):
    path = tmp_path / "amp_access_aegismesh.jsonl"
    data = line(record())
    path.write_bytes(b"bad-json\n" + data[:-3])
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 0
    assert db.get(LogIngestCursor, path.name).byte_offset == len(b"bad-json\n")
    with path.open("ab") as stream:
        stream.write(data[-3:])
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 1
    assert db.get(LogIngestCursor, path.name).invalid_lines == 1


def test_oversized_line_is_skipped_once_then_reader_recovers(db, tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "MAX_LINE", 512)
    path = tmp_path / "amp_access_aegismesh.jsonl"
    path.write_bytes(b"x" * 3000 + b"\n" + line(record()))
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 1
    assert db.get(LogIngestCursor, path.name).invalid_lines == 1


def test_rotation_and_copytruncate_regrowth_resume_without_duplicates(db, tmp_path):
    path = tmp_path / "amp_access_aegismesh.jsonl"
    path.write_bytes(line(record(log_id="old")))
    ingest(db, tmp_path)
    path.rename(tmp_path / "old.jsonl")
    path.write_bytes(line(record(log_id="new")))
    ingest(db, tmp_path)
    path.write_bytes(line(record(log_id="regrown-record-with-longer-id")))
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 3
    assert db.get(LogIngestCursor, path.name).rotations == 2
    assert db.get(LogIngestCursor, path.name).rotation_gaps == 0


def test_rotation_with_unread_backlog_is_reported(db, tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "BATCH_LINES", 1)
    path = tmp_path / "amp_access_aegismesh.jsonl"
    path.write_bytes(line(record(log_id="one")) + line(record(log_id="unread")))
    ingest(db, tmp_path)
    path.rename(tmp_path / "archive.jsonl")
    path.write_bytes(line(record(log_id="new-file")))
    ingest(db, tmp_path)
    source = next(s for s in logs.index_status(db)["sources"] if s["name"] == path.name)
    assert source["rotation_gaps"] == 1
    assert source["rotations"] == 1
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 2


def test_symlinks_and_unknown_files_are_not_read(db, tmp_path):
    private = tmp_path / "not-an-amp-log.txt"
    private.write_bytes(line(record()))
    (tmp_path / "amp_access_aegismesh.jsonl").symlink_to(private)
    (tmp_path / "amp_untrusted.jsonl").write_bytes(line(record()))
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 0
    assert db.get(LogIngestCursor, "amp_access_aegismesh.jsonl").last_error == "unreadable"


def test_index_budget_reports_backlog_and_resumes(db, tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "BATCH_LINES", 1)
    path = tmp_path / "amp_access_aegismesh.jsonl"
    path.write_bytes(line(record(log_id="one")) + line(record(log_id="two")))
    ingest(db, tmp_path)
    state = next(s for s in logs.index_status(db)["sources"] if s["name"] == path.name)
    assert state["pending_bytes"] > 0
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 2


def test_retention_only_prunes_local_index_not_source_or_cursors(db, tmp_path, monkeypatch):
    monkeypatch.setattr(logs.get_settings(), "log_max_records", 1)
    path = tmp_path / "amp_access_aegismesh.jsonl"
    path.write_bytes(line(record(log_id="expired", timestamp=(logs.utcnow() - timedelta(days=8)).isoformat())) + line(record(log_id="one")) + line(record(log_id="two")))
    original = path.read_bytes()
    ingest(db, tmp_path)
    assert db.scalar(select(func.count()).select_from(OperationalLog)) == 1
    assert db.get(LogIngestCursor, path.name).expired_lines == 1
    assert path.read_bytes() == original


def test_query_filters_and_literal_wildcards(db):
    add(db, record(log_id="ok"))
    failed = record(log_id="err", correlation_id="other-task")
    failed["body"]["response"]["statusCode"] = 502
    failed["body"]["request"]["route"] = "/100%_failure"
    add(db, failed)
    assert logs.list_logs(db, logs.LogQuery(aic="callee-AIC"))["total"] == 2
    result = logs.list_logs(db, logs.LogQuery(related_id="task-1"))
    assert result["total"] == 1 and result["errors"] == 0
    assert logs.list_logs(db, logs.LogQuery(outcome="error"))["total"] == 1
    assert logs.list_logs(db, logs.LogQuery(q="%_"))["total"] == 1
    assert logs.list_logs(db, logs.LogQuery(q="' OR 1=1 --"))["total"] == 0
    assert logs.list_logs(db, logs.LogQuery(origin="admin"))["total"] == 0


def test_pagination_is_stable_during_inserts_and_handles_time_ties(db):
    stamp = logs.utcnow().isoformat()
    for i in range(5):
        add(db, record(log_id=str(i), timestamp=stamp))
    first = logs.list_logs(db, logs.LogQuery(limit=2))
    add(db, record(log_id="new-arrival", timestamp=stamp))
    second = logs.list_logs(db, logs.LogQuery(limit=2, cursor=first["next_cursor"]))
    third = logs.list_logs(db, logs.LogQuery(limit=2, cursor=second["next_cursor"]))
    ids = [row["id"] for page in (first, second, third) for row in page["items"]]
    assert len(ids) == len(set(ids)) == 5
    assert second["total"] == 5
    assert not third["next_cursor"]
    assert all(row["delivery"] == "not_observed" for row in first["items"])
    with pytest.raises(ValueError, match="游标"):
        logs.list_logs(db, logs.LogQuery(cursor="invalid"))


def test_admin_audit_failure_is_visible_and_does_not_raise(db, monkeypatch):
    monkeypatch.setattr(logs, "_audit_failures", 0)
    def unavailable():
        raise RuntimeError("database unavailable")
    logs.record_admin_event(actor="operator", method="POST", path="/api/agents/test/registration", request_id="test-failed-audit", status_code=422, duration_ms=12, session_factory=unavailable)
    assert logs.index_status(db)["audit_write_failures"] == 1


def test_admin_audit_records_success_and_failure_without_request_secrets():
    override = app.dependency_overrides.pop(require_admin, None)
    try:
        with TestClient(app) as client:
            with SessionLocal() as db:
                db.merge(AdminAccount(username="log-test-admin", password_hash="", password_salt="", active=True))
                db.commit()
            for path in ("/api/admin/logs", "/api/admin/logs/status", "/api/admin/logs/1", "/api/admin/logs/export"):
                assert client.get(path).status_code == 401
            client.cookies.set(COOKIE_NAME, create_session_token("log-test-admin", settings.admin_session_secret, 60))
            failed = client.post("/api/agents/missing-log-test/registration", json={"password": "never-persist-this-password"})
            assert failed.status_code == 404
            request_id = failed.headers["x-request-id"]
            rows = client.get("/api/admin/logs", params={"origin": "admin", "related_id": request_id}).json()
            assert rows["total"] == 1
            row = rows["items"][0]
            assert row["actor"] == "log-test-admin" and row["outcome"] == "error"
            assert row["delivery"] == "local_only"
            detail = client.get(f"/api/admin/logs/{row['id']}").json()
            assert "never-persist" not in json.dumps(detail)
            assert detail["detail"]["note"] == "Agent not found"
            for path in ("/api/admin/logs", "/api/admin/logs/status", f"/api/admin/logs/{row['id']}"):
                assert client.get(path).headers["Cache-Control"] == "no-store"
            policy = client.get("/api/policy").json()
            before = policy["request_timeout_seconds"]
            policy.update(request_timeout_seconds=before + 1, interop_compatibility=False)
            changed = client.put("/api/policy", json=policy)
            assert changed.status_code == 200
            result = client.get("/api/admin/logs", params={"origin": "admin", "related_id": changed.headers["x-request-id"]}).json()
            row_detail = client.get(f"/api/admin/logs/{result['items'][0]['id']}").json()
            assert row_detail["detail"]["policy_changes"]["request_timeout_seconds"] == {"before": before, "after": before + 1}
            exported = client.get("/api/admin/logs/export", params={"origin": "admin", "related_id": request_id})
            assert exported.status_code == 200
            lines = [json.loads(line) for line in exported.text.splitlines()]
            assert lines[0]["exported"] == 1 and not lines[0]["truncated"]
            assert exported.headers["Cache-Control"] == "no-store"
            assert lines[1]["request_id"] == request_id
            assert client.get("/api/admin/logs", params={"cursor": "!"}).status_code == 422
            assert client.get("/api/admin/logs", params={"limit": 10000}).status_code == 422
            assert client.get("/api/admin/logs", params={"since": "2026-09-29T00:00:00Z", "until": "2026-09-28T00:00:00Z"}).status_code == 422
    finally:
        if override is not None:
            app.dependency_overrides[require_admin] = override


def test_export_is_bounded_and_reports_truncation(db):
    from app.main import logs_export
    stamp = logs.utcnow()
    db.add_all(OperationalLog(event_key=f"bounded-{i}", origin="amp", kind="system", occurred_at=stamp,
                             task_id="bounded-export", summary=f"record {i}") for i in range(2001))
    db.commit()
    response = logs_export(db, logs.LogQuery(related_id="bounded-export"))
    lines = [json.loads(item) for item in response.body.decode().splitlines()]
    assert lines[0]["total_matching"] == 2001
    assert lines[0]["exported"] == 2000 and lines[0]["truncated"]
    assert len(lines) == 2001
    assert lines[1]["summary"] == "record 2000"
