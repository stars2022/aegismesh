import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.config import get_settings
from app.models import Agent
from app.service_catalog import apply_service_catalog

spec = importlib.util.spec_from_file_location("service_provisioning", Path(__file__).parents[2] / "scripts/provision_service_agents.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


@pytest.fixture
def registration(db, monkeypatch):
    apply_service_catalog(db)
    settings = get_settings()
    monkeypatch.setattr(settings, "aip_agent_public_urls", {"travel_coordinator": "https://aip.example:8450"})
    agent = db.get(Agent, "travel_coordinator")
    return agent, provision.checked_acs(agent)


def test_old_identity_is_not_a_provisioning_target(db):
    with pytest.raises(ValueError, match="non-catalog"):
        provision.checked_acs(Agent(id="research_leader"))


async def test_draft_id_is_saved_before_submit_failure(db, registration):
    from app.services.registration import RegistrationError
    agent, acs = registration
    client = AsyncMock()
    client._request.return_value = {"items": []}
    client.save_agent.return_value = "new-reg-id"
    client.detail.return_value = {"acs": acs, "approval_status": "DRAFT"}
    client.submit.side_effect = RegistrationError("temporary upstream timeout")
    with pytest.raises(RegistrationError):
        await provision.submit_one(db, client, agent, acs)
    db.expire_all()
    assert db.get(Agent, agent.id).registration_agent_id == "new-reg-id"
    client.update_agent.assert_awaited_once()


async def test_lost_creation_response_recovers_matching_pending_draft(db, registration):
    agent, acs = registration
    client = AsyncMock()
    client._request.return_value = {"items": [{"id": "existing-draft", "name": agent.name}]}
    client.detail.return_value = {"acs": acs, "approval_status": "PENDING"}
    await provision.submit_one(db, client, agent, acs)
    assert agent.registration_agent_id == "existing-draft"
    assert agent.registration_status == "pending"
    client.save_agent.assert_not_called()
    client.submit.assert_not_called()
    client.update_agent.assert_not_called()


async def test_existing_approved_identity_is_only_read(db, registration):
    agent, acs = registration
    agent.registration_agent_id = "existing-approved"
    aic = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"
    client = AsyncMock()
    client.detail.return_value = {"acs": acs, "approval_status": "APPROVED", "aic": aic}
    await provision.submit_one(db, client, agent, acs)
    assert agent.aic == aic
    client.save_agent.assert_not_called()
    client.submit.assert_not_called()
    client.update_agent.assert_not_called()
    client.cancel.assert_not_called()


async def test_same_name_but_other_endpoint_is_not_adopted(db, registration):
    agent, acs = registration
    client = AsyncMock()
    client._request.return_value = {"items": [{"id": "unrelated", "name": agent.name}]}
    client.detail.return_value = {"acs": {**acs, "endPoints": []}, "approval_status": "DRAFT"}
    with pytest.raises(ValueError, match="endpoint differs"):
        await provision.submit_one(db, client, agent, acs)
    assert not agent.registration_agent_id
    client.submit.assert_not_called()
    client.save_agent.assert_not_called()
