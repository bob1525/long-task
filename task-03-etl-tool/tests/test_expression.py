"""Unit tests for the safe expression language."""

import math

import pytest

from etl_tool.transform.expression import ExpressionError, compile_expression


def ev(source: str, record: dict | None = None):
    return compile_expression(source).evaluate(record or {})


def test_arithmetic_keeps_integers_and_uses_float_division():
    assert ev("1 + 2 * 3") == 7
    assert ev("(1 + 2) * 3") == 9
    assert ev("8 - 3") == 5
    assert ev("7 % 4") == 3
    assert ev("-5 % 2") == 1
    assert ev("4 / 2") == 2.0
    assert ev("price * qty", {"price": 10.5, "qty": 3}) == 31.5
    assert ev(".5 + .5") == 1.0
    assert ev("1.5e1") == 15.0
    assert ev("1e2 + 1") == 101.0
    assert ev("--3") == 3
    assert ev("+-4") == -4
    assert ev("+qty", {"qty": 8}) == 8
    assert ev("-qty", {"qty": 8}) == -8


def test_large_integers_are_not_rounded():
    assert ev("9007199254740993 + 1") == 9007199254740994


def test_string_concatenation_and_rejects_mixed_plus():
    assert ev("'a' + 'b'") == "ab"
    assert ev('"a\\nb"') == "a\nb"
    with pytest.raises(ExpressionError, match="number"):
        ev("'a' + 1")


def test_comparisons_and_boolean_logic():
    assert ev("1 < 2 < 3") is True
    assert ev("1 < 2 < 2") is False
    assert ev("5 >= 5 and 4 != 3") is True
    assert ev("false or true and false") is False
    assert ev("true or false and false") is True
    assert ev("not not true") is True
    assert ev("!false") is True
    assert ev("true && false || true") is True
    assert ev("null == null") is True
    assert ev("a == null", {"a": None}) is True
    assert ev("true == 1") is False
    assert ev("true == true") is True
    assert ev("'b' > 'a'") is True
    assert ev("1 <= 1") is True


def test_short_circuit_skips_failing_branch():
    assert ev("false and (1 / 0)") is False
    assert ev("true or (1 / 0)") is True
    assert ev("1 < 0 < (1 / 0)") is False
    with pytest.raises(ExpressionError, match="division by zero"):
        ev("1 < 2 < (1 / 0)")


def test_runtime_errors():
    with pytest.raises(ExpressionError, match="division by zero"):
        ev("1 / 0")
    with pytest.raises(ExpressionError, match="modulo by zero"):
        ev("1 % 0")
    with pytest.raises(ExpressionError, match="unknown field"):
        ev("missing + 1", {"other": 1})
    with pytest.raises(ExpressionError, match="cannot compare"):
        ev("1 < 'a'")
    with pytest.raises(ExpressionError, match="expected a number"):
        ev("name * 2", {"name": "ada"})
    record = {"a": math.inf}
    with pytest.raises(ExpressionError, match="not finite"):
        ev("a + 1", record)
    with pytest.raises(ExpressionError, match="not finite"):
        ev("1e308 * 1e308")


def test_rejects_code_execution_syntax():
    for source in [
        "__import__('os')",
        "os.system('ls')",
        "(lambda: 1)()",
        "a[0]",
        "2 ** 3",
        "foo(1)",
        "{'a': 1}",
    ]:
        with pytest.raises(ExpressionError):
            compile_expression(source)
    assert ev("a", {"a": "__import__('os')"}) == "__import__('os')"


def test_parser_errors():
    for source in ["", "   ", "1 $ 2", "'unterminated", '"\\q"', "1e", "(1 + 2", "1 +"]:
        with pytest.raises(ExpressionError):
            compile_expression(source)


def test_parentheses_and_field_lookup():
    assert ev("(qty + 1) * price", {"qty": 2, "price": 4}) == 12
    assert ev("active", {"active": True}) is True
    assert ev("not active", {"active": False}) is True
