"""Execution reports and human-readable error reports."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from etl_tool.io_util import atomic_write_json, atomic_write_text


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_error_report(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_json(path, payload)
    atomic_write_text(path.with_suffix(".md"), render_error_markdown(payload))


def write_execution_report(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_json(path, payload)


def build_error_report(job: str, status: str, failures: list[dict[str, Any]], batches: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "job": job,
        "status": status,
        "generated_at": utc_now(),
        "failure_count": len(failures),
        "failed_batch_count": len(batches),
        "failures": failures,
        "failed_batches": batches,
    }


def build_execution_report(
    *,
    job: str,
    status: str,
    started_at: str | None,
    duration_seconds: float,
    extracted: int,
    filtered_out: int,
    success: int,
    failed: int,
    loaded: int,
    resumed_from: int,
    rules: list[dict[str, Any]],
    failed_batch_count: int,
    abort_reason: str | None,
    targets: list[str],
) -> dict[str, Any]:
    return {
        "job": job,
        "status": status,
        "started_at": started_at,
        "finished_at": utc_now(),
        "duration_seconds": round(duration_seconds, 6),
        "extracted": extracted,
        "filtered_out": filtered_out,
        "success": success,
        "failed": failed,
        "loaded": loaded,
        "resumed_from": resumed_from,
        "rules": rules,
        "failed_batch_count": failed_batch_count,
        "abort_reason": abort_reason,
        "targets": targets,
    }


def render_error_markdown(payload: dict[str, Any]) -> str:
    lines = [
        f"# ETL error report: {payload.get('job', '')}",
        "",
        f"- Status: {payload.get('status')}",
        f"- Failures: {payload.get('failure_count', 0)}",
        f"- Failed batches: {payload.get('failed_batch_count', 0)}",
        "",
    ]
    failures = payload.get("failures") or []
    if not failures:
        lines.append("No record failures.")
        lines.append("")
    for number, failure in enumerate(failures, start=1):
        lines.append(
            f"## {number}. index {failure.get('index')} — {failure.get('stage')} "
            f"`{failure.get('rule') or failure.get('target') or ''}`"
        )
        lines.append("")
        lines.append(f"- Rule type: {failure.get('rule_type')}")
        lines.append(f"- Target: {failure.get('target')}")
        lines.append(f"- Error: {failure.get('error')}")
        lines.append("")
        lines.append("Original record:")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(failure.get("record"), ensure_ascii=False, indent=2))
        lines.append("```")
        lines.append("")
        if failure.get("transformed") is not None:
            lines.append("Transformed record:")
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(failure.get("transformed"), ensure_ascii=False, indent=2))
            lines.append("```")
            lines.append("")
    batches = payload.get("failed_batches") or []
    if batches:
        lines.append("# Failed batches")
        lines.append("")
        for batch in batches:
            lines.append(
                f"- `{batch.get('batch_id')}` rolled_back={batch.get('rolled_back')} "
                f"target={batch.get('target')} size={batch.get('size')}"
            )
            lines.append(f"  - {batch.get('error')}")
        lines.append("")
    return "\n".join(lines)
