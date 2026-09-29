from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.config import get_settings
from app.models import Agent, utcnow


spec = importlib.util.spec_from_file_location(
    "reapply_research_agents", Path(__file__).resolve().parents[2] / "scripts/reapply_research_agents.py")
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)
OLD_AIC = "1.2.156.3088.1.BUPT.L2K8YU.GVNLWG.B3FPY7.15VB"
NEW_AIC = "1.2.156.3088.1.BUPT.L2K8YU.C807FX.4WK6NH.12WQ"


@pytest.fixture
def entry(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "aip_group_partner_enabled", True)
    monkeypatch.setattr(settings, "aip_group_partner_agent_id", "")
    monkeypatch.setattr(settings, "aip_group_mq_host", "wt.ioa.pub")
    original = Agent(id="docs_overview", name="文献检索与知识综述智能体", role="partner",
                     aic=OLD_AIC, registration_agent_id="old-record", registration_status="approved",
                     transport="openai-compatible", description="检索与综述", active=True,
                     group_enabled=False, security_schemes=[], input_modes=["text/plain"],
                     output_modes=["text/plain"], tools=["web_search"], skills=[],
                     streaming_enabled=True, model_provider="test", model_name="test", updated_at=utcnow())
    acs = workflow.replacement_acs(original)
    assert original.aic == OLD_AIC and original.registration_agent_id == "old-record"
    assert original.registration_status == "approved" and original.group_enabled is False
    assert original.security_schemes == []
    return {"id": original.id, "port": 8459, "acs": acs,
            "previous": {"aic": OLD_AIC, "registrationId": "old-record"},
            "registrationId": "", "aic": "", "status": "not_submitted"}


def remote(entry, status="DRAFT"):
    acs = copy.deepcopy(entry["acs"])
    aic = NEW_AIC if status == "APPROVED" else ""
    acs["aic"] = aic
    if aic:
        acs = json.loads(json.dumps(acs).replace("{AIC}", aic))
    return {"id": "new-record", "aic": aic, "acs": acs, "approval_status": status}


def test_replacement_has_new_identity_mtls_san_and_own_port(entry):
    acs = entry["acs"]
    assert acs["aic"] == "" and acs["version"] == "2.0.0"
    assert acs["certificate"]["altNames"]["dns"] == [workflow.HOST]
    assert acs["endPoints"][0]["url"] == "https://aip.demmo.cc.cd:8459/aip/docs_overview/rpc"
    assert any("inbox_{AIC}" in e["url"] for e in acs["endPoints"])
    assert all(e["security"] == [{"mtls": []}] for e in acs["endPoints"])


def test_other_agents_cannot_be_reapplied():
    with pytest.raises(ValueError, match="four hosted research"):
        workflow.replacement_acs(Agent(id="news_coordinator"))


def test_missing_mq_blocks_submission(entry, monkeypatch):
    monkeypatch.setattr(get_settings(), "aip_group_partner_enabled", False)
    with pytest.raises(ValueError, match="MQ configuration"):
        workflow.replacement_acs(Agent(id="docs_overview", name="test", transport="openai-compatible",
                                      description="test", active=True, role="partner", streaming_enabled=False,
                                      model_name="", model_provider="", tools=[], skills=[],
                                      input_modes=["text/plain"], output_modes=["text/plain"]))


@pytest.mark.parametrize("status", ["DRAFT", "PENDING", "APPROVED"])
def test_remote_validation_supports_aic_substitution(entry, status):
    workflow.validate_replacement(entry, remote(entry, status))


@pytest.mark.parametrize("field", ["name", "version", "certificate", "endPoints"])
def test_identity_mismatch_stops_instead_of_recreating(entry, field):
    detail = remote(entry)
    detail["acs"][field] = None
    with pytest.raises(ValueError, match=f"differs in {field}"):
        workflow.validate_replacement(entry, detail)


def test_old_identity_is_never_adopted(entry):
    detail = remote(entry, "APPROVED")
    detail["aic"] = OLD_AIC
    with pytest.raises(ValueError, match="old identity"):
        workflow.validate_replacement(entry, detail)


async def test_creation_checkpoints_id_before_submit_and_retry_is_idempotent(entry, tmp_path):
    path = tmp_path / "state.json"
    state = {"agents": [entry]}
    detail = remote(entry)
    client = SimpleNamespace(_request=AsyncMock(return_value={"items": [], "total": 0}),
                             save_agent=AsyncMock(return_value="new-record"), detail=AsyncMock(side_effect=lambda _: detail))
    async def submit(reg_id):
        assert reg_id == "new-record"
        assert json.loads(path.read_text())["agents"][0]["registrationId"] == reg_id
        detail["approval_status"] = "PENDING"
    client.submit = AsyncMock(side_effect=submit)
    await workflow.submit_one(path, state, entry, client)
    await workflow.submit_one(path, state, entry, client)
    client.save_agent.assert_awaited_once()
    client.submit.assert_awaited_once()
    assert entry["status"] == "pending"


async def test_lost_create_response_recovers_matching_draft(entry, tmp_path):
    detail = remote(entry, "PENDING")
    client = SimpleNamespace(_request=AsyncMock(return_value={"items": [{"id": "new-record", "name": entry["acs"]["name"]}], "total": 1}),
                             detail=AsyncMock(return_value=detail), save_agent=AsyncMock(), submit=AsyncMock())
    await workflow.submit_one(tmp_path / "state.json", {"agents": [entry]}, entry, client)
    assert entry["registrationId"] == "new-record"
    client.save_agent.assert_not_awaited()
    client.submit.assert_not_awaited()


async def test_rejected_registration_is_not_resubmitted(entry, tmp_path):
    entry["registrationId"] = "new-record"
    client = SimpleNamespace(detail=AsyncMock(return_value=remote(entry, "REJECTED")), submit=AsyncMock())
    with pytest.raises(ValueError, match="requires review"):
        await workflow.submit_one(tmp_path / "state.json", {"agents": [entry]}, entry, client)
    client.submit.assert_not_awaited()


def test_manifest_is_private_and_cannot_be_overwritten_on_prepare(tmp_path):
    path = tmp_path / "state.json"
    workflow.persist(path, {"old": 1}, create=True)
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        workflow.persist(path, {"new": 2}, create=True)
    assert json.loads(path.read_text()) == {"old": 1}
