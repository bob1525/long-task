"""Command line entry points."""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from etl_tool import __version__
from etl_tool.errors import CheckpointError, ConfigError
from etl_tool.monitor.status import StatusBoard
from etl_tool.monitor.web import start_server
from etl_tool.pipeline import run_config_file

ROOT = Path(__file__).resolve().parents[1]
DEMO_CONFIG = ROOT / "demo" / "config.yaml"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="etl-tool", description="Configurable ETL tool")
    parser.add_argument("--version", action="version", version=f"etl-tool {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="run a job from a JSON or YAML config")
    _add_run_arguments(run_parser)

    demo_parser = sub.add_parser("demo", help="run the bundled customer demo")
    _add_run_arguments(demo_parser, include_config=False)

    args = parser.parse_args(argv)
    config_path = DEMO_CONFIG if args.command == "demo" else Path(args.config)
    _configure_logging(getattr(args, "log_level", "INFO"))
    board = StatusBoard(config_path.stem)
    server = None
    if args.web:
        try:
            server = start_server(board, args.web_host, args.web_port)
        except OSError as exc:
            print(f"error: cannot start web monitor: {exc}", file=sys.stderr)
            return 2
        host, port = server.server_address[:2]
        print(f"web monitor: http://{host}:{port}/", file=sys.stderr)
    try:
        try:
            result = run_config_file(
                config_path,
                resume=args.resume,
                board=board,
                progress=not args.quiet,
            )
        except (ConfigError, CheckpointError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        except Exception as exc:
            logging.getLogger("etl_tool").error("job failed: %s", exc)
            print(f"error: {exc}", file=sys.stderr)
            return 1
        if args.web_keep:
            time.sleep(args.web_keep)
        _print_summary(result)
        if result.status == "aborted":
            return 3
        if result.status == "failed":
            return 1
        return 0
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


def _add_run_arguments(parser: argparse.ArgumentParser, *, include_config: bool = True) -> None:
    if include_config:
        parser.add_argument("--config", required=True, help="path to a JSON or YAML job file")
    parser.add_argument("--resume", action="store_true", help="continue from the checkpoint")
    parser.add_argument("--web", action="store_true", help="serve the monitor page during the job")
    parser.add_argument("--web-host", default="127.0.0.1")
    parser.add_argument("--web-port", type=int, default=8765)
    parser.add_argument(
        "--web-keep",
        type=float,
        default=0,
        help="seconds to leave the monitor up after the job finishes",
    )
    parser.add_argument("--quiet", action="store_true", help="disable the progress line")
    parser.add_argument("--log-level", default="INFO")


def _configure_logging(level: str) -> None:
    logger = logging.getLogger("etl_tool")
    logger.handlers.clear()
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.propagate = False
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(handler)


def _print_summary(result: Any) -> None:
    print(f"status: {result.status}")
    print(f"success: {result.success}")
    print(f"failed: {result.failed}")
    print(f"loaded: {result.loaded}")
    print(f"extracted: {result.extracted}")
    print(f"filtered_out: {result.filtered_out}")
    print(f"duration_seconds: {result.duration_seconds:.6f}")
    if result.abort_reason:
        print(f"abort_reason: {result.abort_reason}")
    print(f"error_report: {result.error_report_path}")
    print(f"execution_report: {result.report_path}")
    print(f"checkpoint: {result.checkpoint_path}")


if __name__ == "__main__":
    raise SystemExit(main())
