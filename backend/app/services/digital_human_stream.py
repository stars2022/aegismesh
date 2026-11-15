"""Expose the leading spoken reply while the model is still composing its UI JSON."""
from __future__ import annotations

import asyncio
import json
import re
from contextlib import suppress
from typing import Any

# Only ordinary chat may speak before the complete routing decision is validated.
# A task handoff must not announce success while its dispatch JSON is unfinished.
REPLY_PREFIX = re.compile(r'^\s*\{\s*"action"\s*:\s*"chat"\s*,\s*"reply"\s*:\s*')


async def stream_realtime_result(transport: Any, agent: Any, prompt: str, **kwargs: Any):
    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=4)
    prefix = ""
    emitted = False

    async def on_text(delta: str):
        nonlocal prefix, emitted
        if emitted:
            return
        prefix += delta
        if len(prefix) > 16384:
            emitted = True
            return
        candidate = prefix.strip()
        if candidate.startswith("```json"):
            candidate = candidate[7:].lstrip()
        elif candidate.startswith("```"):
            candidate = candidate[3:].lstrip()
        match = REPLY_PREFIX.match(candidate)
        if match is None:
            return
        try:
            reply, _end = json.JSONDecoder().raw_decode(candidate[match.end():])
        except json.JSONDecodeError:
            return
        emitted = True
        if isinstance(reply, str) and reply.strip() and len(reply) <= 2000:
            await events.put(("speech", reply.strip()))

    async def produce():
        try:
            # The wall-clock limit also covers streams that trickle tokens forever.
            async with asyncio.timeout(float(kwargs.get("timeout_seconds", 18))):
                result = await transport.execute(agent, prompt, on_text=on_text, **kwargs)
            await events.put(("result", result))
        except Exception as exc:
            await events.put(("error", exc))

    task = asyncio.create_task(produce())
    try:
        while True:
            kind, value = await events.get()
            if kind == "error":
                raise value
            yield kind, value
            if kind == "result":
                return
    finally:
        if not task.done():
            task.cancel()
        with suppress(asyncio.CancelledError):
            await task
