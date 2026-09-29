"""Verify Wutong mTLS/EXTERNAL access; optionally save validated settings.

Run from the release root with PYTHONPATH=backend. No task messages are sent.
--apply backs up the env/trust bundle and enables inboxes, NOT compatibility mode.
"""
from __future__ import annotations
import argparse
import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import ssl
import tempfile
import httpx
import aio_pika
from sqlalchemy import create_engine, text
from app.config import get_settings
from acps_sdk.aip.aip_group_runtime import build_external_connection_url


async def main(apply: bool):
    settings = get_settings()
    response = httpx.get("https://wt.ioa.pub/ca-server/acps-atr-v2/ca/trust-bundle", timeout=20)
    response.raise_for_status()
    bundle = response.text
    root = Path(settings.certs_dir).resolve()
    with create_engine(settings.database_url).connect() as db:
        agents = db.execute(text("SELECT id,aic FROM agents WHERE active=1 AND transport != 'aip-rpc' AND registration_status='approved'")).all()
    if not agents:
        raise RuntimeError("No approved hosted identities")
    for agent_id, aic in agents:
        ctx = ssl.create_default_context(cadata=bundle)
        ctx.load_cert_chain(str(root / f"{aic}.pem"), str(root / f"{aic}.key"))
        connection = await asyncio.wait_for(aio_pika.connect(build_external_connection_url(
            host="wt.ioa.pub", port=5671, vhost="acps", connection_name="aegismesh-preflight"), ssl_context=ctx), 15)
        await connection.close()
        async with httpx.AsyncClient(verify=ctx, timeout=10) as client:
            auth = await client.get("https://wt.ioa.pub:9007/health")
            auth.raise_for_status()
        print(f"OK: {agent_id} AMQPS EXTERNAL / acps / auth service")
    print(f"Trusted roots: {bundle.count('BEGIN CERTIFICATE')}")
    if not apply:
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    env = Path(".env").resolve()
    shutil.copy2(env, env.with_name(f".env.pre-interop-{stamp}"))
    trust = root / "wutong-interop-trust.pem"
    if trust.exists():
        shutil.copy2(trust, trust.with_name(f"{trust.name}.{stamp}.bak"))
    trust.write_text(bundle)
    values = {"AIP_GROUP_MQ_HOST": "wt.ioa.pub", "AIP_GROUP_MQ_PORT": "5671",
              "AIP_GROUP_MQ_VHOST": "acps", "AIP_GROUP_MQ_URL": "",
              "AIP_GROUP_AUTH_URL": "https://wt.ioa.pub:9007", "AIP_GROUP_PARTNER_ENABLED": "true",
              "AIP_GROUP_PARTNER_AGENT_ID": "", "AIP_GROUP_LISTENER_WORKER": "true",
              "AIP_CA_FILE": str(trust)}
    lines = env.read_text().splitlines()
    lines = [line for line in lines if line.partition("=")[0].strip() not in values]
    lines.extend(f"{key}={value}" for key, value in values.items())
    fd, temporary = tempfile.mkstemp(prefix=".env-interop-", dir=env.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write("\n".join(lines) + "\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, env)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Saved validated settings; restart API/mTLS workers. Compatibility remains unchanged.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    asyncio.run(main(parser.parse_args().apply))
