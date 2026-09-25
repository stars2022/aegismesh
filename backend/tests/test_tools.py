from __future__ import annotations

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
