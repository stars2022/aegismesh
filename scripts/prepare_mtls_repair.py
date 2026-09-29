"""Export minimal ACS repair requests. Never update/delete/submit registry records."""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from app.database import SessionLocal
from app.models import Agent
from app.services.registration import RegistryClient


async def prepare(output: Path) -> None:
    if output.exists():
        raise SystemExit("Output already exists; preserve the previous evidence")
    output.mkdir(mode=0o700, parents=True)
    client = RegistryClient()
    with SessionLocal() as db:
        agents = db.scalars(select(Agent).where(
            Agent.registration_status == "approved", Agent.transport != "aip-rpc",
            Agent.usage_mode != "internal", Agent.active == True,
        ).order_by(Agent.id)).all()
        # Keep the existing leader authority; allocate dedicated partner ports.
        agents.sort(key=lambda a: (a.role != "leader", a.id))
        for offset, agent in enumerate(agents):
            detail = await client.detail(agent.registration_agent_id)
            if detail.get("approval_status") != "APPROVED" or detail.get("aic") != agent.aic:
                raise SystemExit(f"Identity/status changed for {agent.id}; inspect before proposing changes")
            before = detail["acs"]
            before = json.loads(before) if isinstance(before, str) else before
            after = copy.deepcopy(before)
            endpoints = [e for e in after.get("endPoints", []) if e.get("transport") == "JSONRPC"]
            if len(endpoints) != 1:
                raise SystemExit(f"Ambiguous HTTPS endpoint for {agent.id}")
            endpoint = endpoints[0]
            parsed = urlsplit(endpoint["url"])
            if parsed.scheme != "https" or not parsed.hostname or parsed.username:
                raise SystemExit(f"Invalid HTTPS endpoint for {agent.id}")
            endpoint["url"] = urlunsplit(parsed._replace(netloc=f"{parsed.hostname}:{8443 + offset}"))
            names = after.setdefault("certificate", {}).setdefault("altNames", {}).setdefault("dns", [])
            if parsed.hostname not in names:
                names.append(parsed.hostname)
            request = {"agentId": agent.id, "registrationAgentId": agent.registration_agent_id,
                       "aic": agent.aic, "preserveApprovalStatus": "APPROVED",
                       "before": before, "requestedAcs": after}
            (output / f"{agent.id}.json").write_text(json.dumps(request, ensure_ascii=False, indent=2) + "\n")
            print(f"{agent.id}: proposal only, {endpoint['url']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    asyncio.run(prepare(args.output))
