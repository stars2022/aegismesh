"""Deploy a narrow storage/logging repair after a verified off-host backup.

Run from the active release: python deploy-storage-recovery.py STAGE BACKUP SHA256.
STAGE/expected-current.json pins all source files, including the absent new module.
Only the individually investigated stale invocation may be interrupted. No schema,
account policy, credentials, identity, frontend, or log forwarding configuration changes.
"""
from __future__ import annotations

from datetime import datetime, timezone
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

FILES = ('backend/app/config.py', 'backend/app/database.py',
         'backend/app/services/account_providers.py', 'backend/app/services/model_budget.py',
         'backend/app/services/orchestrator.py', 'backend/app/services/runtime_recovery.py',
         'backend/app/services/persistence.py')
AGENTS = ('docs_overview', 'empirical_design', 'food_guide', 'heritage_guide', 'news_coordinator',
          'news_retrieval', 'news_timeline', 'news_verification', 'peer_review', 'research_leader',
          'travel_coordinator', 'travel_logistics')
PROTECTED_TABLES = ('account_policy', 'routing_policies', 'provider_configs', 'web_search_configs',
                    'platform_access', 'admin_accounts')
STALE_ID = 'inv-00e05231d5c1'
RELEASE = Path('/home/zcode/aegismesh-release-accounts-20260930')


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def digest(path):
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(path):
    with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=5) as response:
        return json.load(response)


def snapshot(database):
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=10) as db:
        db.execute('BEGIN')
        protected = {table: db.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall()
                     for table in PROTECTED_TABLES}
        policies = hashlib.sha256(json.dumps(protected, sort_keys=True).encode()).hexdigest()
        invocations = db.execute("SELECT id,status,created_at,result_data FROM invocations "
                                 "WHERE status NOT IN ('completed','failed','cancelled')").fetchall()
        hosted = db.execute("SELECT task_id FROM hosted_tasks WHERE state IN ('accepted','working')").fetchall()
        stale = db.execute('SELECT status,finished_at FROM invocations WHERE id=?', (STALE_ID,)).fetchone()
        quota = db.execute('SELECT status FROM quota_entries WHERE id=?', (STALE_ID,)).fetchone()
        models = db.execute("SELECT id,invocation_id,status,units FROM model_usage WHERE status='reserved'").fetchall()
        waiting = db.execute("SELECT task_id FROM hosted_tasks WHERE state='awaiting-completion' ORDER BY task_id").fetchall()
        load = db.execute('SELECT id,active_tasks,queued_tasks FROM agents WHERE active_tasks!=0 OR queued_tasks!=0').fetchall()
        return {'policies': policies, 'invocations': invocations, 'hosted': hosted, 'stale': stale,
                'quota': quota, 'models': models, 'waiting': waiting, 'load': load,
                'journal': db.execute('PRAGMA journal_mode').fetchone()[0]}


def require_safe_restart(state, main_pid):
    if state['hosted'] or {r[0] for r in state['invocations']} - {STALE_ID}:
        raise RuntimeError('New or legitimate in-flight work; deployment deferred')
    if state['invocations']:
        identifier, status, created, data = state['invocations'][0]
        data = json.loads(data or '{}')
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(created).replace(tzinfo=timezone.utc)).total_seconds()
        if (identifier != STALE_ID or status != 'working' or age < 3600 or state['quota'] != ('released',)
                or data.get('_runtime', {}).get('pid') != main_pid
                or any(t.get('status') != 'completed' for t in data.get('runtime_tools', []))):
            raise RuntimeError('Stale-task evidence changed; nothing modified')


def main():
    os.umask(0o077)
    stage, backup, backup_sha = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
    release = Path(run('systemctl', 'show', 'aegismesh', '--property=WorkingDirectory', '--value')).resolve()
    if release != RELEASE or Path.cwd().resolve() != release:
        raise SystemExit('Unexpected active release')
    if stage.parent != Path('/home/zcode') or not stage.name.startswith('aegismesh-storage-recovery-'):
        raise SystemExit('Unexpected stage directory')
    if backup.parent != Path('/home/zcode/aegismesh-backups') or digest(backup) != backup_sha:
        raise SystemExit('Private backup verification failed')
    if shutil.disk_usage(release).free < 512 * 1024 * 1024:
        raise SystemExit('Insufficient free space for safe WAL startup')
    expected = json.loads((stage / 'expected-current.json').read_text())
    if set(expected) != set(FILES) or any(digest(release / path) != expected[path] for path in FILES):
        raise SystemExit('Production source changed since review')
    for path in FILES:
        compile((stage / path).read_text(), path, 'exec')
    database = (release / 'backend/data/aegismesh.db').resolve()
    before = snapshot(database)
    main_pid = int(run('systemctl', 'show', 'aegismesh', '--property=MainPID', '--value'))
    require_safe_restart(before, main_pid)
    configs = {path: fetch(path) for path in ('/api/account/config', '/api/chat/config')}
    units = ['aegismesh.service', *(f'aegismesh-aip-agent@{name}.service' for name in AGENTS)]
    run('sudo', '-n', 'systemctl', 'is-active', '--quiet', *units, 'aegismesh-fluentbit.service')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    rollback = release / 'deployment-backup' / ('storage-recovery-' + stamp)
    rollback.mkdir(parents=True, mode=0o700)
    after_hashes = {path: digest(stage / path) for path in FILES}
    for path in FILES:
        if expected[path] is not None:
            destination = rollback / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(release / path, destination)
    (rollback / 'manifest.json').write_text(json.dumps({
        'before': expected, 'after': after_hashes, 'full_backup': str(backup), 'backup_sha256': backup_sha,
    }))
    before_stop = snapshot(database)
    require_safe_restart(before_stop, main_pid)
    if before_stop['policies'] != before['policies']:
        raise SystemExit('Protected policy changed; deployment deferred')
    stopped = False
    changed = False
    try:
        print(json.dumps({'phase': 'quiesce', 'stale_invocation': STALE_ID}), flush=True)
        stopped = True
        run('sudo', '-n', 'systemctl', 'stop', *units)
        state = snapshot(database)
        require_safe_restart(state, main_pid)
        if state['policies'] != before['policies']:
            raise RuntimeError('Protected policy changed during quiescence')
        changed = True
        for path in FILES:
            target = release / path
            temporary = target.with_suffix(target.suffix + '.storage-stage')
            if temporary.exists():
                raise RuntimeError('Unexpected temporary source file')
            shutil.copy2(stage / path, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
        print(json.dumps({'phase': 'start_main'}), flush=True)
        run('sudo', '-n', 'systemctl', 'start', units[0])
        for _ in range(55):
            try:
                if fetch('/api/health').get('status') != 'ok':
                    raise ValueError('Unhealthy backend')
                break
            except (OSError, ValueError):
                time.sleep(1)
        else:
            raise RuntimeError('Main backend readiness failed')
        run('sudo', '-n', 'systemctl', 'start', *units[1:])
        run('sudo', '-n', 'systemctl', 'is-active', '--quiet', *units, 'aegismesh-fluentbit.service')
        if any(fetch(path) != value for path, value in configs.items()):
            raise RuntimeError('Public module settings changed')
        after = snapshot(database)
        if after['policies'] != before['policies'] or after['waiting'] != before['waiting']:
            raise RuntimeError('Protected configuration or waiting-user tasks changed')
        if after['journal'] != 'wal' or (after['stale'] and after['stale'][0] not in {'failed', 'completed', 'cancelled'}):
            raise RuntimeError('WAL or abandoned-task recovery not effective')
        # Unknown usage is not refunded. Already-terminal orphaned tickets are estimated.
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            for entry_id, invocation_id, _, units_used in before['models']:
                status, persisted_units = db.execute('SELECT status,units FROM model_usage WHERE id=?', (entry_id,)).fetchone()
                terminal = db.execute('SELECT status FROM invocations WHERE id=?', (invocation_id,)).fetchone()
                if persisted_units != units_used or (terminal and terminal[0] in {'completed', 'failed', 'cancelled'} and status != 'estimated'):
                    raise RuntimeError('Model reservation recovery changed historical cost')
        for path in ('/api/admin/accounts/users', '/api/admin/quotas/usage'):
            try:
                fetch(path)
                raise RuntimeError('Unauthenticated admin access allowed')
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
        audit_id = 'storage-deploy-' + uuid.uuid4().hex
        run(str(release / '.venv/bin/python'), '-c',
            "import sys; from dotenv import load_dotenv; load_dotenv('public-aip.env', override=True); "
            "from app.services.observability import record_admin_event; "
            "record_admin_event(actor='operator:authorized-service-repair', method='PATCH', "
            "path='/runtime/storage-recovery', request_id=sys.argv[1], status_code=200, duration_ms=0, "
            "note='Verified off-host backup; storage failure rollback and lease cleanup, WAL and access logging fixed; quotas unchanged')",
            audit_id, env=dict(os.environ, PYTHONPATH='backend:.'))
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            if not db.execute("SELECT 1 FROM operational_logs WHERE request_id=? AND outcome='success'", (audit_id,)).fetchone():
                raise RuntimeError('Local repair audit missing')
        result = {'release': str(release), 'rollback': str(rollback), 'services': len(units),
                  'policy_preserved': True, 'admin_auth_required': True, 'audit_id': audit_id,
                  'journal_mode': after['journal'], 'stale_task': after['stale'], 'quota': after['quota'],
                  'active_invocation_ids': [r[0] for r in after['invocations']], 'agent_load': after['load'],
                  'deployed_sha256': after_hashes}
        (stage / 'deployment-result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    except BaseException:
        if stopped:
            run('sudo', '-n', 'systemctl', 'stop', *units)
        if changed:
            for path in FILES:
                if expected[path] is None:
                    if digest(release / path) == after_hashes[path]:
                        (release / path).unlink()
                else:
                    shutil.copy2(rollback / path, release / path)
        if stopped:
            run('sudo', '-n', 'systemctl', 'start', *units)
        raise


if __name__ == '__main__':
    main()
