from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import AgentCreate, AgentUpdate

VALID_AIC = "1.2.156.3088.0.1.2.3.4.ABCD"


def payload(**overrides: object) -> dict:
    base: dict = {
        "id": "research-lead",
        "name": "研究协调器",
        "aic": VALID_AIC,
        "role": "partner",
        "transport": "aip-rpc",
        "endpoint_url": "https://agent.example.com/rpc",
    }
    base.update(overrides)
    return base


def test_valid_payload_passes() -> None:
    agent = AgentCreate(**payload())
    assert agent.id == "research-lead"


def test_rejects_blank_name() -> None:
    with pytest.raises(ValidationError):
        AgentCreate(**payload(name="  "))


def test_rejects_invalid_id() -> None:
    for bad_id in ["", "bad id", "中文标识", "x" * 65]:
        with pytest.raises(ValidationError):
            AgentCreate(**payload(id=bad_id))


def test_rejects_invalid_aic() -> None:
    for bad_aic in ["not-an-aic", "1.2.156.3088.0.1.2.3.4"]:
        with pytest.raises(ValidationError):
            AgentCreate(**payload(aic=bad_aic))


def test_allows_empty_aic_for_local_agent() -> None:
    assert AgentCreate(**payload(aic="")).aic == ""


def test_requires_endpoint_for_aip_rpc() -> None:
    with pytest.raises(ValidationError):
        AgentCreate(**payload(endpoint_url=""))


def test_rejects_non_http_endpoint() -> None:
    with pytest.raises(ValidationError):
        AgentCreate(**payload(endpoint_url="ftp://agent.example.com/rpc"))


def test_requires_provider_for_hosted_transport() -> None:
    with pytest.raises(ValidationError):
        AgentCreate(**payload(transport="provider", model_provider=""))


def test_create_payload_persists_system_prompt() -> None:
    agent = AgentCreate(**payload(system_prompt="你是研究协调器"))
    assert agent.system_prompt == "你是研究协调器"
    assert agent.model_dump()["system_prompt"] == "你是研究协调器"


def test_update_rejects_bad_endpoint_url() -> None:
    with pytest.raises(ValidationError):
        AgentUpdate(endpoint_url="not-a-url")
    assert AgentUpdate(endpoint_url="https://agent.example.com/rpc").endpoint_url
