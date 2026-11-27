"""Error types shared by the ETL pipeline.

Record-level failures are ordinary exceptions that the pipeline catches.
They must not abort the process by themselves.
"""

from __future__ import annotations


class ConfigError(Exception):
    """The job configuration or an input source cannot be used."""


class TransformError(Exception):
    """A single record failed while a rule was applied."""

    def __init__(self, message: str, rule: str, rule_type: str) -> None:
        super().__init__(message)
        self.rule = rule
        self.rule_type = rule_type

    def __str__(self) -> str:
        message = super().__str__()
        if self.rule and not message.startswith(f"{self.rule}:"):
            return f"{self.rule}: {message}"
        return message


class LoadError(Exception):
    """A load target rejected a batch or a record."""

    def __init__(self, message: str, target: str = "") -> None:
        super().__init__(message)
        self.target = target


class ExtractError(Exception):
    """A source could not be opened, or one extracted item is unusable."""


class CheckpointError(Exception):
    """Resume state is missing, unreadable, or does not match this job."""
