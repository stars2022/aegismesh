from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
if settings.database_url.startswith("sqlite:///./"):
    database_path = Path(settings.database_url.removeprefix("sqlite:///./"))
    database_path.parent.mkdir(parents=True, exist_ok=True)

connect_args = ({"check_same_thread": False, "timeout": settings.sqlite_busy_timeout_seconds}
                if settings.database_url.startswith("sqlite") else {})
engine = create_engine(settings.database_url, connect_args=connect_args)


def configure_sqlite_connection(connection, _record) -> None:
    """Bound writer contention and avoid readers blocking file-backed writers."""
    cursor = connection.cursor()
    try:
        cursor.execute(f"PRAGMA busy_timeout={int(settings.sqlite_busy_timeout_seconds * 1000)}")
        # An in-memory database has no WAL files. Do not change its semantics.
        databases = cursor.execute("PRAGMA database_list").fetchall()
        if any(name == "main" and filename for _, name, filename in databases):
            mode = cursor.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if mode.lower() != "wal":
                raise RuntimeError("Unable to initialize SQLite WAL journal")
    finally:
        cursor.close()


if engine.dialect.name == "sqlite":
    event.listen(engine, "connect", configure_sqlite_connection)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
