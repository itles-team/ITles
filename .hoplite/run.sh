#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ITLES_DB_PATH="${ITLES_DB_PATH:-$PWD/.local/itles.sqlite3}"
export ITLES_DEMO_ENABLED="${ITLES_DEMO_ENABLED:-1}"
export ITLES_COOKIE_SECURE="${ITLES_COOKIE_SECURE:-0}"
mkdir -p .local
chmod 700 .local
exec .venv/bin/python -m uvicorn server:app --app-dir "$PWD" --host 0.0.0.0 --port "${PORT:-3000}" --no-access-log
