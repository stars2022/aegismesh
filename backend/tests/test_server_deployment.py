"""Offline bootstrap guards. No credentials, network or package-manager calls."""
import hashlib
import importlib.util
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load('deploy_server')
installer = load('install_server')


def make_archive(path, name='backend/app/main.py', kind=tarfile.REGTYPE):
    payload = b'print("safe")\n'
    with tarfile.open(path, 'w:gz') as archive:
        item = tarfile.TarInfo(name)
        item.type = kind
        item.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
        item.size = len(payload) if kind == tarfile.REGTYPE else 0
        archive.addfile(item, io.BytesIO(payload) if item.size else None)
    return {name: {'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)}}


class DeploymentTest(unittest.TestCase):
    def test_target_validation(self):
        deploy.validate_target('111.91.23.163', 'root', 22)
        for host, user, port in [('127.0.0.1;id', 'root', 22), ('::1', 'root', 22),
                                 ('111.91.23.163', 'root;id', 22), ('111.91.23.163', 'root', 0)]:
            with self.subTest(host=host, user=user, port=port), self.assertRaises(ValueError):
                deploy.validate_target(host, user, port)

    def test_standby_environment_cannot_be_overridden_by_imported_file(self):
        unit = installer.systemd_config(Path('/opt/aegismesh/release'))
        self.assertNotIn('\nEnvironmentFile=', unit)
        for value in ('BACKGROUND_WORKER_ENABLED=false', 'AIP_GROUP_LISTENER_WORKER=false',
                      'AIP_GROUP_PARTNER_ENABLED=false', 'ADMIN_AUTH_ENABLED=true'):
            self.assertIn('Environment=' + value, unit)
        self.assertIn('--host 127.0.0.1 --port 18081 --workers 1', unit)
        self.assertIn('User=aegismesh', unit)
        self.assertIn('NoNewPrivileges=true', unit)

    def test_nginx_only_local_no_aip_proxy(self):
        nginx = installer.nginx_config()
        self.assertIn('listen 127.0.0.1:18080;', nginx)
        self.assertNotIn('listen 80;', nginx)
        self.assertNotIn('listen 443', nginx)
        self.assertIn('location ^~ /aip/ { return 404; }', nginx)
        self.assertIn('proxy_buffering off;', nginx)

    def test_lab_requires_explicit_mode_and_keeps_backend_private(self):
        nginx = installer.nginx_config('lab', '111.91.23.163')
        self.assertIn('listen 0.0.0.0:80;', nginx)
        self.assertIn('server_name 111.91.23.163', nginx)
        self.assertIn('proxy_pass http://127.0.0.1:18081;', nginx)
        self.assertIn('location ^~ /aip/ { return 404; }', nginx)
        with self.assertRaises(ValueError):
            installer.nginx_config('lab', '111.91.23.163; bad directive')
        with self.assertRaises(ValueError):
            installer.nginx_config('unknown')

    def test_lab_rejects_production_import_before_io(self):
        args = ['deploy_server.py', '--mode', 'lab', '--apply', '--env-file', '/missing/production.env',
                '--database-snapshot', '/missing/production.db']
        with patch.object(sys, 'argv', args), self.assertRaisesRegex(ValueError, 'MUST NOT import'):
            deploy.main()

    def test_verified_extract_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bundle = root / 'app.tar.gz'
            expected = make_archive(bundle)
            installer.extract_verified(bundle, root / 'release', expected)
            self.assertEqual((root / 'release/backend/app/main.py').read_bytes(), b'print("safe")\n')
            with self.assertRaises(FileExistsError):
                installer.extract_verified(bundle, root / 'release', expected)

    def test_unsafe_archive_members(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/tmp/outside', tarfile.REGTYPE),
                           ('backend/app/link', tarfile.SYMTYPE), ('backend/app/device', tarfile.CHRTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                expected = make_archive(root / 'app.tar.gz', name, kind)
                with self.assertRaises(ValueError):
                    installer.extract_verified(root / 'app.tar.gz', root / 'release', expected)

    def test_archive_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            expected = make_archive(root / 'app.tar.gz')
            expected['backend/app/main.py']['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                installer.extract_verified(root / 'app.tar.gz', root / 'release', expected)

    def test_snapshot_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.db'
            with sqlite3.connect(path) as db:
                db.executescript('CREATE TABLE agents(id); CREATE TABLE admin_accounts(active); '
                    'INSERT INTO admin_accounts VALUES(1); CREATE TABLE provider_configs(id); '
                    'CREATE TABLE invocations(status); INSERT INTO invocations VALUES("completed");')
            deploy.verify_snapshot(path)
            with sqlite3.connect(path) as db:
                db.execute('INSERT INTO invocations VALUES("queued")')
            with self.assertRaisesRegex(ValueError, 'in-flight'):
                deploy.verify_snapshot(path)
            Path(str(path) + '-wal').touch()
            with self.assertRaisesRegex(ValueError, 'offline'):
                deploy.verify_snapshot(path)

    def test_application_bundle_excludes_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            paths = ['pyproject.toml', 'README.md', 'backend/app/main.py',
                     'scripts/serve.py', 'scripts/check_aip_tls.py']
            for name in paths:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('x=1\n')
            (root / '.env').write_text('DO_NOT_PACKAGE=secret\n')
            dist = root / 'dist'
            dist.mkdir()
            (dist / 'index.html').write_text('<html>frontend</html>')
            bundle = root / 'app.tar.gz'
            with patch.object(deploy.subprocess, 'check_output', return_value='\0'.join(paths[:3]).encode()):
                manifest = deploy.build_bundle(root, dist, bundle)
                with tarfile.open(bundle) as archive:
                    self.assertEqual(set(archive.getnames()), set(manifest))
                    self.assertNotIn('.env', archive.getnames())
                    self.assertIn('frontend/dist/index.html', archive.getnames())
                self.assertEqual(bundle.stat().st_mode & 0o777, 0o600)
                (dist / 'leak').symlink_to(root / '.env')
                with self.assertRaisesRegex(ValueError, 'symlinks'):
                    deploy.build_bundle(root, dist, root / 'rejected.tar.gz')


if __name__ == '__main__':
    unittest.main()
