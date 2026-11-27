"""Extract records from CSV, JSON, and SQLite sources."""

from etl_tool.extract.sources import ExtractItem, open_source

__all__ = ["ExtractItem", "open_source"]
