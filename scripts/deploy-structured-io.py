"""Publish tested optional capabilities after verified local backup retrieval.

Run from the active release: python deploy-structured-io.py STAGE BACKUP SHA256.
The stage manifest pins all source hashes. No account, quota, identity, TLS,
service-unit or existing agent settings are changed. Migrations are additive.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone


RELEASE = Path("/home/zcode/aegismesh-release-accounts-20260930")
FILES = (
    "backend/app/main.py", "backend/app/models.py", "backend/app/schemas.py",
    "backend/app/services/aip_execution.py", "backend/app/services/bounty.py",
    "backend/app/services/bounty_runtime.py", "backend/app/services/database_transfer.py",
    "backend/app/services/orchestrator.py", "backend/app/services/prompt.py",
    "backend/app/services/runtime_recovery.py", "backend/app/services/structured_io.py",
    "backend/app/services/transport.py", "pyproject.toml",
    "frontend/src/App.tsx", "frontend/src/api.ts", "frontend/src/types.ts",
    "frontend/src/BountyBoard.tsx", "frontend/src/BountyBoard.css",
    "frontend/src/StructuredIO.tsx", "frontend/src/StructuredIO.css",
    "frontend/src/structuredIOModel.ts", "docs/structured-io.md",
)
AGENTS = ("docs_overview", "empirical_design", "food_guide", "heritage_guide", "news_coordinator",
          "news_retrieval", "news_timeline", "news_verification", "peer_review", "research_leader",
          "travel_coordinator", "travel_logistics")
PROTECTED = ("account_policy", "routing_policies", "provider_configs", "web_search_configs",
             "platform_access", "admin_accounts")
AGENT_CONFIG = ("id", "name", "aic", "role", "active", "usage_mode", "model_provider", "model_name",
                "transport", "endpoint_url", "tools", "skills", "system_prompt", "streaming_enabled")


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fetch(path, data=None):
    request = urllib.request.Request("http://127.0.0.1:8000" + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def main():
    os.umask(0o077)
    stage, backup, expected_hash = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    release = Path(run("systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value")).resolve()
    if release != RELEASE or release != Path.cwd().resolve():
        raise SystemExit("Unexpected active release")
    if stage.parent != Path("/home/zcode") or not stage.name.startswith("aegismesh-structured-io-"):
        raise SystemExit("Unexpected stage directory")
    if backup.parent != Path("/home/zcode/aegismesh-backups") or digest(backup) != expected_hash:
        raise SystemExit("Release/configuration backup verification failed")
    manifest = json.loads((stage / "deployment-manifest.json").read_text())
    if (set(manifest["sources"]) != set(FILES)
            or not manifest["database_backup"].get("locally_restored_and_checked")
            or len(manifest["database_backup"].get("sha256", "")) != 64):
        raise SystemExit("Expected verified database backup and exact source allowlist")
    for path, hashes in manifest["sources"].items():
        target = release / path
        if (digest(target) if target.is_file() else None) != hashes["before"]:
            raise SystemExit(f"Production source changed: {path}")
        if digest(stage / path) != hashes["after"]:
            raise SystemExit(f"Stage source changed: {path}")
        if path.endswith(".py"):
            compile((stage / path).read_text(), path, "exec")
    if not (stage / "frontend/dist/index.html").is_file():
        raise SystemExit("Missing built frontend")
    if shutil.disk_usage(release).free < 384 * 1024 * 1024:
        raise SystemExit("Insufficient deployment headroom")
    database = (release / "backend/data/aegismesh.db").resolve()
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
        columns = {table: [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
                   for table in PROTECTED}

    def snapshot():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5) as db:
            active = db.execute("SELECT count(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]
            active += db.execute("SELECT count(*) FROM hosted_tasks WHERE state IN ('accepted','working')").fetchone()[0]
            protected = {}
            for table, names in columns.items():
                projection = ",".join('"' + name + '"' for name in names)
                protected[table] = db.execute(f'SELECT {projection} FROM "{table}" ORDER BY 1').fetchall()
            projection = ",".join('"' + name + '"' for name in AGENT_CONFIG)
            protected["agents"] = db.execute(f'SELECT {projection} FROM agents ORDER BY id').fetchall()
            protected["roles"] = db.execute("SELECT id,role FROM user_accounts ORDER BY id").fetchall()
            protected["environment"] = {p.name: digest(p) for p in release.glob("*.env")}
            if (release / ".env").is_file():
                protected["environment"][".env"] = digest(release / ".env")
            return active, hashlib.sha256(json.dumps(protected, sort_keys=True).encode()).hexdigest()

    active, policy_hash = snapshot()
    if active:
        raise SystemExit(f"Refusing restart: {active} active tasks; nothing changed")
    units = ["aegismesh.service", *(f"aegismesh-aip-agent@{name}.service" for name in AGENTS)]
    run("sudo", "-n", "systemctl", "is-active", "--quiet", *units, "aegismesh-fluentbit.service")
    before_config = {path: fetch(path) for path in ("/api/account/config", "/api/chat/config")}
    rollback = release / "deployment-backup" / ("structured-io-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    rollback.mkdir(parents=True, mode=0o700)
    web = Path("/var/www/aegismesh")
    shutil.copy2(web / "index.html", rollback / "index.html")
    existed = []
    for path in FILES:
        if (release / path).is_file():
            target = rollback / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(release / path, target)
            existed.append(path)
    (rollback / "manifest.json").write_text(json.dumps({**manifest, "existed": existed,
                                                       "release_backup": str(backup)}))
    env = dict(os.environ, PYTHONPATH="backend:.")
    # Add only the validator dependency; never upgrade unrelated server packages.
    run(str(release / ".venv/bin/python"), "-m", "pip", "install", "jsonschema==4.26.0")
    if snapshot() != (0, policy_hash):
        raise SystemExit("Activity or configuration changed; no application files changed")
    restarted = False
    try:
        for path in FILES:
            target = release / path
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".structured-stage")
            shutil.copy2(stage / path, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
        run(str(release / ".venv/bin/python"), "-c",
            "from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); "
            "from app.main import initialize_schema; initialize_schema()", env=env)
        if snapshot() != (0, policy_hash):
            raise RuntimeError("Activity or protected settings changed before restart")
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if db.execute("SELECT count(*) FROM agents WHERE structured_io_enabled=1").fetchone()[0]:
                raise RuntimeError("Existing agents must remain opted out")
            if db.execute("SELECT count(*) FROM routing_policies WHERE bounty_enabled=1").fetchone()[0]:
                raise RuntimeError("Do not activate the pending bidding capability")
        restarted = True
        run("sudo", "-n", "systemctl", "restart", *units)
        for _ in range(45):
            try:
                if fetch("/api/health")["status"] != "ok":
                    raise ValueError("Unhealthy backend")
                for path, old_config in before_config.items():
                    config = fetch(path)
                    if any(config.get(key) != value for key, value in old_config.items()):
                        raise ValueError("Existing public settings changed")
                run("sudo", "-n", "systemctl", "is-active", "--quiet", *units, "aegismesh-fluentbit.service")
                if snapshot()[1] != policy_hash:
                    raise ValueError("Protected settings changed")
                break
            except (OSError, ValueError, subprocess.CalledProcessError):
                time.sleep(1)
        else:
            raise RuntimeError("Readiness or preservation check failed")
        for path in ("/api/admin/accounts/users", "/api/admin/quotas/usage"):
            try:
                fetch(path)
                raise RuntimeError("Admin route accepted an unauthenticated request")
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
        # Negative validation must not bind a conversation, create a task or call a model.
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            invocation_count = db.execute("SELECT count(*) FROM invocations").fetchone()[0]
        try:
            fetch("/api/demo/chat", {"message": "structured deployment validation", "agent_id": "docs_overview",
                                     "session_id": "deploy-structured-" + uuid.uuid4().hex,
                                     "structured_io": True, "input_data": {}})
            raise RuntimeError("Disabled capability unexpectedly accepted a structured request")
        except urllib.error.HTTPError as error:
            detail = json.loads(error.read())
            if error.code != 422 or "结构化" not in str(detail):
                raise RuntimeError("Structured preflight did not reject the disabled capability") from error
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if db.execute("SELECT count(*) FROM invocations").fetchone()[0] != invocation_count:
                raise RuntimeError("Negative validation created an invocation")
        shutil.copytree(stage / "frontend/dist/assets", web / "assets", dirs_exist_ok=True)
        shutil.copy2(stage / "frontend/dist/index.html", web / "index.structured-stage.html")
        (web / "index.structured-stage.html").replace(web / "index.html")
        audit_id = "structured-deploy-" + uuid.uuid4().hex
        run(str(release / ".venv/bin/python"), "-c",
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-release',method='PATCH',"
            "path='/release/structured-io',request_id=sys.argv[1],status_code=200,duration_ms=0,"
            "note='Published optional built-in capability after verified local backup; existing settings preserved')",
            audit_id, env=env)
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if not db.execute("SELECT 1 FROM operational_logs WHERE request_id=? AND outcome='success'", (audit_id,)).fetchone():
                raise RuntimeError("Deployment audit missing")
    except BaseException:
        for path in FILES:
            if path in existed:
                shutil.copy2(rollback / path, release / path)
            elif (release / path).is_file():
                # Only newly introduced code in the explicit allowlist.
                (release / path).unlink()
        shutil.copy2(rollback / "index.html", web / "index.html")
        if restarted:
            run("sudo", "-n", "systemctl", "restart", *units)
        raise
    print(json.dumps({"release": str(release), "rollback": str(rollback), "services": len(units),
                      "policy_preserved": True, "existing_agents_opted_out": True,
                      "negative_request_status": 422, "negative_request_created_tasks": False,
                      "audit_id": audit_id, "index_sha256": digest(web / "index.html")}))


if __name__ == "__main__":
    main()
