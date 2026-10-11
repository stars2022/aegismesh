"""Create a private, consistent pre-release archive without emitting secrets."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone


def snapshot_database(database: Path, snapshot: Path) -> None:
    """Brief page reads on the live DB; expensive verification/export is offline."""
    started = time.monotonic()

    def check_headroom(_status, _remaining, _total):
        if time.monotonic() - started > 600 or shutil.disk_usage(snapshot.parent).free < 384 * 1024 * 1024:
            raise RuntimeError("Backup stopped to preserve disk headroom or time budget")

    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=10) as source:
        with sqlite3.connect(snapshot) as target:
            source.backup(target, pages=1024, progress=check_headroom, sleep=0.02)


def stream_database(database: Path) -> None:
    """Stream a consistent WAL read transaction to a private local receiver.

    No large temporary snapshot is placed on the production disk. Require WAL
    so the export's read transaction cannot block ordinary production writers.
    Keep an execution/headroom bound because readers delay WAL checkpoints.
    """
    started = time.monotonic()
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=10) as connection:
        if connection.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
            raise SystemExit("Streaming backup requires an existing WAL database")
        connection.execute("BEGIN")
        with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=6, mtime=0) as stream:
            for index, line in enumerate(connection.iterdump()):
                if index % 500 == 0:
                    if time.monotonic() - started > 600:
                        raise RuntimeError("Streaming backup exceeded its time budget")
                    if shutil.disk_usage(database.parent).free < 384 * 1024 * 1024:
                        raise RuntimeError("Streaming backup stopped to preserve disk headroom")
                stream.write((line + "\n").encode("utf-8"))
        connection.rollback()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--stream-database", action="store_true", help="Write consistent compressed SQL to stdout; redirect to a private local file")
    mode.add_argument("--files-only", action="store_true", help="Back up release/configuration/files separately from an already streamed database")
    args = parser.parse_args()
    os.umask(0o077)
    release = Path(subprocess.check_output([
        "systemctl", "show", "aegismesh", "--property=WorkingDirectory", "--value"
    ], text=True).strip()).resolve()
    if release.parent != Path("/home/zcode") or not release.name.startswith("aegismesh-release-"):
        raise SystemExit("Unexpected production release")
    database = (release / "backend/data/aegismesh.db").resolve()
    if not database.is_file():
        raise SystemExit("Production database missing")
    if args.stream_database:
        stream_database(database)
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = Path("/home/zcode/aegismesh-backups")
    root.mkdir(mode=0o700, exist_ok=True)
    required_headroom = 512 * 1024 * 1024 + (0 if args.files_only else database.stat().st_size)
    if shutil.disk_usage(root).free < required_headroom:
        raise SystemExit("Insufficient disk headroom; offload inactive backups before creating a snapshot")
    archive = root / f"pre-accounts-{stamp}.tar.gz"
    manifest = {"created_utc": stamp, "release": str(release), "database": str(database),
                "database_format": "sqlite SQL dump in a consistent read transaction",
                "snapshot_method": "chunked SQLite online backup; verification and dump run on the offline copy",
                "contains_secrets": True, "excluded": ["virtualenv", "node_modules", "older backups", "Git metadata"]}
    if args.files_only:
        manifest["database_format"] = "external database.sql.gz; retrieve and verify separately before deployment"
        manifest["snapshot_method"] = "files-only archive; database not included"
    with tempfile.TemporaryDirectory(prefix="pre-accounts-", dir=root) as temporary:
        dump = Path(temporary) / "database.sql.gz"
        snapshot = Path(temporary) / "snapshot.sqlite3"
        # Never hold the live DELETE-mode database's reader lock for the full
        # verification/SQL export: that would block production writers.
        if not args.files_only:
            snapshot_database(database, snapshot)
            with sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True) as connection:
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
            if not args.files_only:
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
