"""Restore a streamed production backup locally and verify it, without printing content."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

os.umask(0o077)
root = Path(sys.argv[1]).resolve()
archive = root / "database.sql.gz"
target = root / "verified-snapshot.sqlite3"
if target.exists():
    raise SystemExit("Refusing to overwrite an existing verified snapshot")
with sqlite3.connect(target) as db:
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    with gzip.open(archive, "rt", encoding="utf-8") as stream:
        statement = ""
        for line in stream:
            statement += line
            if sqlite3.complete_statement(statement):
                db.execute(statement)
                statement = ""
        if statement.strip():
            raise SystemExit("Incomplete SQL backup")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("Backup verification failed")
    counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
              for table in ("user_accounts", "conversations", "invocations", "login_sessions")}
    owner = "account_e7e72543d2490ee57e648bb84d608b51"
    owned = {table: db.execute(f'SELECT count(*) FROM "{table}" WHERE owner_id=?', (owner,)).fetchone()[0]
             for table in ("conversations", "invocations")}
with archive.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
result = {"sha256": digest, "locally_restored_and_checked": True, "counts": counts, "owner_counts": owned}
(root / "database-verification.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
