#!/usr/bin/env bash
set -euo pipefail

DEVTOOLS_PORT_FILE="$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"

if ! pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "FAIL Google Chrome is not running." >&2
  echo "Open Chrome, log into Stripe, keep the window open, and rerun this check." >&2
  exit 1
fi

if [ ! -f "$DEVTOOLS_PORT_FILE" ]; then
  echo "FAIL Chrome is running but remote debugging is not attachable yet." >&2
  echo "Expected file missing: $DEVTOOLS_PORT_FILE" >&2
  echo "Keep Chrome open, approve any attach prompt, then rerun this check." >&2
  exit 1
fi

PORT="$(head -n 1 "$DEVTOOLS_PORT_FILE" | tr -d '\r')"
if [ -z "$PORT" ]; then
  echo "FAIL Chrome DevToolsActivePort file is present but empty." >&2
  exit 1
fi

echo "OK Chrome user session looks attachable for Stripe automation (DevTools port: $PORT)"
