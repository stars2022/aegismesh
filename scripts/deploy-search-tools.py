"""Publish the optional DeepSeek tools without changing production settings.

Run in the active release: python SCRIPT STAGE CONFIG_ARCHIVE CONFIG_SHA256.
Requires a freshly restored local DB backup and a hash-pinned source/build bundle.
No migrations, dependency upgrades, policy edits, or paid tool requests are run.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


RELEASE = Path("/home/zcode/aegismesh-release-accounts-20260930")
FILES = (
    "backend/app/config.py", "backend/app/main.py", "backend/app/schemas.py",
    "backend/app/services/model_budget.py", "backend/app/services/deepseek_tools.py",
    "backend/app/services/orchestrator.py", "backend/app/services/source_pages.py",
    "backend/app/services/web_search.py", "frontend/src/WebSearchSettings.tsx",
    ".env.example", "README.md", "docs/deepseek-native-search.md",
)
AGENTS = (
    "docs_overview", "empirical_design", "food_guide", "heritage_guide",
    "news_coordinator", "news_retrieval", "news_timeline", "news_verification",
    "peer_review", "research_leader", "travel_coordinator", "travel_logistics",
)
UNITS = ("aegismesh.service", *(f"aegismesh-aip-agent@{name}.service" for name in AGENTS))
PROTECTED = (
    "account_policy", "account_quota_overrides", "routing_policies", "provider_configs",
    "web_search_configs", "platform_access", "admin_accounts",
)
AGENT_CONFIG = (
    "id", "name", "aic", "role", "active", "usage_mode", "model_provider", "model_name",
    "transport", "endpoint_url", "tools", "skills", "system_prompt", "streaming_enabled",
    "description", "notification_enabled", "group_enabled", "input_modes", "output_modes",
    "security_schemes", "estimated_cost_per_1k", "registration_status", "registration_agent_id",
    "structured_io_enabled", "input_schema", "output_schema",
)


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fetch(path, *, nginx=False):
    request = urllib.request.Request(
        ("http://127.0.0.1" if nginx else "http://127.0.0.1:8000") + path,
        headers={"Host": "demmo.cc.cd", "User-Agent": "AegisMesh-deployment-check/1.0"},
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return response.read()


def snapshot():
    """Do not emit credentials, prompts, or customer conversations."""
    database = (RELEASE / "backend/data/aegismesh.db").resolve()
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=10) as db:
        db.execute("BEGIN")
        active = db.execute(
            "SELECT count(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')"
        ).fetchone()[0]
        active += db.execute(
            "SELECT count(*) FROM hosted_tasks WHERE state IN ('accepted','working')"
        ).fetchone()[0]
        protected = {}
        for table in PROTECTED:
            # Admission serialization counters are not quota settings.
            columns = 'id,"values"' if table == "account_policy" else "*"
            protected[table] = db.execute(f'SELECT {columns} FROM "{table}" ORDER BY 1').fetchall()
        names = {row[1] for row in db.execute("PRAGMA table_info(agents)")}
        columns = ",".join(f'"{name}"' for name in AGENT_CONFIG if name in names)
        protected["agents"] = db.execute(f"SELECT {columns} FROM agents ORDER BY id").fetchall()
        protected["roles"] = db.execute("SELECT id,role,active FROM user_accounts ORDER BY id").fetchall()
        protected["ownership"] = db.execute("SELECT id,owner_id FROM conversations ORDER BY id").fetchall()
        protected["environment"] = {
            path.name: digest(path) for path in [*RELEASE.glob("*.env"), RELEASE / ".env"] if path.is_file()
        }
        states = {table: dict(db.execute(f"SELECT {column},count(*) FROM {table} GROUP BY {column}"))
                  for table, column in (("invocations", "status"), ("hosted_tasks", "state"))}
        backend = db.execute("SELECT backend FROM web_search_configs WHERE id=1").fetchone()[0]
        tool_requests = db.execute(
            "SELECT count(*) FROM operational_logs WHERE action='deepseek_tool_request'"
        ).fetchone()[0]
    return {"active_tasks": active,
            "protected_sha256": hashlib.sha256(json.dumps(protected, sort_keys=True).encode()).hexdigest(),
            "search_backend": backend, "task_states": states, "native_tool_requests": tool_requests}


def readiness(before_config, policy_hash):
    for _ in range(45):
        try:
            if json.loads(fetch("/api/health"))["status"] != "ok":
                raise ValueError("API not ready")
            if any(json.loads(fetch(path)) != expected for path, expected in before_config.items()):
                raise ValueError("Public account/runtime settings changed")
            if snapshot()["protected_sha256"] != policy_hash:
                raise ValueError("Protected settings changed")
            run("systemctl", "is-active", "--quiet", *UNITS, "aegismesh-fluentbit.service")
            return
        except (OSError, ValueError, subprocess.CalledProcessError):
            time.sleep(1)
    raise RuntimeError("Readiness or preservation verification failed")


def main():
    os.umask(0o077)
    stage, backup, expected_hash = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    if Path(run("systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value")).resolve() != RELEASE:
        raise SystemExit("Unexpected active release")
    if Path.cwd().resolve() != RELEASE or stage.parent != Path("/home/zcode") or not stage.name.startswith("aegismesh-search-"):
        raise SystemExit("Unexpected release/staging path")
    if backup.parent != Path("/home/zcode/aegismesh-backups") or digest(backup) != expected_hash:
        raise SystemExit("Configuration archive mismatch")
    manifest = json.loads((stage / "deployment-manifest.json").read_text())
    verified = manifest["database_backup"]
    if set(manifest["sources"]) != set(FILES) or not verified.get("locally_restored_and_checked") or len(verified.get("sha256", "")) != 64:
        raise SystemExit("Expected exact allowlist and verified local backup")
    if manifest["config_archive_sha256"] != expected_hash:
        raise SystemExit("Bundle configuration archive mismatch")
    for name, hashes in manifest["sources"].items():
        target = RELEASE / name
        if (digest(target) if target.is_file() else None) != hashes["before"] or digest(stage / name) != hashes["after"]:
            raise SystemExit("Source changed: " + name)
        if name.endswith(".py"):
            compile((stage / name).read_text(), name, "exec")
    for name, expected in manifest["unchanged_backend"].items():
        if digest(RELEASE / name) != expected:
            raise SystemExit("Unstaged backend source changed: " + name)
    dist = stage / "frontend/dist"
    actual_assets = {str(path.relative_to(dist)): digest(path) for path in dist.rglob("*") if path.is_file()}
    if actual_assets != manifest["frontend_files"]:
        raise SystemExit("Frontend build mismatch")
    for name, expected in actual_assets.items():
        if name != "index.html" and not name.startswith("assets/"):
            if digest(Path("/var/www/aegismesh") / name) != expected:
                raise SystemExit("Unchanged public media differ: " + name)
    if shutil.disk_usage(RELEASE).free < 384 * 1024 * 1024:
        raise SystemExit("Insufficient disk headroom")
    for unit in UNITS:
        if Path(run("systemctl", "show", unit, "--property=WorkingDirectory", "--value")).resolve() != RELEASE:
            raise SystemExit("Listener uses a different release: " + unit)
    run("systemctl", "is-active", "--quiet", *UNITS, "aegismesh-fluentbit.service")
    before = snapshot()
    if before["active_tasks"] or before["search_backend"] != "deepseek":
        raise SystemExit("Active tasks or search selection changed; refusing publication")
    before_config = {path: json.loads(fetch(path)) for path in ("/api/account/config", "/api/chat/config")}
    rollback = RELEASE / "deployment-backup" / ("search-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    rollback.mkdir(parents=True, mode=0o700)
    web = Path("/var/www/aegismesh")
    shutil.copy2(web / "index.html", rollback / "index.html")
    existed = []
    for name in FILES:
        if (RELEASE / name).is_file():
            target = rollback / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / name, target)
            existed.append(name)
    (rollback / "manifest.json").write_text(json.dumps({**manifest, "existed": existed, "before": before}))
    # Consecutive quiescent checks catch work accepted while the backup was prepared.
    time.sleep(2)
    if snapshot() != before:
        raise SystemExit("Activity or settings changed before publication; nothing changed")
    restarted = False
    try:
        for name in FILES:
            target = RELEASE / name
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".search-stage")
            shutil.copy2(stage / name, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
        if snapshot() != before:
            raise RuntimeError("Activity or settings changed before restart")
        # Graceful SIGTERM/restart; no force kill, policy override or task cancellation.
        restarted = True
        run("sudo", "-n", "systemctl", "restart", *UNITS)
        readiness(before_config, before["protected_sha256"])
        after = snapshot()
        if after["search_backend"] != before["search_backend"] or after["native_tool_requests"] != before["native_tool_requests"]:
            raise RuntimeError("Native mode/request count changed unexpectedly")
        if after["task_states"] != before["task_states"]:
            raise RuntimeError("Task states changed during publication; inspect before retrying")
        schema = json.loads(fetch("/openapi.json"))["components"]["schemas"]
        if "deepseek_native" not in schema["WebSearchUpdate"]["properties"]["backend"]["enum"]:
            raise RuntimeError("New backend capability is not loaded")
        for path in ("/api/admin/web-search", "/api/admin/accounts/users", "/api/admin/quotas/usage"):
            try:
                fetch(path)
                raise RuntimeError("Unauthenticated admin access: " + path)
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
        if json.loads(fetch("/api/account/history"))["items"]:
            raise RuntimeError("Anonymous history isolation failed")
        # Retain old hashed assets for open browsers; only replace the HTML entry.
        shutil.copytree(dist / "assets", web / "assets", dirs_exist_ok=True)
        (web / "assets").chmod(0o755)
        for source in (dist / "assets").rglob("*"):
            (web / "assets" / source.relative_to(dist / "assets")).chmod(0o755 if source.is_dir() else 0o644)
        shutil.copy2(dist / "index.html", web / "index.search-stage.html")
        (web / "index.search-stage.html").chmod(0o644)
        (web / "index.search-stage.html").replace(web / "index.html")
        published = fetch("/", nginx=True)
        if hashlib.sha256(published).hexdigest() != manifest["frontend_files"]["index.html"]:
            raise RuntimeError("Nginx served the wrong entry")
        for asset in re.findall(r'(?:src|href)="(/assets/[a-zA-Z0-9_.-]+)"', published.decode()):
            data = fetch(asset, nginx=True)
            if hashlib.sha256(data).hexdigest() != manifest["frontend_files"][asset.lstrip("/")]:
                raise RuntimeError("Nginx asset mismatch: " + asset)
        audit_id = "search-deploy-" + uuid.uuid4().hex
        env = dict(os.environ, PYTHONPATH="backend:.", PYTHONDONTWRITEBYTECODE="1")
        run(str(RELEASE / ".venv/bin/python"), "-c",
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-release',method='PATCH',path='/release/deepseek-search',"
            "request_id=sys.argv[1],status_code=200,duration_ms=0,"
            "note='Published optional Search/Fetch after verified local backup; paid mode disabled; settings preserved')",
            audit_id, env=env)
        database = (RELEASE / "backend/data/aegismesh.db").resolve()
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if not db.execute("SELECT 1 FROM operational_logs WHERE request_id=? AND outcome='success'", (audit_id,)).fetchone():
                raise RuntimeError("Deployment audit missing")
        if snapshot()["protected_sha256"] != before["protected_sha256"]:
            raise RuntimeError("Protected state changed after publication")
        result = {"release": str(RELEASE), "git_commit": manifest["git_commit"], "rollback": str(rollback),
                  "services_reloaded": len(UNITS), "protected_state_preserved": True,
                  "search_backend": after["search_backend"], "native_mode_enabled": False,
                  "native_verification_requests": 0, "task_states_preserved": True,
                  "audit_id": audit_id, "index_sha256": digest(web / "index.html"),
                  "before": before, "after": after, "completed_utc": datetime.now(timezone.utc).isoformat()}
        (stage / "deployment-result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except BaseException:
        # Restore only the explicit changed code and previous entry; never overwrite
        # the shared live DB with a backup or remove previous hashed assets.
        for name in FILES:
            if name in existed:
                shutil.copy2(rollback / name, RELEASE / name)
            elif (RELEASE / name).is_file():
                (RELEASE / name).unlink()
        shutil.copy2(rollback / "index.html", web / "index.html")
        (web / "index.html").chmod(0o644)
        if restarted:
            run("sudo", "-n", "systemctl", "restart", *UNITS)
            readiness(before_config, before["protected_sha256"])
        raise


if __name__ == "__main__":
    main()
