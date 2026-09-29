"""Local read-side log index and administrator audit trail.

Reads (never rewrites) AMP spool files. Nothing here publishes to Kafka, invents
delivery acknowledgements, or stores request/response bodies and credentials.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import re
import stat
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import SessionLocal
from ..models import LogIngestCursor, OperationalLog

logger = logging.getLogger(__name__)
AMP_KINDS = ("access", "message", "heartbeat", "system", "metrics", "audit")
SOURCE_FILES = {f"amp_{kind}_aegismesh.jsonl": kind for kind in AMP_KINDS}
MAX_LINE = 256 * 1024
BATCH_BYTES = 2 * 1024 * 1024
BATCH_LINES = 2000
_index_lock = threading.Lock()
_audit_failures = 0


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def safe_text(value: object, limit: int = 500) -> str:
    """Defence in depth for the *allowlisted* diagnostic text fields below."""
    if not isinstance(value, (str, int, float, bool)):
        return ""
    text = str(value)
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)", "[已隐藏私钥]", text, flags=re.S)
    text = re.sub(r"\b(?:Bearer|Basic)\s+[^\s,;]+", "[已隐藏认证信息]", text, flags=re.I)
    text = re.sub(r"(?i)(password|passwd|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|authorization|cookie)[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;&]+)", r"\1=[已隐藏]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[已隐藏密钥]", text)
    text = re.sub(r"https?://[^\s<>\"]+", lambda m: safe_url(m.group(0)), text)
    return re.sub(r"[\x00-\x1f\x7f]", " ", text)[:limit]


def safe_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        if parts.port:
            host += f":{parts.port}"
        return urlunsplit((parts.scheme, host, parts.path, "", ""))[:500]
    except ValueError:
        return "[无效地址]"


def obj(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def number(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def fields(source: object, names: tuple[str, ...]) -> dict:
    """No recursive raw-body copy: unknown keys, payloads and headers are omitted."""
    data = obj(source)
    return {key: safe_text(data[key]) if isinstance(data[key], str) else data[key]
            for key in names if key in data and isinstance(data[key], (str, int, float, bool))
            and not (isinstance(data[key], float) and not math.isfinite(data[key]))}


def normalize_amp(record: object, expected_kind: str, source_file: str, raw: bytes) -> dict:
    record = obj(record)
    kind = record.get("log_type")
    if kind != expected_kind or kind not in AMP_KINDS:
        raise ValueError("invalid log type")
    stamp = utc(datetime.fromisoformat(str(record.get("timestamp", "")).replace("Z", "+00:00")))
    body = obj(record.get("body"))
    reporter = safe_text(record.get("aic"), 255)
    correlation = safe_text(record.get("correlation_id") or body.get("taskId") or body.get("task_id"), 255)
    trace = safe_text(record.get("trace_id"), 255)
    severity = number(record.get("severity_number")) or 0
    level = safe_text(record.get("severity_text") or ("ERROR" if severity >= 17 else "WARN" if severity >= 13 else "INFO"), 16).upper()
    detail = fields(record, ("schema_version", "log_id", "timestamp", "aic", "trace_id", "span_id", "parent_span_id", "correlation_id", "severity_text", "severity_number"))
    clean: dict = {}
    result = dict(origin="amp", kind=kind, occurred_at=stamp, aic=reporter,
                  task_id=correlation, trace_id=trace, level=level, outcome="unknown",
                  source_file=source_file, actor="", action=kind, target="", summary=kind)
    err = fields(body.get("error"), ("code", "message"))
    if kind == "access":
        clean = {"request": fields(body.get("request"), ("method", "route", "url")),
                 "response": fields(body.get("response"), ("statusCode",)),
                 "caller": fields(body.get("caller"), ("aic", "serviceName")),
                 "callee": fields(body.get("callee"), ("aic", "serviceName"))}
        status_value = number(clean["response"].get("statusCode"))
        code = int(status_value) if status_value is not None and 100 <= status_value <= 599 else None
        duration = number(body.get("durationMs"))
        clean["durationMs"] = duration
        result.update(caller_aic=clean["caller"].get("aic", "")[:255], callee_aic=clean["callee"].get("aic", "")[:255],
                      status_code=code, duration_ms=duration,
                      outcome="error" if err or (code is not None and code >= 400) else "success" if code else "unknown",
                      summary=f"{clean['request'].get('method', 'RPC')} {clean['request'].get('route', '/rpc')} · HTTP {code or '未知'}")
    elif kind == "message":
        clean = fields(body, ("eventType", "operationName", "system", "messageId", "subscriptionName", "consumerGroupName", "payloadSizeBytes", "deliveryAttempt"))
        clean["destination"] = fields(body.get("destination"), ("name", "kind", "virtualHost"))
        clean["routing"] = fields(body.get("routing"), ("key", "partition", "offset"))
        clean["settlement"] = fields(body.get("settlement"), ("latencyMs", "reason"))
        event = clean.get("eventType", "unknown")
        result.update(message_id=str(clean.get("messageId", ""))[:255], action=str(event),
                      outcome="error" if err or event in {"nack", "reject", "timeout", "dead_letter"} else "success" if event in {"send", "receive", "ack"} else "unknown",
                      duration_ms=number(clean["settlement"].get("latencyMs")),
                      summary=f"{clean.get('system', 'MQ')} · {event} · {clean.get('operationName', '')}")
    elif kind == "heartbeat":
        clean = fields(body, ("uptimeSeconds",))
        result.update(summary="智能体心跳 · 本地已记录", outcome="success")
    elif kind == "metrics":
        clean = fields(body, ("uptimeSeconds",))
        clean["loadMetrics"] = fields(body.get("loadMetrics"), ("activeTasks", "queuedTasks", "cpuUsage", "memoryUsage", "diskUsage"))
        result["summary"] = "智能体运行指标"
    elif kind == "audit":
        clean = {"actor": fields(body.get("actor"), ("id", "type", "name", "role")),
                 "action": fields(body.get("action"), ("name", "type", "method")),
                 "target": fields(body.get("target"), ("id", "type", "name")),
                 "result": fields(body.get("result"), ("status", "reason", "errorCode"))}
        result.update(actor=str(clean["actor"].get("id", ""))[:120], action=str(clean["action"].get("name", "audit"))[:120],
                      target=str(clean["target"].get("id", "")), summary=str(clean["action"].get("name", "AMP 审计事件")),
                      outcome={"success": "success", "failure": "error"}.get(clean["result"].get("status"), "unknown"))
        detail["signature_present"] = bool(record.get("integrity"))
        detail["signature_verification"] = "not_verified_locally"
    else:
        clean = fields(body, ("message", "category", "task_id"))
        result.update(summary=clean.get("message", "系统事件"), action=clean.get("category", "system"),
                      outcome="error" if level in {"ERROR", "FATAL", "CRITICAL"} else "unknown")
    if err:
        clean["error"] = err
        result["outcome"] = "error"
        if err.get("message"):
            result["summary"] += f" · {err['message']}"
    if result["outcome"] == "error":
        result["level"] = "ERROR"
    result["summary"] = safe_text(result["summary"], 600)
    detail["body"] = clean
    result["detail"] = detail
    # SDK log IDs are preserved; a content hash supports older unsigned records.
    identity = f"{kind}:{reporter}:{record['log_id']}".encode() if record.get("log_id") else raw
    result["event_key"] = "amp:" + hashlib.sha256(identity).hexdigest()
    return result


def checkpoint(stream, position: int) -> str:
    stream.seek(max(0, position - 128))
    return hashlib.sha256(stream.read(min(position, 128))).hexdigest() if position else ""


def ingest_file(db: Session, directory: Path, filename: str, now: datetime) -> None:
    cursor = db.get(LogIngestCursor, filename)
    if cursor is None:
        cursor = LogIngestCursor(source_file=filename, byte_offset=0, invalid_lines=0, expired_lines=0, rotations=0, rotation_gaps=0, skipping_line=False)
        db.add(cursor)
        db.flush()
    cursor.updated_at = now
    try:
        descriptor = os.open(directory / filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        cursor.last_error = "not_created"
        db.commit()
        return
    except OSError:
        cursor.last_error = "unreadable"
        db.commit()
        return
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            cursor.last_error = "not_regular_file"
            db.commit()
            return
        identity = f"{info.st_dev}:{info.st_ino}"
        changed = (cursor.identity != identity or info.st_size < cursor.byte_offset
                   or (cursor.byte_offset and checkpoint(stream, cursor.byte_offset) != cursor.checkpoint))
        if changed:
            if cursor.identity:
                cursor.rotations += 1
                if cursor.file_size > cursor.byte_offset:
                    cursor.rotation_gaps += 1
            cursor.byte_offset = 0
            cursor.skipping_line = False
        cursor.identity, cursor.file_size, cursor.last_error = identity, info.st_size, ""
        stream.seek(cursor.byte_offset)
        start = cursor.byte_offset
        cutoff = now - timedelta(days=get_settings().log_retention_days)
        seen: set[str] = set()
        for _ in range(BATCH_LINES):
            if stream.tell() - start >= BATCH_BYTES:
                break
            line_start = stream.tell()
            raw = stream.readline(MAX_LINE + 1)
            if not raw:
                break
            if cursor.skipping_line:
                cursor.skipping_line = not raw.endswith(b"\n")
                cursor.byte_offset = stream.tell()
                continue
            if len(raw) > MAX_LINE:
                cursor.invalid_lines += 1
                cursor.skipping_line = not raw.endswith(b"\n")
                cursor.byte_offset = stream.tell()
                continue
            if not raw.endswith(b"\n"):
                # The SDK may still be writing this line; retry from its start.
                cursor.byte_offset = line_start
                break
            cursor.byte_offset = stream.tell()
            if not raw.strip():
                continue
            try:
                data = normalize_amp(json.loads(raw), SOURCE_FILES[filename], filename, raw)
            except (ValueError, TypeError, OverflowError, RecursionError):
                cursor.invalid_lines += 1
                continue
            if data["occurred_at"] < cutoff:
                cursor.expired_lines += 1
                continue
            key = data["event_key"]
            if key not in seen and db.scalar(select(OperationalLog.id).where(OperationalLog.event_key == key)) is None:
                db.add(OperationalLog(**data))
                seen.add(key)
        cursor.checkpoint = checkpoint(stream, cursor.byte_offset)
        db.commit()


def prune_index(db: Session, now: datetime) -> None:
    settings = get_settings()
    for origin, days, cap in (("amp", settings.log_retention_days, settings.log_max_records),
                              ("admin", settings.audit_retention_days, settings.audit_max_records)):
        db.execute(delete(OperationalLog).where(OperationalLog.origin == origin, OperationalLog.occurred_at < now - timedelta(days=days)))
        overflow = select(OperationalLog.id).where(OperationalLog.origin == origin).order_by(OperationalLog.occurred_at.desc(), OperationalLog.id.desc()).offset(cap)
        db.execute(delete(OperationalLog).where(OperationalLog.id.in_(overflow)), execution_options={"synchronize_session": False})
    db.commit()


def index_once(session_factory=SessionLocal, directory: Path | None = None) -> bool:
    if not _index_lock.acquire(blocking=False):
        return False
    try:
        now = utcnow()
        with session_factory() as db:
            for filename in SOURCE_FILES:
                try:
                    ingest_file(db, directory or Path(get_settings().amp_log_dir), filename, now)
                except Exception:
                    db.rollback()
                    logger.exception("Local log index failed for %s", filename)
                    cursor = db.get(LogIngestCursor, filename)
                    if cursor is None:
                        cursor = LogIngestCursor(source_file=filename)
                        db.add(cursor)
                    cursor.last_error = "index_failed"
                    cursor.updated_at = now
                    db.commit()
            prune_index(db, now)
        return True
    finally:
        _index_lock.release()


async def index_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(index_once)
        except Exception:
            logger.exception("Local log index unavailable")
        await asyncio.sleep(get_settings().log_index_interval_seconds)


class LogQuery(BaseModel):
    origin: Literal["amp", "admin"] = "amp"
    kind: Literal["", "activity", "access", "message", "heartbeat", "system", "metrics", "audit"] = "activity"
    outcome: Literal["", "success", "error", "unknown"] = ""
    q: str = Field(default="", max_length=200)
    aic: str = Field(default="", max_length=255)
    related_id: str = Field(default="", max_length=255)
    since: datetime | None = None
    until: datetime | None = None
    cursor: str = Field(default="", max_length=600)
    limit: int = Field(default=25, ge=1, le=100)

    @model_validator(mode="after")
    def valid_range(self):
        if self.since and self.until and utc(self.since) > utc(self.until):
            raise ValueError("起始时间不能晚于结束时间")
        return self


def query_conditions(query: LogQuery) -> list:
    conditions = [OperationalLog.origin == query.origin]
    if query.origin == "amp" and query.kind:
        conditions.append(OperationalLog.kind.in_(("access", "message", "system", "audit")) if query.kind == "activity" else OperationalLog.kind == query.kind)
    if query.outcome:
        conditions.append(OperationalLog.outcome == query.outcome)
    if query.aic.strip():
        conditions.append(or_(*(column == query.aic.strip() for column in (OperationalLog.aic, OperationalLog.caller_aic, OperationalLog.callee_aic))))
    if query.related_id.strip():
        conditions.append(or_(*(column == query.related_id.strip() for column in (OperationalLog.task_id, OperationalLog.trace_id, OperationalLog.message_id, OperationalLog.request_id))))
    if query.since:
        conditions.append(OperationalLog.occurred_at >= utc(query.since))
    if query.until:
        conditions.append(OperationalLog.occurred_at <= utc(query.until))
    if query.q.strip():
        columns = (OperationalLog.summary, OperationalLog.aic, OperationalLog.caller_aic, OperationalLog.callee_aic,
                   OperationalLog.task_id, OperationalLog.trace_id, OperationalLog.message_id, OperationalLog.request_id,
                   OperationalLog.actor, OperationalLog.action, OperationalLog.target)
        conditions.append(or_(*(column.icontains(query.q.strip(), autoescape=True) for column in columns)))
    return conditions


def log_read(row: OperationalLog, *, detail: bool = False) -> dict:
    result = {key: getattr(row, key) for key in ("id", "origin", "kind", "level", "outcome", "aic", "caller_aic", "callee_aic", "task_id", "trace_id", "message_id", "request_id", "actor", "action", "target", "summary", "status_code", "duration_ms", "source_file")}
    result.update(occurred_at=utc(row.occurred_at).isoformat(), indexed_at=utc(row.indexed_at).isoformat(),
                  delivery="not_observed" if row.origin == "amp" else "local_only")
    if detail:
        result["detail"] = row.detail
    return result


def list_logs(db: Session, query: LogQuery) -> dict:
    conditions = query_conditions(query)
    boundary = []
    snapshot = db.scalar(select(func.max(OperationalLog.id))) or 0
    if query.cursor:
        try:
            data = json.loads(base64.urlsafe_b64decode(query.cursor.encode()))
            stamp = utc(datetime.fromisoformat(data["time"]))
            last_id, snapshot = int(data["id"]), int(data["snapshot"])
            if last_id < 1 or snapshot < last_id:
                raise ValueError("invalid boundary")
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            raise ValueError("分页游标无效，请刷新后重试") from exc
        boundary = [or_(OperationalLog.occurred_at < stamp,
                        (OperationalLog.occurred_at == stamp) & (OperationalLog.id < last_id))]
    conditions.append(OperationalLog.id <= snapshot)
    rows = db.scalars(select(OperationalLog).where(*conditions, *boundary).order_by(OperationalLog.occurred_at.desc(), OperationalLog.id.desc()).limit(query.limit + 1)).all()
    more = len(rows) > query.limit
    rows = rows[:query.limit]
    next_cursor = ""
    if more and rows:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps({"time": utc(last.occurred_at).isoformat(), "id": last.id, "snapshot": snapshot}).encode()).decode()
    return {"items": [log_read(row) for row in rows], "next_cursor": next_cursor,
            "total": db.scalar(select(func.count()).select_from(OperationalLog).where(*conditions)) or 0,
            "errors": db.scalar(select(func.count()).select_from(OperationalLog).where(*conditions, OperationalLog.outcome == "error")) or 0}


def index_status(db: Session) -> dict:
    settings = get_settings()
    sources = [{"name": row.source_file, "offset": row.byte_offset, "size": row.file_size,
                "pending_bytes": max(0, row.file_size - row.byte_offset), "invalid_lines": row.invalid_lines,
                "expired_lines": row.expired_lines, "rotations": row.rotations, "rotation_gaps": row.rotation_gaps, "error": row.last_error,
                "checked_at": utc(row.updated_at).isoformat()}
               for row in db.scalars(select(LogIngestCursor).order_by(LogIngestCursor.source_file)).all()]
    return {"sources": sources, "indexer_enabled": settings.log_indexer_enabled,
            "poll_seconds": settings.log_index_interval_seconds, "audit_write_failures": _audit_failures,
            "retention": {"amp_days": settings.log_retention_days, "amp_limit": settings.log_max_records,
                          "audit_days": settings.audit_retention_days, "audit_limit": settings.audit_max_records},
            "delivery": {"state": "not_observed", "message": "本地落盘及 MQ ack 不代表 AMP 平台已接收或计榜；当前未接入平台回执。"}}


def audit_action(method: str, path: str) -> str:
    if path == "/api/admin/login": return "管理员登录"
    if path == "/api/admin/logout": return "管理员退出"
    if path.endswith("/registration/sync"): return "同步审核状态"
    if path.endswith("/registration"): return "提交智能体审核"
    if path.endswith("/certificate"): return "签发智能体证书"
    if path.endswith("/eab"): return "获取证书授权"
    if path.endswith("/database/import"): return "导入平台数据"
    if path.endswith("/database/export"): return "导出平台数据"
    if path.endswith("/logs/export"): return "导出脱敏日志"
    if path == "/api/policy": return "修改路由策略"
    if path == "/api/admin/access": return "修改访问配置"
    if path == "/api/discovery/import": return "接入发现智能体"
    if path.startswith("/api/probes"): return "执行智能体探针"
    if path.endswith("/test"): return "测试供应商连接"
    domain = "智能体" if path.startswith("/api/agents") else "模型供应商" if path.startswith("/api/providers") else "管理配置"
    return {"POST": "创建", "PATCH": "修改", "PUT": "修改", "DELETE": "删除"}.get(method, "访问") + domain


def record_admin_event(*, actor: str, method: str, path: str, request_id: str,
                       status_code: int, duration_ms: float, note: str = "", changes: dict | None = None,
                       session_factory=SessionLocal) -> None:
    global _audit_failures
    action = audit_action(method, path)
    note = safe_text(note)
    summary = safe_text(f"{action} · HTTP {status_code}" + (f" · {note}" if note else ""), 600)
    try:
        with session_factory() as db:
            db.add(OperationalLog(event_key="admin:" + request_id, origin="admin", kind="audit", occurred_at=utcnow(),
                                  actor=safe_text(actor or "未认证", 120), request_id=request_id, action=action,
                                  target=safe_text(path), summary=summary, status_code=status_code,
                                  level="ERROR" if status_code >= 400 else "INFO", outcome="error" if status_code >= 400 else "success",
                                  duration_ms=round(duration_ms, 2), detail={"method": method, "path": safe_text(path),
                                  "note": note, "policy_changes": changes or {}}))
            db.commit()
    except Exception:
        _audit_failures += 1
        logger.exception("Administrator audit could not be persisted (request_id=%s)", request_id)


class AdminAuditMiddleware:
    """Observe headers/status only; never buffer bodies or interfere with SSE."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path, method = scope.get("path", ""), scope.get("method", "")
        watched = (scope["type"] == "http" and bool(re.match(r"^/api/(admin(?:/|$)|agents(?:/|$)|providers(?:/|$)|policy$|probes(?:/|$)|discovery/import$)", path)))
        mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        exported = method == "GET" and path in {"/api/admin/database/export", "/api/admin/logs/export"}
        if not watched or not (mutation or exported):
            return await self.app(scope, receive, send)
        started, status_code, completed = time.monotonic(), 500, False
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["audit_request_id"] = request_id

        async def observe(message):
            nonlocal status_code, completed
            if message["type"] == "http.response.start":
                status_code = message["status"]
                message["headers"] = [*message.get("headers", []), (b"x-request-id", request_id.encode())]
            elif message["type"] == "http.response.body" and not message.get("more_body", False):
                completed = True
            await send(message)
        try:
            await self.app(scope, receive, observe)
        finally:
            state = scope.get("state", {})
            await asyncio.to_thread(record_admin_event, actor=state.get("audit_actor", ""), method=method, path=path,
                                    request_id=request_id, status_code=status_code if completed else 500,
                                    duration_ms=(time.monotonic() - started) * 1000,
                                    note=state.get("audit_note", ""), changes=state.get("audit_policy_changes"))
