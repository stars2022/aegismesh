"""The low-disk export is consistent, compressed and does not mutate the source."""
import gzip
import importlib.util
import io
from pathlib import Path
import sqlite3
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location(
    "production_backup", Path(__file__).resolve().parents[2] / "scripts/backup-production.py"
)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def test_streaming_database_round_trip(tmp_path, monkeypatch):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO sample VALUES (1, ?)", ('multiline\n中文 "quote"',))
    output = io.BytesIO()
    with monkeypatch.context() as patch:
        patch.setattr(backup.sys, "stdout", SimpleNamespace(buffer=output))
        backup.stream_database(source)
    restored = sqlite3.connect(":memory:")
    restored.executescript(gzip.decompress(output.getvalue()).decode())
    assert restored.execute("SELECT * FROM sample").fetchall() == [(1, 'multiline\n中文 "quote"')]
    assert restored.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    with sqlite3.connect(source) as connection:
        assert connection.execute("SELECT count(*) FROM sample").fetchone()[0] == 1


def test_streaming_refuses_non_wal_source(tmp_path):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE sample (id INTEGER)")
    with pytest.raises(SystemExit, match="requires an existing WAL"):
        backup.stream_database(source)


def test_streaming_refuses_low_headroom(tmp_path, monkeypatch):
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sample (id INTEGER)")
    with monkeypatch.context() as patch:
        patch.setattr(backup.sys, "stdout", SimpleNamespace(buffer=io.BytesIO()))
        patch.setattr(backup.shutil, "disk_usage", lambda _: SimpleNamespace(free=1))
        with pytest.raises(RuntimeError, match="headroom"):
            backup.stream_database(source)
