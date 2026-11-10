"""Local web page for job status, progress, and error counts."""

from __future__ import annotations

import json
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from etl_tool.monitor.status import StatusBoard


def render_page(state: dict[str, Any]) -> str:
    total = state.get("total")
    processed = int(state.get("processed") or 0)
    if total:
        percent = max(0.0, min(100.0, processed / int(total) * 100))
        total_label = str(total)
    else:
        percent = 0.0 if processed == 0 else 100.0
        total_label = "unknown"
    status = str(state.get("status") or "unknown")
    rules = state.get("rules") or []
    errors = state.get("recent_errors") or []
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
    ) or "<tr><td colspan='6'>No rules yet.</td></tr>"
    error_rows = "\n".join(
        "<tr>"
        f"<td>{escape(str(item.get('index', '')))}</td>"
        f"<td>{escape(str(item.get('stage', '')))}</td>"
        f"<td>{escape(str(item.get('rule') or item.get('target') or ''))}</td>"
        f"<td>{escape(str(item.get('error', '')))}</td>"
        "</tr>"
        for item in errors
    ) or "<tr><td colspan='4'>No errors.</td></tr>"
    reason = state.get("abort_reason")
    reason_html = f"<p class='reason'>{escape(str(reason))}</p>" if reason else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="1">
  <title>ETL monitor — {escape(str(state.get('job', '')))}</title>
  <style>
    :root {{
      color-scheme: dark;
      --ink: #14202b;
      --card: #1d2c3a;
      --line: #345066;
      --text: #e7eef6;
      --muted: #9eb2c6;
      --teal: #2ec4b6;
      --coral: #ff6b6b;
      --amber: #f4b942;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: radial-gradient(circle at top left, #244055, var(--ink) 42%);
      color: var(--text);
    }}
    main {{ max-width: 1080px; margin: 0 auto; padding: 28px 20px 48px; }}
    h1 {{ margin: 0 0 6px; font-size: 28px; letter-spacing: -0.03em; }}
    .sub {{ color: var(--muted); margin-bottom: 18px; }}
    .status {{
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: #234656;
      color: var(--teal);
      font-weight: 650;
    }}
    .status.aborted, .status.failed {{ background: #4a2a32; color: var(--coral); }}
    .cards {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 18px 0; }}
    .card {{ background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }}
    .card span {{ display: block; color: var(--muted); font-size: 13px; }}
    .card strong {{ font-size: 28px; }}
    .bar {{ height: 14px; background: #0f1a24; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }}
    .bar i {{ display: block; height: 100%; width: {percent:.2f}%; background: linear-gradient(90deg, var(--teal), var(--amber)); }}
    table {{ width: 100%; border-collapse: collapse; background: var(--card); border-radius: 14px; overflow: hidden; }}
    th, td {{ padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 14px; }}
    th {{ color: var(--muted); font-weight: 600; }}
    h2 {{ margin: 26px 0 10px; font-size: 18px; }}
    .reason {{ color: var(--amber); }}
    @media (max-width: 800px) {{ .cards {{ grid-template-columns: 1fr 1fr; }} }}
  </style>
</head>
<body>
  <main>
    <h1>ETL monitor</h1>
    <p class="sub">Job <strong>{escape(str(state.get('job', '')))}</strong>
      <span class="status {escape(status)}" id="job-status">{escape(status)}</span></p>
    {reason_html}
    <div class="bar" aria-label="progress"><i id="progress-bar"></i></div>
    <p class="sub" id="progress-label">{processed} / {escape(total_label)} ({percent:.1f}%)</p>
    <section class="cards">
      <div class="card"><span>Success</span><strong id="success-count">{int(state.get('success') or 0)}</strong></div>
      <div class="card"><span>Failed</span><strong id="failed-count">{int(state.get('failed') or 0)}</strong></div>
      <div class="card"><span>Loaded</span><strong id="loaded-count">{int(state.get('loaded') or 0)}</strong></div>
      <div class="card"><span>Elapsed seconds</span><strong id="elapsed">{float(state.get('elapsed_seconds') or 0):.2f}</strong></div>
    </section>
    <h2>Rules</h2>
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Seen</th><th>Rows changed</th><th>Fields changed</th><th>Failed</th></tr></thead>
      <tbody>{rule_rows}</tbody>
    </table>
    <h2>Recent errors</h2>
    <table>
      <thead><tr><th>Index</th><th>Stage</th><th>Rule / target</th><th>Error</th></tr></thead>
      <tbody>{error_rows}</tbody>
    </table>
  </main>
</body>
</html>
"""


def start_server(board: StatusBoard, host: str, port: int) -> ThreadingHTTPServer:
    board_ref = board

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
            path = urlparse(self.path).path
            if path == "/api/status":
                body = json.dumps(board_ref.snapshot()).encode("utf-8")
                self._send(200, "application/json; charset=utf-8", body)
                return
            if path in {"/", "/index.html"}:
                body = render_page(board_ref.snapshot()).encode("utf-8")
                self._send(200, "text/html; charset=utf-8", body)
                return
            self._send(404, "text/plain; charset=utf-8", b"not found")

        def _send(self, code: int, content_type: str, body: bytes) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer((host, port), Handler)
    thread_target = server.serve_forever
    import threading

    thread = threading.Thread(target=thread_target, name="etl-web", daemon=True)
    thread.start()
    return server
