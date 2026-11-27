"""Execution reports and human-readable error reports."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from html import escape
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
    html_path = path.with_suffix(".html") if path.suffix else path.with_name(path.name + ".html")
    atomic_write_text(html_path, render_execution_html(payload))


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
    dry_run: bool = False,
    would_load: int = 0,
    samples: list[dict[str, Any]] | None = None,
    error_samples: list[dict[str, Any]] | None = None,
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
        "dry_run": dry_run,
        "would_load": would_load,
        "samples": samples or [],
        "error_samples": error_samples or [],
    }


def render_execution_html(payload: dict[str, Any]) -> str:
    rules = payload.get("rules") or []
    rule_rows = "\n".join(
        "<tr>"
        f"<td>{escape(str(rule.get('name', '')))}</td>"
        f"<td>{escape(str(rule.get('type', '')))}</td>"
        f"<td>{int(rule.get('rows_seen', 0))}</td>"
        f"<td>{int(rule.get('rows_modified', 0))}</td>"
        f"<td>{int(rule.get('fields_modified', 0))}</td>"
        f"<td>{int(rule.get('rows_failed', 0))}</td>"
        "</tr>"
        for rule in rules
    ) or "<tr><td colspan='6'>No rules.</td></tr>"
    errors = payload.get("error_samples") or []
    error_rows = "\n".join(
        "<tr>"
        f"<td>{escape(str(item.get('index', '')))}</td>"
        f"<td>{escape(str(item.get('stage', '')))}</td>"
        f"<td>{escape(str(item.get('rule') or item.get('target') or ''))}</td>"
        f"<td>{escape(str(item.get('error', '')))}</td>"
        f"<td><pre>{escape(json.dumps(item.get('record'), ensure_ascii=False))}</pre></td>"
        "</tr>"
        for item in errors
    ) or "<tr><td colspan='5'>No errors.</td></tr>"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ETL report — {escape(str(payload.get('job', '')))}</title>
  <style>
    body {{ font-family: "Segoe UI", sans-serif; margin: 24px; color: #14202b; }}
    h1 {{ margin-bottom: 4px; }}
    .cards {{ display: flex; gap: 12px; margin: 16px 0; }}
    .card {{ border: 1px solid #d5dee8; border-radius: 10px; padding: 10px 14px; min-width: 120px; }}
    .card span {{ display: block; color: #5c6f82; font-size: 13px; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border-bottom: 1px solid #e1e8ef; text-align: left; padding: 6px 8px; vertical-align: top; }}
    pre {{ margin: 0; white-space: pre-wrap; }}
  </style>
</head>
<body>
  <h1>ETL execution report</h1>
  <p>Job <strong>{escape(str(payload.get('job', '')))}</strong> — {escape(str(payload.get('status', '')))}</p>
  <section class="cards">
    <div class="card"><span>Success</span><strong id="report-success">{int(payload.get('success') or 0)}</strong></div>
    <div class="card"><span>Failed</span><strong id="report-failed">{int(payload.get('failed') or 0)}</strong></div>
    <div class="card"><span>Loaded</span><strong id="report-loaded">{int(payload.get('loaded') or 0)}</strong></div>
    <div class="card"><span>Would load</span><strong id="report-would-load">{int(payload.get('would_load') or 0)}</strong></div>
    <div class="card"><span>Duration seconds</span><strong>{float(payload.get('duration_seconds') or 0):.6f}</strong></div>
  </section>
  <p>Dry run: {escape(str(bool(payload.get('dry_run'))))}. Filtered out: {int(payload.get('filtered_out') or 0)}.</p>
  <h2>Rules</h2>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Seen</th><th>Rows changed</th><th>Fields changed</th><th>Failed</th></tr></thead>
    <tbody>{rule_rows}</tbody>
  </table>
  <h2>Error samples</h2>
  <table>
    <thead><tr><th>Index</th><th>Stage</th><th>Rule / target</th><th>Error</th><th>Record</th></tr></thead>
    <tbody>{error_rows}</tbody>
  </table>
</body>
</html>
"""


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
