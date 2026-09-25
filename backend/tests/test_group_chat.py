from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app


def client() -> TestClient:
    return TestClient(app)


def make_agent_payload(agent_id: str, transport: str) -> dict:
    return {
        "id": agent_id,
        "name": f"专家{agent_id}",
        "aic": f"1.2.156.3088.0.{int(uuid.uuid4().hex[:8], 16) % 9 + 1}.{uuid.uuid4().hex[:6]}.1.2.ABCD",
        "role": "partner",
        "transport": transport,
        "endpoint_url": "https://partner.example.com/rpc" if transport == "aip-rpc" else "",
    }


def test_group_chat_local_flow(monkeypatch) -> None:
    a1 = f"ga-{uuid.uuid4().hex[:6]}"
    a2 = f"ga-{uuid.uuid4().hex[:6]}"
    with client() as test_client:
        assert test_client.post("/api/agents", json=make_agent_payload(a1, "openai-compatible")).status_code == 201
        assert test_client.post("/api/agents", json=make_agent_payload(a2, "openai-compatible")).status_code == 201

        created = test_client.post(
            "/api/group-chat",
            json={"name": "科研群", "host_agent_id": a1, "members": [a1, a2]},
        )
        assert created.status_code == 200
        body = created.json()
        assert body["transport"] == "local"
        gid = body["id"]

        async def fake_reply(db, agent, prompt, timeout, group_session_id):
            assert "科研群" in prompt
            assert "群聊历史公开记录" in prompt
            return "收到，我是 " + agent.name

        monkeypatch.setattr(main_module, "run_group_agent_reply", fake_reply)

        sent = test_client.post(
            f"/api/group-chat/{gid}/messages",
            json={"text": f"@专家{a1} 请打个招呼", "mentioned": a1},
        )
        assert sent.status_code == 200
        result = sent.json()
        assert result["reply"] == "收到，我是 专家" + a1
        assert result["agent_id"] == a1

        detail = test_client.get(f"/api/group-chat/{gid}").json()
        roles = [(m["sender_id"], m["role"]) for m in detail["messages"]]
        assert ("user", "user") in roles
        assert (a1, "agent") in roles
        assert detail["transport"] == "local"


def test_group_chat_transport_decision(monkeypatch) -> None:
    a_ext = f"ge-{uuid.uuid4().hex[:6]}"
    a_int = f"gi-{uuid.uuid4().hex[:6]}"
    with client() as test_client:
        test_client.post("/api/agents", json=make_agent_payload(a_ext, "aip-rpc"))
        test_client.post("/api/agents", json=make_agent_payload(a_int, "openai-compatible"))

        # 无 MQ 配置 → 即使有外部成员也回落 local
        created = test_client.post(
            "/api/group-chat",
            json={"name": "回落群", "members": [a_ext, a_int]},
        )
        assert created.json()["transport"] == "local"

        # 配置 MQ → aip-mq
        original = main_module.settings.aip_group_mq_host
        main_module.settings.aip_group_mq_host = "localhost"
        try:
            created = test_client.post(
                "/api/group-chat",
                json={"name": "国标群", "members": [a_ext, a_int]},
            )
            assert created.json()["transport"] == "aip-mq"
        finally:
            main_module.settings.aip_group_mq_host = original


def test_group_chat_rejects_invalid_members() -> None:
    with client() as test_client:
        response = test_client.post(
            "/api/group-chat",
            json={"name": "空群", "members": [f"ghost-{uuid.uuid4().hex[:6]}"]},
        )
        assert response.status_code == 422
