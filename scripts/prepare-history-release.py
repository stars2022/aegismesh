"""Build an exact, hash-pinned history release bundle (no production mutation)."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

os.umask(0o077)
workspace = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('history_release', workspace / 'scripts/deploy-history-sync.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
root = (workspace / sys.argv[1]).resolve()
verified = json.loads((root / 'database-verification.json').read_text())
if not verified['locally_restored_and_checked']:
    raise SystemExit('Database backup has not been verified locally')
code = "import hashlib,json; from pathlib import Path; root=Path(" + repr(str(release.RELEASE)) + "); files=" + repr(release.FILES) + "; print(json.dumps({name: hashlib.sha256((root/name).read_bytes()).hexdigest() if (root/name).is_file() else None for name in files}))"
before = json.loads(subprocess.check_output(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'zcode@34.150.109.119', 'python3', '-c', __import__('shlex').quote(code)], text=True))
manifest = {'sources': {name: {'before': before[name], 'after': release.digest(workspace / name)} for name in release.FILES},
            'database_backup': verified, 'git_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, text=True).strip(),
            'index_sha256': release.digest(workspace / 'frontend/dist/index.html')}
(root / 'deployment-manifest.json').write_text(json.dumps(manifest, indent=2))
with tarfile.open(root / 'stage.tar.gz', 'w:gz') as archive:
    for name in release.FILES:
        archive.add(workspace / name, arcname=name)
    archive.add(workspace / 'frontend/dist', arcname='frontend/dist')
    archive.add(root / 'deployment-manifest.json', arcname='deployment-manifest.json')
print(json.dumps({'sources': len(release.FILES), 'backup_verified': True, 'bundle': str(root / 'stage.tar.gz')}))
