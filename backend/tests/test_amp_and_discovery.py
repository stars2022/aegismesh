from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import Agent
from app.services.amp_service import AmpService


def client() -> TestClient:
    return TestClient(app)


@pytest.mark.asyncio
async def test_amp_service_writes_standard_ndjson_records():
    with tempfile.TemporaryDirectory() as tmpdir:
        amp = AmpService(log_dir=tmpdir, aic="1.2.156.3088.1.BUPT.TEST.01")
        
        # Test heartbeat
        await amp._heartbeat_emitter.emit()
        hb_file = Path(tmpdir) / "amp_heartbeat_aegismesh.jsonl"
        assert hb_file.exists()
        hb_lines = [json.loads(line) for line in hb_file.read_text().splitlines() if line.strip()]
        assert len(hb_lines) >= 1
        assert hb_lines[0]["log_type"] == "heartbeat"
        assert hb_lines[0]["aic"] == "1.2.156.3088.1.BUPT.TEST.01"

        # Test access record with correlationId = taskId (Official ranking requirement)
        await amp.record_access(
            caller_aic="1.2.156.3088.1.BUPT.CALLER.01",
            callee_aic="1.2.156.3088.1.BUPT.TEST.01",
            task_id="task-ranking-check-999",
            duration_ms=250,
            status_code=200,
            session_id="session-xyz",
        )
        access_file = Path(tmpdir) / "amp_access_aegismesh.jsonl"
        assert access_file.exists()
        access_lines = [json.loads(line) for line in access_file.read_text().splitlines() if line.strip()]
        assert len(access_lines) >= 1
        record = access_lines[0]
        assert record["log_type"] == "access"
        assert record["correlation_id"] == "task-ranking-check-999"
        assert record["body"]["durationMs"] == 250.0
        assert record["body"]["response"]["statusCode"] == 200
        assert record["body"]["caller"]["aic"] == "1.2.156.3088.1.BUPT.CALLER.01"
        assert record["body"]["callee"]["aic"] == "1.2.156.3088.1.BUPT.TEST.01"


def test_get_agents_accessible_for_chat_demo():
    with client() as test_client:
        # GET /api/agents should be accessible (require_demo_or_admin) without requiring admin login
        response = test_client.get("/api/agents")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


def test_discovery_import_flow():
    with client() as test_client:
        # Create admin login to test admin import
        admin_login = test_client.post(
            "/api/admin/login",
            json={"username": "admin", "password": "InitialAdminPassword123!"},
        )
        import secrets
        suffix = secrets.token_hex(2).upper()
        aic_to_import = f"1.2.156.3088.1.BUPT.TEST.ABCD.EFGH.{suffix}"
        payload = {
            "aic": aic_to_import,
            "name": "测试外部文献综述Agent",
            "description": "通过发现服务检索到的外部学术分析助手",
            "endpoint": "https://external-agent.example.com/rpc",
            "transport": "aip",
            "skills": [
                {"id": "ext.search", "name": "文献分析", "description": "分析文献", "tags": ["search"]}
            ],
        }

        # Clear existing agent if any
        with SessionLocal() as db:
            existing = db.query(Agent).filter(Agent.aic == aic_to_import).first()
            if existing:
                db.delete(existing)
                db.commit()

        response = test_client.post("/api/discovery/import", json=payload)
        assert response.status_code == 201
        created = response.json()
        assert created["aic"] == aic_to_import
        assert created["role"] == "partner"
        assert created["registration_status"] == "imported"
        assert created["name"] == "测试外部文献综述Agent"

        # Duplicate import should return 409
        dup_response = test_client.post("/api/discovery/import", json=payload)
        assert dup_response.status_code == 409


def test_discovery_feed_endpoint(monkeypatch):
    from unittest.mock import AsyncMock
    from app.services.discovery import AdpDiscoveryClient

    mock_discover = AsyncMock(return_value={
        "acsMap": {
            "1.2.156.3088.1.BUPT.TEST.EXT.01": {
                "name": "全网测试Agent",
                "description": "测试ADP全网发现流",
                "provider": {"organization": "测试组织"},
                "endPoints": [{"url": "https://ext.example.com/api", "transport": "HTTP_JSON"}],
                "skills": [{"id": "test.skill", "name": "测试技能"}],
            }
        }
    })
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock_discover)

    with client() as test_client:
        response = test_client.get("/api/discovery/feed?refresh=true")
        assert response.status_code == 200
        items = response.json()
        assert len(items) == 1
        assert items[0]["aic"] == "1.2.156.3088.1.BUPT.TEST.EXT.01"
        assert items[0]["name"] == "全网测试Agent"
        assert items[0]["organization"] == "测试组织"
        assert items[0]["is_external"] is True
