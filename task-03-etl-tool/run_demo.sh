#!/usr/bin/env bash
# Run the bundled demo from any working directory.
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$(pwd)${PYTHONPATH:+:$PYTHONPATH}"
python3 -m etl_tool demo "$@"
