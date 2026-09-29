"""Stage four replacement research registrations without changing live identities.

The user explicitly authorized reapplication on 2026-09-29. Unlike the legacy
reapply_agents.py, this command never writes Agent rows, deletes old records,
edits live environment files, or activates an unverified endpoint.
"""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from acps_sdk.aic import validate_aic_format

from app.config import get_settings
from app.database import SessionLocal
from app.models import Agent, utcnow
from app.services.acs import build_acs
from app.services.aip_tls import validate_agent_authorities
from app.services.certificates import CertificateError, issue_certificate, validate_certificate_files
from app.services.registration import RegistryClient, RegistrationError, validate_registration_acs


PORTS = {"research_leader": 8458, "docs_overview": 8459,
         "empirical_design": 8460, "peer_review": 8461}
HOST = "aip.demmo.cc.cd"
VERSION = "2.0.0"
FORMAT = "aegismesh.research-reapplication.v1"


def replacement_acs(agent: Agent) -> dict:
    if agent.id not in PORTS or agent.transport == "aip-rpc":
        raise ValueError("Only the four hosted research agents may be reapplied")
    # Construct a detached object: mutating a shallow ORM copy also mutates its
    # SQLAlchemy state. Never expose a new/pending identity to the running app.
    fields = ("id", "name", "role", "description", "transport", "active",
              "streaming_enabled", "input_modes", "output_modes", "skills",
              "model_provider", "model_name", "tools")
    draft = Agent(**{key: getattr(agent, key) for key in fields}, aic="",
                  registration_status="local", group_enabled=True,
                  security_schemes=["mtls"], updated_at=utcnow())
    acs = build_acs(draft, f"https://{HOST}:{PORTS[agent.id]}/aip/{agent.id}/rpc")
    acs["version"] = VERSION
    validate_registration_acs(acs)
    if acs["aic"] or acs.get("certificate") != {"altNames": {"dns": [HOST]}}:
        raise ValueError("Replacement must request a new AIC and the correct DNS SAN")
    if not any(e["transport"] == "AMQP" and "inbox_{AIC}" in e["url"]
               for e in acs["endPoints"]):
        raise ValueError("Official MQ configuration is required before reapplication")
    return acs


def persist(path: Path, state: dict, *, create: bool = False) -> None:
    """Durably checkpoint every upstream ID before attempting submission."""
    data = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode()
    if create:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        return
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_acs(detail: dict) -> dict:
    acs = detail.get("acs") or {}
    return json.loads(acs) if isinstance(acs, str) else acs


def approval_status(detail: dict) -> str:
    raw = detail.get("approval_status") or detail.get("approvalStatus") or detail.get("status")
    value = RegistryClient.map_status(raw)
    if value == "local":
        raise ValueError(f"Unrecognized registry status: {raw}")
    return value


def validate_replacement(entry: dict, detail: dict) -> None:
    expected, actual = entry["acs"], read_acs(detail)
    aic = str(detail.get("aic") or "").strip().upper()
    if detail.get("id") == entry["previous"]["registrationId"] or (
            aic and aic == entry["previous"]["aic"]):
        raise ValueError("Refusing to adopt the old identity as its own replacement")
    if approval_status(detail) == "approved" and (
            not validate_aic_format(aic)[0] or actual.get("aic") != aic):
        raise ValueError("Approved replacement has an invalid or inconsistent AIC")
    endpoints = json.loads(json.dumps(expected["endPoints"]).replace("{AIC}", aic)) if aic else expected["endPoints"]
    for key, value in (("name", expected["name"]), ("version", VERSION),
                       ("certificate", expected["certificate"]), ("endPoints", endpoints)):
        if actual.get(key) != value:
            raise ValueError(f"Replacement {entry['id']} differs in {key}; inspect, do not recreate")


async def prepare(path: Path, client: RegistryClient) -> dict:
    if path.exists():
        raise ValueError("State already exists; resume with --submit/--sync, never overwrite it")
    settings = get_settings().model_copy(deep=True)
    settings.aip_agent_public_urls.update({key: f"https://{HOST}:{port}" for key, port in PORTS.items()})
    validate_agent_authorities(settings)
    entries = []
    with SessionLocal() as db:
        for key, port in PORTS.items():
            agent = db.get(Agent, key)
            if not agent or agent.registration_status != "approved" or not agent.registration_agent_id:
                raise ValueError(f"Missing approved source identity: {key}")
            detail = await client.detail(agent.registration_agent_id)
            if approval_status(detail) != "approved" or detail.get("aic") != agent.aic:
                raise ValueError(f"Source identity has changed: {key}")
            entries.append({"id": key, "port": port, "acs": replacement_acs(agent),
                            "previous": {"registrationId": agent.registration_agent_id,
                                         "aic": agent.aic, "acs": read_acs(detail)},
                            "registrationId": "", "aic": "", "status": "not_submitted"})
    state = {"format": FORMAT, "createdAt": utcnow().isoformat(), "agents": entries,
             "activation": "not_started", "publicPortsVerified": False}
    persist(path, state, create=True)
    return state


async def matching_drafts(client: RegistryClient, entry: dict) -> list[dict]:
    """Recover lost create responses by name AND version, including later pages."""
    matches, page = [], 1
    while True:
        result = await client._request("GET", "/agent/client?" + urlencode(
            {"name": entry["acs"]["name"], "page_size": 100, "page_num": page}))
        if not isinstance(result, dict) or not isinstance(result.get("items"), list) or not isinstance(result.get("total"), int):
            raise ValueError("Cannot rule out duplicate registrations: invalid listing")
        items = result["items"]
        for item in items:
            if item.get("name") != entry["acs"]["name"]:
                continue
            detail = await client.detail(str(item["id"]))
            if read_acs(detail).get("version") == VERSION:
                matches.append(detail)
        if page * 100 >= result["total"]:
            return matches
        if not items or page >= 100:
            raise ValueError("Incomplete registry listing; refusing a potentially duplicate create")
        page += 1


def checkpoint_detail(path: Path, state: dict, entry: dict, detail: dict) -> None:
    validate_replacement(entry, detail)
    entry.update(status=approval_status(detail), aic=str(detail.get("aic") or ""),
                 syncedAt=utcnow().isoformat())
    persist(path, state)


async def submit_one(path: Path, state: dict, entry: dict, client: RegistryClient) -> None:
    if not entry["registrationId"]:
        matches = await matching_drafts(client, entry)
        if len(matches) > 1:
            raise ValueError("Multiple matching replacements; manual inspection required")
        if matches:
            validate_replacement(entry, matches[0])
            entry["registrationId"] = str(matches[0]["id"])
        else:
            acs = entry["acs"]
            entry["registrationId"] = await client.save_agent(acs["name"], VERSION, acs["description"], acs)
        persist(path, state)
    detail = await client.detail(entry["registrationId"])
    checkpoint_detail(path, state, entry, detail)
    if entry["status"] in {"pending", "approved"}:
        return
    if entry["status"] != "draft":
        raise ValueError("Rejected/unexpected replacement requires review; no automatic resubmission")
    await client.submit(entry["registrationId"])
    entry["status"] = "submission_sent"
    persist(path, state)
    checkpoint_detail(path, state, entry, await client.detail(entry["registrationId"]))


async def certificates(path: Path, state: dict, entry: dict, client: RegistryClient) -> None:
    if entry["status"] != "approved":
        return
    settings, aic = get_settings(), entry["aic"]
    root = Path(settings.certs_dir)
    for usage in ("clientAuth", "serverAuth"):
        stem = aic + (".serverauth" if usage == "serverAuth" else "")
        hostname = HOST if usage == "serverAuth" else None
        try:
            validate_certificate_files(root / f"{stem}.pem", root / f"{stem}.key",
                                       settings.aip_ca_file, aic, usage, hostname)
        except CertificateError:
            credential = await client.fetch_eab(aic)
            await issue_certificate(aic, {"keyId": credential.key_id, "macKey": credential.mac_key},
                                    usage, server_hostname=hostname)
            validate_certificate_files(root / f"{stem}.pem", root / f"{stem}.key",
                                       settings.aip_ca_file, aic, usage, hostname)
        entry.setdefault("verifiedCertificates", {})[usage] = utcnow().isoformat()
        persist(path, state)


async def run(args) -> None:
    client, path = RegistryClient(), args.state
    if args.prepare:
        state = await prepare(path, client)
    else:
        state = json.loads(path.read_text())
        if state.get("format") != FORMAT or [e["id"] for e in state["agents"]] != list(PORTS):
            raise ValueError("Unexpected replacement manifest")
        # Preflight every old binding before any upstream write. No live DB writes.
        with SessionLocal() as db:
            for entry in state["agents"]:
                agent = db.get(Agent, entry["id"])
                old = entry["previous"]
                if not agent or agent.aic != old["aic"] or agent.registration_agent_id != old["registrationId"]:
                    raise ValueError("Live source binding changed; inspect before continuing")
                if entry["port"] != PORTS[entry["id"]]:
                    raise ValueError("Reserved port changed")
        for entry in state["agents"]:
            if args.submit:
                await submit_one(path, state, entry, client)
            elif args.sync or args.certificates:
                if not entry["registrationId"]:
                    raise ValueError("No replacement ID to sync")
                checkpoint_detail(path, state, entry, await client.detail(entry["registrationId"]))
                if args.certificates:
                    await certificates(path, state, entry, client)
    for entry in state["agents"]:
        print(json.dumps({key: entry[key] for key in ("id", "port", "registrationId", "aic", "status")},
                         ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True, help="Server-local checkpoint, not a live agent database")
    actions = parser.add_mutually_exclusive_group()
    for action in ("prepare", "submit", "sync", "certificates"):
        actions.add_argument(f"--{action}", action="store_true")
    args = parser.parse_args()
    try:
        # Lock survives lost SSH responses; an explicit retry safely resumes IDs.
        with args.state.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            asyncio.run(run(args))
    except (ValueError, RegistrationError, CertificateError, BlockingIOError) as exc:
        raise SystemExit(str(exc)) from None
