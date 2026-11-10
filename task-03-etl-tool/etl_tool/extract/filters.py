"""Row filters applied during extract."""

from __future__ import annotations

import re
from typing import Any, Callable

from etl_tool.errors import ConfigError

Predicate = Callable[[dict[str, Any]], bool]

_ORDERING = {"gt", "gte", "lt", "lte"}
_NUMERIC = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")


def compile_filter(spec: Any) -> Predicate:
    if spec is None:
        return lambda _record: True
    if isinstance(spec, list):
        checks = [compile_filter(item) for item in spec]
        return lambda record: all(check(record) for check in checks)
    if not isinstance(spec, dict):
        raise ConfigError("filter must be a mapping or a list")
    if "all" in spec:
        children = spec["all"]
        if not isinstance(children, list):
            raise ConfigError("filter.all must be a list")
        checks = [compile_filter(item) for item in children]
        return lambda record: all(check(record) for check in checks)
    if "any" in spec:
        children = spec["any"]
        if not isinstance(children, list):
            raise ConfigError("filter.any must be a list")
        checks = [compile_filter(item) for item in children]
        return lambda record: any(check(record) for check in checks)
    if "not" in spec:
        inner = compile_filter(spec["not"])
        return lambda record: not inner(record)
    if "field" not in spec or "op" not in spec:
        raise ConfigError("filter leaf requires field and op")
    field = str(spec["field"])
    op = str(spec["op"])
    if op in {"is_null", "not_null", "is_blank", "exists"}:
        return _null_predicate(field, op)
    if "value" not in spec and op not in {"is_null", "not_null", "is_blank", "exists"}:
        raise ConfigError(f"filter op {op} requires value")
    value = spec.get("value")
    if op == "regex":
        try:
            pattern = re.compile(str(value))
        except re.error as exc:
            raise ConfigError(f"invalid filter regex: {exc}") from exc
        return lambda record: pattern.search(_as_text(record.get(field))) is not None
    if op not in {
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "startswith",
        "endswith",
        "in",
        "not_in",
    }:
        raise ConfigError(f"unsupported filter op {op!r}")
    return lambda record, _field=field, _op=op, _value=value: _compare(
        record.get(_field), _op, _value, _field in record
    )


def _null_predicate(field: str, op: str) -> Predicate:
    if op == "is_null":
        return lambda record: field not in record or record[field] is None
    if op == "not_null":
        return lambda record: field in record and record[field] is not None
    if op == "exists":
        return lambda record: field in record
    if op == "is_blank":
        return lambda record: field not in record or record[field] is None or (
            isinstance(record[field], str) and record[field].strip() == ""
        )
    raise ConfigError(f"unsupported filter op {op!r}")


def _compare(left: Any, op: str, right: Any, present: bool) -> bool:
    if not present and op not in {"eq", "ne", "in", "not_in"}:
        return False
    if op == "eq":
        return _equals(left, right)
    if op == "ne":
        return not _equals(left, right)
    if op in _ORDERING:
        return _order(left, right, op)
    if op == "contains":
        return str(right) in _as_text(left)
    if op == "startswith":
        return _as_text(left).startswith(str(right))
    if op == "endswith":
        return _as_text(left).endswith(str(right))
    if op == "in":
        if not isinstance(right, (list, tuple, set)):
            return False
        return any(_equals(left, item) for item in right)
    if op == "not_in":
        if not isinstance(right, (list, tuple, set)):
            return True
        return all(not _equals(left, item) for item in right)
    return False


def _equals(left: Any, right: Any) -> bool:
    left_ok, left_num = _try_number(left)
    right_ok, right_num = _try_number(right)
    if left_ok and right_ok:
        return left_num == right_num
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    return left == right


def _order(left: Any, right: Any, op: str) -> bool:
    left_ok, left_num = _try_number(left)
    right_ok, right_num = _try_number(right)
    if left_ok and right_ok:
        lval: Any = left_num
        rval: Any = right_num
    elif isinstance(left, str) and isinstance(right, str):
        lval = left
        rval = right
    else:
        return False
    if op == "gt":
        return lval > rval
    if op == "gte":
        return lval >= rval
    if op == "lt":
        return lval < rval
    if op == "lte":
        return lval <= rval
    return False


def _try_number(value: Any) -> tuple[bool, float]:
    if isinstance(value, bool) or value is None:
        return False, 0.0
    if isinstance(value, (int, float)):
        return True, float(value)
    if isinstance(value, str) and _NUMERIC.fullmatch(value.strip()):
        try:
            return True, float(value.strip())
        except ValueError:
            return False, 0.0
    return False, 0.0


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
