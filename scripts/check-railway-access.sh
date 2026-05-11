#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PROJECT="ai-phone-agent"
EXPECTED_ENVIRONMENT="production"
EXPECTED_SERVICE="ai-phone-agent"
TOKEN_SOURCE=""
if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_API_TOKEN"
elif [ -n "${RAILWAY_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_TOKEN"
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "FAIL railway CLI not installed" >&2
  exit 1
fi

if [ -z "$TOKEN_SOURCE" ]; then
  echo "FAIL Railway auth missing" >&2
  echo "Set RAILWAY_TOKEN or RAILWAY_API_TOKEN, then rerun." >&2
  exit 1
fi

echo "Using Railway token from $TOKEN_SOURCE"

status_output=""
status_code=0
status_output="$(railway status 2>&1)" || status_code=$?

if [ "$status_code" -ne 0 ]; then
  if printf '%s' "$status_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token'; then
    echo "FAIL Railway auth invalid" >&2
    echo "Token source: $TOKEN_SOURCE" >&2
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