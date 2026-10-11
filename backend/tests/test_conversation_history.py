import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import main
from app.account_models import Conversation, ConversationHistory, UserAccount
from app.config import get_settings
from app.database import get_db
from app.main import app
from app.models import GroupChat, Invocation
from app.services import identity


@pytest.fixture
def client(db, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", False)
    monkeypatch.setattr(cfg, "account_public_origin", "https://testserver")
    monkeypatch.setattr(cfg, "background_worker_enabled", False)
    monkeypatch.setattr(identity, "SessionLocal", lambda: Session(db.bind, expire_on_commit=False))
    app.dependency_overrides[get_db] = lambda: db
    account = UserAccount(id="history-test", email="history@test.test")
    db.add(account); db.commit()
    token, _ = identity.issue_session(db, account=account)
    with TestClient(app, base_url="https://testserver") as client:
        client.cookies.set(identity.SESSION_COOKIE, token)
        yield client
    app.dependency_overrides.pop(get_db, None)


def principal(client):
    return client.get("/api/demo/session").json()["owner_id"]


def document(session="ses-a", text="hello"):
    return {"id": "client-a", "session": session, "title": "标题", "messages": [{"role": "user", "text": text}]}


def put(client, value=None, revision=0, **kwargs):
    value = value or document()
    return client.put("/api/account/history/" + value["session"], json={"revision": revision, "conversation": value}, **kwargs)


def test_cloud_history_works_without_optional_account_or_quota_modules(client, db):
    owner = principal(client)
    assert put(client).json() == {"revision": 1}
    index = client.get("/api/account/history").json()
    assert index["items"][0]["id"] == "client-a"
    assert index["items"][0]["messageCount"] == 1
    assert db.get(Conversation, "ses-a").owner_id == owner
    assert client.get("/api/account/history/ses-a").json()["conversation"]["messages"][0]["text"] == "hello"


def test_cloud_restores_preexisting_owned_sessions_not_other_or_ambiguous_sessions(client, db):
    owner = principal(client)
    db.add_all([Conversation(id="old", owner_id=owner), Conversation(id="other", owner_id="someone-else"),
                Invocation(id="call-a", session_id="old", owner_id=owner, query="原问题", status="completed", result_text="原答案"),
                Invocation(id="call-b", session_id="other", owner_id="someone-else", query="private", status="completed", result_text="secret")])
    db.commit()
    items = client.get("/api/account/history").json()["items"]
    assert [item["session"] for item in items] == ["old"]
    data = client.get("/api/account/history/old").json()
    assert [m["text"] for m in data["conversation"]["messages"]] == ["原问题", "原答案"]
    assert data["conversation"]["messages"][1]["result"]["invocation_id"] == "call-a"
    assert client.get("/api/account/history/other").status_code == 404


def test_owned_result_is_compacted_and_hydrated_new_calls_are_appended_once(client, db):
    owner = principal(client)
    db.add_all([Conversation(id="ses-a", owner_id=owner), Invocation(id="call-a", session_id="ses-a", owner_id=owner,
                query="hello", result_text="answer", status="completed", result_data={"evidence": "kept only on invocation"})])
    db.commit()
    data = document()
    data["messages"].append({"role": "assistant", "text": "answer", "result": {"invocation_id": "call-a", "huge": "discard"}, "streaming": True, "taskId": "not-a-credential"})
    assert put(client, data).status_code == 200
    saved = db.get(ConversationHistory, "ses-a").payload
    assert saved["messages"][1]["result"] == {"invocation_id": "call-a"}
    assert "taskId" not in saved["messages"][1]
    db.add(Invocation(id="call-new", session_id="ses-a", owner_id=owner, query="next", result_text="next answer", status="completed"))
    db.commit()
    result = client.get("/api/account/history/ses-a").json()["conversation"]
    assert len(result["messages"]) == 4
    assert result["messages"][1]["result"]["result_data"]["evidence"] == "kept only on invocation"
    assert put(client, result, revision=1).status_code == 200
    assert len(client.get("/api/account/history/ses-a").json()["conversation"]["messages"]) == 4


def test_stale_writes_do_not_overwrite_newer_transcripts(client, db):
    assert put(client).status_code == 200
    assert put(client, document(text="new"), 1).status_code == 200
    assert put(client, document(text="stale"), 1).status_code == 409
    assert db.get(ConversationHistory, "ses-a").payload["messages"][0]["text"] == "new"


def test_delete_tombstone_blocks_resurrection_and_restore_is_explicit(client, db):
    assert put(client).status_code == 200
    assert client.delete("/api/account/history/ses-a?revision=0").status_code == 409
    assert client.delete("/api/account/history/ses-a?revision=1").status_code == 200
    assert client.get("/api/account/history/ses-a").status_code == 410
    assert put(client, revision=2).status_code == 410
    assert client.get("/api/account/history").json()["items"][0]["deleted"] is True
    assert client.post("/api/account/history/ses-a/restore?revision=2").status_code == 200
    assert client.get("/api/account/history/ses-a").json()["conversation"]["messages"][0]["text"] == "hello"


def test_delete_legacy_without_snapshot_keeps_tasks_and_can_restore(client, db):
    owner = principal(client)
    db.add_all([Conversation(id="old", owner_id=owner), Invocation(id="old-call", session_id="old", owner_id=owner, query="original", status="failed")])
    db.commit()
    assert client.delete("/api/account/history/old?revision=0").status_code == 200
    assert client.post("/api/account/history/old/restore?revision=1").status_code == 200
    assert len(client.get("/api/account/history/old").json()["conversation"]["messages"]) == 2
    assert db.get(Invocation, "old-call") is not None


def test_foreign_session_result_group_and_stale_identity_are_rejected_even_for_owner(client, db):
    account = UserAccount(id="owner-test", email="owner@test.test", role="owner")
    db.add(account); db.commit()
    token, _ = identity.issue_session(db, account=account)
    client.cookies.set(identity.SESSION_COOKIE, token)
    owner = principal(client)
    db.add_all([Conversation(id="foreign", owner_id="other"), Invocation(id="private", session_id="foreign", owner_id="other", query="secret"),
                GroupChat(id="private-group", owner_id="other", name="private")]); db.commit()
    assert put(client, document(session="foreign")).status_code == 404
    assert client.get("/api/account/history/foreign", headers={"X-API-Key": "test-public-api-key-123456"}).status_code == 404
    data = document(); data["messages"][0]["result"] = {"invocation_id": "private"}
    assert put(client, data).status_code == 404
    data = document(); data["groupConfig"] = {"backendId": "private-group"}
    assert put(client, data).status_code == 404
    assert put(client, headers={"X-Conversation-Owner": "old-account"}).status_code == 401
    assert owner == "account_owner-test" and db.get(ConversationHistory, "ses-a") is None


def test_csrf_and_payload_validation_happen_before_binding(client, db):
    assert put(client, headers={"Origin": "https://evil.test"}).status_code == 403
    assert put(client, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert put(client, revision=-1).status_code == 422
    data = document(); data["owner_id"] = "spoof"
    assert put(client, data).status_code == 422
    assert put(client, document(text="x" * (2 * 1024 * 1024))).status_code == 413
    assert db.scalar(select(ConversationHistory)) is None
    assert db.get(Conversation, "ses-a") is None


def test_index_is_paginated_without_silent_fifty_item_truncation(client, db):
    owner = principal(client)
    db.add_all([Conversation(id=f"session-{i:03}", owner_id=owner) for i in range(125)]); db.commit()
    first = client.get("/api/account/history").json()
    second = client.get(f"/api/account/history?offset={first['next_offset']}").json()
    assert len(first["items"]) == 100 and len(second["items"]) == 25
    assert second["next_offset"] is None
    assert len({item["session"] for item in first["items"] + second["items"]}) == 125


def test_public_guest_has_no_unbounded_cloud_storage_and_history_is_still_readable(client, db):
    client.cookies.clear()
    owner = principal(client)
    assert owner.startswith("guest_")
    assert put(client).status_code == 401
    assert client.get("/api/account/history").status_code == 200
    assert client.get("/api/demo/session").json()["authenticated"] is True
    assert db.get(ConversationHistory, "ses-a") is None


def test_old_owned_invocations_without_mapping_are_discovered_but_mixed_owners_are_not(client, db):
    owner = principal(client)
    db.add_all([Invocation(id="unmapped", session_id="unmapped", owner_id=owner, query="recover"),
                Invocation(id="mixed-a", session_id="mixed", owner_id=owner, query="ambiguous"),
                Invocation(id="mixed-b", session_id="mixed", owner_id="other", query="private")])
    db.commit()
    assert [item["session"] for item in client.get("/api/account/history").json()["items"]] == ["unmapped"]
    assert client.get("/api/account/history/mixed").status_code == 404
    assert client.get("/api/account/history/unmapped").headers["cache-control"] == "no-store"
