"""CLI, demo command, and the local web monitor."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from urllib.error import HTTPError
from urllib.request import urlopen

from etl_tool.monitor.status import StatusBoard
from etl_tool.monitor.web import render_page, start_server

ROOT = Path(__file__).resolve().parents[1]


def test_cli_bad_config_does_not_traceback(tmp_path: Path):
    config = tmp_path / "bad.yaml"
    config.write_text(":\n  - [\n", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "etl_tool", "run", "--config", str(config)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr
    assert "Traceback" not in proc.stdout
    missing = subprocess.run(
        [sys.executable, "-m", "etl_tool", "run", "--config", str(tmp_path / "nope.yaml")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert missing.returncode == 2
    assert "Traceback" not in missing.stderr


def test_demo_command_writes_success_errors_and_report():
    proc = subprocess.run(
        [sys.executable, "-m", "etl_tool", "demo"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "Traceback" not in proc.stderr
    assert "success: 8" in proc.stdout
    assert "failed: 4" in proc.stdout
    output = ROOT / "demo-output"
    rows = json.loads((output / "customers.json").read_text(encoding="utf-8"))
    by_name = {row["full_name"]: row for row in rows}
    ada = by_name["Ada Lovelace"]
    assert ada["email_address"] == "ada@example.com"
    assert ada["comment"] == "hello"
    assert ada["line_total"] == 31.5
    assert ada["unit_price"] == 3.5
    assert ada["tier"] == "bronze"
    assert ada["address"] == "12 King St, London, SW1A"
    assert ada["first_name"] == "Ada" and ada["last_name"] == "Lovelace"
    assert by_name["Grace Hopper"]["comment"] == "legend"
    assert by_name["Eve Extra Names"]["tier"] == "silver"
    assert by_name["Eve Extra Names"]["last_name"] == "Extra Names"
    assert by_name["High Value"]["tier"] == "gold"
    assert by_name["High Value"]["line_total"] == 1000
    assert by_name["Prince"]["last_name"] == ""
    assert by_name["Neg Price"]["line_total"] == -10
    assert "Skip Me" not in by_name
    assert [row["full_name"] for row in rows].count("Dup Key") == 0
    errors = json.loads((output / "errors.json").read_text(encoding="utf-8"))
    assert errors["failure_count"] == 4
    assert errors["failed_batch_count"] == 1
    assert errors["failed_batches"][0]["rolled_back"] is True
    rules = {item["rule"] for item in errors["failures"]}
    assert "cast_types" in rules
    assert "unit_price" in rules
    assert any(item["stage"] == "load" for item in errors["failures"])
    report = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "completed"
    assert report["success"] == 8
    assert report["failed"] == 4
    assert report["filtered_out"] == 1
    assert report["extracted"] == 13
    assert report["duration_seconds"] >= 0
    assert len(report["rules"]) == 10
    assert (output / "customers.csv").exists()
    assert (output / "customers.db").exists()
    assert (output / "errors.md").exists()
    assert "[etl]" in proc.stderr


def test_web_monitor_shows_status_and_counts():
    board = StatusBoard("customer-demo")
    board.update(
        status="running",
        processed=4,
        total=10,
        success=3,
        failed=1,
        loaded=3,
        elapsed_seconds=1.25,
        rules=[{"name": "cast_types", "type": "cast", "rows_seen": 4, "rows_modified": 3, "fields_modified": 6, "rows_failed": 1}],
        recent_errors=[{"index": 3, "stage": "transform", "rule": "cast_types", "error": "bad age"}],
    )
    page = render_page(board.snapshot())
    assert 'id="success-count">3' in page
    assert 'id="failed-count">1' in page
    assert "cast_types" in page
    assert "bad age" in page
    server = start_server(board, "127.0.0.1", 0)
    try:
        port = server.server_address[1]
        with urlopen(f"http://127.0.0.1:{port}/api/status") as response:
            payload = json.loads(response.read().decode("utf-8"))
        assert payload["success"] == 3
        assert payload["failed"] == 1
        assert payload["status"] == "running"
        with urlopen(f"http://127.0.0.1:{port}/") as response:
            html = response.read().decode("utf-8")
        assert "ETL monitor" in html
        assert "customer-demo" in html
        with pytest.raises(HTTPError) as caught:
            urlopen(f"http://127.0.0.1:{port}/missing")
        assert caught.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
