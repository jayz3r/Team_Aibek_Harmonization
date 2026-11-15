#!/bin/sh
# FireBridge: starts the API (port 8000) and the UI (port 5173). Ctrl+C stops both.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/backend"
if [ ! -d .venv ]; then
  echo "Creating Python environment..."
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -r requirements.txt
else
  . .venv/bin/activate
fi
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 &
API=$!
trap 'kill $API 2>/dev/null' EXIT INT TERM
cd "$ROOT/frontend"
[ -d node_modules ] || npm ci
npm run dev
