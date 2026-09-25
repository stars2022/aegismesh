#!/usr/bin/env python3
"""Issue certificates for approved local agents without exposing EAB secrets."""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from backend.app.database import SessionLocal
from backend.app.models import Agent
from backend.app.services.certificates import issue_certificate
from backend.app.services.registration import RegistryClient


async def main() -> int:
    registry = RegistryClient()
    results: list[dict[str, str]] = []
    failed = False
    with SessionLocal() as db:
        agents = db.scalars(
            select(Agent)
            .where(Agent.registration_status == "approved")
            .where(Agent.registration_agent_id != "")
            .order_by(Agent.id)
        ).all()
        for agent in agents:
            try:
                credential = await registry.fetch_eab(agent.aic)
                issued = await issue_certificate(
                    agent.aic,
                    {"keyId": credential.key_id, "macKey": credential.mac_key},
                )
                agent.eab_key_id = credential.key_id
                agent.certificate_issued_at = datetime.now(timezone.utc)
                db.commit()
                results.append(
                    {
                        "agentId": agent.id,
                        "aic": agent.aic,
                        "status": "issued",
                        "certificate": issued.cert_path,
                    }
                )
            except Exception as exc:  # Operational command: report every agent.
                db.rollback()
                failed = True
                results.append(
                    {
                        "agentId": agent.id,
                        "aic": agent.aic,
                        "status": "failed",
                        "error": str(exc),
                    }
                )
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
