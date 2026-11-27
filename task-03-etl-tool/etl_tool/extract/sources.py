"""CSV, JSON, and SQLite extractors.

Each source yields ExtractItem values. A bad item is reported and does not
raise out of the iterator, so one corrupt row cannot stop the job.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from etl_tool.errors import ConfigError, ExtractError
from etl_tool.io_util import quote_ident


@dataclass
class ExtractItem:
    record: dict[str, Any] | None
    error: str | None = None
    raw: Any = None


class Source:
    def rows(self) -> Iterator[ExtractItem]:
        raise NotImplementedError

    def fingerprint(self) -> str:
        raise NotImplementedError

    def estimate_total(self) -> int | None:
        return None


class CsvSource(Source):
    def __init__(
        self,
        *,
        path: Path | None,
        text: str | None,
        encoding: str,
        delimiter: str,
    ) -> None:
        if (path is None) == (text is None):
            raise ConfigError("csv extract needs exactly one of path or data")
        self.path = path
        self.text = text
        self.encoding = encoding
        self.delimiter = delimiter
        if len(delimiter) != 1:
            raise ConfigError("csv delimiter must be a single character")

    def rows(self) -> Iterator[ExtractItem]:
        handle: io.TextIOBase
        if self.text is not None:
            handle = io.StringIO(self.text)
        else:
            assert self.path is not None
            try:
                handle = open(self.path, encoding=self.encoding, newline="")
            except OSError as exc:
                raise ConfigError(f"cannot read csv {self.path}: {exc}") from exc
        try:
            reader = csv.DictReader(
                handle,
                delimiter=self.delimiter,
                restkey="_extra_columns",
                restval="",
            )
            if reader.fieldnames is None:
                return
            names = [name for name in reader.fieldnames if name is not None]
            if len(names) != len(set(names)):
                raise ConfigError("csv header has duplicate column names")
            for line_no, row in enumerate(reader, start=2):
                if row is None:
                    yield ExtractItem(record=None, error=f"empty csv row at line {line_no}")
                    continue
                extra = row.pop("_extra_columns", None)
                if extra:
                    yield ExtractItem(
                        record=None,
                        error=f"csv row at line {line_no} has extra columns: {extra!r}",
                        raw=dict(row),
                    )
                    continue
                yield ExtractItem(record={str(key): value for key, value in row.items() if key is not None})
        finally:
            handle.close()

    def fingerprint(self) -> str:
        if self.text is not None:
            payload = self.text.encode("utf-8")
        else:
            assert self.path is not None
            try:
                payload = self.path.read_bytes()
            except OSError as exc:
                raise ConfigError(f"cannot read csv {self.path}: {exc}") from exc
        return hashlib.sha256(payload).hexdigest()

    def estimate_total(self) -> int | None:
        count = 0
        for item in self.rows():
            if item.record is not None or item.error:
                count += 1
        return count


class JsonSource(Source):
    def __init__(
        self,
        *,
        path: Path | None,
        text: str | None,
        records: list[Any] | None,
        records_key: str | None,
        jsonl: bool,
    ) -> None:
        provided = sum(item is not None for item in (path, text, records))
        if provided != 1:
            raise ConfigError("json extract needs exactly one of path, data, or records")
        self.path = path
        self.text = text
        self.records = records
        self.records_key = records_key
        self.jsonl = jsonl

    def rows(self) -> Iterator[ExtractItem]:
        if self.jsonl:
            yield from self._jsonl_rows()
            return
        payload = self._load_payload()
        if self.records_key:
            payload = _dig(payload, self.records_key)
        if not isinstance(payload, list):
            raise ConfigError("json extract expected a list of records")
        for index, item in enumerate(payload):
            yield _json_item(item, index)

    def _jsonl_rows(self) -> Iterator[ExtractItem]:
        if self.records is not None:
            lines = [json.dumps(item) for item in self.records]
        elif self.text is not None:
            lines = self.text.splitlines()
        else:
            assert self.path is not None
            try:
                lines = self.path.read_text(encoding="utf-8").splitlines()
            except OSError as exc:
                raise ConfigError(f"cannot read json {self.path}: {exc}") from exc
        for index, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                yield ExtractItem(record=None, error=f"bad json line {index + 1}: {exc}", raw=line)
                continue
            yield _json_item(item, index)

    def _load_payload(self) -> Any:
        if self.records is not None:
            return self.records
        if self.text is not None:
            try:
                return json.loads(self.text)
            except json.JSONDecodeError as exc:
                raise ConfigError(f"cannot parse json data: {exc}") from exc
        assert self.path is not None
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"cannot read json {self.path}: {exc}") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"cannot parse json {self.path}: {exc}") from exc

    def fingerprint(self) -> str:
        if self.records is not None:
            payload = json.dumps(self.records, sort_keys=True, default=str).encode("utf-8")
        elif self.text is not None:
            payload = self.text.encode("utf-8")
        else:
            assert self.path is not None
            try:
                payload = self.path.read_bytes()
            except OSError as exc:
                raise ConfigError(f"cannot read json {self.path}: {exc}") from exc
        return hashlib.sha256(payload).hexdigest()

    def estimate_total(self) -> int | None:
        try:
            return sum(1 for _ in self.rows())
        except ConfigError:
            return None


class SqliteSource(Source):
    def __init__(
        self,
        *,
        path: str | None,
        query: str | None,
        table: str | None,
        init_sql: str | None,
        records: list[dict[str, Any]] | None,
        record_table: str,
    ) -> None:
        self.path = path
        self.query = query
        self.table = table
        self.init_sql = init_sql
        self.records = records
        self.record_table = record_table
        if records is None and not path:
            raise ConfigError("sqlite extract needs path or records")
        if records is None and not query and not table:
            raise ConfigError("sqlite extract needs query or table")

    def rows(self) -> Iterator[ExtractItem]:
        if self.records is not None:
            conn = sqlite3.connect(":memory:")
        elif self.path == ":memory:":
            conn = sqlite3.connect(":memory:")
        else:
            assert self.path is not None
            if not Path(self.path).exists():
                raise ConfigError(f"sqlite database not found: {self.path}")
            conn = sqlite3.connect(self.path)
        try:
            if self.init_sql:
                try:
                    conn.executescript(self.init_sql)
                except sqlite3.Error as exc:
                    raise ConfigError(f"sqlite init_sql failed: {exc}") from exc
            if self.records is not None:
                _load_memory_table(conn, self.record_table, self.records)
                sql = f"SELECT * FROM {quote_ident(self.record_table)}"
            elif self.query:
                sql = self.query
            else:
                assert self.table is not None
                sql = f"SELECT * FROM {quote_ident(self.table)}"
            try:
                cursor = conn.execute(sql)
            except sqlite3.Error as exc:
                raise ConfigError(f"sqlite query failed: {exc}") from exc
            description = cursor.description
            if description is None:
                return
            columns = [str(item[0]) for item in description]
            for row in cursor:
                record = {
                    column: normalize_sqlite_value(value)
                    for column, value in zip(columns, row)
                }
                yield ExtractItem(record=record)
        finally:
            conn.close()

    def fingerprint(self) -> str:
        parts: list[bytes] = []
        if self.records is not None:
            parts.append(json.dumps(self.records, sort_keys=True, default=str).encode("utf-8"))
        elif self.path and self.path != ":memory:":
            try:
                parts.append(Path(self.path).read_bytes())
            except OSError as exc:
                raise ConfigError(f"cannot read sqlite {self.path}: {exc}") from exc
        parts.append((self.query or "").encode("utf-8"))
        parts.append((self.table or "").encode("utf-8"))
        parts.append((self.init_sql or "").encode("utf-8"))
        return hashlib.sha256(b"\0".join(parts)).hexdigest()

    def estimate_total(self) -> int | None:
        try:
            return sum(1 for _ in self.rows())
        except ConfigError:
            return None


def open_source(spec: dict[str, Any]) -> Source:
    source_type = str(spec.get("type", "")).lower()
    if source_type == "csv":
        return CsvSource(
            path=Path(spec["path"]) if spec.get("path") else None,
            text=spec.get("data"),
            encoding=str(spec.get("encoding", "utf-8-sig")),
            delimiter=str(spec.get("delimiter", ",")),
        )
    if source_type == "json":
        return JsonSource(
            path=Path(spec["path"]) if spec.get("path") else None,
            text=spec.get("data"),
            records=spec.get("records"),
            records_key=spec.get("records_key"),
            jsonl=str(spec.get("format", "array")).lower() == "jsonl",
        )
    if source_type == "sqlite":
        return SqliteSource(
            path=spec.get("path") or spec.get("database"),
            query=spec.get("query"),
            table=spec.get("table"),
            init_sql=spec.get("init_sql"),
            records=spec.get("records"),
            record_table=str(spec.get("table") or "records"),
        )
    raise ConfigError(f"unsupported extract type {source_type!r}")


def normalize_sqlite_value(value: Any) -> Any:
    if isinstance(value, memoryview):
        value = bytes(value)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {"__bytes_b64__": base64.b64encode(value).decode("ascii")}
    return value


def _json_item(item: Any, index: int) -> ExtractItem:
    if isinstance(item, dict):
        return ExtractItem(record={str(key): value for key, value in item.items()})
    return ExtractItem(
        record=None,
        error=f"json item {index} is {type(item).__name__}, expected an object",
        raw=item,
    )


def _dig(payload: Any, path: str) -> Any:
    current = payload
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise ConfigError(f"records_key {path!r} not found in json")
        current = current[part]
    return current


def _load_memory_table(conn: sqlite3.Connection, table: str, records: list[dict[str, Any]]) -> None:
    if not records:
        conn.execute(f"CREATE TABLE {quote_ident(table)} (id)")
        return
    columns: list[str] = []
    for record in records:
        if not isinstance(record, dict):
            raise ExtractError("sqlite memory records must be objects")
        for key in record:
            if key not in columns:
                columns.append(str(key))
    definitions = ", ".join(quote_ident(column) for column in columns)
    conn.execute(f"CREATE TABLE {quote_ident(table)} ({definitions})")
    placeholders = ", ".join(["?"] * len(columns))
    rows = [tuple(record.get(column) for column in columns) for record in records]
    conn.executemany(
        f"INSERT INTO {quote_ident(table)} ({definitions}) VALUES ({placeholders})",
        rows,
    )
