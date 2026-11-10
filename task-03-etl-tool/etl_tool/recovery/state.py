"""Append-only checkpoint journal.

Each line is a complete snapshot. A torn final line is ignored. The pipeline
writes a line only after the corresponding output bytes are flushed, and on
resume it truncates outputs back to the sizes stored in the last good line.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from etl_tool.io_util import atomic_write_json, fsync_directory

STATE_VERSION = 1


@dataclass
class JobState:
    version: int = STATE_VERSION
    fingerprint: str = ""
    end_index: int = 0
    index_bases: dict[str, int] = field(default_factory=dict)
    sizes: dict[str, int] = field(default_factory=dict)
    extracted: int = 0
    filtered_out: int = 0
    success: int = 0
    failed: int = 0
    loaded: int = 0
    failures: list[dict[str, Any]] = field(default_factory=list)
    failed_batches: list[dict[str, Any]] = field(default_factory=list)
    rule_stats: list[dict[str, Any]] = field(default_factory=list)
    elapsed_seconds: float = 0.0
    started_at: str | None = None
    status: str = "running"
    abort_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "fingerprint": self.fingerprint,
            "end_index": self.end_index,
            "index_bases": self.index_bases,
            "sizes": self.sizes,
            "extracted": self.extracted,
            "filtered_out": self.filtered_out,
            "success": self.success,
            "failed": self.failed,
            "loaded": self.loaded,
            "failures": self.failures,
            "failed_batches": self.failed_batches,
            "rule_stats": self.rule_stats,
            "elapsed_seconds": self.elapsed_seconds,
            "started_at": self.started_at,
            "status": self.status,
            "abort_reason": self.abort_reason,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "JobState":
        return cls(
            version=int(payload.get("version", 0)),
            fingerprint=str(payload.get("fingerprint", "")),
            end_index=int(payload.get("end_index", 0)),
            index_bases={str(k): int(v) for k, v in dict(payload.get("index_bases") or {}).items()},
            sizes={str(k): int(v) for k, v in dict(payload.get("sizes") or {}).items()},
            extracted=int(payload.get("extracted", 0)),
            filtered_out=int(payload.get("filtered_out", 0)),
            success=int(payload.get("success", 0)),
            failed=int(payload.get("failed", 0)),
            loaded=int(payload.get("loaded", 0)),
            failures=list(payload.get("failures") or []),
            failed_batches=list(payload.get("failed_batches") or []),
            rule_stats=list(payload.get("rule_stats") or []),
            elapsed_seconds=float(payload.get("elapsed_seconds", 0.0)),
            started_at=payload.get("started_at"),
            status=str(payload.get("status", "running")),
            abort_reason=payload.get("abort_reason"),
        )


class Journal:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.log_path = path.with_name(path.name + ".journal")

    def clear(self) -> None:
        for candidate in (self.path, self.log_path):
            if candidate.exists():
                candidate.unlink()

    def load_last(self) -> JobState | None:
        if not self.log_path.exists():
            return None
        text = self.log_path.read_text(encoding="utf-8")
        if text and not text.endswith("\n"):
            newline = text.rfind("\n")
            text = "" if newline < 0 else text[: newline + 1]
        last: dict[str, Any] | None = None
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                break
            if isinstance(payload, dict):
                last = payload
        if last is None:
            return None
        return JobState.from_dict(last)

    def append(self, state: JobState) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(state.to_dict(), ensure_ascii=False, separators=(",", ":"))
        if "\n" in line or "\r" in line:
            raise RuntimeError("checkpoint snapshot is not a single line")
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        fsync_directory(self.log_path.parent)
        atomic_write_json(self.path, state.to_dict())


class Threshold:
    """Abort once failures exceed a count or a ratio. Equality does not abort."""

    def __init__(self, max_failures: int | None, max_ratio: float | None) -> None:
        self.max_failures = max_failures
        self.max_ratio = max_ratio

    def reason(self, failed: int, processed: int) -> str | None:
        if self.max_failures is not None and failed > self.max_failures:
            return (
                f"failure count {failed} exceeded the configured maximum "
                f"of {self.max_failures}"
            )
        if (
            self.max_ratio is not None
            and processed > 0
            and (failed / processed) > self.max_ratio
        ):
            ratio = failed / processed
            return (
                f"failure ratio {ratio:.4f} exceeded the configured maximum "
                f"of {self.max_ratio}"
            )
        return None
