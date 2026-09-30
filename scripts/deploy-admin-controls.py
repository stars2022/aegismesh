"""Apply a staged admin-controls patch after a verified, locally retrieved backup.

Usage from the active release: python deploy-admin-controls.py STAGE BACKUP SHA256
The stage contains only backend files below plus frontend/dist/{assets,index.html}.
Never changes environment, user roles, account/quota policy, AICs or service units.
"""
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
from datetime import datetime, timezone

FILES = (
    "backend/app/account_admin.py", "backend/app/account_api.py", "backend/app/account_models.py",
    "backend/app/services/account_policy.py", "backend/app/services/model_budget.py",
    "backend/app/services/observability.py",
    "frontend/src/App.tsx", "frontend/src/AccountPanel.tsx", "frontend/src/AccountAdministration.tsx",
    "frontend/src/AccountAdministration.css", "frontend/src/accountAdminModel.ts", "frontend/src/styles.css",
    "frontend/package.json", "frontend/package-lock.json", "docs/accounts-and-quotas.md",
)
AGENTS = ("docs_overview", "empirical_design", "food_guide", "heritage_guide", "news_coordinator",
          "news_retrieval", "news_timeline", "news_verification", "peer_review", "research_leader",
          "travel_coordinator", "travel_logistics")


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def fetch(path):
    with urllib.request.urlopen("http://127.0.0.1:8000" + path, timeout=3) as response:
        return json.load(response)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    os.umask(0o077)
    stage, backup, expected_hash = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    release = Path(run("systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value")).resolve()
    assert release == Path.cwd().resolve() and release == Path("/home/zcode/aegismesh-release-accounts-20260930")
    assert stage.parent == Path("/home/zcode") and stage.name.startswith("aegismesh-admin-controls-")
    assert backup.parent == Path("/home/zcode/aegismesh-backups") and backup.is_file() and digest(backup) == expected_hash
    assert all((stage / path).is_file() for path in FILES)
    assert (stage / "frontend/dist/index.html").is_file()
    database = (release / "backend/data/aegismesh.db").resolve()

    def snapshot():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            active = db.execute("SELECT COUNT(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]
            active += db.execute("SELECT COUNT(*) FROM hosted_tasks WHERE state IN ('accepted','working')").fetchone()[0]
            policy = db.execute('SELECT "values" FROM account_policy WHERE id=1').fetchone()
            return active, policy[0] if policy else None

    active, before_policy = snapshot()
    if active:
        raise SystemExit(f"Refusing restart: {active} active tasks; no files changed")
    account_config, chat_config = fetch("/api/account/config"), fetch("/api/chat/config")
    units = ["aegismesh.service", *(f"aegismesh-aip-agent@{name}.service" for name in AGENTS)]
    run("sudo", "-n", "systemctl", "is-active", "--quiet", *units)
    rollback = release / "deployment-backup" / ("admin-controls-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    rollback.mkdir(parents=True, mode=0o700)
    web = Path("/var/www/aegismesh")
    shutil.copy2(web / "index.html", rollback / "index.html")
    existed = []
    for path in FILES:
        destination = rollback / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        if (release / path).is_file():
            shutil.copy2(release / path, destination)
            existed.append(path)
    (rollback / "manifest.json").write_text(json.dumps({"files":FILES,"existed":existed,"full_backup":str(backup)}))

    if snapshot()[0]:
        raise SystemExit("New active task arrived; no files changed, release deferred")
    restarted = False
    try:
        for path in FILES:
            target = release / path
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".admin-stage")
            shutil.copy2(stage / path, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
        # Additive migration runs once before thirteen processes restart.
        env = dict(os.environ, PYTHONPATH="backend:.")
        run(str(release / ".venv/bin/python"), "-c",
            "from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); from app.main import initialize_schema; initialize_schema()",
            env=env)
        if snapshot()[0]:
            raise RuntimeError("New active task arrived; restore files without restart")
        restarted = True
        run("sudo", "-n", "systemctl", "restart", *units)
        for _ in range(40):
            try:
                config, chat = fetch("/api/account/config"), fetch("/api/chat/config")
                assert config == account_config and chat == chat_config
                run("sudo", "-n", "systemctl", "is-active", "--quiet", *units)
                assert snapshot()[1] == before_policy
                break
            except (AssertionError, OSError, ValueError, subprocess.CalledProcessError):
                time.sleep(1)
        else:
            raise RuntimeError("Readiness or policy-preservation check failed")
        for path in ("/api/admin/accounts/users", "/api/admin/quotas/usage"):
            try:
                fetch(path)
                raise RuntimeError("Admin route accepted an unauthenticated request")
            except urllib.error.HTTPError as error:
                assert error.code == 401
        shutil.copytree(stage / "frontend/dist/assets", web / "assets", dirs_exist_ok=True)
        shutil.copy2(stage / "frontend/dist/index.html", web / "index.admin-stage.html")
        (web / "index.admin-stage.html").replace(web / "index.html")
    except BaseException:
        for path in FILES:
            if path in existed:
                shutil.copy2(rollback / path, release / path)
            elif (release / path).is_file():
                # Only the newly introduced, explicitly allowlisted code file.
                (release / path).unlink()
        shutil.copy2(rollback / "index.html", web / "index.html")
        if restarted:
            run("sudo", "-n", "systemctl", "restart", *units)
        raise
    print(json.dumps({"release":str(release),"rollback":str(rollback),"services":len(units),
        "policy_preserved":True,"admin_auth_required":True,"index_sha256":digest(web / "index.html")}))


if __name__ == "__main__":
    main()
