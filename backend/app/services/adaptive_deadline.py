from __future__ import annotations

"""Alias module for adaptive_lease providing backward compatibility and unified naming."""

from .adaptive_lease import (
    AbsoluteTimeoutError,
    AdaptiveDeadlineController,
    AdaptiveTimeoutError,
    IdleTimeoutError,
    PHASE_NAMES_ZH,
    ProfileConfig,
    ProgressPhase,
    TASK_PROFILES,
    estimate_tokens,
)

__all__ = [
    "AbsoluteTimeoutError",
    "AdaptiveDeadlineController",
    "AdaptiveTimeoutError",
    "IdleTimeoutError",
    "PHASE_NAMES_ZH",
    "ProfileConfig",
    "ProgressPhase",
    "TASK_PROFILES",
    "estimate_tokens",
]
