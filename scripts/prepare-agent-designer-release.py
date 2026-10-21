"""Create a hash-pinned admin-designer release from the tested commit only."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

def blob_id(value):
    return hashlib.sha1(b"blob " + str(len(value)).encode() + b"\0" + value).hexdigest()

def git_tree(workspace, ref, *paths):
    raw = subprocess.check_output(["git", "ls-tree", "-rz", ref, *paths], cwd=workspace)
    result = {}
    for entry in raw.split(b"\0"):
        if not entry: continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, digest = metadata.split()
        if kind == b"blob": result[name.decode()] = digest.decode()
    return result

def main():
    os.umask(0o077)
    workspace = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("designer_release", workspace / "scripts/deploy-agent-designer.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    root, built = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    code_commit, base = "552bee0", "616f4bf"
    verified = json.loads((root / "database-verification.json").read_text())
    backup = json.loads((root / "files-backup.json").read_text())
    config_archive = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else root / "release-files.tar.gz"
    if not verified.get("locally_restored_and_checked") or module.digest(config_archive) != backup["sha256"]:
        raise SystemExit("Verified private local backups required")
    # Compare Git blob identities directly. This verifies the tested physical
    # checkout without hydrating unrelated historical binaries from cloud Git.
    committed = git_tree(workspace, code_commit, "backend/app", "frontend", "docs/admin-agent-designer.md")
    source = {}
    for name, expected in committed.items():
        if name.startswith("frontend/") and not name.startswith("frontend/dist"):
            if blob_id((built / name).read_bytes()) != expected:
                raise SystemExit("Tested build input changed: " + name)
    for name in module.FILES:
        candidate = built / name if (built / name).is_file() else workspace / name
        value = candidate.read_bytes()
        if blob_id(value) != committed[name]: raise SystemExit("Committed release source changed: " + name)
        source[name] = value
    base_tree = git_tree(workspace, base, "backend/app", "frontend/src", *module.FILES)
    old = {name: value for name,value in base_tree.items() if name.startswith(("backend/app/", "frontend/src/"))}
    names = sorted(set(old) | set(module.FILES))
    previous_frontend = json.loads((workspace / 'var/deploy-search-20261017/deployment-manifest.json').read_text())['frontend_files']
    command = ("import hashlib,json;from pathlib import Path;root=Path(" + repr(str(module.RELEASE)) + ");"
        "names=" + repr(names) + ";values={n:(root/n).read_bytes() if (root/n).is_file() else None for n in names};"
        "web=Path('/var/www/aegismesh');assets=" + repr(list(previous_frontend)) + ";"
        "print(json.dumps({'sources':{n:{'sha256':hashlib.sha256(v).hexdigest(),'blob':hashlib.sha1(b'blob '+str(len(v)).encode()+b'\\0'+v).hexdigest()} if v is not None else None for n,v in values.items()},'web':{n:hashlib.sha256((web/n).read_bytes()).hexdigest() for n in assets}}))")
    remote = json.loads(subprocess.check_output(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "zcode@34.150.109.119", "python3 -c " + shlex.quote(command)], text=True))
    before = remote['sources']
    if remote['web'] != previous_frontend: raise SystemExit('Live frontend drift from last verified publication')
    for name in names:
        expected = base_tree.get(name)
        actual = before[name]['blob'] if before[name] else None
        # Frontend source on this installation is only a partial historical
        # mirror; its running build is checked against the prior verified assets.
        # Preserve/hash-pin that mirror, but require exact backend base identity.
        if name.startswith('backend/app/') and actual != expected:
            raise SystemExit("Production backend drift: " + name)
    new = {name: hashlib.sha256(source[name]).hexdigest() for name in module.FILES}
    support = workspace / "scripts/deploy-search-tools.py"
    manifest = {"git_commit": subprocess.check_output(["git", "rev-parse", code_commit], cwd=workspace,text=True).strip(),
        "sources": {name:{"before":before[name]['sha256'] if before[name] else None,"after":new[name]} for name in module.FILES},
        "unchanged_backend":{name:before[name]['sha256'] for name in old if name.startswith('backend/app/') and name not in module.FILES},
        "unchanged_frontend":{name:before[name]['sha256'] for name in old if name.startswith('frontend/src/') and name not in module.FILES and before[name]},
        "unchanged_frontend_absent":[name for name in old if name.startswith('frontend/src/') and name not in module.FILES and not before[name]],
        "previous_frontend": previous_frontend,
        "database_backup":verified,"config_archive_sha256":backup["sha256"],"support_sha256":module.digest(support),
        "frontend_files":{str(path.relative_to(built/"frontend/dist")):module.digest(path) for path in (built/"frontend/dist").rglob("*") if path.is_file()}}
    (root / "deployment-manifest.json").write_text(json.dumps(manifest,indent=2))
    with tarfile.open(root/"stage.tar.gz","w:gz") as archive:
        for name in module.FILES:
            info=tarfile.TarInfo(name);info.size=len(source[name]);info.mode=0o644
            archive.addfile(info,io.BytesIO(source[name]))
        archive.add(built/"frontend/dist",arcname="frontend/dist")
        archive.add(root/"deployment-manifest.json",arcname="deployment-manifest.json")
        archive.add(support,arcname="scripts/deploy-search-tools.py")
        archive.add(workspace/"scripts/deploy-agent-designer.py",arcname="scripts/deploy-agent-designer.py")
    print(json.dumps({"bundle_sha256":module.digest(root/"stage.tar.gz"),"code_commit":manifest['git_commit'],"sources":len(module.FILES)}))

if __name__ == "__main__":
    main()
