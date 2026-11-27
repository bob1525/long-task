"""The transform package must not evaluate arbitrary Python."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "etl_tool" / "transform"


def test_transform_package_has_no_eval_or_exec():
    pattern = re.compile(r"\b(eval|exec)\s*\(")
    offenders = []
    for path in ROOT.glob("*.py"):
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(path.name)
    assert offenders == []
