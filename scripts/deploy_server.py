"""Build and deploy to a NEW Debian/Ubuntu systemd host over verified SSH.

Default: inspect only. --apply installs an isolated, loopback-only standby.
--mode lab explicitly publishes a fresh, non-production HTTP target by IP.
Never changes production DNS, the old host, registry, certificates or MQ owners.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_target(host, user, port):
    # This deployment command intentionally accepts an explicit IPv4 address.
    if not isinstance(ipaddress.ip_address(host), ipaddress.IPv4Address):
        raise ValueError('Use the explicit destination IPv4 address')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', user):
        raise ValueError('Invalid SSH user')
    if not 1 <= port <= 65535:
        raise ValueError('Invalid SSH port')


def verify_snapshot(path):
    path = path.resolve()
    if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise ValueError('Use an offline consistent SQLite snapshot, not an active database')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=10) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('Snapshot quick_check failed')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'agents', 'admin_accounts', 'provider_configs'} <= tables:
            raise ValueError('Snapshot is not an AegisMesh application database')
        if db.execute('SELECT count(*) FROM admin_accounts WHERE active=1').fetchone()[0] == 0:
            raise ValueError('Imported snapshot has no active administrator')
        for table, column, terminal in (
            ('invocations', 'status', ('completed', 'failed', 'cancelled')),
            ('hosted_tasks', 'state', ('completed', 'failed', 'canceled', 'cancelled', 'rejected')),
        ):
            if table in tables:
                placeholders = ','.join('?' for _ in terminal)
                if db.execute(f'SELECT count(*) FROM {table} WHERE {column} IS NULL OR {column} NOT IN ({placeholders})', terminal).fetchone()[0]:
                    raise ValueError('Snapshot contains in-flight tasks; obtain a quiescent snapshot before migration')


def build_bundle(project, dist, output, source_cache=None):
    if not (dist / 'index.html').is_file():
        raise ValueError('Missing built frontend index.html')
    tracked = subprocess.check_output(
        ['git', 'ls-files', '-z', '--', 'backend/app', 'pyproject.toml', 'README.md'], cwd=project,
    ).decode().split('\0')
    sources = {name: project / name for name in tracked if name}
    if source_cache:
        # An explicit materialized cache avoids iCloud placeholder stalls.
        # Never accept a stale source: every cached backend blob must equal the Git index.
        index = subprocess.check_output(['git', 'ls-files', '-s', '-z', '--', 'backend/app'], cwd=project).decode()
        for record in index.split('\0'):
            if not record:
                continue
            fields, name = record.split('\t', 1)
            _mode, expected, stage = fields.split()
            if stage != '0':
                raise ValueError('Unmerged backend source')
            path = source_cache / name
            if not path.is_file() or path.is_symlink():
                raise ValueError('Missing cached source: ' + name)
            data = path.read_bytes()
            actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            if actual != expected:
                raise ValueError('Cached backend source is not current: ' + name)
            sources[name] = path
    for name in ('scripts/serve.py', 'scripts/check_aip_tls.py'):
        sources[name] = project / name
    for path in sorted(dist.rglob('*')):
        if path.is_symlink():
            raise ValueError('Frontend symlinks are not accepted')
        if path.is_file():
            sources['frontend/dist/' + str(path.relative_to(dist))] = path
    manifest = {}
    with tarfile.open(output, 'w:gz') as archive:
        for name, path in sorted(sources.items()):
            if path.is_symlink() or not path.is_file():
                raise ValueError('Missing/symlink source: ' + name)
            if name.endswith('.py'):
                ast.parse(path.read_text(), filename=name)
            manifest[name] = {'sha256': digest(path), 'size': path.stat().st_size}
            info = archive.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode = 0o640
            with path.open('rb') as stream:
                archive.addfile(info, stream)
    output.chmod(0o600)
    return manifest


def ssh_options(args, run_dir):
    options = ['-p', str(args.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
               '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
               '-o', 'StrictHostKeyChecking=accept-new',
               '-o', f'UserKnownHostsFile={run_dir.parent / "known_hosts"}']
    if args.identity:
        options += ['-i', str(args.identity.resolve()), '-o', 'IdentitiesOnly=yes']
    return options


def remote(args, run_dir, command, *, capture=False, timeout=60):
    return subprocess.run(['ssh', *ssh_options(args, run_dir), f'{args.user}@{args.host}',
                           shlex.join(command)], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, timeout=timeout)


def upload(args, run_dir, paths, stage):
    # scp uses -P, not ssh's -p. All destinations are generated safe /tmp paths.
    options = ssh_options(args, run_dir)
    options[0] = '-P'
    subprocess.run(['scp', *options, *map(str, paths), f'{args.user}@{args.host}:{stage}/'],
                   check=True, timeout=1200)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='111.91.23.163')
    parser.add_argument('--user', default='root')
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--identity', type=Path)
    parser.add_argument('--apply', action='store_true', help='Install a fresh loopback-only standby; never switch DNS')
    parser.add_argument('--mode', choices=('standby', 'lab'), default='standby',
                        help='lab: fresh isolated IP/HTTP test target; no real accounts or credentials')
    parser.add_argument('--package-only', action='store_true', help='Build and audit bundle locally; no SSH')
    parser.add_argument('--skip-build', action='store_true', help='Explicitly use an already verified frontend build')
    parser.add_argument('--frontend-dist', type=Path, default=ROOT / 'frontend/dist')
    parser.add_argument('--source-cache', type=Path, help='Explicit materialized backend cache; must match Git index blobs')
    parser.add_argument('--env-file', type=Path, help='Private environment file; paired with --database-snapshot')
    parser.add_argument('--database-snapshot', type=Path, help='Verified offline SQLite snapshot; not a live DB')
    args = parser.parse_args()
    validate_target(args.host, args.user, args.port)
    if bool(args.env_file) != bool(args.database_snapshot):
        raise ValueError('Import requires BOTH --env-file and --database-snapshot, preserving encryption keys')
    if args.mode == 'lab' and (args.env_file or args.database_snapshot):
        raise ValueError('Lab targets MUST NOT import production configuration or data')
    os.umask(0o077)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    run_dir = ROOT / 'var/deploy-new-server' / stamp
    run_dir.mkdir(parents=True, mode=0o700)
    if args.database_snapshot:
        verify_snapshot(args.database_snapshot)
        if not args.env_file.is_file() or args.env_file.is_symlink():
            raise ValueError('Private environment file missing or symlinked')
    if not args.apply and not args.package_only:
        remote(args, run_dir, ['sh', '-c',
            'id; uname -srm; cat /etc/os-release; df -h /; '
            'python3 --version; systemctl list-units --all --no-legend "aegismesh*"; '
            'ss -lnt | head -25'])
        print('Read-only preflight complete; no installation or DNS changes.')
        return
    if not args.skip_build:
        subprocess.run(['npm', 'ci'], cwd=ROOT / 'frontend', check=True)
        subprocess.run(['npm', 'run', 'build'], cwd=ROOT / 'frontend', check=True)
    bundle = run_dir / 'application.tar.gz'
    print('Verifying application sources and frontend bundle...', flush=True)
    files = build_bundle(ROOT, args.frontend_dist.resolve(), bundle, args.source_cache)
    plan = {'host': args.host, 'user': args.user, 'port': args.port,
            'git_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'bundle_sha256': digest(bundle), 'files': files,
            'database_import': bool(args.database_snapshot), 'public_listener': args.mode == 'lab',
            'runtime_mode': args.mode, 'dns_changed': False,
            'background_workers_enabled': False, 'mq_consumers_enabled': False}
    uploads = [bundle, ROOT / 'scripts/install_server.py']
    if args.env_file:
        # Private artifacts only; never archive them with the application sources.
        import shutil
        for source, name in ((args.env_file, 'import.env'), (args.database_snapshot, 'import.sqlite3')):
            target = run_dir / name
            shutil.copyfile(source, target)
            target.chmod(0o600)
            plan[name + '_sha256'] = digest(target)
            uploads.append(target)
    manifest = run_dir / 'manifest.json'
    plan['installer_sha256'] = digest(ROOT / 'scripts/install_server.py')
    manifest.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    uploads.append(manifest)
    print(f'Bundle verified: {len(files)} files; private artifacts: {run_dir}', flush=True)
    if args.package_only:
        print('Package only: no network, no remote changes.')
        return
    stage = remote(args, run_dir, ['mktemp', '-d', '/tmp/aegismesh-install-XXXXXXXX'], capture=True).stdout.strip()
    if not re.fullmatch(r'/tmp/aegismesh-install-[A-Za-z0-9]{8,}', stage):
        raise ValueError('Unexpected remote staging directory')
    (run_dir / 'remote-stage.txt').write_text(stage + '\n')
    upload(args, run_dir, uploads, stage)
    command = ['python3', '-I', '-S', stage + '/install_server.py', '--stage', stage,
               '--expected-installer-sha256', plan['installer_sha256']]
    if args.user != 'root':
        command = ['sudo', '-n', *command]
    remote(args, run_dir, command, timeout=1800)
    result = remote(args, run_dir, ['cat', stage + '/result.json'], capture=True).stdout
    (run_dir / 'result.json').write_text(result)
    if args.mode == 'lab':
        print(f'Isolated HTTP test target: http://{args.host}/ ; no production configuration or data imported.')
        print('HTTP is for disposable test accounts only; never enter production passwords or provider keys.')
    else:
        print('Standby installed. Existing production server and DNS were not changed.')
        print(f'Inspect securely: ssh -p {args.port} -L 18080:127.0.0.1:18080 {args.user}@{args.host}')
        print('Then open http://127.0.0.1:18080/admin .')
    print('Initial credentials remain in /opt/aegismesh/initial-admin.json (root only).')
    print('No MQ/AIP identity or production traffic has been activated.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        if isinstance(exc, subprocess.CalledProcessError):
            raise SystemExit(f'Deployment stopped (exit {exc.returncode}); no source-server or DNS changes.')
        raise SystemExit(str(exc))
