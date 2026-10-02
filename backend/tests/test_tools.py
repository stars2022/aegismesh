from __future__ import annotations

import asyncio
import pytest

from app.services.tools import ToolRegistry


def test_calculator_executes_arithmetic_only() -> None:
    registry = ToolRegistry()
    assert registry.execute("calculator", {"expression": "(12 + 8) / 4"}) == {
        "ok": True,
        "result": 5.0,
    }
    assert registry.execute("calculator", {"expression": "__import__('os')"})["ok"] is False


def test_only_registered_tools_are_exposed() -> None:
    schemas = ToolRegistry().schemas(["calculator", "database"])
    assert [item["function"]["name"] for item in schemas] == ["calculator"]


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [SyntaxError("bad expression"), ZeroDivisionError("division by zero"), ValueError("bad argument")])
async def test_async_tools_keep_the_same_recoverable_error_boundary(error):
    async def broken(_):
        raise error
    registry = ToolRegistry()
    registry.register("probe", {}, broken)
    assert await registry.execute("probe", {}) == {"ok": False, "error": str(error)}


@pytest.mark.asyncio
async def test_async_tool_cancellation_is_not_converted_to_an_error_result():
    async def cancelled(_):
        raise asyncio.CancelledError
    registry = ToolRegistry()
    registry.register("probe", {}, cancelled)
    with pytest.raises(asyncio.CancelledError):
        await registry.execute("probe", {})
