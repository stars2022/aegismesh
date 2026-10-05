"""Storage failures stop business execution; only short SQL cleanup may retry."""
from __future__ import annotations

import time
from typing import Callable, TypeVar

from sqlalchemy.exc import OperationalError, SQLAlchemyError

T = TypeVar("T")


class StorageFailure(SQLAlchemyError):
    """Not a recoverable tool/model error: never replay external work for it."""

    def __init__(self, error_code: str = "storage_unavailable") -> None:
        self.error_code = error_code
        super().__init__("任务记录写入失败，执行已停止，请稍后重试。")


def storage_error(exc: BaseException) -> SQLAlchemyError | None:
    """Transport wrappers may retain the database error in their cause chain."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, SQLAlchemyError):
            return exc
        exc = exc.__cause__ or exc.__context__
    return None


def storage_error_code(exc: BaseException) -> str:
    error = storage_error(exc)
    if isinstance(error, StorageFailure):
        return error.error_code
    original = str(getattr(error, "orig", "")).lower()
    if "database is locked" in original or "database table is locked" in original:
        return "database_busy"
    if "disk is full" in original or "no space left" in original:
        return "storage_full"
    return "storage_unavailable"


def sql_cleanup(factory, operation: Callable[..., T], *, attempts: int = 3) -> T:
    """Retry an idempotent local SQL transaction, never a task or provider call."""
    for index in range(attempts):
        try:
            with factory() as db:
                result = operation(db)
                db.commit()
                return result
        except OperationalError as exc:
            if storage_error_code(exc) != "database_busy" or index + 1 == attempts:
                raise
            time.sleep(0.05 * (index + 1))
    raise AssertionError("Unreachable cleanup retry state")
