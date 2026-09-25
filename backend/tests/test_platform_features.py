from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient

from app.main import app, settings

API_KEY = "test-public-api-key-123456"
HEADERS = {"X-API-Key": API_KEY}


def client() -> TestClient:
    return TestClient(app)


def create_agent(payload: dict) -> dict:
    with client() as test_client:
        response = test_client.post("/api/agents", json=payload)
        assert response.status_code == 201, response.text
        return response.json()


def task_command(command: str = "start", task_id: str | None = None) -> dict:
    return {
        "id": f"cmd-{uuid.uuid4().hex[:8]}",
        "sentAt": "2026-09-13T00:00:00+00:00",
        "senderRole": "leader",
        "senderId": "1.2.156.3088.0.1.2.3.4.ABCD",
        "sessionId": "session-test",
        "command": command,
        "taskId": task_id,
        "dataItems": [{"type": "text", "text": "测试任务"}],
    }


def enable_test_aip_runtime(monkeypatch) -> None:
    monkeypatch.setattr(settings, "aip_identity_binding_enabled", True)
    monkeypatch.setattr(settings, "aip_tls_certfile", "test-cert.pem")
    monkeypatch.setattr(settings, "aip_tls_keyfile", "test-key.pem")
    monkeypatch.setattr(settings, "aip_tls_client_ca_file", "test-ca.pem")
    monkeypatch.setattr(settings, "aip_tls_port", 8443)
    monkeypatch.setattr(settings, "public_base_url", "https://aip.example.com:8443")


def test_hosted_agent_acs_declares_streaming_and_notification(monkeypatch) -> None:
    enable_test_aip_runtime(monkeypatch)
    agent = create_agent(
        {
            "id": f"hosted-{uuid.uuid4().hex[:8]}",
            "name": "托管执行者",
            "aic": "1.2.156.3088.0.1.2.3.4.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
        }
    )
    with client() as test_client:
        response = test_client.get(f"/api/agents/{agent['id']}/acs", headers=HEADERS)
        assert response.status_code == 200
        capabilities = response.json()["capabilities"]
        assert capabilities["streaming"] is True
        assert capabilities["notification"] is True


def test_external_agent_acs_respects_streaming_choice() -> None:
    agent_id = f"external-{uuid.uuid4().hex[:8]}"
    create_agent(
        {
            "id": agent_id,
            "name": "外部执行者",
            "aic": "1.2.156.3088.0.2.3.4.5.ABCD",
            "role": "partner",
            "transport": "aip-rpc",
            "endpoint_url": "https://agent.example.com/rpc",
            "streaming_enabled": False,
        }
    )
    with client() as test_client:
        response = test_client.get(f"/api/agents/{agent_id}/acs", headers=HEADERS)
        assert response.status_code == 200
        capabilities = response.json()["capabilities"]
        assert capabilities["streaming"] is False
        assert capabilities["notification"] is False
        test_client.delete(f"/api/agents/{agent_id}")


def test_internal_agent_is_hidden_from_external_endpoints() -> None:
    agent = create_agent(
        {
            "id": f"internal-{uuid.uuid4().hex[:8]}",
            "name": "仅内部",
            "aic": "1.2.156.3088.0.3.4.5.6.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
            "usage_mode": "internal",
        }
    )
    with client() as test_client:
        assert test_client.get(f"/api/agents/{agent['id']}/acs", headers=HEADERS).status_code == 404
        rpc = test_client.post(
            f"/aip/{agent['id']}/rpc",
            json={"jsonrpc": "2.0", "method": "rpc", "id": "1", "params": {"command": task_command()}},
        )
        assert rpc.status_code == 404


def test_external_only_agent_rejects_internal_dispatch_via_acs_visibility(monkeypatch) -> None:
    enable_test_aip_runtime(monkeypatch)
    agent = create_agent(
        {
            "id": f"outer-{uuid.uuid4().hex[:8]}",
            "name": "仅对外",
            "aic": "1.2.156.3088.0.4.5.6.7.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
            "usage_mode": "external",
        }
    )
    with client() as test_client:
        response = test_client.get(f"/api/agents/{agent['id']}/acs", headers=HEADERS)
        assert response.status_code == 200


def test_notification_routes_fail_closed_without_mtls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "aip_tls_port", 0)
    agent = create_agent(
        {
            "id": f"notif-{uuid.uuid4().hex[:8]}",
            "name": "通知执行者",
            "aic": "1.2.156.3088.0.5.6.7.8.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
        }
    )
    base = f"/aip/{agent['id']}/notification"
    config = {"url": "https://leader.example.com/callback", "token": "shared-token", "taskId": "task-notify-1"}
    with client() as test_client:
        set_response = test_client.post(
            f"{base}/set",
            json={"jsonrpc": "2.0", "method": "notification/set", "id": "1", "params": config},
        )
        assert set_response.status_code == 503


def test_stream_endpoint_fails_closed_without_mtls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "aip_tls_port", 0)
    agent = create_agent(
        {
            "id": f"stream-{uuid.uuid4().hex[:8]}",
            "name": "流式执行者",
            "aic": "1.2.156.3088.0.6.7.8.9.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
        }
    )
    with client() as test_client:
        response = test_client.post(
            f"/aip/{agent['id']}/stream",
            json={"jsonrpc": "2.0", "method": "stream", "id": "rpc-1", "params": {"message": task_command()}},
        )
        assert response.status_code == 503


def test_stream_endpoint_respects_agent_setting() -> None:
    agent = create_agent(
        {
            "id": f"stream-off-{uuid.uuid4().hex[:8]}",
            "name": "关闭流式",
            "aic": "1.2.156.3088.0.6.7.8.A.ABCD",
            "role": "partner",
            "transport": "openai-compatible",
            "streaming_enabled": False,
        }
    )
    with client() as test_client:
        response = test_client.post(
            f"/aip/{agent['id']}/stream",
            json={"jsonrpc": "2.0", "method": "stream", "id": "rpc-1", "params": {"message": task_command()}},
        )
        assert response.status_code == 409
