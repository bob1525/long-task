"""Load and normalize a job configuration from JSON or YAML."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from etl_tool.errors import ConfigError


@dataclass
class TargetSpec:
    type: str
    path: Path
    mode: str
    table: str = "records"
    primary_key: list[str] = field(default_factory=list)
    delimiter: str = ","


@dataclass
class JobConfig:
    name: str
    extract: dict[str, Any]
    rules: list[dict[str, Any]]
    targets: list[TargetSpec]
    batch_size: int
    max_failures: int | None
    max_failure_ratio: float | None
    checkpoint_path: Path
    error_report_path: Path
    report_path: Path
    log_path: Path | None
    progress: bool
    web_enabled: bool
    web_host: str
    web_port: int
    retry_attempts: int
    retry_backoff_seconds: float
    retry_max_backoff_seconds: float
    fingerprint_material: dict[str, Any]


def load_config_file(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read config {path}: {exc}") from exc
    return parse_config_text(text, path.suffix.lower(), str(path))


def parse_config_text(text: str, suffix: str, label: str) -> dict[str, Any]:
    try:
        if suffix in {".yaml", ".yml"}:
            data = yaml.safe_load(text)
        elif suffix == ".json":
            data = json.loads(text)
        else:
            try:
                data = yaml.safe_load(text)
            except yaml.YAMLError:
                data = json.loads(text)
    except (yaml.YAMLError, json.JSONDecodeError) as exc:
        raise ConfigError(f"cannot parse {label}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{label} must contain a mapping")
    return data


def normalize_config(data: dict[str, Any], base_dir: Path) -> JobConfig:
    extract = data.get("extract")
    if not isinstance(extract, dict):
        raise ConfigError("config.extract is required")
    extract_type = str(extract.get("type", "")).lower()
    if extract_type not in {"csv", "json", "sqlite"}:
        raise ConfigError("extract.type must be csv, json, or sqlite")
    normalized_extract = _normalize_extract(extract, base_dir)

    transform = data.get("transform") or {}
    if not isinstance(transform, dict):
        raise ConfigError("config.transform must be a mapping")
    rules = transform.get("rules") or []
    if not isinstance(rules, list):
        raise ConfigError("transform.rules must be a list")
    rules = [_resolve_rule_paths(rule, base_dir) for rule in rules]

    load = data.get("load")
    if not isinstance(load, dict):
        raise ConfigError("config.load is required")
    targets, batch_size, retry = _normalize_load(load, base_dir)

    handling = data.get("error_handling") or {}
    if not isinstance(handling, dict):
        raise ConfigError("error_handling must be a mapping")
    monitor = data.get("monitor") or {}
    if not isinstance(monitor, dict):
        raise ConfigError("monitor must be a mapping")
    web = monitor.get("web") or {}
    if not isinstance(web, dict):
        raise ConfigError("monitor.web must be a mapping")

    output_dir = base_dir / "output"
    checkpoint_path = _resolve_path(
        base_dir, handling.get("checkpoint_path"), output_dir / "checkpoint.json"
    )
    error_report_path = _resolve_path(
        base_dir, handling.get("error_report_path"), output_dir / "errors.json"
    )
    report_path = _resolve_path(base_dir, monitor.get("report_path"), output_dir / "report.json")
    log_value = handling.get("log_path")
    log_path = _resolve_path(base_dir, log_value, None) if log_value else None

    max_failures = handling.get("max_failures")
    if max_failures is not None:
        if isinstance(max_failures, bool) or not isinstance(max_failures, int) or max_failures < 0:
            raise ConfigError("error_handling.max_failures must be a non-negative integer")
    max_ratio = handling.get("max_failure_ratio")
    if max_ratio is not None:
        if isinstance(max_ratio, bool) or not isinstance(max_ratio, (int, float)):
            raise ConfigError("error_handling.max_failure_ratio must be a number")
        max_ratio = float(max_ratio)
        if max_ratio < 0 or max_ratio > 1:
            raise ConfigError("error_handling.max_failure_ratio must be between 0 and 1")

    web_port = int(web.get("port", 8765))
    if web_port < 0 or web_port > 65535:
        raise ConfigError("monitor.web.port is out of range")

    fingerprint_material = {
        "version": 1,
        "extract": normalized_extract,
        "rules": rules,
        "targets": [
            {
                "type": target.type,
                "path": str(target.path),
                "mode": target.mode,
                "table": target.table,
                "primary_key": target.primary_key,
                "delimiter": target.delimiter,
            }
            for target in targets
        ],
    }
    return JobConfig(
        name=str(data.get("name") or "etl-job"),
        extract=normalized_extract,
        rules=rules,
        targets=targets,
        batch_size=batch_size,
        max_failures=max_failures,
        max_failure_ratio=max_ratio,
        checkpoint_path=checkpoint_path,
        error_report_path=error_report_path,
        report_path=report_path,
        log_path=log_path,
        progress=bool(monitor.get("progress", True)),
        web_enabled=bool(web.get("enabled", False)),
        web_host=str(web.get("host", "127.0.0.1")),
        web_port=web_port,
        retry_attempts=retry[0],
        retry_backoff_seconds=retry[1],
        retry_max_backoff_seconds=retry[2],
        fingerprint_material=fingerprint_material,
    )


def _normalize_extract(extract: dict[str, Any], base_dir: Path) -> dict[str, Any]:
    kind = str(extract["type"]).lower()
    normalized: dict[str, Any] = {"type": kind}
    if kind == "csv":
        _assign_location(normalized, extract, base_dir)
        normalized["encoding"] = str(extract.get("encoding", "utf-8-sig"))
        normalized["delimiter"] = str(extract.get("delimiter", ","))
    elif kind == "json":
        _assign_location(normalized, extract, base_dir)
        if extract.get("records_key") is not None:
            normalized["records_key"] = str(extract["records_key"])
        if extract.get("format") is not None:
            normalized["format"] = str(extract["format"]).lower()
    elif kind == "sqlite":
        if extract.get("records") is not None:
            normalized["records"] = extract["records"]
        else:
            location = extract.get("path", extract.get("database"))
            if location is None:
                raise ConfigError("sqlite extract needs path, database, or records")
            normalized["path"] = _location_string(base_dir, location)
        for key in ("query", "table", "init_sql"):
            if extract.get(key) is not None:
                normalized[key] = str(extract[key])
    if "filter" in extract:
        normalized["filter"] = extract["filter"]
    return normalized


def _assign_location(normalized: dict[str, Any], extract: dict[str, Any], base_dir: Path) -> None:
    choices = [name for name in ("path", "data", "records") if extract.get(name) is not None]
    if len(choices) != 1:
        raise ConfigError(
            f"{normalized['type']} extract needs exactly one of path, data, or records"
        )
    choice = choices[0]
    if choice == "path":
        normalized["path"] = _location_string(base_dir, extract["path"])
    else:
        normalized[choice] = extract[choice]


def _normalize_load(
    load: dict[str, Any], base_dir: Path
) -> tuple[list[TargetSpec], int, tuple[int, float, float]]:
    batch_size = load.get("batch_size", 200)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ConfigError("load.batch_size must be a positive integer")
    retry = _normalize_retry(load.get("retry"))
    if "targets" in load and "type" in load:
        raise ConfigError("load must use either type or targets, not both")
    if "targets" in load:
        raw_targets = load["targets"]
        if not isinstance(raw_targets, list) or not raw_targets:
            raise ConfigError("load.targets must be a non-empty list")
    else:
        raw_targets = [load]
    targets = [_normalize_target(item, base_dir) for item in raw_targets]
    return targets, batch_size, retry


def _normalize_retry(retry: Any) -> tuple[int, float, float]:
    if retry is None:
        return 1, 0.0, 0.0
    if not isinstance(retry, dict):
        raise ConfigError("load.retry must be a mapping")
    attempts = retry.get("attempts", 1)
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
        raise ConfigError("load.retry.attempts must be a positive integer")
    backoff = retry.get("backoff_seconds", 0)
    if isinstance(backoff, bool) or not isinstance(backoff, (int, float)) or backoff < 0:
        raise ConfigError("load.retry.backoff_seconds must be a non-negative number")
    max_backoff = retry.get("max_backoff_seconds", backoff)
    if isinstance(max_backoff, bool) or not isinstance(max_backoff, (int, float)) or max_backoff < 0:
        raise ConfigError("load.retry.max_backoff_seconds must be a non-negative number")
    if float(max_backoff) < float(backoff):
        raise ConfigError("load.retry.max_backoff_seconds must be >= backoff_seconds")
    return int(attempts), float(backoff), float(max_backoff)


def _normalize_target(item: Any, base_dir: Path) -> TargetSpec:
    if not isinstance(item, dict):
        raise ConfigError("each load target must be a mapping")
    kind = str(item.get("type", "")).lower()
    if kind not in {"csv", "json", "sqlite"}:
        raise ConfigError("load target type must be csv, json, or sqlite")
    if "path" not in item:
        raise ConfigError(f"{kind} load target requires path")
    mode = str(item.get("mode", "overwrite"))
    if mode not in {"overwrite", "append", "upsert"}:
        raise ConfigError("load mode must be overwrite, append, or upsert")
    if mode == "upsert" and kind != "sqlite":
        raise ConfigError("upsert mode is only supported for sqlite targets")
    primary_key = item.get("primary_key") or []
    if not isinstance(primary_key, list) or not all(isinstance(key, str) for key in primary_key):
        raise ConfigError("sqlite primary_key must be a list of column names")
    if mode == "upsert" and not primary_key:
        raise ConfigError("sqlite upsert requires primary_key")
    table = str(item.get("table") or "records")
    delimiter = str(item.get("delimiter", ","))
    return TargetSpec(
        type=kind,
        path=Path(_location_string(base_dir, item["path"])),
        mode=mode,
        table=table,
        primary_key=[str(key) for key in primary_key],
        delimiter=delimiter,
    )


def _location_string(base_dir: Path, value: Any) -> str:
    text = str(value)
    if text == ":memory:":
        return text
    path = Path(text)
    if not path.is_absolute():
        path = (base_dir / path).resolve()
    return str(path)


def _resolve_rule_paths(rule: Any, base_dir: Path) -> Any:
    if not isinstance(rule, dict):
        return rule
    copied = dict(rule)
    source = copied.get("from")
    if str(copied.get("type", "")).lower() == "lookup" and isinstance(source, dict) and source.get("path"):
        resolved = dict(source)
        resolved["path"] = _location_string(base_dir, source["path"])
        copied["from"] = resolved
    return copied


def _resolve_path(base_dir: Path, value: Any, default: Path | None) -> Path:
    if value is None:
        if default is None:
            raise ConfigError("expected a path")
        return default
    return Path(_location_string(base_dir, value))
