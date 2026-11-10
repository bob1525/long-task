"""Rule ordering and per-rule statistics."""

import pytest

from etl_tool.errors import TransformError
from etl_tool.transform.engine import Engine
from etl_tool.transform.rules import build_rules


def test_rules_run_in_order_and_stats_count_changes():
    rules = build_rules(
        [
            {"name": "trim_name", "type": "string", "field": "name", "ops": ["trim"]},
            {"name": "upper_name", "type": "string", "field": "name", "ops": ["upper"]},
            {"name": "cast_age", "type": "cast", "field": "age", "to": "int"},
        ]
    )
    engine = Engine(rules)
    assert engine.transform({"name": " ada ", "age": "3"}) == {"name": "ADA", "age": 3}
    assert engine.transform({"name": "ada", "age": 3})["name"] == "ADA"
    stats = {item["name"]: item for item in engine.snapshot()}
    assert stats["trim_name"]["rows_seen"] == 2
    assert stats["trim_name"]["rows_modified"] == 1
    assert stats["trim_name"]["fields_modified"] == 1
    assert stats["trim_name"]["rows_failed"] == 0
    assert stats["upper_name"]["rows_modified"] == 2
    assert stats["cast_age"]["rows_modified"] == 1
    assert stats["cast_age"]["rows_failed"] == 0


def test_failure_stops_later_rules_and_is_counted():
    engine = Engine(
        build_rules(
            [
                {"name": "cast_age", "type": "cast", "field": "age", "to": "int"},
                {"name": "after", "type": "expression", "target": "double", "expr": "age * 2"},
            ]
        )
    )
    with pytest.raises(TransformError, match="cast_age"):
        engine.transform({"age": "nope"})
    assert engine.transform({"age": "4"})["double"] == 8
    stats = {item["name"]: item for item in engine.snapshot()}
    assert stats["cast_age"]["rows_seen"] == 2
    assert stats["cast_age"]["rows_failed"] == 1
    assert stats["after"]["rows_seen"] == 1
    assert stats["after"]["rows_failed"] == 0


def test_unexpected_exception_becomes_transform_error():
    class Boom:
        name = "boom"
        type = "cast"

        def apply(self, record):
            raise RuntimeError("nope")

    engine = Engine([Boom()])  # type: ignore[list-item]
    with pytest.raises(TransformError, match="nope") as caught:
        engine.transform({"a": 1})
    assert caught.value.rule == "boom"
    assert engine.snapshot()[0]["rows_failed"] == 1


def test_restore_stats_then_continue():
    rules = build_rules([{"name": "add", "type": "expression", "target": "n", "expr": "n + 1"}])
    first = Engine(rules)
    assert first.transform({"n": 1})["n"] == 2
    saved = first.snapshot()
    second = Engine(build_rules([{"name": "add", "type": "expression", "target": "n", "expr": "n + 1"}]))
    second.restore(saved)
    second.restore([])
    assert second.transform({"n": 5})["n"] == 6
    assert second.snapshot()[0]["rows_seen"] == 2
