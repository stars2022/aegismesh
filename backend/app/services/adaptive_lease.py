from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class ProgressPhase(str, Enum):
    WAITING_FIRST_TOKEN = "waiting_first_token"
    GENERATING = "generating"
    TOOL_RUNNING = "tool_running"
    WAITING_SUBAGENT = "waiting_subagent"
    SYNTHESIZING = "synthesizing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


PHASE_NAMES_ZH: dict[ProgressPhase, str] = {
    ProgressPhase.WAITING_FIRST_TOKEN: "等待模型首字响应",
    ProgressPhase.GENERATING: "模型流式生成中",
    ProgressPhase.TOOL_RUNNING: "执行工具/联网检索中",
    ProgressPhase.WAITING_SUBAGENT: "等待协同子任务执行",
    ProgressPhase.SYNTHESIZING: "整合各方成果分析中",
    ProgressPhase.COMPLETED: "任务已完成",
    ProgressPhase.FAILED: "任务执行失败",
    ProgressPhase.CANCELLED: "任务已被取消",
}


class AdaptiveTimeoutError(Exception):
    """Base class for adaptive deadline errors."""
    def __init__(self, message: str, code: str = "timeout", phase: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.phase = phase


class IdleTimeoutError(AdaptiveTimeoutError):
    """Raised when no effective progress occurs within current phase's idle grace period."""
    def __init__(self, message: str, phase: str | None = None) -> None:
        super().__init__(message, code="idle_timeout", phase=phase)


class AbsoluteTimeoutError(AdaptiveTimeoutError):
    """Raised when total elapsed time exceeds the absolute ceiling."""
    def __init__(self, message: str) -> None:
        super().__init__(message, code="absolute_timeout")


@dataclass
class ProfileConfig:
    name: str
    default_absolute_ceiling: float
    max_caller_ceiling: float
    admin_max_ceiling: float
    idle_grace_by_phase: dict[ProgressPhase, float]


TASK_PROFILES: dict[str, ProfileConfig] = {
    "standard": ProfileConfig(
        name="standard",
        default_absolute_ceiling=600.0,
        max_caller_ceiling=900.0,
        admin_max_ceiling=1800.0,
        idle_grace_by_phase={
            ProgressPhase.WAITING_FIRST_TOKEN: 120.0,
            ProgressPhase.GENERATING: 180.0,
            ProgressPhase.TOOL_RUNNING: 300.0,
            ProgressPhase.WAITING_SUBAGENT: 600.0,
            ProgressPhase.SYNTHESIZING: 180.0,
        },
    ),
    "research": ProfileConfig(
        name="research",
        default_absolute_ceiling=600.0,
        max_caller_ceiling=1200.0,
        admin_max_ceiling=1800.0,
        idle_grace_by_phase={
            ProgressPhase.WAITING_FIRST_TOKEN: 120.0,
            ProgressPhase.GENERATING: 180.0,
            ProgressPhase.TOOL_RUNNING: 300.0,
            ProgressPhase.WAITING_SUBAGENT: 600.0,
            ProgressPhase.SYNTHESIZING: 180.0,
        },
    ),
}


def estimate_tokens(text: str) -> tuple[int, bool]:
    """估算文本 Token 数量。
    流式估算阶段标记 approximate=True，直至 Provider 返回真实 usage 后由 calibrate_tokens 校正为 False。
    """
    if not text:
        return 0, True
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text, disallowed_special=())), True
    except Exception:
        pass

    # 多语言启发式估算：
    # 中日韩 (CJK) 字符每个字符大致对应 0.8~1 个 token
    # 西文单词或每 4 字符大致对应 1 个 token
    cjk_count = sum(
        1 for c in text
        if '\u4e00' <= c <= '\u9fff' or '\u3040' <= c <= '\u30ff' or '\uac00' <= c <= '\ud7af'
    )
    non_cjk = "".join(
        c for c in text
        if not ('\u4e00' <= c <= '\u9fff' or '\u3040' <= c <= '\u30ff' or '\uac00' <= c <= '\ud7af')
    )
    words = len(non_cjk.split())
    tokens = cjk_count + max(words, int(len(non_cjk) / 4))
    return max(1, tokens), True


class AdaptiveDeadlineController:
    """统一进度租约与自适应截止控制器（ProgressLease / AdaptiveDeadlineController）。
    
    作为 orchestrator、子智能体、TaskManager 与 AIP 的同一进度源。
    具备：
    1. 两级超时：长时间无有效进展触发 soft/idle timeout；绝对硬上限触发 absolute ceiling；
    2. 阶段感知：针对不同 phase（等待首字、流式生成、工具执行、等待子任务、二次综合）分别配置空闲宽限；
    3. 有效进展过滤：拦截零星单字符/空白 trickle 攻击与重复无产出轮询；
    4. EWMA Token 生成速度平滑计算与 ETA 预估；
    5. Token 校准：Provider 最终 usage 到达后自动校准累计 tokens 并消除 approximate 标记。
    """

    def __init__(
        self,
        task_id: str,
        profile_name: str = "standard",
        hard_deadline_seconds: float | None = None,
        is_admin: bool = False,
        expected_tokens: int | None = None,
        custom_idle_grace: dict[ProgressPhase, float] | None = None,
    ) -> None:
        self.task_id = task_id
        self.profile_name = profile_name if profile_name in TASK_PROFILES else "standard"
        profile = TASK_PROFILES[self.profile_name]
        self.profile = profile

        # 计算绝对上限：普通调用者不得超过 max_caller_ceiling，管理员可达 admin_max_ceiling
        if hard_deadline_seconds is not None:
            max_allowed = profile.admin_max_ceiling if is_admin else profile.max_caller_ceiling
            self.absolute_deadline_seconds = min(hard_deadline_seconds, max_allowed)
        else:
            self.absolute_deadline_seconds = profile.default_absolute_ceiling

        self.idle_grace_by_phase: dict[ProgressPhase, float] = dict(profile.idle_grace_by_phase)
        try:
            from ..config import get_settings
            configured_idle = get_settings().idle_watchdog_timeout_seconds
            if configured_idle > 0:
                for phase in (
                    ProgressPhase.GENERATING,
                    ProgressPhase.WAITING_FIRST_TOKEN,
                    ProgressPhase.SYNTHESIZING,
                ):
                    self.idle_grace_by_phase[phase] = max(
                        self.idle_grace_by_phase.get(phase, 60.0), configured_idle
                    )
        except Exception:
            pass
        if custom_idle_grace:
            self.idle_grace_by_phase.update(custom_idle_grace)
        self.idle_deadline_seconds: float | None = None

        self.phase = ProgressPhase.WAITING_FIRST_TOKEN
        now_mono = time.monotonic()
        now_wall = time.time()
        self.started_at = now_mono
        self.started_at_wall = now_wall
        self.last_progress_at = now_mono
        self.last_progress_at_wall = now_wall

        # Token 计量与速度
        self.total_tokens = 0
        self.accumulated_text = ""
        self.is_approximate = True
        self.tokens_buffer = 0
        self.chars_buffer = 0
        self.expected_tokens = expected_tokens

        # EWMA 速度计算 (alpha = 0.35)
        self.ewma_tokens_per_second: float | None = None
        self._last_sample_time: float | None = None
        self._last_sample_tokens = 0
        self.eta_seconds: float | None = None

        # 防重复状态与防零星 trickle
        self._last_state_hash: str | None = None
        self._consecutive_small_chunks = 0

    @property
    def token_count(self) -> int:
        return self.total_tokens

    def set_phase(self, phase: ProgressPhase, reason: str = "") -> None:
        """显式变更当前任务所处阶段，并重置该阶段的空闲宽限计时器。"""
        if self.phase != phase:
            logger.debug(
                "Task %s phase transition: %s -> %s (%s)",
                self.task_id, self.phase.value, phase.value, reason
            )
            self.phase = phase
            self.tokens_buffer = 0
            self.chars_buffer = 0
        now_mono = time.monotonic()
        self.last_progress_at = now_mono
        self.last_progress_at_wall = time.time()

    def touch_progress(self, phase: ProgressPhase | None = None) -> None:
        """显式刷新当前阶段进展时间戳，用于长时间操作的心跳保活。"""
        now_mono = time.monotonic()
        self.last_progress_at = now_mono
        self.last_progress_at_wall = time.time()
        if phase and self.phase != phase:
            self.phase = phase

    def record_first_token(self) -> None:
        """接收到模型输出的第一个有效 token。"""
        now_mono = time.monotonic()
        now_wall = time.time()
        if self.phase == ProgressPhase.WAITING_FIRST_TOKEN:
            self.phase = ProgressPhase.GENERATING
        self.last_progress_at = now_mono
        self.last_progress_at_wall = now_wall
        self._last_sample_time = now_mono
        self._last_sample_tokens = self.total_tokens

    def record_tokens(self, delta: str) -> bool:
        """记录流式输出增量，平滑统计 tokens/s 并进行有效进展判定。
        返回是否判定为有效进展并刷新了租约。
        """
        if not delta:
            return False
        now_mono = time.monotonic()
        now_wall = time.time()

        tokens, approx = estimate_tokens(delta)
        if self.is_approximate:
            self.is_approximate = approx
        self.total_tokens += tokens
        self.accumulated_text += delta
        self.tokens_buffer += tokens
        self.chars_buffer += len(delta)

        # 有效进展门槛（防零星单字符/空白 keepalive 攻击）：
        # 必须累计达到至少 8 个字符、或 3 个 token，才重置空闲计时
        renewed = False
        if self.chars_buffer >= 8 or self.tokens_buffer >= 3:
            if self.phase == ProgressPhase.WAITING_FIRST_TOKEN:
                self.phase = ProgressPhase.GENERATING
            self.last_progress_at = now_mono
            self.last_progress_at_wall = now_wall
            self.tokens_buffer = 0
            self.chars_buffer = 0
            self._consecutive_small_chunks = 0
            renewed = True
        else:
            self._consecutive_small_chunks += 1

        # 计算 EWMA 生成速度
        if self._last_sample_time is None:
            self._last_sample_time = now_mono
            self._last_sample_tokens = self.total_tokens
        else:
            dt = now_mono - self._last_sample_time
            if dt >= 0.01:
                delta_t = self.total_tokens - self._last_sample_tokens
                if delta_t > 0:
                    inst_rate = delta_t / dt
                    alpha = 0.35
                    if self.ewma_tokens_per_second is None:
                        self.ewma_tokens_per_second = inst_rate
                    else:
                        self.ewma_tokens_per_second = alpha * inst_rate + (1 - alpha) * self.ewma_tokens_per_second
                self._last_sample_time = now_mono
                self._last_sample_tokens = self.total_tokens

        # 计算预估剩余时间 (ETA)：仅在存在输出预算且累计样本充足时计算
        if (
            self.expected_tokens
            and self.total_tokens >= 5
            and self.ewma_tokens_per_second
            and self.ewma_tokens_per_second > 0.5
        ):
            remaining = self.expected_tokens - self.total_tokens
            if remaining > 0:
                self.eta_seconds = round(remaining / self.ewma_tokens_per_second, 1)
            else:
                self.eta_seconds = 0.0
        else:
            self.eta_seconds = None

        return renewed

    def calibrate_tokens(self, completion_tokens: int) -> None:
        """Provider 最终 usage 到达后校正累计 token，并消除 approximate 标记。"""
        if completion_tokens > 0:
            self.total_tokens = completion_tokens
            self.is_approximate = False

    def record_tool_start(self, tool_name: str, arguments: dict[str, Any] | None = None) -> None:
        """工具开始执行，转入 TOOL_RUNNING 阶段，宽限期切换至工具专属时限。"""
        self.set_phase(ProgressPhase.TOOL_RUNNING, reason=f"Tool {tool_name} started")

    def record_tool_progress(self, tool_name: str, step_info: str = "") -> None:
        """工具中间批次进展（如联网检索多页/批处理），续租当前阶段空闲时钟。"""
        now_mono = time.monotonic()
        self.last_progress_at = now_mono
        self.last_progress_at_wall = time.time()

    def record_tool_finish(self, tool_name: str, output: Any = None) -> None:
        """工具执行完成，切换回 GENERATING 阶段。"""
        self.set_phase(ProgressPhase.GENERATING, reason=f"Tool {tool_name} finished")

    def record_waiting_subagent(self) -> None:
        """主协调器派发子任务，转入 WAITING_SUBAGENT 阶段。"""
        self.set_phase(ProgressPhase.WAITING_SUBAGENT, reason="Waiting for subagent reports")

    def record_subagent_progress(
        self, subtask_id: str, status: str, has_new_data: bool = True
    ) -> None:
        """子智能体状态更新。重复无产出的轮询不续租。"""
        state_key = f"{subtask_id}:{status}"
        if not has_new_data and state_key == self._last_state_hash:
            # 重复相同状态且无新增数据，不延长空闲租约
            return
        self._last_state_hash = state_key
        now_mono = time.monotonic()
        self.last_progress_at = now_mono
        self.last_progress_at_wall = time.time()

    def record_synthesizing(self) -> None:
        """主智能体开始整合各子智能体结果，转入 SYNTHESIZING 阶段。"""
        self.set_phase(ProgressPhase.SYNTHESIZING, reason="Synthesizing subagent results")

    def record_aip_progress(self, event_type: str, has_chunk: bool = False) -> None:
        """AIP 协议状态映射：Working 状态变化与有效 ProductChunk 视为有效进展。"""
        if event_type in ("ping", "keepalive"):
            return
        if not has_chunk and event_type == self._last_state_hash:
            return
        self._last_state_hash = event_type
        now_mono = time.monotonic()
        self.last_progress_at = now_mono
        self.last_progress_at_wall = time.time()

    def check_deadline(self) -> tuple[bool, str | None, str | None]:
        """检查当前任务是否已超时。
        返回 (is_expired, error_code, error_message)。
        error_code: 'absolute_timeout' | 'idle_timeout' | None。
        """
        now = time.monotonic()

        # 1. 绝对上限检查（任何情况不得突破）
        if now - self.started_at > self.absolute_deadline_seconds:
            return (
                True,
                "absolute_timeout",
                f"任务达到总时长绝对上限（{self.absolute_deadline_seconds:.1f} 秒），已终止",
            )

        # 2. 阶段性空闲宽限期检查（仅在持续无有效进展时触发）
        idle_grace = (
            self.idle_deadline_seconds
            if self.idle_deadline_seconds is not None
            else self.idle_grace_by_phase.get(self.phase, 30.0)
        )
        idle_time = now - self.last_progress_at
        if idle_time > idle_grace:
            phase_desc = PHASE_NAMES_ZH.get(self.phase, str(self.phase.value))
            return (
                True,
                "idle_timeout",
                f"任务在阶段「{phase_desc}」停顿 {idle_time:.1f} 秒无有效进展（超过空闲宽限 {idle_grace:.1f} 秒），已判定超时终止",
            )

        return False, None, None

    def get_summary(self) -> dict[str, Any]:
        """生成供 API、日志与前端展示的真实指标摘要（无数据则置为 None，绝不伪造）。"""
        now = time.monotonic()
        idle_grace = (
            self.idle_deadline_seconds
            if self.idle_deadline_seconds is not None
            else self.idle_grace_by_phase.get(self.phase, 30.0)
        )
        idle_time = max(0.0, now - self.last_progress_at)

        # 仅在有有效流速采样时返回速度
        tps = None
        if self.ewma_tokens_per_second is not None and self.total_tokens >= 5:
            tps = round(self.ewma_tokens_per_second, 1)

        return {
            "phase": self.phase.value,
            "phase_name": PHASE_NAMES_ZH.get(self.phase, str(self.phase.value)),
            "started_at": self.started_at_wall,
            "elapsed_seconds": round(now - self.started_at, 1),
            "last_progress_at": self.last_progress_at_wall,
            "idle_seconds": round(idle_time, 1),
            "idle_grace_seconds": idle_grace,
            "idle_deadline": round(self.last_progress_at + idle_grace, 2),
            "absolute_deadline_seconds": self.absolute_deadline_seconds,
            "token_count": self.total_tokens if self.total_tokens > 0 else None,
            "tokens_per_second": tps,
            "tokens_per_second_approximate": self.is_approximate if tps is not None else None,
            "eta_seconds": self.eta_seconds,
        }
