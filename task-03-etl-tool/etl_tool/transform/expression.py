"""Safe arithmetic and comparison expressions.

The grammar is parsed and evaluated by this module. There is no call into
Python's eval or exec, and the grammar has no function calls, attribute
access, or subscripts. Names look up fields on the current record.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, Union

Ast = Union[
    tuple[str, float],
    tuple[str, str],
    tuple[str, bool],
    tuple[str],
    tuple[str, str, "Ast"],
    tuple[str, str, "Ast", "Ast"],
    tuple[str, "Ast", tuple[tuple[str, "Ast"], ...]],
    tuple[str, str, tuple["Ast", ...]],
]


class ExpressionError(Exception):
    """The expression text is invalid, or it cannot be applied to a record."""


@dataclass(frozen=True)
class Token:
    kind: str
    value: Any
    pos: int


_KEYWORDS = {
    "and": "and",
    "or": "or",
    "not": "not",
    "true": "true",
    "false": "false",
    "null": "null",
}

_TWO_CHAR = {"==", "!=", "<=", ">=", "&&", "||"}
_ONE_CHAR = set("+-*/%<>!()")


class Expression:
    """A compiled expression that can be evaluated against many records."""

    def __init__(self, source: str, ast: Ast) -> None:
        self.source = source
        self.ast = ast

    def evaluate(self, record: Mapping[str, Any]) -> Any:
        return _eval_node(self.ast, record, self.source)


def compile_expression(source: str) -> Expression:
    if not isinstance(source, str) or source.strip() == "":
        raise ExpressionError("expression is empty")
    tokens = _tokenize(source)
    parser = _Parser(source, tokens)
    ast = parser.parse_or()
    if parser.peek().kind != "eof":
        token = parser.peek()
        raise ExpressionError(
            f"unexpected token {token.value!r} at position {token.pos} in {source!r}"
        )
    return Expression(source, ast)


def _tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch.isspace():
            i += 1
            continue
        two = source[i : i + 2]
        if two in _TWO_CHAR:
            tokens.append(Token("op", two, i))
            i += 2
            continue
        if ch in _ONE_CHAR:
            tokens.append(Token("op", ch, i))
            i += 1
            continue
        if ch in {"'", '"'}:
            start = i
            text, i = _read_string(source, i)
            tokens.append(Token("str", text, start))
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and source[i + 1].isdigit()):
            start = i
            number, i = _read_number(source, i)
            tokens.append(Token("num", number, start))
            continue
        if ch.isalpha() or ch == "_":
            start = i
            i += 1
            while i < n and (source[i].isalnum() or source[i] == "_"):
                i += 1
            word = source[start:i]
            kind = _KEYWORDS.get(word, "name")
            tokens.append(Token(kind, word, start))
            continue
        raise ExpressionError(f"unexpected character {ch!r} at position {i} in {source!r}")
    tokens.append(Token("eof", None, n))
    return tokens


def _read_string(source: str, start: int) -> tuple[str, int]:
    quote = source[start]
    i = start + 1
    chars: list[str] = []
    escapes = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"'}
    while i < len(source):
        ch = source[i]
        if ch == quote:
            return "".join(chars), i + 1
        if ch == "\\":
            if i + 1 >= len(source):
                break
            nxt = source[i + 1]
            if nxt not in escapes:
                raise ExpressionError(
                    f"unknown string escape \\{nxt} at position {i} in {source!r}"
                )
            chars.append(escapes[nxt])
            i += 2
            continue
        if ch == "\n":
            raise ExpressionError(f"unterminated string at position {start} in {source!r}")
        chars.append(ch)
        i += 1
    raise ExpressionError(f"unterminated string at position {start} in {source!r}")


def _read_number(source: str, start: int) -> tuple[int | float, int]:
    i = start
    n = len(source)
    saw_dot = False
    saw_exp = False
    while i < n and source[i].isdigit():
        i += 1
    if i < n and source[i] == ".":
        saw_dot = True
        i += 1
        while i < n and source[i].isdigit():
            i += 1
    if i < n and source[i] in {"e", "E"}:
        saw_exp = True
        j = i + 1
        if j < n and source[j] in {"+", "-"}:
            j += 1
        exp_start = j
        while j < n and source[j].isdigit():
            j += 1
        if j == exp_start:
            raise ExpressionError(f"bad number at position {start} in {source!r}")
        i = j
    text = source[start:i]
    try:
        if not saw_dot and not saw_exp:
            return int(text), i
        return float(text), i
    except ValueError as exc:
        raise ExpressionError(f"bad number {text!r} at position {start}") from exc


class _Parser:
    def __init__(self, source: str, tokens: Sequence[Token]) -> None:
        self.source = source
        self.tokens = tokens
        self.index = 0

    def peek(self) -> Token:
        return self.tokens[self.index]

    def pop(self) -> Token:
        token = self.tokens[self.index]
        self.index += 1
        return token

    def _error(self, message: str) -> ExpressionError:
        token = self.peek()
        return ExpressionError(f"{message} at position {token.pos} in {self.source!r}")

    def parse_or(self) -> Ast:
        left = self.parse_and()
        parts = [left]
        while self.peek().kind == "or" or (self.peek().kind == "op" and self.peek().value == "||"):
            self.pop()
            parts.append(self.parse_and())
        if len(parts) == 1:
            return left
        return ("boolop", "or", tuple(parts))

    def parse_and(self) -> Ast:
        left = self.parse_not()
        parts = [left]
        while self.peek().kind == "and" or (self.peek().kind == "op" and self.peek().value == "&&"):
            self.pop()
            parts.append(self.parse_not())
        if len(parts) == 1:
            return left
        return ("boolop", "and", tuple(parts))

    def parse_not(self) -> Ast:
        if self.peek().kind == "not" or (self.peek().kind == "op" and self.peek().value == "!"):
            self.pop()
            return ("unary", "not", self.parse_not())
        return self.parse_comparison()

    def parse_comparison(self) -> Ast:
        left = self.parse_add()
        ops: list[tuple[str, Ast]] = []
        while self.peek().kind == "op" and self.peek().value in {"==", "!=", "<", ">", "<=", ">="}:
            op = str(self.pop().value)
            ops.append((op, self.parse_add()))
        if not ops:
            return left
        return ("cmp", left, tuple(ops))

    def parse_add(self) -> Ast:
        left = self.parse_mul()
        while self.peek().kind == "op" and self.peek().value in {"+", "-"}:
            op = str(self.pop().value)
            right = self.parse_mul()
            left = ("bin", op, left, right)
        return left

    def parse_mul(self) -> Ast:
        left = self.parse_unary()
        while self.peek().kind == "op" and self.peek().value in {"*", "/", "%"}:
            op = str(self.pop().value)
            right = self.parse_unary()
            left = ("bin", op, left, right)
        return left

    def parse_unary(self) -> Ast:
        if self.peek().kind == "op" and self.peek().value in {"+", "-"}:
            op = str(self.pop().value)
            return ("unary", op, self.parse_unary())
        return self.parse_primary()

    def parse_primary(self) -> Ast:
        token = self.peek()
        if token.kind == "num":
            self.pop()
            return ("num", token.value)
        if token.kind == "str":
            self.pop()
            return ("str", str(token.value))
        if token.kind == "true":
            self.pop()
            return ("bool", True)
        if token.kind == "false":
            self.pop()
            return ("bool", False)
        if token.kind == "null":
            self.pop()
            return ("null",)
        if token.kind == "name":
            self.pop()
            return ("name", str(token.value))
        if token.kind == "op" and token.value == "(":
            self.pop()
            inner = self.parse_or()
            if not (self.peek().kind == "op" and self.peek().value == ")"):
                raise self._error("expected ')'")
            self.pop()
            return inner
        raise self._error(f"expected a value, found {token.value!r}")


def _eval_node(node: Ast, record: Mapping[str, Any], source: str) -> Any:
    kind = node[0]
    if kind == "num":
        return node[1]
    if kind == "str":
        return node[1]
    if kind == "bool":
        return node[1]
    if kind == "null":
        return None
    if kind == "name":
        name = node[1]
        if name not in record:
            raise ExpressionError(f"unknown field {name!r} in {source!r}")
        return record[name]
    if kind == "unary":
        op = node[1]
        value = _eval_node(node[2], record, source)  # type: ignore[arg-type]
        if op == "not":
            return not _truthy(value)
        if op in {"+", "-"}:
            if _is_int(value):
                return value if op == "+" else -value
            number = _number(value, source)
            return number if op == "+" else -number
        raise ExpressionError(f"unknown unary operator {op}")
    if kind == "bin":
        op = node[1]
        left = _eval_node(node[2], record, source)  # type: ignore[arg-type]
        right = _eval_node(node[3], record, source)  # type: ignore[arg-type]
        return _binary(op, left, right, source)
    if kind == "boolop":
        op = node[1]
        values = node[2]
        if op == "and":
            current: Any = True
            for child in values:
                current = _eval_node(child, record, source)
                if not _truthy(current):
                    return current
            return current
        if op == "or":
            current = False
            for child in values:
                current = _eval_node(child, record, source)
                if _truthy(current):
                    return current
            return current
        raise ExpressionError(f"unknown boolean operator {op}")
    if kind == "cmp":
        left = _eval_node(node[1], record, source)  # type: ignore[arg-type]
        for op, right_node in node[2]:  # type: ignore[union-attr]
            right = _eval_node(right_node, record, source)
            if not _compare(op, left, right, source):
                return False
            left = right
        return True
    raise ExpressionError(f"unknown expression node {kind}")


def _truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            return False
        return value != 0
    if isinstance(value, str):
        return value != ""
    return True


def _number(value: Any, source: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExpressionError(
            f"expected a number, got {type(value).__name__} in {source!r}"
        )
    if isinstance(value, float) and not math.isfinite(value):
        raise ExpressionError(f"numeric value is not finite in {source!r}")
    return float(value)


def _binary(op: str, left: Any, right: Any, source: str) -> Any:
    if op == "+" and isinstance(left, str) and isinstance(right, str):
        return left + right
    if _is_int(left) and _is_int(right) and op in {"+", "-", "*", "%"}:
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if right == 0:
            raise ExpressionError(f"modulo by zero in {source!r}")
        return left % right
    left_num = _number(left, source)
    right_num = _number(right, source)
    if op == "+":
        result = left_num + right_num
    elif op == "-":
        result = left_num - right_num
    elif op == "*":
        result = left_num * right_num
    elif op == "/":
        if right_num == 0:
            raise ExpressionError(f"division by zero in {source!r}")
        result = left_num / right_num
    elif op == "%":
        if right_num == 0:
            raise ExpressionError(f"modulo by zero in {source!r}")
        result = left_num % right_num
    else:
        raise ExpressionError(f"unknown operator {op}")
    if not math.isfinite(result):
        raise ExpressionError(f"numeric result is not finite in {source!r}")
    return result


def _compare(op: str, left: Any, right: Any, source: str) -> bool:
    if op in {"==", "!="}:
        same = _equals(left, right)
        return same if op == "==" else not same
    if _is_number(left) and _is_number(right):
        lval = float(left)
        rval = float(right)
    elif isinstance(left, str) and isinstance(right, str):
        lval = left
        rval = right
    else:
        raise ExpressionError(
            f"cannot compare {type(left).__name__} and {type(right).__name__} in {source!r}"
        )
    if op == "<":
        return lval < rval
    if op == ">":
        return lval > rval
    if op == "<=":
        return lval <= rval
    if op == ">=":
        return lval >= rval
    raise ExpressionError(f"unknown comparison {op}")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _equals(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left == right
    if left is None or right is None:
        return left is None and right is None
    return left == right
