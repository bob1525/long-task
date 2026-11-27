"""Read tests for CSV, JSON, and SQLite sources, including in-memory input."""

import json
import sqlite3
from pathlib import Path

import pytest

from etl_tool.errors import ConfigError
from etl_tool.extract.sources import normalize_sqlite_value, open_source


def collect(source):
    return list(source.rows())


def test_csv_file_and_memory_and_bad_rows(tmp_path: Path):
    path = tmp_path / "people.csv"
    path.write_text("id,name\n1,Ada\n2,Alan,extra\n", encoding="utf-8")
    rows = collect(open_source({"type": "csv", "path": str(path)}))
    assert rows[0].record == {"id": "1", "name": "Ada"}
    assert rows[1].error and "extra" in rows[1].error
    memory = collect(open_source({"type": "csv", "data": "id;name\n1;Ada\n", "delimiter": ";"}))
    assert memory[0].record == {"id": "1", "name": "Ada"}
    empty = collect(open_source({"type": "csv", "data": ""}))
    assert empty == []
    short = collect(open_source({"type": "csv", "data": "id,name\n1\n"}))
    assert short[0].record == {"id": "1", "name": ""}
    with pytest.raises(ConfigError, match="duplicate"):
        collect(open_source({"type": "csv", "data": "id,id\n1,2\n"}))
    with pytest.raises(ConfigError):
        open_source({"type": "csv", "path": str(path), "data": "id\n1\n"})
    with pytest.raises(ConfigError):
        collect(open_source({"type": "csv", "path": str(tmp_path / "missing.csv")}))


def test_json_file_memory_records_key_and_jsonl(tmp_path: Path):
    path = tmp_path / "rows.json"
    path.write_text(json.dumps([{"id": 1}, 5, {"id": 2}]), encoding="utf-8")
    rows = collect(open_source({"type": "json", "path": str(path)}))
    assert rows[0].record == {"id": 1}
    assert rows[1].error and "expected an object" in rows[1].error
    assert rows[2].record == {"id": 2}
    wrapped = tmp_path / "wrapped.json"
    wrapped.write_text(json.dumps({"data": {"items": [{"ok": True}]}}), encoding="utf-8")
    keyed = collect(open_source({"type": "json", "path": str(wrapped), "records_key": "data.items"}))
    assert keyed[0].record == {"ok": True}
    text_rows = collect(open_source({"type": "json", "data": "[{\"n\": 1}]"}))
    assert text_rows[0].record == {"n": 1}
    memory = collect(open_source({"type": "json", "records": [{"n": 2}]}))
    assert memory[0].record == {"n": 2}
    lines = collect(open_source({"type": "json", "format": "jsonl", "data": "{\"n\": 1}\nnot-json\n"}))
    assert lines[0].record == {"n": 1}
    assert lines[1].error and "bad json" in lines[1].error
    with pytest.raises(ConfigError):
        collect(open_source({"type": "json", "data": "{}"}))
    with pytest.raises(ConfigError, match="records_key"):
        collect(open_source({"type": "json", "data": "{}", "records_key": "missing"}))
    assert open_source({"type": "json", "records": [{"n": 1}]}).estimate_total() == 1
    assert open_source({"type": "json", "records": [{"n": 1}]}).fingerprint()


def test_sqlite_file_memory_and_bytes(tmp_path: Path):
    path = tmp_path / "src.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE people (id INTEGER, name TEXT, blob BLOB)")
    conn.execute("INSERT INTO people VALUES (1, 'Ada', ?)", (b"hi",))
    conn.execute("INSERT INTO people VALUES (2, 'Byte', ?)", (b"\xff",))
    conn.commit()
    conn.close()
    rows = collect(open_source({"type": "sqlite", "path": str(path), "table": "people"}))
    assert rows[0].record["name"] == "Ada"
    assert rows[0].record["blob"] == "hi"
    assert rows[1].record["blob"]["__bytes_b64__"]
    queried = collect(open_source({"type": "sqlite", "path": str(path), "query": "SELECT name FROM people WHERE id = 1"}))
    assert queried[0].record == {"name": "Ada"}
    memory = collect(
        open_source(
            {
                "type": "sqlite",
                "records": [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Alan"}],
                "table": "people",
            }
        )
    )
    assert [row.record["name"] for row in memory] == ["Ada", "Alan"]
    scripted = collect(
        open_source(
            {
                "type": "sqlite",
                "database": ":memory:",
                "init_sql": "CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (7, 'Grace');",
                "query": "SELECT id, name FROM t",
            }
        )
    )
    assert scripted[0].record == {"id": 7, "name": "Grace"}
    assert normalize_sqlite_value(memoryview(b"hi")) == "hi"
    with pytest.raises(ConfigError):
        collect(open_source({"type": "sqlite", "path": str(tmp_path / "missing.db"), "table": "t"}))
    with pytest.raises(ConfigError, match="query failed"):
        collect(open_source({"type": "sqlite", "path": str(path), "query": "SELECT missing FROM people"}))
    with pytest.raises(ConfigError):
        open_source({"type": "csv"})
    with pytest.raises(ConfigError):
        open_source({"type": "parquet"})
