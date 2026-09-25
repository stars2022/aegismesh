from __future__ import annotations

from ..config import get_settings
from ..models import Agent


LOCAL_AIC_PREFIX = "local:"


def inbound_notification_ready() -> bool:
    """Hosted notification is only true when the mTLS listener can actually accept it."""
    settings = get_settings()
    return bool(
        settings.aip_identity_binding_enabled
        and settings.aip_tls_certfile
        and settings.aip_tls_keyfile
        and settings.aip_tls_client_ca_file
        and settings.aip_tls_port
        and str(settings.public_base_url).startswith("https://")
    )


def public_aic(agent: Agent) -> str:
    return "" if (agent.aic or "").startswith(LOCAL_AIC_PREFIX) else (agent.aic or "")


def build_acs(agent: Agent, rpc_url: str | None) -> dict:
    security_schemes: dict = {}
    endpoint_security: list[dict[str, list[str]]] = []
    if "mtls" in (agent.security_schemes or []):
        security_schemes["mtls"] = {
            "type": "mutualTLS",
            "description": "ACPs 双向身份认证",
        }
        endpoint_security.append({"mtls": []})

    hosted = agent.transport != "aip-rpc"
    payload = {
        "aic": public_aic(agent),
        "active": agent.active,
        "lastModifiedTime": agent.updated_at.isoformat(),
        "protocolVersion": "02.02",
        "name": agent.name,
        "description": agent.description,
        "version": "1.0.0",
        "provider": {"countryCode": "CN", "organization": "AegisMesh Workspace"},
        "securitySchemes": security_schemes,
        "endPoints": [
            {
                "url": rpc_url,
                "transport": "JSONRPC",
                "security": endpoint_security or None,
            }
        ] if rpc_url else [],
        "capabilities": {
            "streaming": bool(agent.streaming_enabled),
            "notification": hosted and inbound_notification_ready(),
            "messageQueue": [],
        },
        "defaultInputModes": agent.input_modes or ["text/plain"],
        "defaultOutputModes": agent.output_modes or ["application/json"],
        "skills": [
            {
                "id": skill.get("id") or "general",
                "name": skill.get("name") or "通用能力",
                "description": skill.get("description") or agent.description or "核心业务能力",
                "version": skill.get("version") or "1.0.0",
                "tags": skill.get("tags") or [],
                "examples": skill.get("examples") or [],
                "inputModes": skill.get("input_modes") or skill.get("inputModes") or agent.input_modes or ["text/plain"],
                "outputModes": skill.get("output_modes") or skill.get("outputModes") or agent.output_modes or ["application/json"],
            }
            for skill in (agent.skills or [])
        ] or [
            {
                "id": "general",
                "name": agent.name or "通用能力",
                "description": agent.description or "核心业务能力",
                "version": "1.0.0",
                "tags": ["通用"],
                "examples": [],
                "inputModes": agent.input_modes or ["text/plain"],
                "outputModes": agent.output_modes or ["application/json"],
            }
        ],
        "entityMeta": {
            "platform": "AegisMesh",
            "role": agent.role,
            "modelProvider": agent.model_provider,
            "model": agent.model_name,
            "tools": agent.tools,
        },
    }
    from acps_sdk.acs import AgentCapabilitySpec

    return AgentCapabilitySpec.model_validate(payload).model_dump(
        by_alias=True, exclude_none=True, mode="json"
    )
