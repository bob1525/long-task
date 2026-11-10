"""Write, append, overwrite, and rollback tests for each load target."""

import json
import sqlite3

import pytest

from etl_tool.errors import ConfigError, LoadError
from etl_tool.load.targets import CsvTarget, JsonTarget, SqliteTarget, build_outputs


def test_csv_overwrite_append_and_truncate(tmp_path):
    path = tmp_path / "out.csv"
    target = CsvTarget(path, "overwrite")
    target.prepare(fresh=True)
    target.append_records([{"id": 1, "name": "Ada"}])
    size = target.size()
    target.append_records([{"id": 2, "name": "Alan"}])
    assert [row["name"] for row in target.read_dicts()] == ["Ada", "Alan"]
    target.truncate(size)
    assert [row["name"] for row in target.read_dicts()] == ["Ada"]
    target.truncate(0)
    assert target.read_dicts() == []
    again = CsvTarget(path, "append")
    again.prepare(fresh=True)
    again.append_records([{"id": 3, "name": "Grace"}])
    again.append_records([{"id": 4, "name": "Grace"}])
    assert len(again.read_dicts()) == 2
    with pytest.raises(LoadError, match="columns"):
        again.append_records([{"id": 5, "extra": "nope"}])
    with pytest.raises(ConfigError):
        CsvTarget(path, "upsert")


def test_json_array_append_adopt_and_truncate(tmp_path):
    path = tmp_path / "out.json"
    target = JsonTarget(path, "overwrite")
    target.prepare(fresh=True)
    target.append_records([{"id": 1}])
    target.materialize()
    target.append_records([{"id": 2}])
    target.materialize()
    assert target.read_array() == [{"id": 1}, {"id": 2}]
    size = target.size()
    target.append_records([{"id": 3}])
    target.truncate(size)
    target.materialize()
    assert target.read_array() == [{"id": 1}, {"id": 2}]

    fresh = tmp_path / "existing.json"
    fresh.write_text(json.dumps([{"id": 9}]), encoding="utf-8")
    adopted = JsonTarget(fresh, "append")
    adopted.prepare(fresh=True)
    adopted.append_records([{"id": 10}])
    adopted.materialize()
    assert adopted.read_array() == [{"id": 9}, {"id": 10}]
    with pytest.raises(ConfigError):
        JsonTarget(path, "sideways")
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    with pytest.raises(ConfigError):
        broken = JsonTarget(bad, "append")
        broken.prepare(fresh=True)


def test_sqlite_transaction_rollback_and_rewind(tmp_path):
    path = tmp_path / "out.db"
    target = SqliteTarget(path, "customers", "overwrite", ["id"])
    target.prepare(fresh=True)
    target.append_records([{"id": 1, "name": "Ada"}], [0])
    with pytest.raises(LoadError, match="UNIQUE"):
        target.append_records([{"id": 2, "name": "Alan"}, {"id": 1, "name": "Dup"}], [1, 2])
    rows = target.fetch_all()
    assert [row["id"] for row in rows] == [1]
    assert "Dup" not in {row["name"] for row in rows}
    target.append_records([{"id": 3, "name": "Grace", "city": "NY"}], [3])
    assert {row["id"] for row in target.fetch_all()} == {1, 3}
    target.rewind(target.index_base + 3)
    assert [row["id"] for row in target.fetch_all()] == [1]
    target.close()
    with pytest.raises(ConfigError):
        SqliteTarget(path, "etl_loaded_index", "overwrite", [])


def test_output_set_rolls_back_every_target(tmp_path):
    outputs = build_outputs(
        [
            type("S", (), {"type": "csv", "path": tmp_path / "o.csv", "mode": "overwrite", "delimiter": ","})(),
            type("S", (), {"type": "json", "path": tmp_path / "o.json", "mode": "overwrite"})(),
            type("S", (), {"type": "sqlite", "path": tmp_path / "o.db", "mode": "overwrite", "table": "rows", "primary_key": ["id"]})(),
        ]
    )
    outputs.prepare(fresh=True)
    outputs.commit([{"id": 1, "name": "Ada"}], [0])
    outputs.materialize()
    with pytest.raises(LoadError):
        outputs.commit([{"id": 2, "name": "Alan", "extra": "x"}], [1])
    assert outputs.csvs[0].read_dicts() == [{"id": "1", "name": "Ada"}]
    assert outputs.jsons[0].read_array() == [{"id": 1, "name": "Ada"}]
    assert [row["id"] for row in outputs.sqlites[0].fetch_all()] == [1]
    outputs.close()
    conn = sqlite3.connect(tmp_path / "o.db")
    count = conn.execute("SELECT COUNT(*) FROM rows").fetchone()[0]
    conn.close()
    assert count == 1
