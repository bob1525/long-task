"""Run an extract-transform-load job with isolated record failures."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from etl_tool.config import JobConfig, load_config_file, normalize_config
from etl_tool.errors import CheckpointError, ConfigError, LoadError, TransformError
from etl_tool.extract.filters import compile_filter
from etl_tool.extract.sources import open_source
from etl_tool.load.targets import OutputSet, build_outputs
from etl_tool.monitor.progress import ProgressDisplay
from etl_tool.monitor.report import (
    build_error_report,
    build_execution_report,
    write_error_report,
    write_execution_report,
)
from etl_tool.monitor.status import StatusBoard
from etl_tool.recovery.state import STATE_VERSION, JobState, Journal, Threshold
from etl_tool.transform.engine import Engine
from etl_tool.transform.rules import build_rules
from etl_tool.values import sanitize, snapshot

logger = logging.getLogger("etl_tool")


@dataclass
class RunHooks:
    """Test hooks. interrupt_after_loaded stops after a committed window."""

    interrupt_after_loaded: int | None = None


@dataclass
class RunResult:
    status: str
    success: int
    failed: int
    loaded: int
    extracted: int
    filtered_out: int
    abort_reason: str | None
    resumed_from: int
    error_report_path: Path
    report_path: Path
    checkpoint_path: Path
    duration_seconds: float


def run_config_file(
    path: Path,
    *,
    resume: bool = False,
    hooks: RunHooks | None = None,
    board: StatusBoard | None = None,
    progress: bool | None = None,
) -> RunResult:
    raw = load_config_file(path)
    config = normalize_config(raw, path.parent)
    return run_job(config, resume=resume, hooks=hooks, board=board, progress=progress)


def run_mapping(
    data: dict[str, Any],
    base_dir: Path,
    *,
    resume: bool = False,
    hooks: RunHooks | None = None,
    board: StatusBoard | None = None,
    progress: bool | None = None,
) -> RunResult:
    config = normalize_config(data, base_dir)
    return run_job(config, resume=resume, hooks=hooks, board=board, progress=progress)


def run_job(
    config: JobConfig,
    *,
    resume: bool = False,
    hooks: RunHooks | None = None,
    board: StatusBoard | None = None,
    progress: bool | None = None,
) -> RunResult:
    source = open_source(config.extract)
    fingerprint = _fingerprint(config, source.fingerprint())
    rules = build_rules(config.rules)
    engine = Engine(rules)
    predicate = compile_filter(config.extract.get("filter"))
    outputs = build_outputs(config.targets)
    journal = Journal(config.checkpoint_path)
    threshold = Threshold(config.max_failures, config.max_failure_ratio)
    board = board or StatusBoard(config.name)
    show_progress = config.progress if progress is None else progress
    progress_display = ProgressDisplay(enabled=show_progress)
    hooks = hooks or RunHooks()

    file_handler = _attach_log_file(config.log_path)
    try:
        total = source.estimate_total()
    except Exception as exc:
        logger.warning("could not estimate the number of input rows: %s", exc)
        total = None

    state = JobState(fingerprint=fingerprint, started_at=_now())
    resumed_from = 0
    durable = False
    status = "completed"
    abort_reason: str | None = None
    generator = None
    run_started = 0.0
    baseline_elapsed = 0.0

    def elapsed() -> float:
        return baseline_elapsed + (_clock() - run_started)

    try:
        if resume:
            loaded = journal.load_last()
            if loaded is None:
                raise CheckpointError(f"no checkpoint found at {journal.log_path}")
            if loaded.version != STATE_VERSION:
                raise CheckpointError(f"unsupported checkpoint version {loaded.version}")
            if loaded.fingerprint != fingerprint:
                raise CheckpointError(
                    "checkpoint does not match this configuration or source data; "
                    "start again without --resume"
                )
            state = loaded
            resumed_from = state.end_index
            outputs.prepare(fresh=False)
            outputs.recover(
                sizes=state.sizes,
                index_bases=state.index_bases,
                end_index=state.end_index,
            )
            engine.restore(state.rule_stats)
        else:
            journal.clear()
            outputs.prepare(fresh=True)
            state.index_bases = outputs.index_bases()
            state.sizes = outputs.sizes()
            state.status = "running"
            journal.append(state)
        durable = True
        baseline_elapsed = state.elapsed_seconds
        run_started = _clock()
        if not state.started_at:
            state.started_at = _now()
        board.update(status="running", total=total, job=config.name)
        _publish(board, progress_display, state, engine, total, elapsed(), force=True)
        logger.info("job %s started (resume=%s, from=%s)", config.name, resume, resumed_from)

        early = threshold.reason(state.failed, state.failed + state.loaded)
        if early:
            status = "aborted"
            abort_reason = early
        else:
            generator = source.rows()
            last_index = state.end_index - 1
            window_ok: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
            window_failures: list[dict[str, Any]] = []
            dirty = False

            def flush() -> str | None:
                nonlocal dirty
                if not dirty:
                    return threshold.reason(state.failed, state.failed + state.loaded)
                end_index = last_index + 1
                batch_id = f"{state.end_index}-{end_index}"
                loaded_rows = 0
                if window_ok:
                    records = [item[2] for item in window_ok]
                    indices = [item[0] for item in window_ok]
                    try:
                        outputs.commit(records, indices)
                        loaded_rows = len(records)
                    except LoadError as exc:
                        state.failed_batches.append(
                            {
                                "batch_id": batch_id,
                                "stage": "load",
                                "target": exc.target,
                                "error": str(exc),
                                "rolled_back": True,
                                "retried_record_by_record": True,
                                "size": len(records),
                                "indices": indices,
                                "records": [snapshot(record) for record in records],
                            }
                        )
                        logger.warning("load batch %s rolled back: %s", batch_id, exc)
                        for index, original, record in window_ok:
                            try:
                                outputs.commit([record], [index])
                            except LoadError as row_error:
                                state.failed += 1
                                window_failures.append(
                                    _failure(
                                        index=index,
                                        stage="load",
                                        rule=None,
                                        rule_type=None,
                                        target=row_error.target,
                                        error=str(row_error),
                                        record=original,
                                        transformed=record,
                                    )
                                )
                                logger.warning("load failed for index %s: %s", index, row_error)
                            else:
                                loaded_rows += 1
                state.loaded += loaded_rows
                state.success = state.loaded
                state.failures.extend(window_failures)
                state.end_index = end_index
                state.elapsed_seconds = elapsed()
                state.rule_stats = engine.snapshot()
                state.sizes = outputs.sizes()
                state.index_bases = outputs.index_bases()
                state.status = "running"
                journal.append(state)
                # The JSON array is rebuilt once, in the finalizer. The jsonl
                # journal is already durable, so rewriting the array on every
                # batch would copy the whole output again.
                _write_outputs(config, state, resumed_from, "running", None)
                window_ok.clear()
                window_failures.clear()
                dirty = False
                _publish(board, progress_display, state, engine, total, elapsed(), force=True)
                if (
                    hooks.interrupt_after_loaded is not None
                    and state.loaded >= hooks.interrupt_after_loaded
                ):
                    return "interrupted"
                return threshold.reason(state.failed, state.failed + state.loaded)

            for raw_index, item in enumerate(generator):
                if raw_index < state.end_index:
                    continue
                last_index = raw_index
                dirty = True
                state.extracted += 1
                if item.error or item.record is None:
                    state.failed += 1
                    window_failures.append(
                        _failure(
                            index=raw_index,
                            stage="extract",
                            rule=None,
                            rule_type=None,
                            target=None,
                            error=item.error or "empty extracted record",
                            record=item.record if item.record is not None else {"raw": item.raw},
                        )
                    )
                    logger.warning("extract failed for index %s: %s", raw_index, item.error)
                else:
                    filter_error = False
                    try:
                        keep = bool(predicate(item.record))
                    except Exception as exc:
                        filter_error = True
                        keep = False
                        state.failed += 1
                        window_failures.append(
                            _failure(
                                index=raw_index,
                                stage="extract",
                                rule=None,
                                rule_type=None,
                                target=None,
                                error=f"filter failed: {exc}",
                                record=item.record,
                            )
                        )
                        logger.warning("filter failed for index %s: %s", raw_index, exc)
                    if filter_error:
                        pass
                    elif not keep:
                        state.filtered_out += 1
                    else:
                        try:
                            transformed = engine.transform(item.record)
                        except TransformError as exc:
                            state.failed += 1
                            window_failures.append(
                                _failure(
                                    index=raw_index,
                                    stage="transform",
                                    rule=exc.rule,
                                    rule_type=exc.rule_type,
                                    target=None,
                                    error=str(exc),
                                    record=item.record,
                                )
                            )
                            logger.warning(
                                "transform failed for index %s in rule %s: %s",
                                raw_index,
                                exc.rule,
                                exc.args[0] if exc.args else exc,
                            )
                        else:
                            try:
                                clean = sanitize(transformed)
                            except LoadError as exc:
                                state.failed += 1
                                window_failures.append(
                                    _failure(
                                        index=raw_index,
                                        stage="load",
                                        rule=None,
                                        rule_type=None,
                                        target=exc.target,
                                        error=str(exc),
                                        record=item.record,
                                        transformed=transformed,
                                    )
                                )
                            else:
                                window_ok.append((raw_index, item.record, clean))
                pending = state.failed + state.loaded + len(window_ok)
                tripped = threshold.reason(state.failed, pending)
                raw_pending = last_index + 1 - state.end_index
                if raw_pending >= config.batch_size or tripped:
                    signal = flush()
                    if signal == "interrupted":
                        status = "interrupted"
                        break
                    if signal:
                        status = "aborted"
                        abort_reason = signal
                        break
            else:
                signal = flush()
                if signal == "interrupted":
                    status = "interrupted"
                elif signal:
                    status = "aborted"
                    abort_reason = signal
    except Exception:
        if durable:
            status = "failed"
        raise
    finally:
        if generator is not None:
            generator.close()
        if durable:
            state.status = status
            state.abort_reason = abort_reason
            state.elapsed_seconds = elapsed()
            state.rule_stats = engine.snapshot()
            try:
                journal.append(state)
                outputs.materialize()
            except Exception as exc:
                logger.warning("could not write the final checkpoint: %s", exc)
            _write_outputs(config, state, resumed_from, status, abort_reason)
            _publish(board, progress_display, state, engine, total, state.elapsed_seconds, force=True)
        progress_display.close()
        outputs.close()
        if file_handler is not None:
            logger.removeHandler(file_handler)
            file_handler.close()

    logger.info(
        "job %s %s success=%s failed=%s loaded=%s",
        config.name,
        status,
        state.success,
        state.failed,
        state.loaded,
    )
    return RunResult(
        status=status,
        success=state.success,
        failed=state.failed,
        loaded=state.loaded,
        extracted=state.extracted,
        filtered_out=state.filtered_out,
        abort_reason=abort_reason,
        resumed_from=resumed_from,
        error_report_path=config.error_report_path,
        report_path=config.report_path,
        checkpoint_path=config.checkpoint_path,
        duration_seconds=state.elapsed_seconds,
    )


def _fingerprint(config: JobConfig, source_hash: str) -> str:
    payload = dict(config.fingerprint_material)
    payload["source"] = source_hash
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _failure(
    *,
    index: int,
    stage: str,
    rule: str | None,
    rule_type: str | None,
    target: str | None,
    error: str,
    record: Any,
    transformed: Any = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "index": index,
        "stage": stage,
        "rule": rule,
        "rule_type": rule_type,
        "target": target,
        "error": error,
        "record": snapshot(record),
    }
    if transformed is not None:
        payload["transformed"] = snapshot(transformed)
    return payload


def _write_outputs(
    config: JobConfig,
    state: JobState,
    resumed_from: int,
    status: str,
    abort_reason: str | None,
) -> None:
    write_error_report(
        config.error_report_path,
        build_error_report(config.name, status, state.failures, state.failed_batches),
    )
    write_execution_report(
        config.report_path,
        build_execution_report(
            job=config.name,
            status=status,
            started_at=state.started_at,
            duration_seconds=state.elapsed_seconds,
            extracted=state.extracted,
            filtered_out=state.filtered_out,
            success=state.success,
            failed=state.failed,
            loaded=state.loaded,
            resumed_from=resumed_from,
            rules=state.rule_stats,
            failed_batch_count=len(state.failed_batches),
            abort_reason=abort_reason,
            targets=[str(target.path) for target in config.targets],
        ),
    )


def _publish(
    board: StatusBoard,
    progress: ProgressDisplay,
    state: JobState,
    engine: Engine,
    total: int | None,
    elapsed_seconds: float,
    force: bool,
) -> None:
    recent = [
        {
            "index": item.get("index"),
            "stage": item.get("stage"),
            "rule": item.get("rule"),
            "target": item.get("target"),
            "error": item.get("error"),
        }
        for item in state.failures[-20:]
    ]
    processed = state.end_index
    if state.extracted and processed < state.extracted:
        processed = state.extracted
    board.update(
        status=state.status,
        processed=processed,
        total=total,
        success=state.success,
        failed=state.failed,
        loaded=state.loaded,
        filtered_out=state.filtered_out,
        elapsed_seconds=round(elapsed_seconds, 6),
        abort_reason=state.abort_reason,
        rules=engine.snapshot(),
        recent_errors=recent,
        failed_batch_count=len(state.failed_batches),
    )
    progress.update(
        processed=processed,
        total=total,
        success=state.success,
        failed=state.failed,
        elapsed=elapsed_seconds,
        force=force,
    )


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _clock() -> float:
    import time

    return time.perf_counter()


def _attach_log_file(path: Path | None) -> logging.Handler | None:
    if path is None:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return handler
