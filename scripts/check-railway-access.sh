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
COMMON_SHELL_FILES=(
  "$HOME/.zshrc"
  "$HOME/.zprofile"
  "$HOME/.zshenv"
  "$HOME/.bashrc"
  "$HOME/.bash_profile"
  "$HOME/.profile"
)
mask_token() {
  local raw="$1"
  local len=${#raw}
  if [ "$len" -le 8 ]; then
    printf 'len=%s' "$len"
    return
  fi
  printf 'len=%s prefix=%s suffix=%s' "$len" "${raw:0:3}" "${raw: -3}"
}
read_token_from_file() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 1
  awk -F= -v target="$key" '
    $1 == target {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"|"$/, "", value)
      gsub(/^'"'"'|'"'"'$/, "", value)
      print value
      exit
    }
  ' "$file"
}
file_token_hint() {
  local file="$1"
  local key="$2"
  if ! grep -Eq "^${key}=" "$file"; then
    return 1
  fi
  local value
  value="$(read_token_from_file "$file" "$key" || true)"
  if [ -z "$value" ]; then
    echo "$key is blank in $file"
    return 0
  fi
  local relation="different from active token"
  if [ "$value" = "$current_token" ]; then
    relation="matches active token"
  fi
  echo "$key in $file ($(mask_token "$value"), $relation)"
}
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

current_token="${!TOKEN_SOURCE}"
echo "Using Railway token from $TOKEN_SOURCE ($TOKEN_ORIGIN, $(mask_token "$current_token"))"

status_output=""
status_code=0
status_output="$(railway status 2>&1)" || status_code=$?

if [ "$status_code" -ne 0 ]; then
  if printf '%s' "$status_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token'; then
    echo "FAIL Railway auth invalid" >&2
    echo "Token source: $TOKEN_SOURCE ($TOKEN_ORIGIN, $(mask_token "$current_token"))" >&2
    any_file_match=0
    any_file_nonblank_match=0
    for env_file in "${COMMON_ENV_FILES[@]}"; do
      if [ -f "$env_file" ] && grep -Eq "^${TOKEN_SOURCE}=" "$env_file"; then
        any_file_match=1
        hint="$(file_token_hint "$env_file" "$TOKEN_SOURCE")"
        echo "Hint: $hint" >&2
        if [[ "$hint" != *"blank in"* ]]; then
          any_file_nonblank_match=1
        fi
      fi
    done
    if [ "$TOKEN_ORIGIN" = "process environment" ] && [ "$any_file_match" -eq 1 ] && [ "$any_file_nonblank_match" -eq 0 ]; then
      echo "Hint: the invalid token is coming from the current shell, not the local env files; unset $TOKEN_SOURCE or replace it in the shell before retrying." >&2
      shell_match=0
      for shell_file in "${COMMON_SHELL_FILES[@]}"; do
        if [ -f "$shell_file" ] && grep -Eq "${TOKEN_SOURCE}|RAILWAY_API_TOKEN" "$shell_file"; then
          shell_match=1
          echo "Hint: shell startup file references Railway auth: $shell_file" >&2
        fi
      done
      if [ "$shell_match" -eq 0 ]; then
        echo "Hint: no common shell startup files reference Railway auth; the bad token is likely inherited from the parent session or launcher environment." >&2
      fi
    fi
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