"""Failure isolation, thresholds, checkpoints, and an end-to-end flow."""

import json
import sqlite3

import pytest

from etl_tool.errors import CheckpointError, ConfigError
from etl_tool.pipeline import RunHooks
from tests.conftest import run_job

ROOT_RULES = [
    {"name": "cast_id", "type": "cast", "field": "id", "to": "int"},
    {"name": "total", "type": "expression", "target": "total", "expr": "id * 2"},
]


def _targets(tmp_path, mode="overwrite"):
    return [
        {"type": "csv", "path": str(tmp_path / "out.csv"), "mode": mode},
        {"type": "json", "path": str(tmp_path / "out.json"), "mode": mode},
        {
            "type": "sqlite",
            "path": str(tmp_path / "out.db"),
            "table": "rows",
            "mode": mode,
            "primary_key": ["id"],
        },
    ]


def test_bad_record_does_not_stop_the_job(tmp_path):
    result = run_job(
        tmp_path,
        rules=[
            {"name": "cast_age", "type": "cast", "field": "age", "to": "int"},
            {"name": "double", "type": "expression", "target": "double", "expr": "age * 2"},
        ],
        records=[
            {"id": 1, "age": "4", "name": "ok"},
            {"id": 2, "age": "nope", "name": "bad"},
            {"id": 3, "age": "5", "name": "also"},
        ],
        targets=_targets(tmp_path),
    )
    assert result.status == "completed"
    assert result.success == 2
    assert result.failed == 1
    assert result.loaded == 2
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["success"] == 2 and report["failed"] == 1
    stats = {item["name"]: item for item in report["rules"]}
    assert stats["cast_age"]["rows_seen"] == 3
    assert stats["cast_age"]["rows_failed"] == 1
    assert stats["double"]["rows_seen"] == 2
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    failure = errors["failures"][0]
    assert failure["index"] == 1
    assert failure["rule"] == "cast_age"
    assert failure["record"]["name"] == "bad"
    assert "not_a_number" in failure["error"] or "cannot cast" in failure["error"]
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["name"] for row in loaded] == ["ok", "also"]
    assert "cast failed" not in (tmp_path / "etl.log").read_text(encoding="utf-8")
    assert "cast_age" in (tmp_path / "etl.log").read_text(encoding="utf-8")


def test_failure_thresholds_are_strictly_greater_than(tmp_path):
    records = [{"age": "1"}, {"age": "bad"}, {"age": "bad"}, {"age": "2"}]
    rules = [{"name": "cast_age", "type": "cast", "field": "age", "to": "int"}]
    finished = run_job(tmp_path / "eq", records=records, rules=rules, handling={"max_failures": 2})
    assert finished.status == "completed"
    assert finished.failed == 2
    assert finished.success == 2
    aborted = run_job(
        tmp_path / "over",
        records=[{"age": "bad"}, {"age": "bad"}, {"age": "3"}],
        rules=rules,
        handling={"max_failures": 1},
        batch_size=10,
    )
    assert aborted.status == "aborted"
    assert aborted.failed == 2
    assert aborted.success == 0
    assert "exceeded" in (aborted.abort_reason or "")
    ratio_ok = run_job(
        tmp_path / "ratio-eq",
        records=[{"age": "1"}, {"age": "bad"}],
        rules=rules,
        handling={"max_failure_ratio": 0.5},
        batch_size=10,
    )
    assert ratio_ok.status == "completed"
    assert ratio_ok.failed == 1 and ratio_ok.success == 1
    ratio_abort = run_job(
        tmp_path / "ratio-over",
        records=[{"age": "1"}, {"age": "bad"}, {"age": "bad"}],
        rules=rules,
        handling={"max_failure_ratio": 0.5},
        batch_size=10,
    )
    assert ratio_abort.status == "aborted"
    assert ratio_abort.loaded == 1
    assert ratio_abort.failed == 2


def test_resume_does_not_rewrite_successful_rows(tmp_path):
    records = [{"id": index, "name": f"n{index}"} for index in range(6)]
    first = run_job(
        tmp_path,
        records=records,
        rules=ROOT_RULES,
        targets=_targets(tmp_path),
        batch_size=1,
        hooks=RunHooks(interrupt_after_loaded=3),
    )
    assert first.status == "interrupted"
    assert first.loaded == 3
    assert first.resumed_from == 0
    second = run_job(
        tmp_path,
        records=records,
        rules=ROOT_RULES,
        targets=_targets(tmp_path),
        batch_size=1,
        resume=True,
    )
    assert second.status == "completed"
    assert second.loaded == 6
    assert second.resumed_from == 3
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["id"] for row in loaded] == list(range(6))
    conn = sqlite3.connect(tmp_path / "out.db")
    ids = [row[0] for row in conn.execute("SELECT id FROM rows ORDER BY id")]
    conn.close()
    assert ids == list(range(6))
    report = json.loads(second.report_path.read_text(encoding="utf-8"))
    assert report["rules"][0]["rows_seen"] == 6


def test_resume_discards_unjournaled_output_and_rejects_changed_input(tmp_path):
    records = [{"id": index} for index in range(4)]
    run_job(tmp_path, records=records, rules=ROOT_RULES, targets=_targets(tmp_path), batch_size=2)
    csv_path = tmp_path / "out.csv"
    csv_path.write_bytes(csv_path.read_bytes() + b"GARBAGE\n")
    conn = sqlite3.connect(tmp_path / "out.db")
    conn.execute("INSERT INTO rows (id, total) VALUES (99, 1)")
    rowid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO etl_loaded_index (table_name, src_index, rowid_ref) VALUES ('rows', 99, ?)",
        (rowid,),
    )
    conn.commit()
    conn.close()
    resumed = run_job(
        tmp_path,
        records=records,
        rules=ROOT_RULES,
        targets=_targets(tmp_path),
        batch_size=2,
        resume=True,
    )
    assert resumed.status == "completed"
    assert b"GARBAGE" not in csv_path.read_bytes()
    conn = sqlite3.connect(tmp_path / "out.db")
    ids = sorted(row[0] for row in conn.execute("SELECT id FROM rows"))
    conn.close()
    assert ids == [0, 1, 2, 3]
    with pytest.raises(CheckpointError, match="does not match"):
        run_job(
            tmp_path,
            records=[{"id": 1}, {"id": 2}],
            rules=ROOT_RULES,
            targets=_targets(tmp_path),
            resume=True,
        )
    conn = sqlite3.connect(tmp_path / "out.db")
    assert conn.execute("SELECT COUNT(*) FROM rows").fetchone()[0] == 4
    conn.close()


def test_load_failure_rolls_back_batch_and_keeps_good_rows(tmp_path):
    records = [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Alan"}, {"id": 1, "name": "Dup"}]
    result = run_job(
        tmp_path,
        records=records,
        rules=[{"name": "cast_id", "type": "cast", "field": "id", "to": "int"}],
        targets=_targets(tmp_path),
        batch_size=10,
    )
    assert result.status == "completed"
    assert result.loaded == 2
    assert result.failed == 1
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failed_batch_count"] == 1
    batch = errors["failed_batches"][0]
    assert batch["rolled_back"] is True
    assert batch["retried_record_by_record"] is True
    assert any(item["stage"] == "load" and item["record"]["name"] == "Dup" for item in errors["failures"])
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["name"] for row in loaded] == ["Ada", "Alan"]


def test_append_mode_keeps_existing_rows_and_overwrite_replaces_them(tmp_path):
    first = run_job(tmp_path, records=[{"id": 1}], rules=ROOT_RULES, targets=_targets(tmp_path))
    assert first.loaded == 1
    appended = run_job(
        tmp_path,
        records=[{"id": 2}],
        rules=ROOT_RULES,
        targets=_targets(tmp_path, mode="append"),
        name="append-job",
    )
    assert appended.loaded == 1
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["id"] for row in loaded] == [1, 2]
    replaced = run_job(
        tmp_path,
        records=[{"id": 7}],
        rules=ROOT_RULES,
        targets=_targets(tmp_path, mode="overwrite"),
        name="replace-job",
    )
    assert replaced.loaded == 1
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["id"] for row in loaded] == [7]


def test_filter_empty_input_progress_and_extract_errors(tmp_path, capsys):
    filtered = run_job(
        tmp_path / "filter",
        records=[{"status": "active", "id": 1}, {"status": "ignore", "id": 2}],
        extract={
            "type": "json",
            "records": [{"status": "active", "id": 1}, {"status": "ignore", "id": 2}],
            "filter": {"field": "status", "op": "eq", "value": "active"},
        },
        rules=[{"type": "cast", "field": "id", "to": "int"}],
    )
    assert filtered.filtered_out == 1
    assert filtered.loaded == 1
    assert filtered.extracted == filtered.filtered_out + filtered.failed + filtered.loaded
    empty = run_job(tmp_path / "empty", records=[])
    assert empty.status == "completed"
    assert empty.loaded == 0
    assert json.loads((tmp_path / "empty" / "out.json").read_text(encoding="utf-8")) == []
    mixed = run_job(
        tmp_path / "mixed",
        extract={"type": "json", "data": '[{"id": 1}, 5, {"id": 2}]'},
        rules=[{"type": "cast", "field": "id", "to": "int"}],
    )
    assert mixed.loaded == 2
    assert mixed.failed == 1
    progressed = run_job(tmp_path / "progress", records=[{"id": 1}], rules=ROOT_RULES, progress=True)
    assert progressed.loaded == 1
    captured = capsys.readouterr()
    assert "[etl]" in captured.err
    with pytest.raises(ConfigError):
        run_job(tmp_path / "bad", extract={"type": "csv", "path": str(tmp_path / "missing.csv")})


def test_unusual_values_fail_one_record_and_do_not_abort(tmp_path):
    overflow = run_job(
        tmp_path / "overflow",
        records=[{"id": 1, "n": 1e308}, {"id": 2, "n": 2}],
        rules=[
            {"name": "cast_id", "type": "cast", "field": "id", "to": "int"},
            {"name": "square", "type": "expression", "target": "square", "expr": "n * n"},
        ],
    )
    assert overflow.status == "completed"
    assert overflow.loaded == 1
    assert overflow.failed == 1
    errors = json.loads((tmp_path / "overflow" / "errors.json").read_text(encoding="utf-8"))
    assert errors["failures"][0]["rule"] == "square"
    assert "not finite" in errors["failures"][0]["error"]
    loaded = json.loads((tmp_path / "overflow" / "out.json").read_text(encoding="utf-8"))
    assert loaded == [{"id": 2, "n": 2, "square": 4}]

    weird = run_job(
        tmp_path / "weird",
        records=[{"id": 1, "name": "ok"}, {"id": 2, "blob": {1, 2}}, {"id": 3, "name": "also"}],
        rules=[{"name": "cast_id", "type": "cast", "field": "id", "to": "int"}],
    )
    assert weird.status == "completed"
    assert weird.loaded == 2
    assert weird.failed == 1
    report = json.loads((tmp_path / "weird" / "errors.json").read_text(encoding="utf-8"))
    blob_failure = report["failures"][0]
    assert blob_failure["index"] == 1
    assert blob_failure["stage"] == "load"
    assert isinstance(blob_failure["record"]["blob"], list)
