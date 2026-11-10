"""Apply an ordered list of rules and record what each rule did."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from etl_tool.errors import TransformError
from etl_tool.transform.rules import Rule


@dataclass
class RuleStats:
    name: str
    type: str
    rows_seen: int = 0
    rows_modified: int = 0
    fields_modified: int = 0
    rows_failed: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def restore(self, payload: dict[str, Any]) -> None:
        self.rows_seen = int(payload.get("rows_seen", 0))
        self.rows_modified = int(payload.get("rows_modified", 0))
        self.fields_modified = int(payload.get("fields_modified", 0))
        self.rows_failed = int(payload.get("rows_failed", 0))


class Engine:
    def __init__(self, rules: list[Rule]) -> None:
        self.rules = rules
        self.stats = [
            RuleStats(name=rule.name, type=rule.type) for rule in rules
        ]

    def transform(self, record: dict[str, Any]) -> dict[str, Any]:
        working = dict(record)
        for rule, stats in zip(self.rules, self.stats):
            stats.rows_seen += 1
            try:
                changed = rule.apply(working)
            except TransformError:
                stats.rows_failed += 1
                raise
            except Exception as exc:
                stats.rows_failed += 1
                raise TransformError(str(exc), rule.name, rule.type) from exc
            if changed:
                stats.rows_modified += 1
                stats.fields_modified += int(changed)
        return working

    def snapshot(self) -> list[dict[str, Any]]:
        return [item.to_dict() for item in self.stats]

    def restore(self, saved: list[dict[str, Any]]) -> None:
        by_name = {item["name"]: item for item in saved}
        for stats in self.stats:
            payload = by_name.get(stats.name)
            if payload:
                stats.restore(payload)
