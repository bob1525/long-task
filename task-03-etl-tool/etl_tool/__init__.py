"""Small ETL tool: configurable rules, failure isolation, and a run monitor."""

from __future__ import annotations

import logging

__version__ = "1.0.0"

logging.getLogger("etl_tool").addHandler(logging.NullHandler())
