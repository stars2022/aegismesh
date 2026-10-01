"""Deploy only the circuit recovery patch, after retrieving a private backup.

Run from the active release: python deploy-circuit-recovery.py STAGE BACKUP SHA256
STAGE/expected-current.json pins the two pre-deployment source hashes.
No schema, frontend, credentials, policies or service-unit changes are made.
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

FILES = ("backend/app/services/orchestrator.py", "backend/app/services/runtime_recovery.py")
AGENTS = ("docs_overview", "empirical_design", "food_guide", "heritage_guide", "news_coordinator",
          "news_retrieval", "news_timeline", "news_verification", "peer_review", "research_leader",
          "travel_coordinator", "travel_logistics")
PROTECTED_TABLES = ("account_policy", "routing_policies", "provider_configs", "web_search_configs",
                    "platform_access", "admin_accounts")


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fetch(path):
    with urllib.request.urlopen("http://127.0.0.1:8000" + path, timeout=3) as response:
        return json.load(response)


def main():
    os.umask(0o077)
    stage, backup, expected_hash = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    release = Path(run("systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value")).resolve()
    if release != Path.cwd().resolve() or release != Path("/home/zcode/aegismesh-release-accounts-20260930"):
        raise SystemExit("Unexpected release directory")
    if stage.parent != Path("/home/zcode") or not stage.name.startswith("aegismesh-circuit-recovery-"):
        raise SystemExit("Unexpected stage directory")
    if backup.parent != Path("/home/zcode/aegismesh-backups") or digest(backup) != expected_hash:
        raise SystemExit("Backup verification failed")
    expected = json.loads((stage / "expected-current.json").read_text())
    if set(expected) != set(FILES) or any(digest(release / path) != expected[path] for path in FILES):
        raise SystemExit("Production code changed since review")
    for path in FILES:
        compile((stage / path).read_text(), path, "exec")
    database = (release / "backend/data/aegismesh.db").resolve()

    def snapshot():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            active = db.execute("SELECT COUNT(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]
            active += db.execute("SELECT COUNT(*) FROM hosted_tasks WHERE state IN ('accepted','working')").fetchone()[0]
            protected = {table: db.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall()
                         for table in PROTECTED_TABLES}
            policy_hash = hashlib.sha256(json.dumps(protected, sort_keys=True).encode()).hexdigest()
            return active, policy_hash

    active, policy_hash = snapshot()
    if active:
        raise SystemExit(f"Refusing restart: {active} active tasks; nothing changed")
    before_config = {path: fetch(path) for path in ("/api/account/config", "/api/chat/config")}
    units = ["aegismesh.service", *(f"aegismesh-aip-agent@{name}.service" for name in AGENTS)]
    run("sudo", "-n", "systemctl", "is-active", "--quiet", *units, "aegismesh-fluentbit.service")
    rollback = release / "deployment-backup" / ("circuit-recovery-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    rollback.mkdir(parents=True, mode=0o700)
    for path in FILES:
        destination = rollback / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release / path, destination)
    (rollback / "manifest.json").write_text(json.dumps({
        "files": FILES, "before": expected, "after": {path: digest(stage / path) for path in FILES},
        "full_backup": str(backup), "backup_sha256": expected_hash,
    }))
    if snapshot() != (0, policy_hash):
        raise SystemExit("Activity or config changed; deployment deferred before file changes")
    restarted = False
    try:
        for path in FILES:
            target = release / path
            temporary = target.with_suffix(target.suffix + ".circuit-stage")
            shutil.copy2(stage / path, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
        if snapshot() != (0, policy_hash):
            raise RuntimeError("Activity or config changed; restoring files without restart")
        restarted = True
        run("sudo", "-n", "systemctl", "restart", *units)
        for _ in range(40):
            try:
                if any(fetch(path) != value for path, value in before_config.items()):
                    raise ValueError("Public config changed")
                run("sudo", "-n", "systemctl", "is-active", "--quiet", *units, "aegismesh-fluentbit.service")
                if snapshot()[1] != policy_hash:
                    raise ValueError("Protected configuration changed")
                break
            except (OSError, ValueError, subprocess.CalledProcessError):
                time.sleep(1)
        else:
            raise RuntimeError("Readiness or policy-preservation check failed")
        for path in ("/api/admin/accounts/users", "/api/admin/quotas/usage"):
            try:
                fetch(path)
                raise RuntimeError("Admin route accepted an unauthenticated request")
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
        request_id = "circuit-deploy-" + uuid.uuid4().hex
        run(str(release / ".venv/bin/python"), "-c",
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env', override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-circuit-repair', method='PATCH', "
            "path='/runtime/circuit-recovery', request_id=sys.argv[1], status_code=200, duration_ms=0, "
            "note='Deployed tested probe cleanup after verified private backup; policies unchanged')",
            request_id, env=dict(os.environ, PYTHONPATH="backend:."))
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if not db.execute("SELECT 1 FROM operational_logs WHERE request_id=? AND outcome='success'", (request_id,)).fetchone():
                raise RuntimeError("Deployment audit missing")
    except BaseException:
        for path in FILES:
            shutil.copy2(rollback / path, release / path)
        if restarted:
            run("sudo", "-n", "systemctl", "restart", *units)
        raise
    print(json.dumps({"release": str(release), "rollback": str(rollback), "services": len(units),
                      "policy_preserved": True, "admin_auth_required": True, "audit_id": request_id,
                      "deployed_sha256": {path: digest(release / path) for path in FILES}}))


if __name__ == "__main__":
    main()
