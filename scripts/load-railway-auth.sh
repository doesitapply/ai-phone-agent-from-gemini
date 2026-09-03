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

looks_placeholder_token() {
  case "$1" in
    "***"|"fake-token"|"<token>"|"<valid-token>"|"your-token-here"|"replace-me") return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  # A command or test harness may deliberately supply its own token. Do not
  # override that explicit boundary by reading a developer-machine credential
  # file; this keeps dry-run fixtures isolated from real local secrets.
  if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
    if looks_placeholder_token "$RAILWAY_API_TOKEN"; then
      echo "FAIL placeholder RAILWAY_API_TOKEN supplied by environment; refusing to use it" >&2
      return 1
    fi
    return 0
  fi
  if [ -n "${RAILWAY_TOKEN:-}" ]; then
    if looks_placeholder_token "$RAILWAY_TOKEN"; then
      echo "FAIL placeholder RAILWAY_TOKEN supplied by environment; refusing to use it" >&2
      return 1
    fi
    export RAILWAY_API_TOKEN="$RAILWAY_TOKEN"
    return 0
  fi

  for env_file in "${ENV_FILES[@]}"; do
    [ -f "$env_file" ] || continue
    railway_api_token="$(extract_value "$env_file" "RAILWAY_API_TOKEN" || true)"
    if [ -n "$railway_api_token" ]; then
      if looks_placeholder_token "$railway_api_token"; then
        echo "FAIL placeholder RAILWAY_API_TOKEN found in $env_file; refusing to export it" >&2
        echo "Replace it with a real Railway token from https://railway.app/account/tokens" >&2
        echo "Remove placeholder first: python3 - <<'PY'
from pathlib import Path
p = Path('$env_file')
lines = p.read_text().splitlines()
p.write_text('\\n'.join(line for line in lines if not line.startswith('RAILWAY_API_TOKEN=')) + ('\\n' if lines else ''))
PY" >&2
        echo "Fast path: printf '%s' '<real-token>' | TARGET_FILE='$env_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
        return 1
      fi
      export RAILWAY_API_TOKEN="$railway_api_token"
      echo "Loaded RAILWAY_API_TOKEN from $env_file"
      return 0
    fi

    railway_token="$(extract_value "$env_file" "RAILWAY_TOKEN" || true)"
    if [ -n "$railway_token" ]; then
      if looks_placeholder_token "$railway_token"; then
        echo "FAIL placeholder RAILWAY_TOKEN found in $env_file; refusing to export it" >&2
        echo "Replace it with a real Railway token from https://railway.app/account/tokens" >&2
        echo "Remove placeholder first: python3 - <<'PY'
from pathlib import Path
p = Path('$env_file')
lines = p.read_text().splitlines()
p.write_text('\\n'.join(line for line in lines if not line.startswith('RAILWAY_TOKEN=')) + ('\\n' if lines else ''))
PY" >&2
        echo "Fast path: printf '%s' '<real-token>' | TARGET_FILE='$env_file' KEY_NAME='RAILWAY_TOKEN' npm run -s bootstrap:railway-auth" >&2
        return 1
      fi
      export RAILWAY_TOKEN="$railway_token"
      echo "Loaded RAILWAY_TOKEN from $env_file"
      return 0
    fi
  done

  echo "No nonblank Railway auth token found in known env files." >&2
  echo "Get one at https://railway.app/account/tokens, then save RAILWAY_API_TOKEN into ~/.openclaw/workspace/.env.operator." >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "Recommended fast path:" >&2
  echo "  printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "Manual alternative:" >&2
  echo "  printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s save:railway-auth" >&2
  return 1
}

if main "$@"; then
  exit_code=0
else
  exit_code=$?
fi
return "$exit_code" 2>/dev/null || exit "$exit_code"
