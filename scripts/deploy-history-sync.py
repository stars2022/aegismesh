"""Publish history-only changes after a verified local database/config backup.

Run on the active release: python SCRIPT STAGE CONFIG_ARCHIVE CONFIG_SHA256.
Only the API is restarted; AIP listeners, credentials and quota policies stay intact.
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
import uuid
from datetime import datetime, timezone

RELEASE = Path('/home/zcode/aegismesh-release-accounts-20260930')
FILES = ('backend/app/account_models.py', 'backend/app/main.py', 'backend/app/conversation_api.py',
         'frontend/src/App.tsx', 'frontend/src/Demo.tsx', 'frontend/src/SettingsDialog.tsx',
         'frontend/src/SettingsDialog.css', 'frontend/src/conversationStorage.ts',
         'frontend/src/historyDocument.ts', 'frontend/src/conversationSync.ts', 'docs/conversation-sync.md')
PROTECTED = ('account_policy', 'routing_policies', 'provider_configs', 'web_search_configs', 'platform_access', 'admin_accounts')

def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def fetch(path):
    with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=10) as response:
        return json.load(response)

def main():
    os.umask(0o077)
    stage, backup, expected = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    active = Path(run('systemctl', 'show', 'aegismesh', '--property=WorkingDirectory', '--value')).resolve()
    if active != RELEASE or active != Path.cwd().resolve():
        raise SystemExit('Unexpected active release')
    if stage.parent != Path('/home/zcode') or not stage.name.startswith('aegismesh-history-'):
        raise SystemExit('Unexpected stage directory')
    if backup.parent != Path('/home/zcode/aegismesh-backups') or digest(backup) != expected:
        raise SystemExit('Configuration backup mismatch')
    manifest = json.loads((stage / 'deployment-manifest.json').read_text())
    if set(manifest['sources']) != set(FILES) or not manifest['database_backup']['locally_restored_and_checked']:
        raise SystemExit('Expected exact allowlist and verified local database backup')
    for name, hashes in manifest['sources'].items():
        target = RELEASE / name
        if (digest(target) if target.is_file() else None) != hashes['before'] or digest(stage / name) != hashes['after']:
            raise SystemExit('Source changed: ' + name)
        if name.endswith('.py'):
            compile((stage / name).read_text(), name, 'exec')
    if shutil.disk_usage(RELEASE).free < 384 * 1024 * 1024:
        raise SystemExit('Insufficient disk headroom')
    database = (RELEASE / 'backend/data/aegismesh.db').resolve()
    def snapshot():
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=10) as db:
            active = db.execute("SELECT count(*) FROM invocations WHERE status NOT IN ('completed','failed','cancelled')").fetchone()[0]
            active += db.execute("SELECT count(*) FROM hosted_tasks WHERE state IN ('accepted','working')").fetchone()[0]
            protected = {table: db.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall() for table in PROTECTED}
            protected['roles'] = db.execute('SELECT id,role FROM user_accounts ORDER BY id').fetchall()
            protected['conversations'] = db.execute('SELECT * FROM conversations ORDER BY id').fetchall()
            protected['agents'] = db.execute('SELECT id,active,aic,transport,model_provider,model_name,system_prompt,tools,skills FROM agents ORDER BY id').fetchall()
            protected['env'] = {path.name: digest(path) for path in [*RELEASE.glob('*.env'), RELEASE / '.env'] if path.is_file()}
        return active, hashlib.sha256(json.dumps(protected, sort_keys=True).encode()).hexdigest()
    active, protected_hash = snapshot()
    if active:
        raise SystemExit(f'{active} tasks still active; refusing restart')
    before_config = {path: fetch(path) for path in ('/api/account/config', '/api/chat/config')}
    rollback = RELEASE / 'deployment-backup' / ('history-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    rollback.mkdir(parents=True, mode=0o700)
    web = Path('/var/www/aegismesh')
    shutil.copy2(web / 'index.html', rollback / 'index.html')
    existed = []
    for name in FILES:
        if (RELEASE / name).is_file():
            target = rollback / name; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / name, target); existed.append(name)
    (rollback / 'manifest.json').write_text(json.dumps({**manifest, 'existed': existed}))
    if snapshot() != (0, protected_hash):
        raise SystemExit('Activity or settings changed before publication')
    restarted = False
    env = dict(os.environ, PYTHONPATH='backend:.')
    try:
        for name in FILES:
            target = RELEASE / name; target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + '.history-stage')
            shutil.copy2(stage / name, temporary); temporary.chmod(0o644); temporary.replace(target)
        # Import creates only the new additive table; no historical row is reassigned.
        run(str(RELEASE / '.venv/bin/python'), '-c',
            "from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); from app.main import initialize_schema; initialize_schema()", env=env)
        if snapshot() != (0, protected_hash):
            raise RuntimeError('Protected configuration or existing conversation ownership changed')
        restarted = True
        run('sudo', '-n', 'systemctl', 'restart', 'aegismesh.service')
        for _ in range(40):
            try:
                if fetch('/api/health')['status'] != 'ok':
                    raise ValueError('Unhealthy API')
                if any(fetch(path) != value for path, value in before_config.items()):
                    raise ValueError('Account/quota/runtime configuration changed')
                if snapshot()[1] != protected_hash:
                    raise ValueError('Protected state changed')
                break
            except (OSError, ValueError):
                time.sleep(1)
        else:
            raise RuntimeError('Readiness or preservation check failed')
        history = fetch('/api/account/history')
        if history['items']:
            raise RuntimeError('Anonymous browser saw existing account history')
        for path in ('/api/admin/accounts/users', '/api/admin/quotas/usage'):
            try:
                fetch(path)
                raise RuntimeError('Admin route was unexpectedly public')
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
        shutil.copytree(stage / 'frontend/dist/assets', web / 'assets', dirs_exist_ok=True)
        shutil.copy2(stage / 'frontend/dist/index.html', web / 'index.history-stage.html')
        (web / 'index.history-stage.html').replace(web / 'index.html')
        audit_id = 'history-deploy-' + uuid.uuid4().hex
        run(str(RELEASE / '.venv/bin/python'), '-c',
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env',override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-release',method='PATCH',path='/release/history-sync',"
            "request_id=sys.argv[1],status_code=200,duration_ms=0,note='Private history sync; verified local backup; policies and ownership preserved')", audit_id, env=env)
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            if not db.execute("SELECT 1 FROM operational_logs WHERE request_id=? AND outcome='success'", (audit_id,)).fetchone():
                raise RuntimeError('Deployment audit missing')
        print(json.dumps({'release': str(RELEASE), 'rollback': str(rollback), 'api_restarted': True,
                          'aip_restarted': False, 'protected_state_preserved': True, 'audit_id': audit_id,
                          'index_sha256': digest(web / 'index.html')}))
    except BaseException:
        for name in FILES:
            if name in existed:
                shutil.copy2(rollback / name, RELEASE / name)
            elif (RELEASE / name).is_file():
                (RELEASE / name).unlink()
        shutil.copy2(rollback / 'index.html', web / 'index.html')
        if restarted:
            run('sudo', '-n', 'systemctl', 'restart', 'aegismesh.service')
        raise

if __name__ == '__main__':
    main()
