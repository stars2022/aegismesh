"""Publish only the admin designer code/UI, preserving production data and policy.

Run from the active release with STAGE, verified config archive and its SHA256.
The historical release helper supplies read-only snapshot/readiness primitives;
its publication entrypoint is never called.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

RELEASE = Path("/home/zcode/aegismesh-release-accounts-20260930")
FILES = (
    "backend/app/agent_designer_api.py", "backend/app/main.py", "backend/app/services/model_budget.py",
    "frontend/src/App.tsx", "frontend/src/api.ts", "frontend/src/admin/AgentBuilder.tsx",
    "frontend/src/admin/AgentDesigner.tsx", "frontend/src/admin/AgentDesigner.css",
    "frontend/src/admin/NewAgentMenu.tsx", "frontend/src/admin/Studio.tsx", "docs/admin-agent-designer.md",
)

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def main():
    os.umask(0o077)
    stage, archive, expected_archive = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    if Path.cwd().resolve() != RELEASE or stage.parent != Path("/tmp") or not stage.name.startswith("aegismesh-designer-"):
        raise SystemExit("Unexpected active release or staging location")
    if archive.parent != Path("/home/zcode/aegismesh-backups") or digest(archive) != expected_archive:
        raise SystemExit("Verified configuration backup changed")
    manifest = json.loads((stage / "deployment-manifest.json").read_text())
    if (set(manifest["sources"]) != set(FILES) or manifest["config_archive_sha256"] != expected_archive
            or not manifest["database_backup"].get("locally_restored_and_checked")):
        raise SystemExit("Verified local backups and exact source allowlist required")
    support = stage / "scripts/deploy-search-tools.py"
    if digest(support) != manifest["support_sha256"]:
        raise SystemExit("Release support script changed")
    spec = importlib.util.spec_from_file_location("release_support", support)
    lib = importlib.util.module_from_spec(spec); spec.loader.exec_module(lib)
    for unit in lib.UNITS:
        if Path(lib.run("systemctl", "show", unit, "--property=WorkingDirectory", "--value")).resolve() != RELEASE:
            raise SystemExit("Listener release changed: " + unit)
    for name, hashes in manifest["sources"].items():
        current = RELEASE / name
        if (digest(current) if current.exists() else None) != hashes["before"] or digest(stage / name) != hashes["after"]:
            raise SystemExit("Source drift: " + name)
        if name.endswith(".py"):
            compile((stage / name).read_text(), name, "exec")
    for name, expected in {**manifest["unchanged_backend"], **manifest["unchanged_frontend"]}.items():
        if digest(RELEASE / name) != expected:
            raise SystemExit("Unstaged backend drift: " + name)
    if any((RELEASE / name).exists() for name in manifest['unchanged_frontend_absent']):
        raise SystemExit('Historical frontend source mirror changed')
    dist, web = stage / "frontend/dist", Path("/var/www/aegismesh")
    for name, expected in manifest['previous_frontend'].items():
        if digest(web / name) != expected:
            raise SystemExit('Live frontend changed since verified preflight: ' + name)
    actual = {str(path.relative_to(dist)): digest(path) for path in dist.rglob("*") if path.is_file()}
    if actual != manifest["frontend_files"]:
        raise SystemExit("Frontend build mismatch")
    for name, expected in actual.items():
        if name != "index.html" and not name.startswith("assets/") and digest(web / name) != expected:
            raise SystemExit("Unchanged public asset drift: " + name)
    if shutil.disk_usage(RELEASE).free < 384 * 1024**2:
        raise SystemExit("Insufficient production headroom")
    lib.run("systemctl", "is-active", "--quiet", *lib.UNITS, "aegismesh-fluentbit.service")
    before = lib.snapshot()
    if before["active_tasks"]:
        raise SystemExit("Business tasks still active; no publication")
    before_config = {path: json.loads(lib.fetch(path)) for path in ("/api/account/config", "/api/chat/config")}
    rollback = RELEASE / "deployment-backup" / ("agent-designer-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    rollback.mkdir(mode=0o700, parents=True)
    shutil.copy2(web / "index.html", rollback / "index.html")
    existed = []
    for name in FILES:
        if (RELEASE / name).is_file():
            target = rollback / name; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / name, target); existed.append(name)
    (rollback / "manifest.json").write_text(json.dumps({**manifest, "existed": existed, "before": before}))
    time.sleep(2)
    if lib.snapshot() != before:
        raise SystemExit("Activity/settings changed; no publication")
    restarted = False
    try:
        for name in FILES:
            target = RELEASE / name; target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".designer-stage")
            shutil.copy2(stage / name, temporary); temporary.chmod(0o644); temporary.replace(target)
        if lib.snapshot() != before:
            raise RuntimeError("Activity changed before reload")
        restarted = True
        lib.run("sudo", "-n", "systemctl", "restart", *lib.UNITS)
        lib.readiness(before_config, before["protected_sha256"])
        after = lib.snapshot()
        if after != before:
            raise RuntimeError("Business/task/search/policy state changed during publication")
        schema = json.loads(lib.fetch("/openapi.json"))
        path = "/api/admin/agent-designer/generate"
        if path not in schema["paths"]:
            raise RuntimeError("Admin designer route not loaded")
        request = urllib.request.Request("http://127.0.0.1:8000" + path,
            data=b'{"provider_id":"deployment-invalid-provider","requirements":"deployment authorization check"}',
            headers={"Content-Type":"application/json"}, method="POST")
        try:
            urllib.request.urlopen(request, timeout=8)
            raise RuntimeError("Unauthenticated admin designer access")
        except urllib.error.HTTPError as exc:
            if exc.code != 401: raise
        for protected in ("/api/admin/web-search", "/api/admin/accounts/users", "/api/admin/quotas/usage"):
            try:
                lib.fetch(protected); raise RuntimeError("Unauthenticated admin access")
            except urllib.error.HTTPError as exc:
                if exc.code != 401: raise
        if json.loads(lib.fetch("/api/account/history"))["items"]:
            raise RuntimeError("Anonymous history isolation changed")
        shutil.copytree(dist / "assets", web / "assets", dirs_exist_ok=True)
        (web / "assets").chmod(0o755)
        for source in (dist / "assets").rglob("*"):
            (web / "assets" / source.relative_to(dist / "assets")).chmod(0o755 if source.is_dir() else 0o644)
        shutil.copy2(dist / "index.html", web / "index.designer-stage.html")
        (web / "index.designer-stage.html").chmod(0o644)
        (web / "index.designer-stage.html").replace(web / "index.html")
        published = lib.fetch("/", nginx=True)
        if hashlib.sha256(published).hexdigest() != actual["index.html"]:
            raise RuntimeError("Published entry mismatch")
        for asset in re.findall(r'(?:src|href)="(/assets/[a-zA-Z0-9_.-]+)"', published.decode()):
            if hashlib.sha256(lib.fetch(asset, nginx=True)).hexdigest() != actual[asset.lstrip("/")]:
                raise RuntimeError("Published asset mismatch")
        audit_id = "agent-designer-deploy-" + uuid.uuid4().hex
        env = dict(os.environ, PYTHONPATH="backend:.", PYTHONDONTWRITEBYTECODE="1")
        lib.run(str(RELEASE / ".venv/bin/python"), "-c",
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-release',method='PATCH',path='/release/admin-agent-designer',"
            "request_id=sys.argv[1],status_code=200,duration_ms=0,"
            "note='Admin-only draft designer and compact navigation published after verified local backup; policies preserved')",
            audit_id, env=env)
        if lib.snapshot()["protected_sha256"] != before["protected_sha256"]:
            raise RuntimeError("Protected state changed after publication")
        result = {"git_commit": manifest["git_commit"], "release": str(RELEASE), "rollback": str(rollback),
            "protected_state_preserved": True, "task_states_preserved": True, "services_reloaded": len(lib.UNITS),
            "search_backend": after["search_backend"], "unauthenticated_designer_status": 401,
            "paid_designer_requests": 0, "audit_id": audit_id, "before": before, "after": after,
            "completed_utc": datetime.now(timezone.utc).isoformat(), "free_bytes": shutil.disk_usage(RELEASE).free}
        (stage / "deployment-result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except BaseException:
        for name in FILES:
            if name in existed: shutil.copy2(rollback / name, RELEASE / name)
            elif (RELEASE / name).is_file(): (RELEASE / name).unlink()
        shutil.copy2(rollback / "index.html", web / "index.html"); (web / "index.html").chmod(0o644)
        if restarted: lib.run("sudo", "-n", "systemctl", "restart", *lib.UNITS)
        raise

if __name__ == "__main__":
    main()
