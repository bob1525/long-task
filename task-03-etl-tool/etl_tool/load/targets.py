"""CSV, JSON, and SQLite load targets.

File targets are append-only between checkpoints. The pipeline records the
committed byte size in the journal and truncates anything past that size if a
write is interrupted. SQLite writes happen inside an explicit transaction and
can be removed again by source index.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from etl_tool.errors import ConfigError, LoadError
from etl_tool.io_util import atomic_write_json, quote_ident


def _format_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _render_csv(header: list[str], records: list[dict[str, Any]], write_header: bool) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(
        buffer,
        fieldnames=header,
        lineterminator="\n",
        extrasaction="ignore",
    )
    if write_header:
        writer.writeheader()
    for record in records:
        writer.writerow({column: _format_cell(record.get(column)) for column in header})
    return buffer.getvalue().encode("utf-8")


def _union_keys(records: list[dict[str, Any]]) -> list[str]:
    header: list[str] = []
    for record in records:
        for key in record:
            if key not in header:
                header.append(str(key))
    return header


class CsvTarget:
    def __init__(self, path: Path, mode: str, delimiter: str = ",") -> None:
        if mode not in {"overwrite", "append"}:
            raise ConfigError(f"csv mode must be overwrite or append, got {mode!r}")
        if len(delimiter) != 1:
            raise ConfigError("csv delimiter must be a single character")
        self.path = path
        self.mode = mode
        self.delimiter = delimiter
        self.name = f"csv:{path}"
        self.header: list[str] | None = None

    def prepare(self, *, fresh: bool) -> None:
        if fresh and self.mode == "overwrite" and self.path.exists():
            self.path.unlink()
            self.header = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.load_header()

    def load_header(self) -> None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            self.header = None
            return
        with open(self.path, encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, delimiter=self.delimiter)
            header = next(reader, None)
        self.header = header or None

    def size(self) -> int:
        if not self.path.exists():
            return 0
        return self.path.stat().st_size

    def append_records(self, records: list[dict[str, Any]]) -> None:
        if not records:
            return
        header = self.header
        write_header = header is None
        if header is None:
            header = _union_keys(records)
        else:
            extra = sorted({key for record in records for key in record if key not in header})
            if extra:
                raise LoadError(
                    f"record has columns not in the CSV header: {extra}",
                    target=self.name,
                )
        payload = _render_csv(header, records, write_header)
        with open(self.path, "ab") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        self.header = header

    def truncate(self, size: int) -> None:
        if size < 0:
            raise LoadError(f"invalid truncate size {size}", target=self.name)
        if not self.path.exists():
            if size == 0:
                self.header = None
                return
            raise LoadError(
                f"csv output {self.path} is missing; checkpoint expected {size} bytes",
                target=self.name,
            )
        current = self.path.stat().st_size
        if current < size:
            raise LoadError(
                f"csv output {self.path} is shorter than the checkpoint ({current} < {size})",
                target=self.name,
            )
        if current != size:
            with open(self.path, "r+b") as handle:
                handle.truncate(size)
                handle.flush()
                os.fsync(handle.fileno())
        self.load_header()

    def read_dicts(self) -> list[dict[str, str]]:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return []
        with open(self.path, encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle, delimiter=self.delimiter))


class JsonTarget:
    def __init__(self, path: Path, mode: str) -> None:
        if mode not in {"overwrite", "append"}:
            raise ConfigError(f"json mode must be overwrite or append, got {mode!r}")
        self.path = path
        self.jsonl_path = path.with_name(path.name + ".jsonl")
        self.mode = mode
        self.name = f"json:{path}"

    def prepare(self, *, fresh: bool) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if fresh and self.mode == "overwrite":
            for candidate in (self.path, self.jsonl_path):
                if candidate.exists():
                    candidate.unlink()
            return
        if fresh and self.mode == "append":
            self._adopt_existing_array()

    def _adopt_existing_array(self) -> None:
        if self.jsonl_path.exists() or not self.path.exists() or self.path.stat().st_size == 0:
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ConfigError(f"cannot append to {self.path}: {exc}") from exc
        if not isinstance(payload, list):
            raise ConfigError(f"cannot append to {self.path}: JSON value is not an array")
        records = []
        for item in payload:
            if not isinstance(item, dict):
                raise ConfigError(f"cannot append to {self.path}: array items must be objects")
            records.append(item)
        self.append_records(records)

    def size(self) -> int:
        if not self.jsonl_path.exists():
            return 0
        return self.jsonl_path.stat().st_size

    def append_records(self, records: list[dict[str, Any]]) -> None:
        if not records:
            return
        lines = [
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records
        ]
        payload = "".join(lines).encode("utf-8")
        with open(self.jsonl_path, "ab") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())

    def truncate(self, size: int) -> None:
        if size < 0:
            raise LoadError(f"invalid truncate size {size}", target=self.name)
        if not self.jsonl_path.exists():
            if size == 0:
                return
            raise LoadError(
                f"json journal {self.jsonl_path} is missing; checkpoint expected {size} bytes",
                target=self.name,
            )
        current = self.jsonl_path.stat().st_size
        if current < size:
            raise LoadError(
                f"json journal {self.jsonl_path} is shorter than the checkpoint",
                target=self.name,
            )
        if current != size:
            with open(self.jsonl_path, "r+b") as handle:
                handle.truncate(size)
                handle.flush()
                os.fsync(handle.fileno())

    def materialize(self) -> None:
        records: list[Any] = []
        if self.jsonl_path.exists():
            with open(self.jsonl_path, encoding="utf-8") as handle:
                for line_no, line in enumerate(handle, start=1):
                    text = line.strip()
                    if not text:
                        continue
                    try:
                        records.append(json.loads(text))
                    except json.JSONDecodeError as exc:
                        raise LoadError(
                            f"corrupt jsonl line {line_no} in {self.jsonl_path}: {exc}",
                            target=self.name,
                        ) from exc
        atomic_write_json(self.path, records)

    def read_array(self) -> list[Any]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text(encoding="utf-8"))


class SqliteTarget:
    def __init__(self, path: Path, table: str, mode: str, primary_key: list[str]) -> None:
        if mode not in {"overwrite", "append"}:
            raise ConfigError(f"sqlite mode must be overwrite or append, got {mode!r}")
        if not table or table == "etl_loaded_index":
            raise ConfigError(f"invalid sqlite table name {table!r}")
        self.path = path
        self.table = table
        self.mode = mode
        self.primary_key = list(primary_key)
        self.name = f"sqlite:{path}:{table}"
        self.index_base = 0
        self.conn: sqlite3.Connection | None = None
        self.columns: list[str] = []

    def prepare(self, *, fresh: bool) -> None:
        if fresh and self.mode == "overwrite" and self.path.exists():
            self.path.unlink()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, isolation_level=None)
        self.conn.execute("PRAGMA synchronous=FULL")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS etl_loaded_index (
                table_name TEXT NOT NULL,
                src_index INTEGER NOT NULL,
                rowid_ref INTEGER NOT NULL,
                PRIMARY KEY (table_name, src_index)
            )
            """
        )
        self._load_columns()
        if fresh and self.mode == "append":
            self.index_base = self.max_src_index() + 1
        elif fresh:
            self.index_base = 0

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None

    def max_src_index(self) -> int:
        assert self.conn is not None
        row = self.conn.execute(
            "SELECT MAX(src_index) FROM etl_loaded_index WHERE table_name = ?",
            (self.table,),
        ).fetchone()
        if row is None or row[0] is None:
            return -1
        return int(row[0])

    def append_records(self, records: list[dict[str, Any]], src_indices: list[int]) -> None:
        if not records:
            return
        if len(records) != len(src_indices):
            raise LoadError("source index count does not match records", target=self.name)
        assert self.conn is not None
        self.conn.execute("BEGIN")
        try:
            self._ensure_table(records)
            columns = self.columns
            sql = (
                f"INSERT INTO {quote_ident(self.table)} "
                f"({', '.join(quote_ident(column) for column in columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})"
            )
            for record, src_index in zip(records, src_indices):
                values = [_sqlite_cell(record.get(column)) for column in columns]
                self.conn.execute(sql, values)
                rowid = int(self.conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                self.conn.execute(
                    "INSERT INTO etl_loaded_index (table_name, src_index, rowid_ref) VALUES (?, ?, ?)",
                    (self.table, int(src_index), rowid),
                )
            self.conn.execute("COMMIT")
        except Exception as exc:
            self._rollback()
            self._load_columns()
            if isinstance(exc, LoadError):
                raise
            raise LoadError(str(exc), target=self.name) from exc

    def delete_indices(self, src_indices: list[int]) -> None:
        if not src_indices or self.conn is None:
            return
        self.conn.execute("BEGIN")
        try:
            for src_index in src_indices:
                row = self.conn.execute(
                    "SELECT rowid_ref FROM etl_loaded_index WHERE table_name = ? AND src_index = ?",
                    (self.table, int(src_index)),
                ).fetchone()
                if row is None:
                    continue
                if self._table_exists():
                    self.conn.execute(
                        f"DELETE FROM {quote_ident(self.table)} WHERE rowid = ?",
                        (int(row[0]),),
                    )
                self.conn.execute(
                    "DELETE FROM etl_loaded_index WHERE table_name = ? AND src_index = ?",
                    (self.table, int(src_index)),
                )
            self.conn.execute("COMMIT")
        except Exception as exc:
            self._rollback()
            raise LoadError(f"sqlite rollback failed: {exc}", target=self.name) from exc

    def rewind(self, stored_end: int) -> None:
        """Drop rows whose stored source index is >= stored_end."""
        if self.conn is None:
            return
        rows = self.conn.execute(
            "SELECT src_index FROM etl_loaded_index WHERE table_name = ? AND src_index >= ?",
            (self.table, int(stored_end)),
        ).fetchall()
        self.delete_indices([int(row[0]) for row in rows])

    def fetch_all(self) -> list[dict[str, Any]]:
        if self.conn is None or not self._table_exists():
            return []
        cursor = self.conn.execute(f"SELECT * FROM {quote_ident(self.table)}")
        columns = [str(item[0]) for item in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def _rollback(self) -> None:
        assert self.conn is not None
        try:
            self.conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass

    def _table_exists(self) -> bool:
        assert self.conn is not None
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (self.table,),
        ).fetchone()
        return row is not None

    def _load_columns(self) -> None:
        assert self.conn is not None
        if not self._table_exists():
            self.columns = []
            return
        rows = self.conn.execute(f"PRAGMA table_info({quote_ident(self.table)})").fetchall()
        self.columns = [str(row[1]) for row in rows]

    def _ensure_table(self, records: list[dict[str, Any]]) -> None:
        assert self.conn is not None
        incoming = _union_keys(records)
        if not self.columns:
            columns = incoming
            for key in self.primary_key:
                if key not in columns:
                    raise LoadError(
                        f"primary key column {key!r} is not present in the records",
                        target=self.name,
                    )
            definitions = ", ".join(quote_ident(column) for column in columns)
            if self.primary_key:
                pk = ", ".join(quote_ident(key) for key in self.primary_key)
                definitions = f"{definitions}, PRIMARY KEY ({pk})"
            self.conn.execute(
                f"CREATE TABLE {quote_ident(self.table)} ({definitions})"
            )
            self.columns = columns
            return
        for column in incoming:
            if column not in self.columns:
                self.conn.execute(
                    f"ALTER TABLE {quote_ident(self.table)} ADD COLUMN {quote_ident(column)}"
                )
                self.columns.append(column)


def _sqlite_cell(value: Any) -> Any:
    if isinstance(value, bool):
        return int(value)
    return value


@dataclass
class OutputSet:
    csvs: list[CsvTarget] = field(default_factory=list)
    jsons: list[JsonTarget] = field(default_factory=list)
    sqlites: list[SqliteTarget] = field(default_factory=list)

    def prepare(self, *, fresh: bool) -> None:
        for target in [*self.csvs, *self.jsons, *self.sqlites]:
            target.prepare(fresh=fresh)

    def close(self) -> None:
        for target in self.sqlites:
            target.close()

    def sizes(self) -> dict[str, int]:
        sizes: dict[str, int] = {}
        for target in [*self.csvs, *self.jsons]:
            sizes[target.name] = target.size()
        return sizes

    def index_bases(self) -> dict[str, int]:
        return {target.name: target.index_base for target in self.sqlites}

    def set_index_bases(self, bases: dict[str, int]) -> None:
        for target in self.sqlites:
            if target.name in bases:
                target.index_base = int(bases[target.name])

    def recover(self, *, sizes: dict[str, int], index_bases: dict[str, int], end_index: int) -> None:
        self.set_index_bases(index_bases)
        for target in self.csvs:
            target.truncate(int(sizes.get(target.name, 0)))
        for target in self.jsons:
            target.truncate(int(sizes.get(target.name, 0)))
            target.materialize()
        for target in self.sqlites:
            stored_end = int(index_bases.get(target.name, target.index_base)) + int(end_index)
            target.rewind(stored_end)

    def commit(self, records: list[dict[str, Any]], raw_indices: list[int]) -> None:
        before = self.sizes()
        try:
            for target in self.sqlites:
                stored = [target.index_base + index for index in raw_indices]
                target.append_records(records, stored)
            for target in self.jsons:
                target.append_records(records)
            for target in self.csvs:
                target.append_records(records)
        except Exception as exc:
            self._rollback_attempt(before, raw_indices)
            target_name = getattr(exc, "target", "") or "load"
            raise LoadError(str(exc), target=target_name) from exc

    def materialize(self) -> None:
        for target in self.jsons:
            target.materialize()

    def _rollback_attempt(self, sizes_before: dict[str, int], raw_indices: list[int]) -> None:
        for target in self.sqlites:
            try:
                target.delete_indices([target.index_base + index for index in raw_indices])
            except LoadError:
                pass
        for target in self.jsons:
            target.truncate(int(sizes_before.get(target.name, 0)))
            target.materialize()
        for target in self.csvs:
            target.truncate(int(sizes_before.get(target.name, 0)))


def build_outputs(targets: list[Any]) -> OutputSet:
    outputs = OutputSet()
    for spec in targets:
        if spec.type == "csv":
            outputs.csvs.append(CsvTarget(spec.path, spec.mode, spec.delimiter))
        elif spec.type == "json":
            outputs.jsons.append(JsonTarget(spec.path, spec.mode))
        elif spec.type == "sqlite":
            outputs.sqlites.append(
                SqliteTarget(spec.path, spec.table, spec.mode, spec.primary_key)
            )
        else:
            raise ConfigError(f"unsupported load type {spec.type!r}")
    if not (outputs.csvs or outputs.jsons or outputs.sqlites):
        raise ConfigError("load requires at least one target")
    return outputs
