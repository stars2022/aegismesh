"""Provision only the eight additive service agents; never re-register old agents.

Default: read-only preview. Use --submit, --sync or --certificates explicitly.
Existing pending/approved registry records are read, never updated or cancelled.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from acps_sdk.aic import validate_aic_format

from app.config import get_settings
from app.database import SessionLocal
from app.models import Agent, utcnow
from app.service_catalog import SERVICE_AGENT_CATALOG
from app.services.acs import build_acs, public_aic
from app.services.aip_tls import public_aip_base, validate_agent_authorities
from app.services.certificates import CertificateError, issue_certificate, validate_certificate_files
from app.services.registration import RegistryClient, RegistrationError, validate_registration_acs


def checked_acs(agent: Agent) -> dict:
    settings = get_settings()
    if agent.id not in SERVICE_AGENT_CATALOG:
        raise ValueError("Refusing to modify an existing non-catalog identity")
    if agent.id not in settings.aip_agent_public_urls:
        raise ValueError(f"Missing independent TLS authority: {agent.id}")
    validate_agent_authorities(settings)
    base = public_aip_base(settings, agent.id)
    acs = build_acs(agent, f"{base}/aip/{agent.id}/rpc")
    validate_registration_acs(acs)
    if urlsplit(base).hostname not in acs.get("certificate", {}).get("altNames", {}).get("dns", []):
        raise ValueError("DNS SAN must be present before submitting immutable ACS")
    return acs


def validate_remote(detail: dict, expected: dict) -> None:
    acs = detail.get("acs") or {}
    if isinstance(acs, str):
        acs = json.loads(acs)
    expected_rpc = [e for e in expected["endPoints"] if e["transport"] == "JSONRPC"]
    actual_rpc = [e for e in acs.get("endPoints", []) if e["transport"] == "JSONRPC"]
    if actual_rpc != expected_rpc or acs.get("certificate") != expected.get("certificate"):
        raise ValueError("Registry identity/endpoint differs; inspect manually, do not recreate it")
    if acs.get("name") != expected["name"]:
        raise ValueError("Registry name differs; refusing to adopt unrelated agent")


def apply_status(db, agent: Agent, detail: dict) -> None:
    raw_status = detail.get("approval_status") or detail.get("approvalStatus") or detail.get("status")
    status = RegistryClient.map_status(raw_status)
    if status == "local":
        raise ValueError(f"Unknown registry status: {raw_status}")
    if status == "approved":
        aic = str(detail.get("aic") or "").strip().upper()
        if not validate_aic_format(aic)[0]:
            raise ValueError("Approved registry response lacks a valid AIC")
        if public_aic(agent) and agent.aic != aic:
            raise ValueError("Refusing to replace an existing AIC")
        agent.aic = aic
        agent.usage_mode = "both"
    agent.registration_status = status
    comments = detail.get("comments") or detail.get("processComments") or detail.get("process_comments")
    agent.registration_message = str(comments or f"注册服务状态：{raw_status}")[:500]
    agent.registration_synced_at = utcnow()
    db.commit()


async def submit_one(db, client: RegistryClient, agent: Agent, acs: dict) -> None:
    if not agent.registration_agent_id:
        if public_aic(agent):
            raise ValueError("Public AIC without registration ID; refusing to recreate")
        # Recover even if a previous creation succeeded but its HTTP response was lost.
        result = await client._request("GET", "/agent/client?" + urlencode({"name": agent.name, "page_size": 100}))
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ValueError("Unrecognized registry listing; cannot safely rule out duplicate drafts")
        matches = [item for item in result["items"] if item.get("name") == agent.name]
        if len(matches) > 1:
            raise ValueError("Multiple matching registry drafts; inspect manually")
        if matches:
            detail = await client.detail(str(matches[0]["id"]))
            validate_remote(detail, acs)
            agent.registration_agent_id = str(matches[0]["id"])
        else:
            agent.registration_agent_id = await client.save_agent(agent.name, "1.0.0", agent.description, acs)
        # Persist the identity BEFORE submit, so a retry never replaces it.
        db.commit()
    detail = await client.detail(agent.registration_agent_id)
    validate_remote(detail, acs)
    apply_status(db, agent, detail)
    if agent.registration_status in {"pending", "approved"}:
        return
    if agent.registration_status != "draft":
        raise ValueError("Rejected or unexpected record requires review; no automatic resubmission")
    # Only a matched DRAFT may be repaired, always under its existing ID.
    # APPROVED/PENDING returned above; no cancellation or re-registration.
    await client.update_agent(agent.registration_agent_id, agent.name, "1.0.0", agent.description, acs)
    await client.submit(agent.registration_agent_id)
    agent.registration_status = "pending"
    agent.registration_message = "已提交审核，保留原注册记录等待结果"
    agent.registration_synced_at = utcnow()
    db.commit()


async def certificates(db, client: RegistryClient, agent: Agent, acs: dict) -> None:
    if agent.registration_status != "approved" or not public_aic(agent):
        print(json.dumps({"id": agent.id, "certificates": "waiting_for_approval"}), flush=True)
        return
    settings = get_settings()
    root = Path(settings.certs_dir)
    hostname = urlsplit(next(e["url"] for e in acs["endPoints"] if e["transport"] == "JSONRPC")).hostname
    for usage in ("clientAuth", "serverAuth"):
        stem = f"{agent.aic}.serverauth" if usage == "serverAuth" else agent.aic
        cert, key = root / f"{stem}.pem", root / f"{stem}.key"
        host = hostname if usage == "serverAuth" else None
        try:
            validate_certificate_files(str(cert), str(key), settings.aip_ca_file, agent.aic, usage, host)
        except CertificateError:
            credential = await client.fetch_eab(agent.aic)
            await issue_certificate(agent.aic, {"keyId": credential.key_id, "macKey": credential.mac_key}, usage, server_hostname=host)
            agent.certificate_issued_at = utcnow()
            db.commit()
        print(json.dumps({"id": agent.id, "certificate": usage, "verified": True}), flush=True)


async def run(args) -> None:
    client = RegistryClient()
    with SessionLocal() as db:
        for agent_id in args.ids or SERVICE_AGENT_CATALOG:
            if agent_id not in SERVICE_AGENT_CATALOG:
                raise ValueError("Only the eight new catalog IDs are allowed")
            agent = db.get(Agent, agent_id)
            if not agent:
                raise ValueError(f"Seed the new catalog before provisioning: {agent_id}")
            acs = checked_acs(agent)
            if args.submit:
                await submit_one(db, client, agent, acs)
            if args.sync or args.certificates:
                if not agent.registration_agent_id:
                    raise ValueError(f"No existing registration to sync: {agent_id}")
                detail = await client.detail(agent.registration_agent_id)
                validate_remote(detail, acs)
                apply_status(db, agent, detail)
            if args.certificates:
                await certificates(db, client, agent, acs)
            print(json.dumps({"id": agent.id, "name": agent.name, "role": agent.role,
                "aic": public_aic(agent), "registrationId": agent.registration_agent_id,
                "status": agent.registration_status, "endPoints": acs["endPoints"],
                "certificate": acs["certificate"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--submit", action="store_true")
    action.add_argument("--sync", action="store_true")
    action.add_argument("--certificates", action="store_true")
    parser.add_argument("--ids", nargs="+", choices=list(SERVICE_AGENT_CATALOG))
    try:
        asyncio.run(run(parser.parse_args()))
    except (ValueError, RegistrationError, CertificateError) as exc:
        raise SystemExit(str(exc)) from None
