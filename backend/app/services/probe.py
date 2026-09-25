from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Agent, ProbeResult, ProviderConfig
from .acs import build_acs


@dataclass(slots=True)
class Analysis:
    status: str
    latency_ms: float | None
    acs_valid: bool
    aip_reachable: bool | None
    compatibility_score: float
    findings: list[dict]
    snapshot: dict


class AgentProbe:
    """Read-only ACPs compatibility and reachability probe."""

    async def analyze(self, agent: Agent, provider: ProviderConfig | None = None) -> Analysis:
        findings: list[dict] = []
        score = 0.0

        if agent.aic:
            score += 15
        else:
            findings.append(self._finding("error", "AIC_MISSING", "缺少 AIC"))
        if agent.skills:
            score += 25
        else:
            findings.append(self._finding("error", "SKILL_MISSING", "未声明技能"))
        if agent.input_modes and agent.output_modes:
            score += 20
        else:
            findings.append(self._finding("warning", "MODE_INCOMPLETE", "输入输出模式不完整"))
        if agent.security_schemes:
            score += 15
        else:
            findings.append(self._finding("warning", "SECURITY_MISSING", "未声明安全方案"))

        if agent.transport in {"provider", "openai-compatible", "openai-responses", "anthropic"}:
            hosted_acs = build_acs(agent, f"http://platform.local/aip/{agent.id}/rpc")
            valid, validation_note = self._validate_acs(hosted_acs)
            if valid:
                score += 25
            else:
                findings.append(self._finding("error", "ACS_INVALID", validation_note))
            if agent.transport == "provider":
                key_configured = bool(
                    provider
                    and provider.active
                    and (provider.api_key_ciphertext or provider.api_key_env)
                )
                configured = bool(key_configured and (agent.model_name or provider.default_model))
            else:
                settings = get_settings()
                key_configured = {
                    "openai-compatible": bool(settings.llm_api_key),
                    "openai-responses": bool(settings.openai_api_key),
                    "anthropic": bool(settings.anthropic_api_key),
                }[agent.transport]
                configured = bool(key_configured and agent.model_name)
            if not configured:
                findings.append(
                    self._finding("warning", "MODEL_NOT_CONFIGURED", "模型服务配置不完整")
                )
            return Analysis(
                status="healthy" if valid and configured else "degraded",
                latency_ms=None,
                acs_valid=valid,
                aip_reachable=True,
                compatibility_score=round(score, 1),
                findings=findings,
                snapshot=hosted_acs,
            )

        if agent.transport != "aip-rpc" or not agent.endpoint_url:
            findings.append(self._finding("error", "ENDPOINT_MISSING", "缺少 AIP RPC 端点"))
            return Analysis("unhealthy", None, False, False, round(score, 1), findings, {})

        acs_url = self._acs_url(agent.endpoint_url)
        started = time.monotonic()
        remote_acs: dict = {}
        reachable = False
        valid = False
        settings = get_settings()

        client_kwargs: dict[str, Any] = {"timeout": 4, "follow_redirects": True}
        if agent.endpoint_url.startswith("https://"):
            client_kwargs["verify"] = False
            if (
                "mtls" in (agent.security_schemes or [])
                or ":8443" in agent.endpoint_url
            ) and settings.aip_cert_file and settings.aip_key_file:
                if os.path.exists(settings.aip_cert_file) and os.path.exists(settings.aip_key_file):
                    client_kwargs["cert"] = (settings.aip_cert_file, settings.aip_key_file)

        try:
            async with httpx.AsyncClient(**client_kwargs) as client:
                # 1. Probe reachability of the RPC endpoint
                try:
                    await client.post(
                        agent.endpoint_url,
                        json={"jsonrpc": "2.0", "method": "ping", "id": 1},
                    )
                    reachable = True
                except (httpx.HTTPStatusError, httpx.RequestError) as rpc_err:
                    if isinstance(rpc_err, httpx.HTTPStatusError) or getattr(rpc_err, "response", None) is not None:
                        reachable = True
                    else:
                        try:
                            await client.options(agent.endpoint_url)
                            reachable = True
                        except Exception:
                            pass

                # 2. Probe ACS metadata specification
                try:
                    acs_response = await client.get(acs_url)
                    if acs_response.status_code == 200:
                        remote_acs = acs_response.json()
                        valid, validation_note = self._validate_acs(remote_acs)
                        if valid:
                            score += 25
                        else:
                            findings.append(self._finding("warning", "ACS_INVALID", validation_note))
                        if remote_acs.get("aic") and remote_acs.get("aic") != agent.aic:
                            findings.append(self._finding("warning", "AIC_MISMATCH", "远端 ACS 与登记 AIC 不一致"))
                            score = max(0, score - 15)
                except Exception:
                    pass
        except Exception as exc:
            findings.append(self._finding("error", "PROBE_FAILED", str(exc)[:180]))

        if not valid and reachable:
            if agent.aic and agent.skills:
                valid = True
                score += 20
                findings.append(self._finding("info", "REGISTRY_METADATA_ACTIVE", "使用导入登记的元数据定义"))

        latency = round((time.monotonic() - started) * 1000, 2)
        if not reachable:
            findings.append(self._finding("error", "AIP_UNREACHABLE", "AIP RPC 端点不可达"))
        status = "healthy" if reachable and valid else ("degraded" if reachable else "unhealthy")
        return Analysis(status, latency, valid, reachable, round(score, 1), findings, remote_acs)

    async def run_for_agent(self, db: Session, agent: Agent) -> ProbeResult:
        provider = db.get(ProviderConfig, agent.model_provider) if agent.transport == "provider" else None
        analysis = await self.analyze(agent, provider)
        result = ProbeResult(
            agent_id=agent.id,
            status=analysis.status,
            latency_ms=analysis.latency_ms,
            acs_valid=analysis.acs_valid,
            aip_reachable=analysis.aip_reachable,
            compatibility_score=analysis.compatibility_score,
            findings=analysis.findings,
            snapshot=analysis.snapshot,
        )
        db.add(result)
        if agent.transport == "aip-rpc":
            agent.health = "online" if analysis.status in {"healthy", "degraded"} else "offline"
            if analysis.latency_ms is not None and analysis.aip_reachable:
                agent.avg_latency_ms = analysis.latency_ms
        elif agent.transport in {"provider", "openai-compatible", "openai-responses", "anthropic"}:
            agent.health = "online" if analysis.status == "healthy" else "degraded"
        db.commit()
        db.refresh(result)
        return result

    @staticmethod
    def _acs_url(endpoint: str) -> str:
        parts = urlsplit(endpoint)
        return urlunsplit((parts.scheme, parts.netloc, "/.well-known/acs.json", "", ""))

    @staticmethod
    def _validate_acs(payload: dict) -> tuple[bool, str]:
        try:
            from acps_sdk.acs import AgentCapabilitySpec

            AgentCapabilitySpec.model_validate(payload)
            return True, ""
        except Exception as exc:
            return False, str(exc)[:180]

    @staticmethod
    def _finding(level: str, code: str, message: str) -> dict:
        return {"level": level, "code": code, "message": message}

    @staticmethod
    def _snapshot(agent: Agent) -> dict:
        return {
            "aic": agent.aic,
            "protocolVersion": "02.02",
            "name": agent.name,
            "active": agent.active,
            "endPoints": [{"url": agent.endpoint_url, "transport": agent.transport}],
            "skills": agent.skills,
            "inputModes": agent.input_modes,
            "outputModes": agent.output_modes,
            "securitySchemes": agent.security_schemes,
        }


async def probe_loop(session_factory, interval_seconds: int) -> None:
    probe = AgentProbe()
    while True:
        try:
            with session_factory() as db:
                agents = list(db.scalars(select(Agent).where(Agent.active.is_(True))).all())
                for agent in agents:
                    await probe.run_for_agent(db, agent)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(max(10, interval_seconds))
