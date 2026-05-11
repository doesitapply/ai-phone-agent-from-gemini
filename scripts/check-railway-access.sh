#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PROJECT="ai-phone-agent"
EXPECTED_ENVIRONMENT="production"
EXPECTED_SERVICE="ai-phone-agent"
COMMON_ENV_FILES=(
  "$HOME/.openclaw/workspace/.env.operator"
  "$HOME/.openclaw/workspace/.env.smirk"
  "$HOME/.openclaw/workspace/.env"
)
TOKEN_SOURCE=""
TOKEN_ORIGIN=""
if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_API_TOKEN"
  TOKEN_ORIGIN="process environment"
elif [ -n "${RAILWAY_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_TOKEN"
  TOKEN_ORIGIN="process environment"
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "FAIL railway CLI not installed" >&2
  exit 1
fi

if [ -z "$TOKEN_SOURCE" ]; then
  echo "FAIL Railway auth missing" >&2
  echo "Set RAILWAY_TOKEN or RAILWAY_API_TOKEN, then rerun." >&2
  for env_file in "${COMMON_ENV_FILES[@]}"; do
    if [ -f "$env_file" ]; then
      if grep -Eq '^(RAILWAY_TOKEN|RAILWAY_API_TOKEN)=' "$env_file"; then
        echo "Hint: $env_file contains a Railway token entry but it is not loaded into this shell." >&2
      fi
    fi
  done
  exit 1
fi

echo "Using Railway token from $TOKEN_SOURCE ($TOKEN_ORIGIN)"

status_output=""
status_code=0
status_output="$(railway status 2>&1)" || status_code=$?

if [ "$status_code" -ne 0 ]; then
  if printf '%s' "$status_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token'; then
    echo "FAIL Railway auth invalid" >&2
    echo "Token source: $TOKEN_SOURCE ($TOKEN_ORIGIN)" >&2
    for env_file in "${COMMON_ENV_FILES[@]}"; do
      if [ -f "$env_file" ] && grep -Eq "^${TOKEN_SOURCE}=" "$env_file"; then
        echo "Hint: $TOKEN_SOURCE is also defined in $env_file" >&2
      fi
    done
    echo "Set a valid RAILWAY_TOKEN or RAILWAY_API_TOKEN, or use the Railway dashboard." >&2
    printf '%s\n' "$status_output" >&2
    exit 1
  fi
  echo "FAIL railway status failed" >&2
  printf '%s\n' "$status_output" >&2
  exit 1
fi

printf '%s\n' "$status_output"

project_line="$(printf '%s\n' "$status_output" | grep '^Project:' || true)"
environment_line="$(printf '%s\n' "$status_output" | grep '^Environment:' || true)"
service_line="$(printf '%s\n' "$status_output" | grep '^Service:' || true)"

if [[ "$project_line" != *"$EXPECTED_PROJECT"* ]] || [[ "$environment_line" != *"$EXPECTED_ENVIRONMENT"* ]] || [[ "$service_line" != *"$EXPECTED_SERVICE"* ]]; then
  echo "FAIL Railway target mismatch" >&2
  echo "Expected Project=$EXPECTED_PROJECT Environment=$EXPECTED_ENVIRONMENT Service=$EXPECTED_SERVICE" >&2
  exit 1
fi

echo "OK Railway CLI auth and target service access verified"