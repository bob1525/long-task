"""Extract-stage row filters."""

import pytest

from etl_tool.errors import ConfigError
from etl_tool.extract.filters import compile_filter


def test_comparisons_membership_and_text_ops():
    keep = compile_filter({"field": "status", "op": "eq", "value": "active"})
    assert keep({"status": "active"}) is True
    assert keep({"status": "ignore"}) is False
    assert compile_filter({"field": "qty", "op": "gt", "value": 5})({"qty": "10"}) is True
    assert compile_filter({"field": "qty", "op": "lte", "value": "2"})({"qty": 2}) is True
    assert compile_filter({"field": "qty", "op": "lt", "value": 0})({"qty": "x"}) is False
    assert compile_filter({"field": "name", "op": "ne", "value": "a"})({"name": "b"}) is True
    assert compile_filter({"field": "city", "op": "contains", "value": "don"})({"city": "London"}) is True
    assert compile_filter({"field": "city", "op": "startswith", "value": "Lon"})({"city": "London"}) is True
    assert compile_filter({"field": "city", "op": "endswith", "value": "don"})({"city": "London"}) is True
    assert compile_filter({"field": "city", "op": "regex", "value": "^L"})({"city": "London"}) is True
    assert compile_filter({"field": "id", "op": "in", "value": [1, "2"]})({"id": "1"}) is True
    assert compile_filter({"field": "id", "op": "not_in", "value": [1]})({"id": 2}) is True
    assert compile_filter({"field": "id", "op": "in", "value": "nope"})({"id": 1}) is False
    assert compile_filter({"field": "note", "op": "is_null"})({}) is True
    assert compile_filter({"field": "note", "op": "is_null"})({"note": ""}) is False
    assert compile_filter({"field": "note", "op": "is_blank"})({"note": "  "}) is True
    assert compile_filter({"field": "note", "op": "not_null"})({"note": 0}) is True
    assert compile_filter({"field": "note", "op": "exists"})({"note": None}) is True
    assert compile_filter({"field": "qty", "op": "gte", "value": 1})({}) is False


def test_nested_filters_and_config_errors():
    spec = {
        "all": [
            {"field": "status", "op": "eq", "value": "active"},
            {"any": [{"field": "qty", "op": "gt", "value": 1}, {"not": {"field": "city", "op": "eq", "value": "Oslo"}}]},
        ]
    }
    check = compile_filter(spec)
    assert check({"status": "active", "qty": "0", "city": "Rome"}) is True
    assert check({"status": "ignore", "qty": "3", "city": "Rome"}) is False
    assert compile_filter([{"field": "a", "op": "eq", "value": 1}, {"field": "b", "op": "eq", "value": 2}])(
        {"a": "1", "b": 2}
    ) is True
    assert compile_filter(None)({"anything": 1}) is True
    for bad in [
        {"field": "a"},
        {"field": "a", "op": "regex", "value": "["},
        {"field": "a", "op": "soundex", "value": "a"},
        {"all": "nope"},
        {"any": {}},
        "nope",
    ]:
        with pytest.raises(ConfigError):
            compile_filter(bad)
