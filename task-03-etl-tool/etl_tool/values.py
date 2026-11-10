"""JSON-safe record copies used in loaders and reports."""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from typing import Any

from etl_tool.errors import LoadError


def sanitize(value: Any) -> Any:
    """Return a JSON-compatible copy, or raise LoadError."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise LoadError(f"non-finite number {value!r}")
        return value
    if isinstance(value, datetime):
        return value.isoformat(sep="T")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    raise LoadError(f"unsupported value type {type(value).__name__}")


def snapshot(value: Any) -> Any:
    """Best-effort JSON snapshot for an error report. Never raises."""
    try:
        cleaned = sanitize(value)
    except LoadError:
        cleaned = _fallback(value, set())
    try:
        return json.loads(json.dumps(cleaned, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError):
        return {"unserializable": type(value).__name__}


def _fallback(value: Any, seen: set[int]) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return str(value)
        return value
    if isinstance(value, datetime):
        return value.isoformat(sep="T")
    if isinstance(value, date):
        return value.isoformat()
    marker = id(value)
    if marker in seen:
        return "<cycle>"
    if isinstance(value, dict):
        seen.add(marker)
        return {str(key): _fallback(item, seen) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        seen.add(marker)
        return [_fallback(item, seen) for item in value]
    if isinstance(value, (set, frozenset)):
        seen.add(marker)
        return [_fallback(item, seen) for item in value]
    return str(value)
