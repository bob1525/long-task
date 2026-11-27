"""In-memory job status shared with the web monitor."""

from __future__ import annotations

import threading
from typing import Any


class StatusBoard:
    def __init__(self, job: str) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "job": job,
            "status": "starting",
            "processed": 0,
            "total": None,
            "success": 0,
            "failed": 0,
            "loaded": 0,
            "filtered_out": 0,
            "elapsed_seconds": 0.0,
            "abort_reason": None,
            "rules": [],
            "recent_errors": [],
            "failed_batch_count": 0,
        }

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            state = dict(self._state)
            state["rules"] = [dict(item) for item in self._state.get("rules") or []]
            state["recent_errors"] = [dict(item) for item in self._state.get("recent_errors") or []]
            return state
