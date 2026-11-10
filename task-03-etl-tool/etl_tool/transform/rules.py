"""Configurable transform rules.

Rules mutate a working record and return how many fields changed.
They raise TransformError when one record cannot be converted; the caller
discards the working record and keeps the pipeline running.
"""

from __future__ import annotations

import math
import re
from abc import ABC, abstractmethod
from datetime import date, datetime
from typing import Any

from etl_tool.errors import ConfigError, TransformError
from etl_tool.transform.expression import Expression, ExpressionError, compile_expression

_MISSING = object()
_TRUE = {"true", "yes", "y", "1"}
_FALSE = {"false", "no", "n", "0"}
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d-%m-%Y")
_DATETIME_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y/%m/%d %H:%M:%S",
)


def value_changed(old: Any, new: Any) -> bool:
    if type(old) is not type(new):
        return True
    return old != new


class Rule(ABC):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        self.spec = spec
        self.index = index
        raw_name = spec.get("name")
        self.name = str(raw_name) if raw_name else f"{spec.get('type', 'rule')}_{index}"
        self.type = str(spec.get("type", ""))
        self.on_missing = str(spec.get("on_missing", "skip"))
        if self.on_missing not in {"skip", "fail"}:
            raise ConfigError(f"rule {self.name}: on_missing must be skip or fail")

    @abstractmethod
    def apply(self, record: dict[str, Any]) -> int:
        """Mutate record. Return the number of fields whose value changed."""


class RenameRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        mapping = spec.get("mapping")
        if not isinstance(mapping, dict) or not mapping:
            raise ConfigError(f"rule {self.name}: rename requires a non-empty mapping")
        self.mapping = {str(src): str(dst) for src, dst in mapping.items()}
        destinations = list(self.mapping.values())
        if len(set(destinations)) != len(destinations):
            raise ConfigError(f"rule {self.name}: rename destinations must be unique")

    def apply(self, record: dict[str, Any]) -> int:
        moves: list[tuple[str, str, Any]] = []
        for src, dst in self.mapping.items():
            if src not in record:
                if self.on_missing == "fail":
                    raise TransformError(
                        f"missing field {src!r}",
                        self.name,
                        self.type,
                    )
                continue
            moves.append((src, dst, record[src]))
        for src, dst, _value in moves:
            if src != dst:
                record.pop(src, None)
        changed = 0
        for src, dst, value in moves:
            record[dst] = value
            if src != dst:
                changed += 1
        return changed


class CastRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        fields = spec.get("fields")
        if fields is None and "field" in spec:
            if "to" not in spec:
                raise ConfigError(f"rule {self.name}: cast requires 'to'")
            fields = {spec["field"]: spec["to"]}
        if not isinstance(fields, dict) or not fields:
            raise ConfigError(f"rule {self.name}: cast requires fields")
        self.fields = {str(name): str(kind) for name, kind in fields.items()}
        for kind in self.fields.values():
            if kind not in {"int", "float", "str", "bool", "date", "datetime"}:
                raise ConfigError(f"rule {self.name}: unsupported cast target {kind!r}")
        self.has_default = "default" in spec
        self.default = spec.get("default")

    def apply(self, record: dict[str, Any]) -> int:
        updates: dict[str, Any] = {}
        for field, kind in self.fields.items():
            if field not in record:
                if self.on_missing == "fail":
                    raise TransformError(f"missing field {field!r}", self.name, self.type)
                continue
            try:
                updates[field] = convert_value(record[field], kind)
            except TransformError:
                if not self.has_default:
                    raise TransformError(
                        f"cannot cast field {field!r} value {record[field]!r} to {kind}",
                        self.name,
                        self.type,
                    )
                updates[field] = self.default
        changed = 0
        for field, value in updates.items():
            if value_changed(record[field], value):
                changed += 1
            record[field] = value
        return changed


class StringRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        if "field" not in spec:
            raise ConfigError(f"rule {self.name}: string rule requires field")
        self.field = str(spec["field"])
        ops = spec.get("ops")
        if not isinstance(ops, list) or not ops:
            raise ConfigError(f"rule {self.name}: string rule requires ops")
        self.ops = [_compile_string_op(op, self.name) for op in ops]

    def apply(self, record: dict[str, Any]) -> int:
        if self.field not in record:
            if self.on_missing == "fail":
                raise TransformError(f"missing field {self.field!r}", self.name, self.type)
            return 0
        value = record[self.field]
        if value is None:
            if self.on_missing == "fail":
                raise TransformError(f"field {self.field!r} is null", self.name, self.type)
            return 0
        if not isinstance(value, str):
            if isinstance(value, (int, float, bool)):
                value = "true" if value is True else "false" if value is False else str(value)
            else:
                raise TransformError(
                    f"field {self.field!r} is not a string",
                    self.name,
                    self.type,
                )
        updated = value
        for op in self.ops:
            updated = op(updated)
        if value_changed(value, updated):
            record[self.field] = updated
            return 1
        record[self.field] = updated
        return 0


class ExpressionRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        if "target" not in spec or "expr" not in spec:
            raise ConfigError(f"rule {self.name}: expression requires target and expr")
        self.target = str(spec["target"])
        try:
            self.compiled: Expression = compile_expression(str(spec["expr"]))
        except ExpressionError as exc:
            raise ConfigError(f"rule {self.name}: {exc}") from exc

    def apply(self, record: dict[str, Any]) -> int:
        try:
            value = self.compiled.evaluate(record)
        except ExpressionError as exc:
            raise TransformError(str(exc), self.name, self.type) from exc
        if isinstance(value, float) and not math.isfinite(value):
            raise TransformError(
                f"expression {self.compiled.source!r} returned a non-finite number",
                self.name,
                self.type,
            )
        old = record.get(self.target, _MISSING)
        record[self.target] = value
        if old is _MISSING or value_changed(old, value):
            return 1
        return 0


class ConditionalRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        if "target" not in spec:
            raise ConfigError(f"rule {self.name}: conditional requires target")
        self.target = str(spec["target"])
        clauses = spec.get("when")
        if not isinstance(clauses, list) or not clauses:
            raise ConfigError(f"rule {self.name}: conditional requires when")
        self.clauses: list[tuple[Expression, Any, Expression | None]] = []
        for clause in clauses:
            if not isinstance(clause, dict) or "if" not in clause or "then" not in clause:
                raise ConfigError(f"rule {self.name}: each when clause needs if and then")
            try:
                test = compile_expression(str(clause["if"]))
            except ExpressionError as exc:
                raise ConfigError(f"rule {self.name}: {exc}") from exc
            then_value, then_expr = _compile_result(clause["then"], self.name)
            self.clauses.append((test, then_value, then_expr))
        if "else" in spec:
            self.else_value, self.else_expr = _compile_result(spec["else"], self.name)
            self.has_else = True
        else:
            self.else_value, self.else_expr = None, None
            self.has_else = False

    def apply(self, record: dict[str, Any]) -> int:
        chosen: Any = self.else_value
        chosen_expr = self.else_expr
        matched = False
        for test, then_value, then_expr in self.clauses:
            try:
                result = test.evaluate(record)
            except ExpressionError as exc:
                raise TransformError(str(exc), self.name, self.type) from exc
            if _truthy(result):
                chosen = then_value
                chosen_expr = then_expr
                matched = True
                break
        if not matched and not self.has_else:
            chosen = None
        if chosen_expr is not None:
            try:
                chosen = chosen_expr.evaluate(record)
            except ExpressionError as exc:
                raise TransformError(str(exc), self.name, self.type) from exc
        old = record.get(self.target, _MISSING)
        record[self.target] = chosen
        if old is _MISSING or value_changed(old, chosen):
            return 1
        return 0


class MergeRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        fields = spec.get("fields")
        if not isinstance(fields, list) or len(fields) < 2:
            raise ConfigError(f"rule {self.name}: merge requires at least two fields")
        if "target" not in spec:
            raise ConfigError(f"rule {self.name}: merge requires target")
        self.fields = [str(field) for field in fields]
        self.target = str(spec["target"])
        self.separator = str(spec.get("separator", ""))
        self.skip_empty = bool(spec.get("skip_empty", True))

    def apply(self, record: dict[str, Any]) -> int:
        parts: list[str] = []
        for field in self.fields:
            if field not in record or record[field] is None:
                if self.skip_empty and self.on_missing == "skip":
                    continue
                raise TransformError(f"missing field {field!r}", self.name, self.type)
            text = _as_text(record[field], self)
            if text == "" and self.skip_empty:
                continue
            parts.append(text)
        merged = self.separator.join(parts)
        old = record.get(self.target, _MISSING)
        record[self.target] = merged
        if old is _MISSING or value_changed(old, merged):
            return 1
        return 0


class SplitRule(Rule):
    def __init__(self, spec: dict[str, Any], index: int) -> None:
        super().__init__(spec, index)
        if "field" not in spec:
            raise ConfigError(f"rule {self.name}: split requires field")
        targets = spec.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ConfigError(f"rule {self.name}: split requires targets")
        separator = spec.get("separator", " ")
        if not isinstance(separator, str) or separator == "":
            raise ConfigError(f"rule {self.name}: split separator must be a non-empty string")
        self.field = str(spec["field"])
        self.separator = separator
        self.targets = [str(item) for item in targets]

    def apply(self, record: dict[str, Any]) -> int:
        if self.field not in record or record[self.field] is None:
            if self.on_missing == "fail":
                raise TransformError(f"missing field {self.field!r}", self.name, self.type)
            return 0
        text = _as_text(record[self.field], self)
        pieces = text.split(self.separator, len(self.targets) - 1)
        if len(pieces) < len(self.targets):
            pieces = pieces + [""] * (len(self.targets) - len(pieces))
        changed = 0
        for target, piece in zip(self.targets, pieces):
            old = record.get(target, _MISSING)
            record[target] = piece
            if old is _MISSING or value_changed(old, piece):
                changed += 1
        return changed


def build_rules(specs: list[dict[str, Any]]) -> list[Rule]:
    rules: list[Rule] = []
    names: set[str] = set()
    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise ConfigError(f"rule at index {index} must be a mapping")
        rule_type = spec.get("type")
        cls = _RULES.get(str(rule_type))
        if cls is None:
            raise ConfigError(f"unsupported rule type {rule_type!r}")
        rule = cls(spec, index)
        if rule.name in names:
            raise ConfigError(f"duplicate rule name {rule.name!r}")
        names.add(rule.name)
        rules.append(rule)
    return rules


_RULES: dict[str, type[Rule]] = {
    "rename": RenameRule,
    "cast": CastRule,
    "string": StringRule,
    "expression": ExpressionRule,
    "conditional": ConditionalRule,
    "merge": MergeRule,
    "split": SplitRule,
}


def convert_value(value: Any, kind: str) -> Any:
    if kind == "str":
        if isinstance(value, bool):
            return "true" if value else "false"
        if value is None:
            raise TransformError("cannot cast null", "", "cast")
        return str(value)
    if kind == "bool":
        return _convert_bool(value)
    if kind == "int":
        return _convert_int(value)
    if kind == "float":
        return _convert_float(value)
    if kind == "date":
        return _convert_date(value)
    if kind == "datetime":
        return _convert_datetime(value)
    raise TransformError(f"unsupported cast target {kind}", "", "cast")


def _convert_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 1:
            return True
        if value == 0:
            return False
        raise TransformError("cannot cast number to bool", "", "cast")
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
    raise TransformError("cannot cast value to bool", "", "cast")


def _convert_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise TransformError("cannot cast float to int", "", "cast")
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"[+-]?\d+", text):
            return int(text)
        try:
            number = float(text)
        except ValueError as exc:
            raise TransformError("cannot cast string to int", "", "cast") from exc
        if not math.isfinite(number) or not number.is_integer():
            raise TransformError("cannot cast string to int", "", "cast")
        return int(number)
    raise TransformError("cannot cast value to int", "", "cast")


def _convert_float(value: Any) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise TransformError("cannot cast non-finite float", "", "cast")
        return number
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError as exc:
            raise TransformError("cannot cast string to float", "", "cast") from exc
        if not math.isfinite(number):
            raise TransformError("cannot cast non-finite float", "", "cast")
        return number
    raise TransformError("cannot cast value to float", "", "cast")


def _convert_date(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        text = value.strip()
        try:
            return date.fromisoformat(text[:10] if "T" in text else text).isoformat()
        except ValueError:
            pass
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(text, fmt).date().isoformat()
            except ValueError:
                continue
    raise TransformError("cannot cast value to date", "", "cast")


def _convert_datetime(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(sep="T")
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day).isoformat(sep="T")
    if isinstance(value, str):
        text = value.strip()
        iso = text.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(iso).isoformat(sep="T")
        except ValueError:
            pass
        for fmt in _DATETIME_FORMATS:
            try:
                return datetime.strptime(text, fmt).isoformat(sep="T")
            except ValueError:
                continue
    raise TransformError("cannot cast value to datetime", "", "cast")


def _compile_string_op(op: Any, rule_name: str):
    if isinstance(op, str):
        return _named_string_op(op, rule_name)
    if isinstance(op, dict):
        if "op" in op:
            name = str(op["op"])
            if name == "replace":
                return _replace_op(op, rule_name)
            return _named_string_op(name, rule_name)
        if len(op) == 1:
            name, payload = next(iter(op.items()))
            if name == "replace":
                if not isinstance(payload, dict):
                    raise ConfigError(f"rule {rule_name}: replace expects a mapping")
                return _replace_op(payload, rule_name)
            if payload in (True, None, {}):
                return _named_string_op(str(name), rule_name)
    raise ConfigError(f"rule {rule_name}: unsupported string op {op!r}")


def _named_string_op(name: str, rule_name: str):
    if name == "trim":
        return lambda value: value.strip()
    if name == "lower":
        return lambda value: value.lower()
    if name == "upper":
        return lambda value: value.upper()
    if name == "title":
        return lambda value: value.title()
    raise ConfigError(f"rule {rule_name}: unsupported string op {name!r}")


def _replace_op(payload: dict[str, Any], rule_name: str):
    if "old" not in payload or "new" not in payload:
        raise ConfigError(f"rule {rule_name}: replace requires old and new")
    old = str(payload["old"])
    new = str(payload["new"])
    if old == "":
        raise ConfigError(f"rule {rule_name}: replace old string must not be empty")
    count = payload.get("count")
    if count is None:
        return lambda value: value.replace(old, new)
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ConfigError(f"rule {rule_name}: replace count must be a non-negative integer")
    return lambda value: value.replace(old, new, count)


def _compile_result(value: Any, rule_name: str) -> tuple[Any, Expression | None]:
    if isinstance(value, dict) and "expr" in value and len(value) == 1:
        try:
            return None, compile_expression(str(value["expr"]))
        except ExpressionError as exc:
            raise ConfigError(f"rule {rule_name}: {exc}") from exc
    return value, None


def _as_text(value: Any, rule: Rule) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    raise TransformError(
        f"cannot treat {type(value).__name__} as text",
        rule.name,
        rule.type,
    )


def _truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and not (isinstance(value, float) and not math.isfinite(value))
    if isinstance(value, str):
        return value != ""
    return True
