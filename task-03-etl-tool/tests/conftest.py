"""Shared builders for pipeline tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from etl_tool.pipeline import RunHooks, RunResult, run_mapping


def run_job(
    tmp_path: Path,
    records: list[dict[str, Any]] | None = None,
    *,
    rules: list[dict[str, Any]] | None = None,
    extract: dict[str, Any] | None = None,
    targets: list[dict[str, Any]] | None = None,
    batch_size: int = 20,
    handling: dict[str, Any] | None = None,
    resume: bool = False,
    hooks: RunHooks | None = None,
    progress: bool = False,
    name: str = "job",
) -> RunResult:
    if extract is None:
        extract = {"type": "json", "records": records or []}
    if targets is None:
        targets = [
            {"type": "json", "path": str(tmp_path / "out.json"), "mode": "overwrite"},
        ]
    data = {
        "name": name,
        "extract": extract,
        "transform": {"rules": rules or []},
        "load": {"batch_size": batch_size, "targets": targets},
        "error_handling": {
            "checkpoint_path": str(tmp_path / "checkpoint.json"),
            "error_report_path": str(tmp_path / "errors.json"),
            "log_path": str(tmp_path / "etl.log"),
            **(handling or {}),
        },
        "monitor": {
            "progress": progress,
            "report_path": str(tmp_path / "report.json"),
        },
    }
    return run_mapping(data, tmp_path, resume=resume, hooks=hooks)
