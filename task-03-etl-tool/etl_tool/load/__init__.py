"""Load records into CSV, JSON, and SQLite targets."""

from etl_tool.load.targets import OutputSet, build_outputs

__all__ = ["OutputSet", "build_outputs"]
