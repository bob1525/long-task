"""Unit tests for every transform rule."""

from datetime import date, datetime

import pytest

from etl_tool.errors import ConfigError, TransformError
from etl_tool.transform.rules import build_rules, convert_value


def apply(spec: dict, record: dict):
    rule = build_rules([spec])[0]
    changed = rule.apply(record)
    return record, changed


def test_rename_moves_fields_and_can_swap():
    record, changed = apply(
        {"name": "rename_fields", "type": "rename", "mapping": {"email": "email_address", "notes": "comment"}},
        {"email": "A@B", "notes": "hi", "id": 1},
    )
    assert record == {"id": 1, "email_address": "A@B", "comment": "hi"}
    assert changed == 2
    swapped, changed = apply(
        {"type": "rename", "mapping": {"a": "b", "b": "a"}},
        {"a": 1, "b": 2},
    )
    assert swapped == {"b": 1, "a": 2}
    assert changed == 2


def test_rename_missing_field_modes_and_config_errors():
    record, changed = apply(
        {"type": "rename", "mapping": {"gone": "x"}, "on_missing": "skip"},
        {"a": 1},
    )
    assert record == {"a": 1}
    assert changed == 0
    with pytest.raises(TransformError, match="missing field"):
        apply({"type": "rename", "mapping": {"gone": "x"}, "on_missing": "fail"}, {"a": 1})
    with pytest.raises(ConfigError):
        build_rules([{"type": "rename", "mapping": {"a": "b", "c": "b"}}])
    with pytest.raises(ConfigError):
        build_rules([{"type": "rename", "mapping": {}}])
    with pytest.raises(ConfigError):
        build_rules([{"type": "rename", "on_missing": "maybe", "mapping": {"a": "b"}}])


def test_string_ops_trim_case_and_replace():
    record, changed = apply(
        {
            "name": "normalize_name",
            "type": "string",
            "field": "name",
            "ops": ["trim", "title", {"replace": {"old": "Ada", "new": "Countess"}}],
        },
        {"name": "  ada lovelace  "},
    )
    assert record["name"] == "Countess Lovelace"
    assert changed == 1
    record, changed = apply(
        {"type": "string", "field": "name", "ops": [{"op": "upper"}, {"op": "replace", "old": "A", "new": "X", "count": 1}]},
        {"name": "aba"},
    )
    assert record["name"] == "XBA"
    record, changed = apply(
        {"type": "string", "field": "qty", "ops": ["trim"]},
        {"qty": 12},
    )
    assert record["qty"] == "12"
    same, changed = apply(
        {"type": "string", "field": "name", "ops": ["trim", "lower"]},
        {"name": "ada"},
    )
    assert same["name"] == "ada"
    assert changed == 0


def test_string_null_missing_and_bad_values():
    record, changed = apply(
        {"type": "string", "field": "name", "ops": ["trim"], "on_missing": "skip"},
        {"name": None},
    )
    assert record["name"] is None and changed == 0
    record, _ = apply(
        {"type": "string", "field": "name", "ops": ["lower"], "on_missing": "skip"},
        {},
    )
    assert record == {}
    with pytest.raises(TransformError, match="null"):
        apply({"type": "string", "field": "name", "ops": ["trim"], "on_missing": "fail"}, {"name": None})
    with pytest.raises(TransformError, match="not a string"):
        apply({"type": "string", "field": "name", "ops": ["trim"]}, {"name": {"a": 1}})
    for spec in [
        {"type": "string", "field": "name", "ops": []},
        {"type": "string", "ops": ["trim"]},
        {"type": "string", "field": "name", "ops": ["reverse"]},
        {"type": "string", "field": "name", "ops": [{"replace": {"old": "", "new": "a"}}]},
        {"type": "string", "field": "name", "ops": [{"replace": {"old": "a"}}]},
        {"type": "string", "field": "name", "ops": [{"op": "replace", "old": "a", "new": "b", "count": -1}]},
        {"type": "string", "field": "name", "ops": [1]},
    ]:
        with pytest.raises(ConfigError):
            build_rules([spec])


def test_cast_conversions():
    record, changed = apply(
        {
            "name": "cast_types",
            "type": "cast",
            "fields": {"age": "int", "price": "float", "ok": "bool", "label": "str"},
        },
        {"age": "36", "price": "10.5", "ok": "yes", "label": 3},
    )
    assert record == {"age": 36, "price": 10.5, "ok": True, "label": "3"}
    assert changed == 4
    record, changed = apply(
        {"type": "cast", "field": "day", "to": "date"},
        {"day": "2020/01/02"},
    )
    assert record["day"] == "2020-01-02"
    record, _ = apply(
        {"type": "cast", "field": "when", "to": "datetime"},
        {"when": "2020-01-02T03:04:05"},
    )
    assert record["when"].startswith("2020-01-02T03:04:05")
    record, changed = apply(
        {"type": "cast", "field": "age", "to": "int"},
        {"age": 4},
    )
    assert changed == 0 and record["age"] == 4


def test_cast_failures_default_and_bool_edges():
    with pytest.raises(TransformError, match="cannot cast field 'age'"):
        apply({"type": "cast", "field": "age", "to": "int"}, {"age": "not_a_number"})
    record, _ = apply(
        {"type": "cast", "field": "age", "to": "int", "default": None},
        {"age": "nope"},
    )
    assert record["age"] is None
    record, _ = apply(
        {"type": "cast", "field": "flag", "to": "bool"},
        {"flag": False},
    )
    assert record["flag"] is False
    assert convert_value(True, "int") == 1
    assert convert_value(0, "bool") is False
    assert convert_value("3.0", "int") == 3
    assert convert_value("1e2", "float") == 100.0
    assert convert_value(datetime(2020, 1, 2, 3, 4, 5), "datetime").startswith("2020-01-02T03:04:05")
    assert convert_value(date(2020, 5, 1), "date") == "2020-05-01"
    assert convert_value(True, "str") == "true"
    for value, kind in [("3.5", "int"), (float("inf"), "float"), ("maybe", "bool"), ("nope", "date"), ({}, "int")]:
        with pytest.raises(TransformError):
            convert_value(value, kind)
    with pytest.raises(TransformError):
        convert_value("x", "mystery")
    with pytest.raises(ConfigError):
        build_rules([{"type": "cast", "fields": {"a": "money"}}])
    with pytest.raises(ConfigError):
        build_rules([{"type": "cast", "field": "a"}])
    with pytest.raises(TransformError, match="missing field"):
        apply({"type": "cast", "field": "age", "to": "int", "on_missing": "fail"}, {})


def test_expression_rule_writes_target_and_records_failure():
    record, changed = apply(
        {"name": "line_total", "type": "expression", "target": "total", "expr": "price * qty"},
        {"price": 5, "qty": 4, "total": 0},
    )
    assert record["total"] == 20
    assert changed == 1
    record, changed = apply(
        {"type": "expression", "target": "total", "expr": "1 + 1"},
        {"total": 2},
    )
    assert changed == 0
    with pytest.raises(TransformError, match="division by zero"):
        apply({"name": "unit_price", "type": "expression", "target": "unit", "expr": "price / qty"}, {"price": 10, "qty": 0})
    with pytest.raises(ConfigError):
        build_rules([{"type": "expression", "target": "a", "expr": "1 +"}])
    with pytest.raises(ConfigError):
        build_rules([{"type": "expression", "target": "a"}])


def test_conditional_mapping():
    spec = {
        "name": "tier",
        "type": "conditional",
        "target": "tier",
        "when": [
            {"if": "total >= 1000", "then": "gold"},
            {"if": "total >= 100", "then": {"expr": "'silver'"}},
        ],
        "else": "bronze",
    }
    assert apply(spec, {"total": 1000})[0]["tier"] == "gold"
    assert apply(spec, {"total": 120})[0]["tier"] == "silver"
    assert apply(spec, {"total": 10})[0]["tier"] == "bronze"
    record, changed = apply(
        {"type": "conditional", "target": "tier", "when": [{"if": "total > 0", "then": "bronze"}]},
        {"total": 0, "tier": None},
    )
    assert record["tier"] is None
    assert changed == 0
    with pytest.raises(TransformError, match="unknown field"):
        apply(spec, {})
    with pytest.raises(ConfigError):
        build_rules([{"type": "conditional", "target": "tier", "when": [{"if": "1"}]}])
    with pytest.raises(ConfigError):
        build_rules([{"type": "conditional", "target": "tier", "when": []}])


def test_merge_and_split():
    record, changed = apply(
        {
            "name": "full_address",
            "type": "merge",
            "fields": ["street", "city", "zip"],
            "target": "address",
            "separator": ", ",
        },
        {"street": "12 King St", "city": "London", "zip": "SW1A", "blank": ""},
    )
    assert record["address"] == "12 King St, London, SW1A"
    assert changed == 1
    record, _ = apply(
        {"type": "merge", "fields": ["a", "b"], "target": "c", "separator": "-", "skip_empty": True},
        {"a": "x", "b": ""},
    )
    assert record["c"] == "x"
    record, _ = apply(
        {"type": "merge", "fields": ["a", "b"], "target": "c", "separator": "-", "skip_empty": True},
        {"a": 1, "b": False},
    )
    assert record["c"] == "1-false"
    with pytest.raises(TransformError, match="missing field"):
        apply(
            {"type": "merge", "fields": ["a", "b"], "target": "c", "skip_empty": False, "on_missing": "fail"},
            {"a": "x"},
        )
    with pytest.raises(TransformError, match="text"):
        apply({"type": "merge", "fields": ["a", "b"], "target": "c"}, {"a": {"z": 1}, "b": "y"})
    record, changed = apply(
        {"name": "split_name", "type": "split", "field": "full_name", "separator": " ", "targets": ["first_name", "last_name"]},
        {"full_name": "Eve Extra Names"},
    )
    assert record["first_name"] == "Eve"
    assert record["last_name"] == "Extra Names"
    assert changed == 2
    record, _ = apply(
        {"type": "split", "field": "full_name", "separator": " ", "targets": ["first_name", "last_name"]},
        {"full_name": "Prince"},
    )
    assert record["last_name"] == ""
    record, changed = apply(
        {"type": "split", "field": "full_name", "separator": " ", "targets": ["first_name"], "on_missing": "skip"},
        {},
    )
    assert changed == 0
    with pytest.raises(TransformError, match="missing field"):
        apply(
            {"type": "split", "field": "full_name", "separator": " ", "targets": ["first_name"], "on_missing": "fail"},
            {},
        )
    for spec in [
        {"type": "merge", "fields": ["a"], "target": "c"},
        {"type": "split", "field": "a", "separator": "", "targets": ["b"]},
        {"type": "split", "targets": ["b"]},
    ]:
        with pytest.raises(ConfigError):
            build_rules([spec])


def test_rule_list_must_have_unique_known_types():
    with pytest.raises(ConfigError, match="unsupported"):
        build_rules([{"type": "drop", "field": "a"}])
    with pytest.raises(ConfigError, match="duplicate"):
        build_rules(
            [
                {"name": "same", "type": "expression", "target": "a", "expr": "1"},
                {"name": "same", "type": "expression", "target": "b", "expr": "2"},
            ]
        )
    rules = build_rules([{"type": "cast", "field": "a", "to": "int"}, {"type": "cast", "field": "b", "to": "int"}])
    assert [rule.name for rule in rules] == ["cast_0", "cast_1"]
    with pytest.raises(ConfigError):
        build_rules(["nope"])  # type: ignore[list-item]
