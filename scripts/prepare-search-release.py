"""Build a verified DeepSeek-search release; do not mutate the server."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile


def main():
    os.umask(0o077)
    workspace = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("search_release", workspace / "scripts/deploy-search-tools.py")
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    root, built_source = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    verified = json.loads((root / "database-verification.json").read_text())
    backup = json.loads((root / "files-backup.json").read_text())
    if not verified.get("locally_restored_and_checked") or release.digest(root / "release-files.tar.gz") != backup["sha256"]:
        raise SystemExit("Local DB/config backups have not been verified")
    # The clean build must match all tracked frontend inputs, not only the changed UI.
    inputs = subprocess.check_output(["git", "ls-files", "frontend"], cwd=workspace, text=True).splitlines()
    for name in inputs:
        if release.digest(workspace / name) != release.digest(built_source / name):
            raise SystemExit("Build input mismatch: " + name)
    base = "9abb97f"
    old_files = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", base, "backend/app"], cwd=workspace, text=True).splitlines()
    old_hashes = {name: hashlib.sha256(subprocess.check_output(["git", "show", f"{base}:{name}"], cwd=workspace)).hexdigest()
                  for name in old_files if name.endswith(".py")}
    code = (
        "import hashlib,json; from pathlib import Path; root=Path(" + repr(str(release.RELEASE)) + "); "
        "names=" + repr(sorted(set(old_hashes) | set(release.FILES))) + "; "
        "print(json.dumps({name:hashlib.sha256((root/name).read_bytes()).hexdigest() if (root/name).is_file() else None for name in names}))"
    )
    before = json.loads(subprocess.check_output([
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "zcode@34.150.109.119",
        "python3 -c " + shlex.quote(code),
    ], text=True))
    for name, expected in old_hashes.items():
        if before[name] != expected:
            raise SystemExit("Production drift from tested base: " + name)
    manifest = {
        "sources": {name: {"before": before[name], "after": release.digest(workspace / name)} for name in release.FILES},
        "unchanged_backend": {name: expected for name, expected in old_hashes.items() if name not in release.FILES},
        "database_backup": verified, "config_archive_sha256": backup["sha256"],
        "git_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip(),
        "frontend_files": {str(path.relative_to(built_source / "frontend/dist")): release.digest(path)
                           for path in (built_source / "frontend/dist").rglob("*") if path.is_file()},
    }
    (root / "deployment-manifest.json").write_text(json.dumps(manifest, indent=2))
    with tarfile.open(root / "stage.tar.gz", "w:gz") as archive:
        for name in release.FILES:
            archive.add(workspace / name, arcname=name)
        archive.add(built_source / "frontend/dist", arcname="frontend/dist")
        archive.add(root / "deployment-manifest.json", arcname="deployment-manifest.json")
    print(json.dumps({"bundle": str(root / "stage.tar.gz"), "sha256": release.digest(root / "stage.tar.gz"),
                      "sources": len(release.FILES), "database_verified": True, "config_verified": True}))


if __name__ == "__main__":
    main()
