from copy import deepcopy

from sqlalchemy import select

from app.models import Agent
from app.service_catalog import SERVICE_AGENT_CATALOG, apply_service_catalog
from app.seed import seed_database
from app.services.acs import build_acs


def test_eight_distinct_capabilities_with_two_coordinators(db):
    created = apply_service_catalog(db)
    agents = db.scalars(select(Agent)).all()
    assert len(created) == len(agents) == 8
    assert sum(a.role == "leader" for a in agents) == 2
    assert sum(a.role == "partner" for a in agents) == 6
    assert all(a.usage_mode == "internal" and a.aic.startswith("local:") for a in agents)
    skills = [s["id"] for a in agents for s in a.skills]
    assert len(skills) == len(set(skills))
    for agent in agents:
        assert "web_search" in agent.tools
        assert "不能编造" in agent.system_prompt
        acs = build_acs(agent, f"https://aip.example:8450/aip/{agent.id}/rpc")
        assert acs["aic"] == ""
        assert acs["certificate"]["altNames"]["dns"] == ["aip.example"]
        assert acs["skills"]


def test_coordinators_discover_globally_without_fixed_team_ids():
    for definition in SERVICE_AGENT_CATALOG.values():
        if definition["role"] != "leader":
            continue
        prompt = definition["system_prompt"]
        assert "list_agents" in prompt and "scope=all" in prompt
        assert "质量评分" in prompt and "不绑定固定成员" in prompt
        assert all(agent_id not in prompt for agent_id in SERVICE_AGENT_CATALOG)


def test_additive_seed_preserves_all_existing_identity_scores_and_customization(db):
    seed_database(db)
    agent = db.get(Agent, "travel_coordinator")
    agent.aic = "1.2.156.3088.APPROVED.TRAVEL"
    agent.registration_status = "approved"
    agent.registration_agent_id = "existing-registry-id"
    agent.name = "管理员定制名称"
    agent.system_prompt = "管理员定制提示词"
    agent.active = False
    agent.success_count = 42
    agent.feedback_positive_count = 17
    agent.model_name = "custom-model"
    db.commit()
    before = {a.id: {column.key: deepcopy(getattr(a, column.key)) for column in Agent.__table__.columns}
              for a in db.scalars(select(Agent)).all()}
    assert apply_service_catalog(db) == []
    db.commit()
    after = {a.id: {column.key: deepcopy(getattr(a, column.key)) for column in Agent.__table__.columns}
             for a in db.scalars(select(Agent)).all()}
    assert before == after


def test_new_group_agent_declares_literal_aic_template_before_approval(db, monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "aip_group_partner_enabled", True)
    monkeypatch.setattr(settings, "aip_group_partner_agent_id", "")
    monkeypatch.setattr(settings, "aip_group_mq_host", "mq.example")
    apply_service_catalog(db)
    agent = db.get(Agent, "travel_coordinator")
    acs = build_acs(agent, "https://aip.example:8450/aip/travel_coordinator/rpc")
    assert acs["aic"] == ""
    assert acs["capabilities"]["messageQueue"] == ["amqp:0.9.1"]
    endpoint = next(e for e in acs["endPoints"] if e["transport"] == "AMQP")
    assert endpoint["url"].endswith("?inbox=inbox_{AIC}")
    assert endpoint["security"] == [{"mtls": []}]
    assert "%7B" not in endpoint["url"]
    agent.aic = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"
    agent.registration_status = "approved"
    updated = build_acs(agent, "https://aip.example:8450/aip/travel_coordinator/rpc")
    endpoint = next(e for e in updated["endPoints"] if e["transport"] == "AMQP")
    assert endpoint["url"].endswith(f"inbox_{agent.aic}")


def test_tls_worker_does_not_spawn_background_jobs(monkeypatch):
    from fastapi.testclient import TestClient
    from unittest.mock import AsyncMock, Mock
    import importlib
    main = importlib.import_module("app.main")
    monkeypatch.setattr(main.settings, "background_worker_enabled", False)
    probes = AsyncMock()
    heartbeat = AsyncMock()
    listener = AsyncMock()
    seed = Mock()
    monkeypatch.setattr(main, "probe_loop", probes)
    monkeypatch.setattr(main.amp_service, "start", heartbeat)
    monkeypatch.setattr(main, "start_partner_listener", listener)
    monkeypatch.setattr(main, "seed_database", seed)
    with TestClient(main.app) as client:
        assert client.get("/api/health").status_code == 200
    probes.assert_not_called()
    heartbeat.assert_not_called()
    listener.assert_not_called()
    seed.assert_not_called()
