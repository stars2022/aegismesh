#!/usr/bin/env bash
# Promote an already prepared release; preserve nginx, credentials and log shipper.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "${1:-}" == "--apply" ]] || { echo "Usage: $0 --apply (prepared release only)"; exit 2; }
[[ "$APP_DIR" =~ ^/home/[a-zA-Z0-9_-]+/aegismesh-release-[a-zA-Z0-9._-]+$ ]] || { echo "Expected a named /home/<user>/aegismesh-release-* directory"; exit 1; }
cd "$APP_DIR"
test -f .env
test -x .venv/bin/python
test -f frontend/dist/index.html
test -L backend/data
test -L logs
previous="$(systemctl show aegismesh --property=WorkingDirectory --value)"
[[ -d "$previous" && "$previous" != "$APP_DIR" ]] || { echo "Missing previous release, or already active"; exit 1; }
sudo -n true
export PYTHONPATH=backend
# A running process is not evidence of usable mTLS. Fail before any mutation.
.venv/bin/python -m scripts.check_aip_tls
.venv/bin/python - <<'PY'
import sqlite3
from pathlib import Path
from sqlalchemy import create_engine, inspect, text
from app.config import get_settings
from app.database import Base
from app import models  # Register tables before the API and TLS workers start together.
s = get_settings()
engine = create_engine(s.database_url)
with engine.connect() as c:
    active = c.execute(text("SELECT count(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')")).scalar()
    active += c.execute(text("SELECT count(*) FROM hosted_tasks WHERE state IN ('accepted','working')")).scalar()
    if active:
        raise SystemExit(f"Refusing to restart with {active} active tasks")
db_path = engine.url.database
if engine.url.get_backend_name() != 'sqlite' or not db_path:
    raise SystemExit('This release script requires SQLite backup support')
backup = Path('database-pre-release.sqlite3')
if backup.exists():
    raise SystemExit('Backup exists; inspect previous promotion attempt before retrying')
with sqlite3.connect(db_path) as src, sqlite3.connect(backup) as dst:
    src.backup(dst)
backup.chmod(0o600)
# Apply the additive migration once before starting both API and TLS workers.
Base.metadata.create_all(engine)
with engine.begin() as c:
    if 'interop_compatibility' not in {v['name'] for v in inspect(c).get_columns('routing_policies')}:
        c.execute(text('ALTER TABLE routing_policies ADD COLUMN interop_compatibility BOOLEAN DEFAULT 0'))
PY
backup_dir="$APP_DIR/service-backup"
mkdir -m 700 "$backup_dir"
override_name="zz-aegismesh-release.conf"
for unit in aegismesh aegismesh-mtls; do
    dest="/etc/systemd/system/$unit.service.d/$override_name"
    if sudo test -f "$dest"; then sudo cp "$dest" "$backup_dir/$unit.conf"; fi
    sudo mkdir -p "/etc/systemd/system/$unit.service.d"
done
rollback() {
    echo "Health check failed; restoring previous service configuration" >&2
    for unit in aegismesh aegismesh-mtls; do
        dest="/etc/systemd/system/$unit.service.d/$override_name"
        if sudo test -f "$backup_dir/$unit.conf"; then
            sudo cp "$backup_dir/$unit.conf" "$dest"
        else
            sudo rm -f "$dest"
        fi
    done
    sudo systemctl daemon-reload
    sudo systemctl restart aegismesh aegismesh-mtls
}
trap rollback ERR
for unit in aegismesh aegismesh-mtls; do
    if [[ "$unit" == "aegismesh" ]]; then
        launch="$APP_DIR/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1"
    else
        launch="$APP_DIR/.venv/bin/python -m scripts.serve"
    fi
    printf '[Service]\nWorkingDirectory=%s\nEnvironment=PYTHONPATH=%s/backend\nExecStart=\nExecStart=%s\n' "$APP_DIR" "$APP_DIR" "$launch" | sudo tee "/etc/systemd/system/$unit.service.d/$override_name" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl restart aegismesh aegismesh-mtls
healthy=false
for attempt in {1..20}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:8000/api/health >/dev/null && systemctl is-active --quiet aegismesh-mtls; then
        healthy=true
        break
    fi
    sleep 1
done
[[ "$healthy" == true ]]
trap - ERR
echo "Promoted: $APP_DIR"
echo "Previous: $previous; DB and override backups are in the release directory."
echo "Verify group_partner_ready logs before enabling compatibility; frontend is switched separately."
