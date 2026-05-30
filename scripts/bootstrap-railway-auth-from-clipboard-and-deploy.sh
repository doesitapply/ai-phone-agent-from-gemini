#!/usr/bin/env bash
set -euo pipefail

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "FAIL pbpaste not available; use bootstrap:railway-auth-and-deploy instead" >&2
  echo "Target file: ${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" >&2
  exit 1
fi

TOKEN="$(pbpaste)"
TOKEN="${TOKEN%$'\n'}"
TOKEN="${TOKEN%$'\r'}"
TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

if [ -z "$TOKEN" ]; then
  echo "FAIL clipboard is empty; copy a Railway token first" >&2
  echo "Target file: ${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" >&2
  echo "Next: copy the token from https://railway.app/account/tokens, then rerun this command" >&2
  exit 1
fi

case "$TOKEN" in
  "***"|"fake-token"|"<token>"|"<valid-token>"|"your-token-here"|"replace-me")
    echo "FAIL clipboard contains a placeholder, not a real Railway token" >&2
    echo "Target file: ${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" >&2
    echo "Next: copy a real token from https://railway.app/account/tokens, then rerun this command" >&2
    exit 1
    ;;
esac

printf '%s' "$TOKEN" | TARGET_FILE="${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" KEY_NAME="${KEY_NAME:-RAILWAY_API_TOKEN}" SKIP_CHECK="${SKIP_CHECK:-0}" SKIP_DEPLOY="${SKIP_DEPLOY:-0}" bash "$(cd "$(dirname "$0")" && pwd)/bootstrap-railway-auth-and-deploy.sh"
