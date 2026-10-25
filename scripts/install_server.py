"""Remote half of deploy_server.py. Fresh host, private standby, fail closed."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import secrets
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.error
import urllib.request

BASE = Path('/opt/aegismesh')
WEB = Path('/var/www/aegismesh-standby')
UNIT = Path('/etc/systemd/system/aegismesh-standby.service')
NGINX = Path('/etc/nginx/conf.d/aegismesh-standby.conf')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def extract_verified(bundle, destination, expected):
    """Extract only regular, allowlisted files; reject links, devices and traversal."""
    with tarfile.open(bundle, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError('Bundle exceeds conservative size limits')
        if len({m.name for m in members}) != len(members):
            raise ValueError('Duplicate archive members')
        if {m.name for m in members} != set(expected):
            raise ValueError('Archive manifest mismatch')
        for member in members:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not member.isfile()
                    or member.name not in expected or '\\' in member.name):
                raise ValueError('Unsafe archive member')
            if member.size != expected[member.name]['size']:
                raise ValueError('Archive member size mismatch')
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            # x mode prevents following or replacing any pre-existing file.
            with archive.extractfile(member) as source, target.open('xb') as out:
                shutil.copyfileobj(source, out)
            if digest(target) != expected[member.name]['sha256']:
                raise ValueError('Archive member hash mismatch')
            target.chmod(0o640)


def systemd_config(release, memory_limit='1536M'):
    return f'''[Unit]
Description=AegisMesh isolated standby (no MQ or background workers)
After=network-online.target aegismesh-bootstrap-swap.service
Wants=network-online.target
[Service]
User=aegismesh
Group=aegismesh
WorkingDirectory={release}
# Settings reads .env itself. Do NOT use EnvironmentFile here: systemd's
# EnvironmentFile values would override the locked standby constraints below.
Environment=PYTHONPATH={release}/backend
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=BACKGROUND_WORKER_ENABLED=false
Environment=AIP_GROUP_LISTENER_WORKER=false
Environment=AIP_GROUP_PARTNER_ENABLED=false
Environment=LOG_INDEXER_ENABLED=false
Environment=ADMIN_AUTH_ENABLED=true
Environment=ADMIN_COOKIE_SECURE=false
Environment=ACCOUNT_EMAIL_ENABLED=false
Environment=DATABASE_URL=sqlite:///{BASE}/state/aegismesh.db
Environment=AMP_LOG_DIR={BASE}/logs
ExecStart={release}/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 18081 --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=on-failure
RestartSec=5
TimeoutStopSec=180
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={BASE}/state {BASE}/logs
MemoryMax={memory_limit}
TasksMax=256
[Install]
WantedBy=multi-user.target
'''


def nginx_config(mode='standby', host='111.91.23.163'):
    if mode not in ('standby', 'lab'):
        raise ValueError('Invalid runtime mode')
    import ipaddress
    ipaddress.IPv4Address(host)
    listener = '0.0.0.0:80' if mode == 'lab' else '127.0.0.1:18080'
    return f'''# Lab mode is explicit: disposable test identities only; no production secrets.
server {{
    listen {listener};
    server_name {host} localhost 127.0.0.1;
    root {WEB};
    index index.html;
    client_max_body_size 25m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    location ^~ /aip/ {{ return 404; }}
    location ~ /\\.(?!well-known/) {{ return 404; }}
    location ~ ^/(api/|\\.well-known/|docs$|openapi\\.json$) {{
        proxy_pass http://127.0.0.1:18081;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }}
    location / {{ try_files $uri $uri/ /index.html; }}
}}
'''


def ensure_low_memory_swap(run):
    """Add dedicated swap on tiny fresh VMs, without rewriting /etc/fstab."""
    values = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
              if line.startswith(('MemTotal:', 'SwapTotal:'))}
    small = values['MemTotal'] < 1024 * 1024
    if not small or values['SwapTotal'] >= 1024 * 1024:
        return small, False
    directory = Path('/var/lib/aegismesh-bootstrap')
    unit = Path('/etc/systemd/system/aegismesh-bootstrap-swap.service')
    if directory.exists() or unit.exists():
        raise ValueError('Existing bootstrap swap resources require manual review')
    directory.mkdir(mode=0o700)
    swap = directory / 'swapfile'
    swap.touch(mode=0o600, exist_ok=False)
    run('fallocate', '-l', '2G', str(swap))
    run('mkswap', str(swap))
    binary = shutil.which('swapon')
    if not binary:
        raise ValueError('swapon is not installed')
    unit.write_text('[Unit]\nDescription=Dedicated swap for small AegisMesh host\n'
                    'After=local-fs.target\nBefore=aegismesh-standby.service\n'
                    '[Service]\nType=oneshot\nRemainAfterExit=yes\n'
                    f'ExecStart={binary} {swap}\n[Install]\nWantedBy=multi-user.target\n')
    unit.chmod(0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', unit.name)
    return small, True


def ready_check(mode='standby'):
    base = 'http://127.0.0.1:80' if mode == 'lab' else 'http://127.0.0.1:18080'
    with urllib.request.urlopen(base + '/api/health', timeout=5) as response:
        if json.load(response).get('status') != 'ok':
            raise ValueError('Health response is not ready')
    with urllib.request.urlopen(base + '/', timeout=5) as response:
        if response.status != 200 or b'<html' not in response.read().lower():
            raise ValueError('Frontend is not ready')
    for path, expected in (('/api/admin/accounts/users', 401), ('/aip/rpc', 404)):
        try:
            urllib.request.urlopen(base + path, timeout=5)
            raise ValueError('Protected path unexpectedly accessible: ' + path)
        except urllib.error.HTTPError as exc:
            if exc.code != expected:
                raise ValueError('Unexpected authorization status') from None


def publish_fresh_lab(stage, host):
    """Publish only a bootstrap-owned, empty standby; never convert a production install."""
    import ipaddress
    ipaddress.IPv4Address(host)
    original = json.loads((BASE / 'deployment-result.json').read_text())
    if original.get('status') != 'standby_ready' or original.get('database_imported') is not False:
        raise ValueError('Only a fresh non-imported standby may be published as a lab')
    if not (BASE / 'initial-admin.json').is_file():
        raise ValueError('Fresh bootstrap administrator marker missing')
    release = Path(original['release'])
    if release != BASE / 'release' or not NGINX.is_file() or NGINX.is_symlink():
        raise ValueError('Unexpected installation layout')
    # No production environment secrets can be introduced through this conversion.
    keys = {line.split('=', 1)[0].strip() for line in (release / '.env').read_text().splitlines()
            if line.strip() and not line.lstrip().startswith('#') and '=' in line}
    allowed = {'ADMIN_SESSION_SECRET', 'PROVIDER_ENCRYPTION_KEY', 'QUOTA_MODE', 'ACCOUNTS_ENABLED', 'LLM_ENABLED'}
    if not keys <= allowed:
        raise ValueError('Environment is no longer a pristine test installation')
    sockets = subprocess.check_output(['ss', '-H', '-lnt'], text=True)
    if any(line.split()[3].rsplit(':', 1)[-1] == '80' for line in sockets.splitlines()):
        raise ValueError('Port 80 is already occupied')
    database = BASE / 'state/aegismesh.db'
    backup = BASE / ('lab-baseline-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    backup.mkdir(mode=0o700)
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as source:
        for table in ('agents', 'user_accounts', 'provider_configs', 'conversations', 'invocations'):
            if source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]:
                raise ValueError('Test installation already contains business data; manual review required')
        with sqlite3.connect(backup / 'baseline.sqlite3') as target:
            source.backup(target)
    for source in (release / '.env', UNIT, NGINX, BASE / 'deployment-result.json'):
        shutil.copyfile(source, backup / source.name)
        (backup / source.name).chmod(0o600)
    (backup / 'baseline.sqlite3').chmod(0o600)
    previous = NGINX.read_bytes()
    temporary = NGINX.with_suffix('.lab-staging')
    temporary.write_text(nginx_config('lab', host))
    temporary.chmod(0o644)
    # The staging filename is not a *.conf and isn't loaded before the atomic replacement.
    temporary.replace(NGINX)
    try:
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
        for attempt in range(10):
            try:
                ready_check('lab')
                break
            except (OSError, ValueError):
                if attempt == 9:
                    raise
                time.sleep(.5)
        result = {**original, 'status': 'lab_ready', 'public_listener': True,
                  'public_url': f'http://{host}/', 'baseline_backup': str(backup),
                  'production_data_present': False, 'dns_required': False,
                  'checks': ['frontend_200', 'health_ok', 'admin_401', 'web_aip_404']}
        (BASE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
        (stage / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except BaseException:
        NGINX.write_bytes(previous)
        NGINX.chmod(0o644)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
        raise


def main():
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--expected-installer-sha256', required=True)
    parser.add_argument('--publish-lab', action='store_true', help='Explicitly publish an already verified, empty standby by IP')
    parser.add_argument('--host', default='111.91.23.163')
    args = parser.parse_args()
    os.umask(0o077)
    stage = args.stage.resolve()
    if stage.parent != Path('/tmp') or not stage.name.startswith('aegismesh-install-'):
        raise ValueError('Invalid private staging directory')
    if os.geteuid() != 0 or digest(Path(__file__).resolve()) != args.expected_installer_sha256:
        raise ValueError('Root execution and hash-pinned installer required')
    lock = open('/run/lock/aegismesh-bootstrap.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.publish_lab:
        publish_fresh_lab(stage, args.host)
        return
    if sys.version_info < (3, 11) or not Path('/run/systemd/system').is_dir():
        raise ValueError('Requires systemd and Python >=3.11 (Debian 12+/Ubuntu 24.04+)')
    if not shutil.which('apt-get'):
        raise ValueError('This installer supports apt-based Debian/Ubuntu only')
    if any(p.exists() or p.is_symlink() for p in (BASE, WEB, UNIT, NGINX)):
        raise ValueError('Target installation already exists; refusing to overwrite. Use a reviewed release upgrade.')
    if subprocess.run(['systemctl', 'cat', 'aegismesh.service'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode == 0:
        raise ValueError('Existing production AegisMesh unit found; refusing fresh-host installation')
    sockets = subprocess.check_output(['ss', '-H', '-lnt'], text=True)
    if any(line.split()[3].rsplit(':', 1)[-1] in ('18080', '18081') for line in sockets.splitlines()):
        raise ValueError('Standby ports already in use')
    plan = json.loads((stage / 'manifest.json').read_text())
    mode = plan.get('runtime_mode')
    if mode not in ('standby', 'lab') or plan.get('public_listener') != (mode == 'lab'):
        raise ValueError('Runtime mode/public-listener mismatch')
    if mode == 'lab' and plan.get('database_import'):
        raise ValueError('Lab targets cannot import production configuration or databases')
    bundle = stage / 'application.tar.gz'
    if digest(bundle) != plan['bundle_sha256']:
        raise ValueError('Uploaded bundle hash mismatch')
    imported = plan['database_import']
    for name in ('import.env', 'import.sqlite3') if imported else ():
        if digest(stage / name) != plan[name + '_sha256']:
            raise ValueError('Private import hash mismatch')
    required = sum(f['size'] for f in plan['files'].values()) + 2 * 1024**3
    if imported:
        required += (stage / 'import.sqlite3').stat().st_size * 3
    if shutil.disk_usage('/').free < required:
        raise ValueError('Insufficient disk headroom; no installation performed')
    log = (stage / 'install.log').open('a')

    def run(*command, **kwargs):
        return subprocess.run(command, check=True, stdout=log, stderr=log, timeout=1200, **kwargs)

    small_memory, swap_created = ensure_low_memory_swap(run)
    # Preserve existing nginx/firewall/apps. Suppress automatic package service
    # starts so a new nginx package cannot expose its default HTTP welcome site.
    nginx_preexisting = bool(shutil.which('nginx'))
    policy = Path('/usr/sbin/policy-rc.d')
    policy_created = not (policy.exists() or policy.is_symlink())
    if policy_created:
        policy.write_text('#!/bin/sh\nexit 101\n')
        policy.chmod(0o755)
    try:
        run('apt-get', 'update', env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
        run('apt-get', 'install', '-y', 'python3-venv', 'python3-dev', 'build-essential', 'git',
            'ca-certificates', 'nginx', env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
    finally:
        if policy_created:
            policy.unlink()
    if not nginx_preexisting:
        default = Path('/etc/nginx/sites-enabled/default')
        if default.is_symlink() and os.readlink(default) == '/etc/nginx/sites-available/default':
            # Only the newly installed package's link; recoverable in private staging.
            default.rename(stage / 'nginx-package-default-link')
    run('nginx', '-t')
    try:
        pwd.getpwnam('aegismesh')
        raise ValueError('Existing aegismesh user found; do not repurpose another installation account')
    except KeyError:
        run('useradd', '--system', '--user-group', '--home-dir', str(BASE), '--shell', '/usr/sbin/nologin', 'aegismesh')
    identity = pwd.getpwnam('aegismesh')
    BASE.mkdir(mode=0o750)
    release = BASE / 'release'
    release.mkdir(mode=0o750)
    for name in ('state', 'logs'):
        path = BASE / name
        path.mkdir(mode=0o700)
        os.chown(path, identity.pw_uid, identity.pw_gid)
    extract_verified(bundle, release, plan['files'])
    for path in (BASE, release, *release.rglob('*')):
        os.chown(path, 0, identity.pw_gid)
        path.chmod(0o750 if path.is_dir() else 0o640)
    # The venv is freshly created on Linux, never copied from the developer's Mac.
    os.umask(0o022)
    run('python3', '-m', 'venv', str(release / '.venv'))
    python = str(release / '.venv/bin/python')
    run(python, '-m', 'pip', 'install', '.', cwd=release)
    os.umask(0o077)
    db = BASE / 'state/aegismesh.db'
    if imported:
        shutil.copyfile(stage / 'import.sqlite3', db)
        shutil.copyfile(stage / 'import.sqlite3', BASE / 'state/import-before-schema.sqlite3')
        with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Restored database validation failed')
        text = (stage / 'import.env').read_text()
    else:
        encryption = subprocess.check_output([python, '-c',
            'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'], text=True).strip()
        text = (f'ADMIN_SESSION_SECRET={secrets.token_urlsafe(48)}\n'
                f'PROVIDER_ENCRYPTION_KEY={encryption}\nQUOTA_MODE=enforce\n'
                'ACCOUNTS_ENABLED=false\nLLM_ENABLED=false\n')
    # The import is retained unchanged; operational constraints are explicit systemd overrides.
    env_file = release / '.env'
    env_file.write_text(text)
    env_file.chmod(0o640)
    os.chown(env_file, 0, identity.pw_gid)
    env = {**os.environ, 'PYTHONPATH': str(release / 'backend'),
           'DATABASE_URL': f'sqlite:///{db}', 'BACKGROUND_WORKER_ENABLED': 'false',
           'AIP_GROUP_LISTENER_WORKER': 'false', 'AIP_GROUP_PARTNER_ENABLED': 'false',
           'LOG_INDEXER_ENABLED': 'false', 'AMP_LOG_DIR': str(BASE / 'logs')}
    # Validate the imported encryption/session keys before starting any process.
    run(python, '-c', 'from app.config import get_settings; from cryptography.fernet import Fernet; '
        's=get_settings(); assert len(s.admin_session_secret)>=32; Fernet(s.provider_encryption_key)', cwd=release, env=env)
    if not imported:
        password = secrets.token_urlsafe(24)
        run(python, '-m', 'app.cli', 'admin', 'set', '--username', 'admin', '--password-stdin',
            input=password + '\n', text=True, cwd=release, env=env)
        credentials = BASE / 'initial-admin.json'
        credentials.write_text(json.dumps({'username': 'admin', 'password': password}) + '\n')
        credentials.chmod(0o600)
    run(python, '-c', 'from app.main import initialize_schema; initialize_schema()', cwd=release, env=env)
    for path in (BASE / 'state').iterdir():
        path.chmod(0o600)
        os.chown(path, identity.pw_uid, identity.pw_gid)
    shutil.copytree(release / 'frontend/dist', WEB)
    for path in (WEB, *WEB.rglob('*')):
        path.chmod(0o755 if path.is_dir() else 0o644)
    unit_written = nginx_written = False
    try:
        UNIT.write_text(systemd_config(release, '640M' if small_memory else '1536M'))
        UNIT.chmod(0o644)
        unit_written = True
        NGINX.write_text(nginx_config(mode, plan['host']))
        NGINX.chmod(0o644)
        nginx_written = True
        run('nginx', '-t')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', 'aegismesh-standby.service')
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'nginx']).returncode:
            run('systemctl', 'start', 'nginx')
        else:
            run('systemctl', 'reload', 'nginx')
        for attempt in range(30):
            try:
                ready_check(mode)
                break
            except (OSError, ValueError):
                if attempt == 29:
                    raise
                time.sleep(1)
        run('systemctl', 'enable', 'aegismesh-standby.service')
        # Identify the actual sockets; do not infer safety from systemd active state.
        sockets = subprocess.check_output(['ss', '-H', '-lnt'], text=True)
        frontend_port = '80' if mode == 'lab' else '18080'
        addresses = [line.split()[3] for line in sockets.splitlines()
                     if line.split()[3].rsplit(':', 1)[-1] in (frontend_port, '18081')]
        expected_addresses = {'0.0.0.0:80', '127.0.0.1:18081'} if mode == 'lab' else {'127.0.0.1:18080', '127.0.0.1:18081'}
        if set(addresses) != expected_addresses:
            raise ValueError('Socket binding verification failed')
        result = {'status': mode + '_ready', 'release': str(release),
                  'git_commit': plan['git_commit'], 'bundle_sha256': plan['bundle_sha256'],
                  'database_imported': imported, 'public_listener': mode == 'lab', 'dns_changed': False,
                  'low_memory_host': small_memory, 'dedicated_swap_created': swap_created,
                  'background_workers_enabled': False, 'mq_consumers_enabled': False,
                  'checks': ['frontend_200', 'health_ok', 'admin_401', 'web_aip_404', 'loopback_sockets'],
                  'log': str(stage / 'install.log')}
        (stage / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        (BASE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except BaseException:
        # Only our new unit/config are removed; all data and installation logs stay recoverable.
        if unit_written:
            subprocess.run(['systemctl', 'disable', '--now', 'aegismesh-standby.service'], stdout=log, stderr=log)
            UNIT.unlink(missing_ok=True)
            subprocess.run(['systemctl', 'daemon-reload'], stdout=log, stderr=log)
        if nginx_written:
            NGINX.unlink(missing_ok=True)
            if subprocess.run(['nginx', '-t'], stdout=log, stderr=log).returncode == 0:
                subprocess.run(['systemctl', 'reload', 'nginx'], stdout=log, stderr=log)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Dependency/setup logs can contain private provider settings; never echo them.
        if isinstance(exc, subprocess.CalledProcessError):
            raise SystemExit(f'Installation stopped (exit {exc.returncode}); inspect the private staging install.log.')
        raise SystemExit(f'Installation stopped: {type(exc).__name__}: {exc}')
