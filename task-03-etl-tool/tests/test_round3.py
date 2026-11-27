"""Round-3 rules, upsert, retries, dry-run, HTML report, and live progress."""

import json
import sqlite3
import threading
from pathlib import Path
from urllib.request import urlopen

from etl_tool.errors import ConfigError, TransformError
from etl_tool.monitor.web import render_page, start_server
from etl_tool.pipeline import RunHooks
from etl_tool.transform.rules import build_rules
from tests.conftest import run_job

import pytest


def _apply(spec, record):
    rule = build_rules([spec])[0]
    changed = rule.apply(record)
    return record, changed


def test_validate_required_rejects_missing_blank_and_allows_a_value():
    spec = {"name": "need_email", "type": "validate", "field": "email", "required": True}
    with pytest.raises(TransformError, match="need_email") as missing:
        _apply(spec, {})
    assert missing.value.rule == "need_email"
    with pytest.raises(TransformError, match="required field 'email'"):
        _apply(spec, {"email": "   "})
    record, changed = _apply(spec, {"email": "a@b.co"})
    assert record["email"] == "a@b.co"
    assert changed == 0


def test_validate_regex_uses_fullmatch():
    spec = {
        "name": "email_shape",
        "type": "validate",
        "field": "email",
        "regex": r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
    }
    assert _apply(spec, {"email": "ada@example.com"})[0]["email"] == "ada@example.com"
    with pytest.raises(TransformError, match="email_shape") as bad:
        _apply(spec, {"email": "ada@example.com extra"})
    assert bad.value.rule == "email_shape"
    assert _apply(spec, {})[1] == 0


def test_validate_numeric_range_is_inclusive_and_rejects_text():
    spec = {"name": "age_band", "type": "validate", "field": "age", "min": 0, "max": 120}
    assert _apply(spec, {"age": 0})[1] == 0
    assert _apply(spec, {"age": "120"})[1] == 0
    with pytest.raises(TransformError, match="below 0"):
        _apply(spec, {"age": -1})
    with pytest.raises(TransformError, match="above 120"):
        _apply(spec, {"age": 121})
    with pytest.raises(TransformError, match="not a number"):
        _apply(spec, {"age": "twenty"})


def test_validate_enum_accepts_listed_values():
    spec = {"name": "tier_set", "type": "validate", "field": "tier", "enum": ["gold", "silver", 1]}
    assert _apply(spec, {"tier": "gold"})[1] == 0
    assert _apply(spec, {"tier": "1"})[1] == 0
    with pytest.raises(TransformError, match="tier_set") as bad:
        _apply(spec, {"tier": "bronze"})
    assert bad.value.rule == "tier_set"


def test_validate_failure_is_named_in_the_error_report(tmp_path):
    result = run_job(
        tmp_path,
        records=[{"id": 1, "email": "ada@example.com"}, {"id": 2, "email": "nope"}],
        rules=[
            {
                "name": "check_email",
                "type": "validate",
                "checks": [
                    {"field": "email", "required": True},
                    {"field": "email", "regex": r"^[^@\s]+@[^@\s]+\.[^@\s]+$"},
                ],
            }
        ],
    )
    assert result.status == "completed"
    assert result.loaded == 1
    assert result.failed == 1
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    failure = errors["failures"][0]
    assert failure["rule"] == "check_email"
    assert failure["rule_type"] == "validate"
    assert "check_email" in failure["error"]
    assert failure["record"]["email"] == "nope"


def test_validate_config_rejects_bad_checks():
    with pytest.raises(ConfigError, match="invalid regex"):
        build_rules([{"type": "validate", "field": "email", "regex": "["}])
    with pytest.raises(ConfigError, match="enum"):
        build_rules([{"type": "validate", "field": "tier", "enum": []}])
    with pytest.raises(ConfigError, match="checks"):
        build_rules([{"type": "validate", "checks": []}])
    with pytest.raises(ConfigError, match="min and max"):
        build_rules([{"type": "validate", "field": "age", "min": "old"}])


def test_dedup_keeps_the_first_record_and_reports_the_rest(tmp_path):
    result = run_job(
        tmp_path,
        records=[{"id": 1, "name": "Ada"}, {"id": 1, "name": "Dup"}, {"id": 2, "name": "Alan"}],
        rules=[{"name": "one_id", "type": "dedup", "keys": ["id"], "keep": "first"}],
    )
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["name"] for row in loaded] == ["Ada", "Alan"]
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failures"][0]["rule"] == "one_id"
    assert errors["failures"][0]["index"] == 1
    assert "keeping the first" in errors["failures"][0]["error"]
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    stats = {item["name"]: item for item in report["rules"]}
    assert stats["one_id"]["rows_seen"] == 3
    assert stats["one_id"]["rows_failed"] == 1


def test_dedup_keeps_the_last_record(tmp_path):
    result = run_job(
        tmp_path,
        records=[
            {"id": 1, "name": "first"},
            {"id": 2, "name": "only"},
            {"id": 1, "name": "last"},
        ],
        rules=[{"name": "latest_id", "type": "dedup", "key": "id", "keep": "last"}],
    )
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [(row["id"], row["name"]) for row in loaded] == [(2, "only"), (1, "last")]
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failure_count"] == 1
    assert errors["failures"][0]["rule"] == "latest_id"
    assert errors["failures"][0]["index"] == 0
    assert "keeping the last" in errors["failures"][0]["error"]
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    stats = report["rules"][0]
    assert stats["rows_seen"] == 3
    assert stats["rows_failed"] == 1


def test_dedup_composite_key_and_bad_keep():
    first = build_rules([{"type": "dedup", "keys": ["id", "kind"], "keep": "first"}])[0]
    assert first.apply({"id": 1, "kind": "a"}) == 0
    with pytest.raises(TransformError, match="duplicate key"):
        first.apply({"id": 1, "kind": "a"})
    assert first.apply({"id": 1, "kind": "b"}) == 0
    with pytest.raises(ConfigError, match="keep"):
        build_rules([{"type": "dedup", "keys": ["id"], "keep": "all"}])
    with pytest.raises(ConfigError, match="keys"):
        build_rules([{"type": "dedup"}])


def test_lookup_memory_map_writes_the_target():
    record, changed = _apply(
        {
            "name": "country_name",
            "type": "lookup",
            "key": "code",
            "target": "country",
            "table": {"US": "United States", "FR": "France"},
        },
        {"code": "US"},
    )
    assert record["country"] == "United States"
    assert changed == 1
    again, changed = _apply(
        {
            "type": "lookup",
            "key": "code",
            "target": "country",
            "table": {"1": "one"},
        },
        {"code": 1, "country": "one"},
    )
    assert again["country"] == "one"
    assert changed == 0


def test_lookup_memory_rows_copy_several_fields():
    record, changed = _apply(
        {
            "type": "lookup",
            "keys": ["code"],
            "fields": {"label": "country", "region": "region"},
            "table": [{"code": "US", "label": "United States", "region": "NA"}],
        },
        {"code": "US"},
    )
    assert record["country"] == "United States"
    assert record["region"] == "NA"
    assert changed == 2


def test_lookup_csv_file_matches_numeric_keys(tmp_path):
    path = tmp_path / "cities.csv"
    path.write_text("code,country\n44,United Kingdom\n33,France\n", encoding="utf-8")
    record, _changed = _apply(
        {
            "type": "lookup",
            "keys": ["code"],
            "lookup_keys": ["code"],
            "value": "country",
            "target": "country",
            "from": {"type": "csv", "path": str(path)},
        },
        {"code": 44},
    )
    assert record["country"] == "United Kingdom"


def test_lookup_json_file_and_first_row_wins(tmp_path):
    path = tmp_path / "codes.json"
    path.write_text(
        json.dumps([{"code": "US", "label": "first"}, {"code": "US", "label": "second"}]),
        encoding="utf-8",
    )
    record, _changed = _apply(
        {
            "type": "lookup",
            "key": "code",
            "value": "label",
            "target": "label",
            "from": {"type": "json", "path": str(path)},
        },
        {"code": "US"},
    )
    assert record["label"] == "first"


def test_lookup_miss_fails_with_the_rule_name():
    spec = {
        "name": "must_match",
        "type": "lookup",
        "key": "code",
        "target": "label",
        "table": {"US": "United States"},
        "on_miss": "fail",
    }
    with pytest.raises(TransformError, match="must_match") as caught:
        _apply(spec, {"code": "ZZ"})
    assert caught.value.rule == "must_match"
    assert "lookup miss" in str(caught.value)


def test_lookup_miss_can_use_a_default():
    record, changed = _apply(
        {
            "name": "optional_country",
            "type": "lookup",
            "key": "city",
            "target": "country",
            "table": {"London": "United Kingdom"},
            "on_miss": "default",
            "default": "Unknown",
        },
        {"city": "Atlantis"},
    )
    assert record["country"] == "Unknown"
    assert changed == 1
    with pytest.raises(ConfigError, match="default"):
        build_rules(
            [
                {
                    "type": "lookup",
                    "key": "city",
                    "target": "country",
                    "table": {},
                    "on_miss": "default",
                }
            ]
        )


def test_sqlite_upsert_updates_existing_rows_and_inserts_new_ones(tmp_path):
    database = tmp_path / "people.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)")
    connection.execute("INSERT INTO people (id, name) VALUES (1, 'Old')")
    connection.commit()
    connection.close()
    result = run_job(
        tmp_path,
        records=[{"id": 1, "name": "Ada"}, {"id": 2, "name": "Alan"}],
        rules=[{"type": "cast", "field": "id", "to": "int"}],
        targets=[
            {
                "type": "sqlite",
                "path": str(database),
                "table": "people",
                "mode": "upsert",
                "primary_key": ["id"],
            }
        ],
    )
    assert result.loaded == 2
    connection = sqlite3.connect(database)
    rows = connection.execute("SELECT id, name FROM people ORDER BY id").fetchall()
    connection.close()
    assert rows == [(1, "Ada"), (2, "Alan")]


def test_sqlite_upsert_rolls_back_a_failed_batch_then_keeps_good_rows(tmp_path):
    database = tmp_path / "people.db"
    connection = sqlite3.connect(database)
    connection.execute(
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER CHECK (age >= 0))"
    )
    connection.execute("INSERT INTO people (id, name, age) VALUES (1, 'Old', 1)")
    connection.commit()
    connection.close()
    result = run_job(
        tmp_path,
        records=[{"id": 1, "name": "Ada", "age": 5}, {"id": 2, "name": "Bad", "age": -1}],
        rules=[{"type": "cast", "field": "id", "to": "int"}, {"type": "cast", "field": "age", "to": "int"}],
        targets=[
            {
                "type": "sqlite",
                "path": str(database),
                "table": "people",
                "mode": "upsert",
                "primary_key": ["id"],
            }
        ],
        batch_size=10,
    )
    assert result.loaded == 1
    assert result.failed == 1
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failed_batches"][0]["rolled_back"] is True
    connection = sqlite3.connect(database)
    rows = connection.execute("SELECT id, name, age FROM people ORDER BY id").fetchall()
    connection.close()
    assert rows == [(1, "Ada", 5)]


def test_upsert_without_a_primary_key_is_rejected(tmp_path):
    with pytest.raises(ConfigError, match="primary_key"):
        run_job(
            tmp_path,
            records=[{"id": 1}],
            targets=[{"type": "sqlite", "path": str(tmp_path / "x.db"), "mode": "upsert"}],
        )
    with pytest.raises(ConfigError, match="only supported for sqlite"):
        run_job(
            tmp_path / "csv",
            records=[{"id": 1}],
            targets=[{"type": "csv", "path": str(tmp_path / "out.csv"), "mode": "upsert"}],
        )


def test_load_retries_then_succeeds(tmp_path):
    sleeps: list[float] = []
    result = run_job(
        tmp_path,
        records=[{"id": 1, "name": "Ada"}, {"id": 2, "name": "Alan"}],
        rules=[{"type": "cast", "field": "id", "to": "int"}],
        retry={"attempts": 3, "backoff_seconds": 0.05, "max_backoff_seconds": 1},
        hooks=RunHooks(fail_commits=2, sleep=sleeps.append),
    )
    assert result.status == "completed"
    assert result.loaded == 2
    assert result.failed == 0
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failed_batch_count"] == 0
    assert sleeps == [0.05, 0.1]
    loaded = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert [row["name"] for row in loaded] == ["Ada", "Alan"]


def test_load_retries_exhausted_become_a_failed_batch(tmp_path):
    result = run_job(
        tmp_path,
        records=[{"id": 1}, {"id": 2}],
        rules=[{"type": "cast", "field": "id", "to": "int"}],
        retry={"attempts": 2, "backoff_seconds": 0, "max_backoff_seconds": 0},
        hooks=RunHooks(fail_commits=20, sleep=lambda _seconds: None),
        batch_size=10,
    )
    assert result.loaded == 0
    assert result.failed == 2
    errors = json.loads(result.error_report_path.read_text(encoding="utf-8"))
    assert errors["failed_batch_count"] == 1
    batch = errors["failed_batches"][0]
    assert batch["attempts"] == 2
    assert batch["rolled_back"] is True
    assert batch["retried_record_by_record"] is True
    assert "injected load failure" in batch["error"]


def test_retry_config_rejects_bad_values(tmp_path):
    with pytest.raises(ConfigError, match="attempts"):
        run_job(tmp_path, records=[], retry={"attempts": 0})
    with pytest.raises(ConfigError, match="max_backoff"):
        run_job(
            tmp_path / "cap",
            records=[],
            retry={"attempts": 2, "backoff_seconds": 1, "max_backoff_seconds": 0.1},
        )


def test_dry_run_does_not_write_targets_and_prints_the_sample_count(tmp_path):
    sentinel = tmp_path / "out.json"
    sentinel.write_text("KEEP\n", encoding="utf-8")
    database = tmp_path / "out.db"
    database.write_bytes(b"not a database")
    result = run_job(
        tmp_path,
        records=[{"id": "1", "name": "Ada"}, {"id": "nope", "name": "Bad"}, {"id": "2", "name": "Alan"}],
        rules=[{"name": "cast_id", "type": "cast", "field": "id", "to": "int"}],
        targets=[
            {"type": "json", "path": str(sentinel), "mode": "overwrite"},
            {"type": "sqlite", "path": str(database), "table": "rows", "mode": "overwrite", "primary_key": ["id"]},
        ],
        dry_run=True,
    )
    assert result.dry_run is True
    assert result.would_load == 2
    assert result.loaded == 0
    assert result.failed == 1
    assert result.success == 2
    assert sentinel.read_text(encoding="utf-8") == "KEEP\n"
    assert database.read_bytes() == b"not a database"
    assert [row["name"] for row in result.samples] == ["Ada", "Alan"]
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["dry_run"] is True
    assert report["would_load"] == 2
    assert report["samples"][0]["name"] == "Ada"


def test_execution_report_html_includes_counts_rules_and_an_error(tmp_path):
    result = run_job(
        tmp_path,
        records=[{"age": "4"}, {"age": "nope"}],
        rules=[{"name": "cast_age", "type": "cast", "field": "age", "to": "int"}],
    )
    html = result.report_path.with_suffix(".html").read_text(encoding="utf-8")
    assert 'id="report-success">1' in html
    assert 'id="report-failed">1' in html
    assert "cast_age" in html
    assert "cannot cast" in html
    assert "nope" in html
    assert result.loaded == 1


def test_web_status_grows_while_the_job_is_running(tmp_path):
    from etl_tool.monitor.status import StatusBoard

    board = StatusBoard("live")
    server = start_server(board, "127.0.0.1", 0)
    port = server.server_address[1]
    ready = [threading.Event() for _ in range(4)]
    release = [threading.Event() for _ in range(4)]

    def after_record(index: int) -> None:
        if index < len(ready):
            ready[index].set()
            assert release[index].wait(3)

    def worker():
        run_job(
            tmp_path,
            records=[{"id": index} for index in range(4)],
            rules=[{"name": "cast_id", "type": "cast", "field": "id", "to": "int"}],
            batch_size=1,
            board=board,
            hooks=RunHooks(after_record=after_record),
            progress=False,
        )

    thread = threading.Thread(target=worker)
    thread.start()
    samples = []
    try:
        page = render_page(board.snapshot())
        assert 'setInterval(refreshMonitor, 500)' in page
        assert "/api/status" in page
        for index, gate in enumerate(ready):
            assert gate.wait(3)
            with urlopen(f"http://127.0.0.1:{port}/api/status") as response:
                payload = json.loads(response.read().decode("utf-8"))
            samples.append(payload["processed"])
            assert "rules" in payload
            assert "recent_errors" in payload
            assert any(rule["name"] == "cast_id" for rule in payload["rules"])
            release[index].set()
    finally:
        for gate in release:
            gate.set()
        thread.join(5)
        server.shutdown()
        server.server_close()
    assert samples[0] < samples[-1]
    assert samples == sorted(samples)
    assert len({value for value in samples}) >= 2


def test_upgrade_demo_uses_new_rules_and_upsert():
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-m", "etl_tool", "demo-upgrade"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "success: 7" in proc.stdout
    assert "failed: 6" in proc.stdout
    assert "filtered_out: 1" in proc.stdout
    output = root / "demo-output-upgrade"
    rows = json.loads((output / "customers.json").read_text(encoding="utf-8"))
    by_name = {row["full_name"]: row for row in rows}
    assert by_name["Ada Lovelace"]["country"] == "United Kingdom"
    assert by_name["Lookup Miss"]["country"] == "Unknown"
    assert "Dup Key" not in by_name
    assert "Neg Price" not in by_name
    assert "Skip Me" not in by_name
    errors = json.loads((output / "errors.json").read_text(encoding="utf-8"))
    rules = {item["rule"] for item in errors["failures"]}
    assert "validate_contact" in rules
    assert "validate_ranges" in rules
    assert "dedup_id" in rules
    assert "cast_types" in rules
    assert "unit_price" in rules
    connection = sqlite3.connect(output / "customers.db")
    ada = connection.execute(
        "SELECT full_name, country FROM customers WHERE id = 1"
    ).fetchone()
    count = connection.execute("SELECT COUNT(*) FROM customers").fetchone()[0]
    connection.close()
    assert ada == ("Ada Lovelace", "United Kingdom")
    assert count == 7
    html = (output / "report.html").read_text(encoding="utf-8")
    assert 'id="report-success">7' in html
    assert "dedup_id" in html
