from __future__ import annotations

import uuid
import importlib

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app, settings
from app.database import SessionLocal
from app.models import Agent
from app.services.registration import RegistryClient, RegistrationError, validate_registration_acs

main_module = importlib.import_module("app.main")


def enable_test_aip_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "aip_identity_binding_enabled", True)
    monkeypatch.setattr(settings, "aip_tls_certfile", "test-cert.pem")
    monkeypatch.setattr(settings, "aip_tls_keyfile", "test-key.pem")
    monkeypatch.setattr(settings, "aip_tls_client_ca_file", "test-ca.pem")
    monkeypatch.setattr(settings, "aip_tls_port", 8443)
    monkeypatch.setattr(settings, "public_base_url", "https://aip.example.com:8443")


def make_client(handler) -> RegistryClient:
    return RegistryClient(
        base_url="http://registry.test",
        username="user-1",
        password="secret-1",
        transport=httpx.MockTransport(handler),
    )


def test_registration_requires_mtls_on_mq_as_well_as_rpc():
    acs = {"securitySchemes": {"mtls": {"type": "mutualTLS"}}, "endPoints": [
        {"transport": "JSONRPC", "url": "https://aip.example/rpc", "security": [{"mtls": []}]},
        {"transport": "AMQP", "url": "amqps://mq.example/acps?inbox=inbox_{AIC}"},
    ]}
    with pytest.raises(RegistrationError, match="mutualTLS"):
        validate_registration_acs(acs)
    acs["endPoints"][1]["security"] = [{"mtls": []}]
    validate_registration_acs(acs)


async def test_login_save_submit_and_detail_flow() -> None:
    seen: list[tuple[str, str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("Authorization")
        seen.append((request.method, request.url.path, auth))
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"accessToken": "tok-1", "expiresIn": 3600})
        if request.url.path == "/agent/client":
            return httpx.Response(201, json={"id": "reg-1", "status": "DRAFT"})
        if request.url.path == "/agent/client/reg-1/submit":
            return httpx.Response(200, json={})
        if request.url.path == "/agent/client/reg-1":
            return httpx.Response(200, json={"id": "reg-1", "status": "PENDING"})
        return httpx.Response(404, json={"detail": "not found"})

    client = make_client(handler)
    agent_id = await client.save_agent("协调者", "1.0.0", "描述", {"aic": "x"})
    assert agent_id == "reg-1"
    await client.submit(agent_id)
    detail = await client.detail(agent_id)
    assert RegistryClient.map_status(detail.get("status")) == "pending"
    login_calls = [item for item in seen if item[1] == "/auth/login"]
    assert len(login_calls) == 1
    authenticated = [item for item in seen if item[2] == "Bearer tok-1"]
    assert len(authenticated) >= 2


async def test_fetch_eab_credential() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"accessToken": "tok"})
        if request.url.path == "/acps-atr-v2/eab/1.2.156.3088.0.1.2.3.4.ABCD":
            return httpx.Response(
                201,
                json={
                    "keyId": "kid-1",
                    "macKey": "mac-1",
                    "aic": "1.2.156.3088.0.1.2.3.4.ABCD",
                    "expiresAt": "2026-09-14T00:00:00+00:00",
                },
            )
        return httpx.Response(404)

    client = make_client(handler)
    credential = await client.fetch_eab("1.2.156.3088.0.1.2.3.4.ABCD")
    assert credential.key_id == "kid-1"
    assert credential.mac_key == "mac-1"


async def test_unconfigured_client_raises() -> None:
    client = RegistryClient(base_url="", username="", password="")
    with pytest.raises(RegistrationError):
        await client.login()


def test_registration_endpoint_requires_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module.settings, "registry_password", "")
    agent_id = f"reg-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/agents",
            json={
                "id": agent_id,
                "name": "注册测试",
                "aic": "",
                "role": "partner",
                "transport": "openai-compatible",
            },
        )
        assert created.status_code == 201
        response = test_client.post(f"/api/agents/{agent_id}/registration", json={})
        assert response.status_code == 503
        assert "REGISTRY_API_URL" in response.json()["detail"]
        test_client.delete(f"/api/agents/{agent_id}")


def test_local_and_imported_identity_creation() -> None:
    local_id = f"local-{uuid.uuid4().hex[:8]}"
    imported_id = f"imported-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as test_client:
        local = test_client.post(
            "/api/agents",
            json={
                "id": local_id,
                "name": "本地智能体",
                "aic": "",
                "transport": "openai-compatible",
                "usage_mode": "both",
            },
        )
        assert local.status_code == 201
        assert local.json()["aic"] == ""
        assert local.json()["registration_status"] == "local"
        assert local.json()["usage_mode"] == "internal"

        imported = test_client.post(
            "/api/agents",
            json={
                "id": imported_id,
                "name": "可信智能体",
                "aic": "1.2.156.3088.0.7.8.9.2.ABCD",
                "transport": "openai-compatible",
                "usage_mode": "both",
            },
        )
        assert imported.status_code == 201
        assert imported.json()["registration_status"] == "imported"
        assert imported.json()["usage_mode"] == "both"
        test_client.delete(f"/api/agents/{local_id}")
        test_client.delete(f"/api/agents/{imported_id}")


def test_local_registration_submits_empty_aic_and_hosted_rpc(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_test_aip_runtime(monkeypatch)
    agent_id = f"submit-{uuid.uuid4().hex[:8]}"
    captured: dict = {}

    class FakeRegistryClient:
        def configured(self) -> bool:
            return True

        async def save_agent(self, name: str, version: str, description: str, acs: dict) -> str:
            captured["acs"] = acs
            return "registry-local-1"

        async def submit(self, registration_agent_id: str) -> None:
            captured["submitted"] = registration_agent_id

    monkeypatch.setattr(main_module, "RegistryClient", FakeRegistryClient)
    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/agents",
            json={
                "id": agent_id,
                "name": "提交测试",
                "aic": "",
                "transport": "openai-compatible",
            },
        )
        assert created.status_code == 201
        submitted = test_client.post(f"/api/agents/{agent_id}/registration", json={})
        assert submitted.status_code == 200
        assert submitted.json()["registration_status"] == "pending"
        assert captured["acs"]["aic"] == ""
        assert captured["acs"]["securitySchemes"]["mtls"]["type"] == "mutualTLS"
        assert captured["acs"]["endPoints"][0]["security"] == [{"mtls": []}]
        assert captured["acs"]["endPoints"][0]["url"] == f"https://aip.example.com:8443/aip/{agent_id}/rpc"
        assert captured["acs"]["certificate"]["altNames"]["dns"] == ["aip.example.com"]
        assert captured["submitted"] == "registry-local-1"
        test_client.delete(f"/api/agents/{agent_id}")


@pytest.mark.parametrize("upstream,expected", [(400, 422), (422, 422), (409, 409), (403, 503), (429, 503), (502, 502)])
async def test_registry_rejection_keeps_actionable_status(upstream, expected):
    def handler(request):
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"accessToken": "test-token"})
        return httpx.Response(upstream, json={"detail": "endPoint must use mutualTLS security scheme"})
    with pytest.raises(RegistrationError) as error:
        await make_client(handler).submit("draft-1")
    assert error.value.status_code == expected
    assert "mutualTLS" in str(error.value) and "双向证书" in str(error.value)


@pytest.mark.parametrize("endpoint,schemes", [
    ({"url": "http://agent.example/rpc", "transport": "JSONRPC", "security": [{"mtls": []}]}, {"mtls": {"type": "mutualTLS"}}),
    ({"url": "https://agent.example/rpc", "transport": "JSONRPC"}, {}),
    ({"url": "https://agent.example/rpc", "transport": "JSONRPC", "security": [{"mtls": []}]}, {"mtls": {"type": "apiKey"}}),
])
def test_registration_preflight_rejects_insecure_declarations(endpoint, schemes):
    with pytest.raises(RegistrationError) as error:
        validate_registration_acs({"endPoints": [endpoint], "securitySchemes": schemes})
    assert error.value.status_code == 422


def test_registration_endpoint_preserves_draft_on_rejected_submission(db, monkeypatch):
    import asyncio
    from starlette.requests import Request
    from app.schemas import RegistrationRequest
    enable_test_aip_runtime(monkeypatch)
    agent = Agent(id="discovery", aic="local:discovery", name="发现助手", transport="provider", security_schemes=[])
    db.add(agent); db.commit()

    class FakeRegistry:
        def configured(self): return True
        async def save_agent(self, *args): return "saved-draft"
        async def submit(self, _id): raise RegistrationError("注册服务返回 400：需要补充技能", 422)

    monkeypatch.setattr(main_module, "RegistryClient", FakeRegistry)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        asyncio.run(main_module.register_agent(agent.id, RegistrationRequest(), Request({"type": "http"}), db))
    assert error.value.status_code == 422
    assert agent.registration_agent_id == "saved-draft"
    assert "需要补充技能" in agent.registration_message
    assert agent.aic == "local:discovery"


async def test_registry_html_error_does_not_leak_gateway_page():
    def handler(request):
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"accessToken": "test-token"})
        return httpx.Response(502, text="<html>private gateway diagnostics</html>")
    with pytest.raises(RegistrationError) as error:
        await make_client(handler).submit("draft-1")
    assert error.value.status_code == 502
    assert "private" not in str(error.value)


def test_approved_sync_reads_official_status_and_persists_aic(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_id = f"sync-{uuid.uuid4().hex[:8]}"
    assigned_aic = "1.2.156.3088.0.7.8.9.3.ABCD"

    class FakeRegistryClient:
        async def detail(self, registration_agent_id: str) -> dict:
            assert registration_agent_id == "registry-sync-1"
            return {
                "approval_status": "APPROVED",
                "acs": {"aic": assigned_aic},
                "comments": "审核通过",
            }

        @staticmethod
        def map_status(status: str) -> str:
            return RegistryClient.map_status(status)

    monkeypatch.setattr(main_module, "RegistryClient", FakeRegistryClient)
    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/agents",
            json={"id": agent_id, "name": "同步测试", "aic": "", "transport": "openai-compatible"},
        )
        assert created.status_code == 201
        with SessionLocal() as db:
            agent = db.get(Agent, agent_id)
            assert agent is not None
            agent.registration_agent_id = "registry-sync-1"
            agent.registration_status = "pending"
            db.commit()
        synced = test_client.post(f"/api/agents/{agent_id}/registration/sync")
        assert synced.status_code == 200
        assert synced.json()["registration_status"] == "approved"
        assert synced.json()["aic"] == assigned_aic
        test_client.delete(f"/api/agents/{agent_id}")


def test_stream_requires_verified_peer_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    enable_test_aip_runtime(monkeypatch)
    agent_id = f"stream-id-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/agents",
            json={
                "id": agent_id,
                "name": "流式鉴权",
                "aic": "1.2.156.3088.0.8.9.1.2.ABCD",
                "role": "partner",
                "transport": "openai-compatible",
            },
        )
        assert created.status_code == 201
        command = {
            "id": "cmd-1",
            "sentAt": "2026-09-13T00:00:00+00:00",
            "senderRole": "leader",
            "senderId": "1.2.156.3088.0.1.2.3.4.ABCD",
            "sessionId": "ses",
            "command": "start",
            "taskId": "task-idcheck",
            "dataItems": [{"type": "text", "text": "任务"}],
        }
        response = test_client.post(
            f"/aip/{agent_id}/stream",
            json={"jsonrpc": "2.0", "method": "stream", "id": "1", "params": {"message": command}},
        )
        assert response.status_code == 401
        test_client.delete(f"/api/agents/{agent_id}")


def test_registration_uses_server_credentials_and_skills(monkeypatch) -> None:
    enable_test_aip_runtime(monkeypatch)
    agent_id = f"reg-custom-{uuid.uuid4().hex[:8]}"
    client_instances: list[dict] = []

    class MockCustomRegistryClient:
        def __init__(self, username=None, password=None, **kwargs):
            client_instances.append({"username": username, "password": password})

        def configured(self) -> bool:
            return True

        async def save_agent(self, name, version, description, acs_dict):
            return "reg-custom-id"

        async def submit(self, registration_id):
            return None

        async def detail(self, registration_id):
            return {"status": "PENDING"}

        @classmethod
        def map_status(cls, raw):
            return "pending"

    monkeypatch.setattr(main_module, "RegistryClient", MockCustomRegistryClient)

    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/agents",
            json={
                "id": agent_id,
                "name": "富技能智能体",
                "aic": "",
                "transport": "openai-compatible",
                "skills": [
                    {
                        "id": "skill-market",
                        "name": "市场研报",
                        "version": "2.1.0",
                        "description": "深入的市场行情监测与研究报告撰写",
                        "tags": ["研报", "金融"],
                        "examples": ["生成光伏研报"],
                        "input_modes": ["text/plain"],
                        "output_modes": ["text/markdown"],
                    }
                ],
            },
        )
        assert created.status_code == 201

        # Check ACS preview export has rich skill info
        orig_auth = settings.admin_auth_enabled
        settings.admin_auth_enabled = False
        try:
            preview = test_client.get(f"/api/agents/{agent_id}/acs-preview")
            assert preview.status_code == 200
            acs_skills = preview.json().get("acs", {}).get("skills", [])
            assert len(acs_skills) == 1
            assert acs_skills[0]["id"] == "skill-market"
            assert acs_skills[0]["name"] == "市场研报"
            assert acs_skills[0]["version"] == "2.1.0"
            assert acs_skills[0]["description"] == "深入的市场行情监测与研究报告撰写"
            assert acs_skills[0]["tags"] == ["研报", "金融"]
            assert acs_skills[0]["examples"] == ["生成光伏研报"]
            assert acs_skills[0]["inputModes"] == ["text/plain"]
            assert acs_skills[0]["outputModes"] == ["text/markdown"]
        finally:
            settings.admin_auth_enabled = orig_auth

        # Browser submissions cannot override the server-side registry credentials.
        reg = test_client.post(
            f"/api/agents/{agent_id}/registration",
            json={"rpc_url": "https://test.agent/rpc"},
        )
        assert reg.status_code == 200
        assert len(client_instances) == 1
        assert client_instances[0]["username"] is None
        assert client_instances[0]["password"] is None

        test_client.delete(f"/api/agents/{agent_id}")
