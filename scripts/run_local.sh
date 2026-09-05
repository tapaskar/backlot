#!/usr/bin/env bash
# Run the app on your machine against whatever .env points at (Grafana Cloud or the compose studio).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; source .env; set +a; }
python -m uvicorn backlot.web.app:app --host 0.0.0.0 --port "${PORT:-8080}" --reload
