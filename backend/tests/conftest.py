from __future__ import annotations

import os
import tempfile

# TestClient 的请求运行在独立线程，:memory: SQLite 每线程独立建库会导致表缺失，改用临时文件库。
_test_dir = tempfile.mkdtemp(prefix="aegismesh-tests-")
os.environ["DATABASE_URL"] = f"sqlite:///{_test_dir}/test.db"
os.environ["ADMIN_AUTH_ENABLED"] = "true"
os.environ["ADMIN_SESSION_SECRET"] = "test-admin-session-secret-not-for-production"
os.environ["PUBLIC_API_KEY"] = "test-public-api-key-123456"
os.environ["LOG_INDEXER_ENABLED"] = "false"

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.main import app, require_admin

# Most tests exercise protected business handlers rather than administrator login.
# Authentication-specific tests call the guard directly or temporarily remove this override.
app.dependency_overrides[require_admin] = lambda: None


@pytest.fixture
def db() -> Session:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture
def registered_directory(db, monkeypatch):
    """Explicit directory fixture for delegation tests (never an application fallback)."""
    from unittest.mock import AsyncMock
    from sqlalchemy import select
    from app.models import Agent
    from app.services.discovery import AdpDiscoveryClient

    async def discover(*args, **kwargs):
        agents = db.scalars(select(Agent)).all()
        return {
            "acsMap": {a.aic: {
                "name": a.name, "description": a.description, "skills": a.skills or [],
                "defaultInputModes": a.input_modes, "defaultOutputModes": a.output_modes,
                "endPoints": [{"transport": "JSONRPC", "url": a.endpoint_url or "https://fixture.example/rpc"}],
            } for a in agents},
            "aliveMap": {a.aic: {"alive": a.health != "offline"} for a in agents},
        }

    mock = AsyncMock(side_effect=discover)
    monkeypatch.setattr(AdpDiscoveryClient, "discover", mock)
    return mock
