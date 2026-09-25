from __future__ import annotations

import argparse
import getpass
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from .database import Base, SessionLocal, engine, settings
from .models import AdminAccount
from .research_catalog import (
    RESEARCH_AGENT_CATALOG,
    RETIRED_RESEARCH_AGENTS,
    apply_research_catalog,
)
from .services.admin_auth import hash_password


def set_admin(username: str, password_from_stdin: bool) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", username):
        raise ValueError("用户名仅支持字母、数字、点、下划线和连字符")
    password = sys.stdin.readline().rstrip("\n") if password_from_stdin else getpass.getpass("密码：")
    password_hash, salt = hash_password(password)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        account = db.get(AdminAccount, username)
        if account is None:
            account = AdminAccount(
                username=username,
                password_hash=password_hash,
                password_salt=salt,
            )
            db.add(account)
        else:
            account.password_hash = password_hash
            account.password_salt = salt
            account.active = True
        db.commit()
    print(f"管理员账户已保存：{username}")


def _backup_sqlite_database() -> Path | None:
    relative_prefix = "sqlite:///./"
    absolute_prefix = "sqlite:////"
    if settings.database_url.startswith(relative_prefix):
        source = Path(settings.database_url.removeprefix(relative_prefix))
    elif settings.database_url.startswith(absolute_prefix):
        source = Path("/") / settings.database_url.removeprefix(absolute_prefix)
    else:
        return None
    if not source.exists():
        return None
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = source.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"{source.stem}-before-research-catalog-{timestamp}{source.suffix}"
    with sqlite3.connect(source) as source_db, sqlite3.connect(target) as backup_db:
        source_db.backup(backup_db)
    return target


def consolidate_research_catalog(*, apply: bool, prune_retired: bool) -> None:
    plan = {
        "active_agents": [
            {"id": agent_id, "name": definition["name"]}
            for agent_id, definition in RESEARCH_AGENT_CATALOG.items()
        ],
        "retired_agents": RETIRED_RESEARCH_AGENTS,
        "mode": "apply" if apply else "preview",
    }
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if not apply:
        return
    Base.metadata.create_all(engine)
    backup = _backup_sqlite_database()
    with SessionLocal() as db:
        result = apply_research_catalog(db, prune_retired=prune_retired)
    result["backup"] = str(backup) if backup else None
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(prog="aegismesh")
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser("admin")
    admin_commands = admin.add_subparsers(dest="admin_command", required=True)
    set_command = admin_commands.add_parser("set")
    set_command.add_argument("--username", required=True)
    set_command.add_argument("--password-stdin", action="store_true")
    catalog = commands.add_parser("research-catalog")
    catalog.add_argument("--apply", action="store_true")
    catalog.add_argument("--prune-retired", action="store_true")
    args = parser.parse_args()
    if args.command == "admin" and args.admin_command == "set":
        set_admin(args.username, args.password_stdin)
    elif args.command == "research-catalog":
        consolidate_research_catalog(apply=args.apply, prune_retired=args.prune_retired)


if __name__ == "__main__":
    main()
