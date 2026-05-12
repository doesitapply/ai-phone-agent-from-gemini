#!/usr/bin/env bash
set -euo pipefail

ENV_FILES=(
  "$HOME/.openclaw/workspace/.env.operator"
  "$HOME/.openclaw/workspace/.env.smirk"
  "$HOME/.openclaw/workspace/.env"
)

extract_value() {
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

for env_file in "${ENV_FILES[@]}"; do
  [ -f "$env_file" ] || continue
  railway_api_token="$(extract_value "$env_file" "RAILWAY_API_TOKEN" || true)"
  if [ -n "$railway_api_token" ]; then
    export RAILWAY_API_TOKEN="$railway_api_token"
    echo "Loaded RAILWAY_API_TOKEN from $env_file"
    exit 0
  fi
  railway_token="$(extract_value "$env_file" "RAILWAY_TOKEN" || true)"
  if [ -n "$railway_token" ]; then
    export RAILWAY_TOKEN="$railway_token"
    echo "Loaded RAILWAY_TOKEN from $env_file"
    exit 0
  fi
done

echo "No nonblank Railway auth token found in known env files." >&2
echo "Populate RAILWAY_API_TOKEN or RAILWAY_TOKEN in ~/.openclaw/workspace/.env.operator, .env.smirk, or .env first." >&2
exit 1
