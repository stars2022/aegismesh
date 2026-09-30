"""Promote the prepared account release without changing AIP identities or ports.

Run from a named release with PYTHONPATH=backend:., after retrieving the full backup.
The old service overrides and webpage are restored if readiness fails.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

from dotenv import load_dotenv
load_dotenv("public-aip.env", override=True)
from sqlalchemy import select, text
from app.config import get_settings
from app.database import SessionLocal, engine
from app.main import initialize_schema
from app.models import Agent, ProviderConfig
from app.account_models import AccountPolicy
from app.account_api import mail_ready
from app.services.account_policy import get_policy, ProviderBudget
from app.services.observability import record_admin_event
from scripts.serve import listener_options


def sudo(*args):
    return subprocess.run(["sudo", "-n", *args], check=True, capture_output=True, text=True).stdout.strip()


release = Path.cwd().resolve()
assert release.parent == Path("/home/zcode") and release.name.startswith("aegismesh-release-accounts-")
cfg = get_settings()
assert cfg.accounts_enabled and cfg.account_email_enabled and cfg.quota_mode == "enforce"
assert cfg.turnstile_enabled and cfg.turnstile_hostnames == "demmo.cc.cd" and cfg.turnstile_secret
assert cfg.account_owner_email == "2046738782@qq.com" and not cfg.account_oauth and mail_ready()
assert (release / "backend/data").is_symlink()
previous = Path(subprocess.check_output(["systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value"], text=True).strip())
assert previous != release and previous.is_dir()
assert (Path("/home/zcode/aegismesh-backups/pre-accounts-20260930T064010Z.tar.gz")).is_file()
with engine.connect() as db:
    active = db.execute(text("SELECT COUNT(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')")).scalar()
    active += db.execute(text("SELECT COUNT(*) FROM hosted_tasks WHERE state IN ('accepted','working')")).scalar()
    if active:
        raise SystemExit(f"Refusing restart: {active} active tasks")
with SessionLocal() as db:
    agents = db.scalars(select(Agent).where(Agent.active.is_(True), Agent.registration_status == "approved", Agent.transport != "aip-rpc")).all()
    names = sorted(agent.id for agent in agents)
assert len(names) == 12
for name in names:
    listener_options(cfg.model_copy(update={"aip_tls_agent_id": name}))
units = ["aegismesh.service", *(f"aegismesh-aip-agent@{name}.service" for name in names)]
backup = release / "deployment-backup"
backup.mkdir(mode=0o700, exist_ok=False)
web = Path("/var/www/aegismesh")
shutil.copy2(web / "index.html", backup / "index.html")
overrides = [Path("/etc/systemd/system/aegismesh.service.d/zz-aegismesh-release.conf"),
             Path("/etc/systemd/system/aegismesh-aip-agent@.service.d/zz-aegismesh-release.conf")]
for index, path in enumerate(overrides):
    original = path.read_text()
    assert str(previous) in original
    shutil.copy2(path, backup / f"override-{index}.conf")
    (backup / f"new-{index}.conf").write_text(original.replace(str(previous), str(release)))

# Initialize sequentially before the API and twelve AIP workers race to start.
initialize_schema()
with SessionLocal() as db:
    old = db.get(AccountPolicy, 1)
    old_policy = old.values if old else None
    policy = get_policy(db)
    policy.accounts_enabled, policy.email_enabled, policy.quota_mode = True, True, "enforce"
    policy.guest_turns, policy.daily_tasks, policy.concurrent_tasks = 3, 20, 2
    policy.member_monthly_units, policy.public_monthly_units = 1600000, 160000000
    for provider in db.scalars(select(ProviderConfig)):
        policy.provider_budgets[provider.id] = ProviderBudget(monthly_units=160000000, output_tokens=4096,
            role_monthly_units={"guest": 160000, "member": 1600000, "trusted": 4800000, "service": 1600000})
    row = old or AccountPolicy(id=1)
    row.values = policy.model_dump()
    db.add(row)
    db.commit()

try:
    for index, target in enumerate(overrides):
        sudo("cp", str(backup / f"new-{index}.conf"), str(target))
    sudo("systemctl", "daemon-reload")
    sudo("systemctl", "restart", *units)
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/api/account/config", timeout=2) as response:
                status = json.load(response)
            assert status["enabled"] and status["email_registration_ready"] and status["turnstile"]["ready"]
            assert status["quota_mode"] == "enforce" and not any(p["available"] for p in status["providers"])
            sudo("systemctl", "is-active", "--quiet", *units)
            break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError("Account service readiness failed")
    # Keep old hashed assets for already-open browsers; switch the entry atomically.
    for folder in ("assets", "media"):
        shutil.copytree(release / "frontend/dist" / folder, web / folder, dirs_exist_ok=True)
    shutil.copy2(release / "frontend/dist/index.html", web / "index.accounts.html")
    (web / "index.accounts.html").replace(web / "index.html")
    record_admin_event(actor="deployment", method="PUT", path="/api/admin/accounts/policy",
                       request_id="accounts-release-20260930", status_code=200, duration_ms=0,
                       note="用户授权上线账号、访客三轮、角色与供应商配额、Turnstile；第三方登录保持关闭")
except BaseException:
    for index, target in enumerate(overrides):
        sudo("cp", str(backup / f"override-{index}.conf"), str(target))
    with SessionLocal() as db:
        row = db.get(AccountPolicy, 1)
        if old_policy is None:
            db.delete(row)
        else:
            row.values = old_policy
        db.commit()
    sudo("systemctl", "daemon-reload")
    sudo("systemctl", "restart", *units)
    shutil.copy2(backup / "index.html", web / "index.html")
    raise
print(json.dumps({"release": str(release), "previous": str(previous), "units": len(units),
                  "accounts": True, "guest_turns": 3, "quota": "enforce", "oauth": False, "backup": str(backup)}))
