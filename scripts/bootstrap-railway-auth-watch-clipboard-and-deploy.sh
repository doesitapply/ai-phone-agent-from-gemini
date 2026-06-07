#!/usr/bin/env bash
set -euo pipefail

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "FAIL pbpaste not available; use bootstrap:railway-auth-and-deploy instead" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-2}"
STARTED_AT="$(date +%s)"

normalize() {
  printf '%s' "$1" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

is_placeholder() {
  case "$1" in
    ""|"***"|"fake-token"|"<token>"|"<valid-token>"|"your-token-here"|"replace-me") return 0 ;;
    *) return 1 ;;
  esac
}

looks_like_railway_token() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._:-]{24,255}$'
}

echo "Waiting for a real Railway token in the clipboard..." >&2
echo "After you copy it, this helper will save auth, run Railway checks, generate the approval bundle, and deploy." >&2
while true; do
  TOKEN="$(normalize "$(pbpaste)")"
  if ! is_placeholder "$TOKEN" && looks_like_railway_token "$TOKEN"; then
    printf '%s' "$TOKEN" | TARGET_FILE="${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" KEY_NAME="${KEY_NAME:-RAILWAY_API_TOKEN}" SKIP_CHECK="${SKIP_CHECK:-0}" SKIP_DEPLOY="${SKIP_DEPLOY:-0}" bash "$SCRIPT_DIR/bootstrap-railway-auth-and-deploy.sh"
    exit 0
  fi

  NOW="$(date +%s)"
  if [ $((NOW - STARTED_AT)) -ge "$TIMEOUT_SECONDS" ]; then
    echo "FAIL timed out waiting for a real Railway token in the clipboard" >&2
    echo "Next: copy the token from https://railway.app/account/tokens, then rerun this command" >&2
    exit 1
  fi

  sleep "$POLL_SECONDS"
done
