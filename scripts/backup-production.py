"""Create a private, consistent pre-release archive without emitting secrets."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone


def main():
    os.umask(0o077)
    release = Path(subprocess.check_output([
        "systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value"
    ], text=True).strip()).resolve()
    if release.parent != Path("/home/zcode") or not release.name.startswith("aegismesh-release-"):
        raise SystemExit("Unexpected production release")
    database = (release / "backend/data/aegismesh.db").resolve()
    if not database.is_file():
        raise SystemExit("Production database missing")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = Path("/home/zcode/aegismesh-backups")
    root.mkdir(mode=0o700, exist_ok=True)
    archive = root / f"pre-accounts-{stamp}.tar.gz"
    manifest = {"created_utc": stamp, "release": str(release), "database": str(database),
                "database_format": "sqlite SQL dump in a consistent read transaction",
                "contains_secrets": True, "excluded": ["virtualenv", "node_modules", "older backups", "Git metadata"]}
    with tempfile.TemporaryDirectory(prefix="pre-accounts-", dir=root) as temporary:
        dump = Path(temporary) / "database.sql.gz"
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
            connection.execute("BEGIN")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise SystemExit("Production database failed quick_check")
            manifest["tables"] = dict(connection.execute(
                "SELECT name, (SELECT 0) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ))
            for table in manifest["tables"]:
                manifest["tables"][table] = connection.execute('SELECT COUNT(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
            with gzip.open(dump, "wt", encoding="utf-8", compresslevel=6) as stream:
                for line in connection.iterdump():
                    stream.write(line + "\n")
            connection.rollback()

        def filtered(info):
            parts = Path(info.name).parts
            if any(p in {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", "deployment-backup", "service-backup", "backups"} for p in parts):
                return None
            if info.name.startswith("release/") and (parts[1] in {"logs", "var", "tmp", "outputs"} or info.name.startswith("release/backend/data")):
                return None
            if info.name.startswith("data/") and (info.name.endswith((".db", ".db-wal", ".db-shm", ".sqlite3"))):
                return None
            if info.isreg():
                info.mode = 0o600
            elif info.isdir():
                info.mode = 0o700
            return info

        with tarfile.open(archive, "w:gz", compresslevel=6, dereference=True) as tar:
            tar.add(release, arcname="release", filter=filtered)
            tar.add(database.parent, arcname="data", filter=filtered)
            tar.add(dump, arcname="database.sql.gz")
            tar.add("/var/www/aegismesh", arcname="frontend-live", filter=filtered)
            tar.add((release / "logs").resolve(), arcname="logs", filter=filtered)
            # Root-owned service configuration is readable on this deployment.
            for pattern in ("aegismesh*.service", "aegismesh*.service.d"):
                for path in Path("/etc/systemd/system").glob(pattern):
                    tar.add(path, arcname="systemd/" + path.name, filter=filtered)
            for path in (Path("/etc/nginx/nginx.conf"), Path("/etc/nginx/sites-enabled"), Path("/etc/nginx/conf.d")):
                tar.add(path, arcname="nginx/" + path.name, filter=filtered)
            payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
            info = tarfile.TarInfo("manifest.json")
            info.size, info.mode = len(payload), 0o600
            tar.addfile(info, io.BytesIO(payload))
        archive.chmod(0o600)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size, "sha256": digest, "release": str(release)}))


if __name__ == "__main__":
    main()
