#!/usr/bin/env bash
# Start TMI, the memory scanner, on this computer and open it in the browser.
# First run installs everything into .venv (about 1-2 minutes). Press Ctrl+C to stop.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8077}"
VENV=".venv"
URL="http://127.0.0.1:$PORT"

ready() { [ -x "$VENV/bin/uvicorn" ] && "$VENV/bin/python" -c "import en_core_web_md, presidio_analyzer" 2>/dev/null; }

if ! ready; then
  echo "First run: installing the scanner (about 1-2 minutes, needs internet once)..."
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
    VIRTUAL_ENV="$VENV" uv pip install -r requirements.txt
  else
    PY="$(command -v python3.12 || command -v python3.11 || command -v python3.10 || true)"
    if [ -z "$PY" ]; then
      echo "TMI needs Python 3.10, 3.11 or 3.12 (or uv: https://docs.astral.sh/uv/). Install one, then run this again."
      exit 1
    fi
    "$PY" -m venv "$VENV"
    "$VENV/bin/python" -m pip install --upgrade pip
    "$VENV/bin/python" -m pip install -r requirements.txt
  fi
  ready || { echo "Setup didn't finish. Run this script again; it picks up where it stopped."; exit 1; }
fi

echo
echo "TMI is running at $URL"
echo "Everything stays on this computer. Press Ctrl+C to stop."
echo
if [ -z "${TMI_NO_BROWSER:-}" ]; then  # set TMI_NO_BROWSER=1 to skip opening a browser
  ( sleep 3; (command -v open >/dev/null 2>&1 && open "$URL") || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL") || true ) &
fi
exec "$VENV/bin/uvicorn" api.scanner:app --host 127.0.0.1 --port "$PORT" --no-access-log
