"""Terminal progress line. Uses carriage return on a TTY and newlines otherwise."""

from __future__ import annotations

import sys
import time


class ProgressDisplay:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self._last_len = 0
        self._last_at = 0.0

    def update(
        self,
        *,
        processed: int,
        total: int | None,
        success: int,
        failed: int,
        elapsed: float,
        force: bool = False,
    ) -> None:
        if not self.enabled:
            return
        now = time.perf_counter()
        if not force and now - self._last_at < 0.1:
            return
        self._last_at = now
        if total:
            ratio = processed / total
            head = f"[etl] processed={processed}/{total} ({ratio:.1%})"
        else:
            head = f"[etl] processed={processed}"
        message = (
            f"{head} success={success} failed={failed} elapsed={elapsed:.2f}s"
        )
        if sys.stderr.isatty():
            padding = " " * max(0, self._last_len - len(message))
            print("\r" + message + padding, end="", file=sys.stderr, flush=True)
            self._last_len = len(message)
        else:
            print(message, file=sys.stderr, flush=True)

    def close(self) -> None:
        if self.enabled and self._last_len and sys.stderr.isatty():
            print(file=sys.stderr)
            self._last_len = 0
