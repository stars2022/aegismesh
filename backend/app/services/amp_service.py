from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import Any

from acps_sdk.amp import (
    AccessBody,
    AccessEmitter,
    AccessParticipant,
    AccessRequest,
    AccessResponse,
    ErrorInfo,
    HeartbeatEmitter,
    SystemEmitter,
)

from ..config import get_settings

logger = logging.getLogger(__name__)


class AmpService:
    def __init__(self, log_dir: str | Path | None = None, aic: str = "local:research_leader") -> None:
        settings = get_settings()
        self.log_dir = Path(log_dir or settings.amp_log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.aic = aic
        self._heartbeat_emitter = HeartbeatEmitter(
            self.log_dir / "amp_heartbeat_aegismesh.jsonl", aic=self.aic
        )
        self._access_emitter = AccessEmitter(
            self.log_dir / "amp_access_aegismesh.jsonl", aic=self.aic
        )
        self._system_emitter = SystemEmitter(
            self.log_dir / "amp_system_aegismesh.jsonl",
            aic=self.aic,
            resource={
                "service.name": "aegismesh-platform",
                "service.namespace": "acps",
            },
        )
        self._hb_task: asyncio.Task[None] | None = None

    def update_aic(self, aic: str) -> None:
        if aic and aic != self.aic:
            self.aic = aic
            self._heartbeat_emitter = HeartbeatEmitter(
                self.log_dir / "amp_heartbeat_aegismesh.jsonl", aic=self.aic
            )
            self._access_emitter = AccessEmitter(
                self.log_dir / "amp_access_aegismesh.jsonl", aic=self.aic
            )
            self._system_emitter = SystemEmitter(
                self.log_dir / "amp_system_aegismesh.jsonl",
                aic=self.aic,
                resource={
                    "service.name": "aegismesh-platform",
                    "service.namespace": "acps",
                },
            )

    async def start(self) -> None:
        settings = get_settings()
        interval = getattr(settings, "amp_heartbeat_interval_seconds", 15.0)
        self._hb_task = asyncio.create_task(
            self._heartbeat_emitter.run_periodic(interval),
            name="amp-heartbeat",
        )
        logger.info("AMP 心跳服务已启动 (AIC: %s, 周期: %.1fs)", self.aic, interval)
        self.record_system(
            category="lifecycle",
            message="AegisMesh 启动完成并已开启 AMP 可观测性追踪",
            severity_number=9,
            severity_text="INFO",
        )

    async def stop(self) -> None:
        if self._hb_task:
            self._hb_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._hb_task
            self._hb_task = None
        self.record_system(
            category="lifecycle",
            message="AegisMesh 正在停止并注销 AMP 心跳",
            severity_number=9,
            severity_text="INFO",
        )
        logger.info("AMP 心跳服务已停止")

    async def record_access(
        self,
        *,
        caller_aic: str,
        callee_aic: str,
        task_id: str,
        method: str = "POST",
        url: str = "/rpc",
        route: str = "/rpc",
        status_code: int = 200,
        duration_ms: int = 0,
        session_id: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """
        Record AMP access log.
        Matches platform ranking rule: correlationId == taskId.
        """
        err_info = ErrorInfo(code=status_code, message=error_message) if error_message else None
        body = AccessBody(
            request=AccessRequest(
                method=method,
                url=url,
                route=route,
            ),
            response=AccessResponse(statusCode=status_code),
            caller=AccessParticipant(aic=caller_aic, serviceName="caller"),
            callee=AccessParticipant(aic=callee_aic, serviceName="callee"),
            durationMs=float(duration_ms),
            error=err_info,
        )
        try:
            await self._access_emitter.emit(
                body,
                correlation_id=task_id,
                trace_id=session_id or task_id,
            )
        except Exception:
            logger.warning("AMP access 日志写入失败", exc_info=True)

    def record_system(
        self,
        *,
        category: str,
        message: str,
        severity_number: int = 9,
        severity_text: str = "INFO",
        task_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "message": message,
            "category": category,
            "task_id": task_id,
            **(extra or {}),
        }
        try:
            self._system_emitter.emit_sync(
                payload,
                severity_number=severity_number,
                severity_text=severity_text,
                correlation_id=task_id,
            )
        except Exception:
            logger.warning("AMP system 日志写入失败", exc_info=True)


amp_service = AmpService()
