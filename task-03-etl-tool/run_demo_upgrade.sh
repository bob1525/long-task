#!/usr/bin/env bash
# Run the round-3 demo from any working directory.
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$(pwd)${PYTHONPATH:+:$PYTHONPATH}"
python3 -m etl_tool demo-upgrade "$@"
