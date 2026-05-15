#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null
fi

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage:
  ./scripts/set-landing-app-url.sh [--dry-run]
  LANDING_APP_URL='https://smirkcalls.com' ./scripts/set-landing-app-url.sh [--dry-run]

Sets the live Railway LANDING_APP_URL and re-checks the full launch-blocker audit.
If LANDING_APP_URL is not already exported, the script will load it from common operator env files.
Use this when the only remaining blocker is a placeholder landing URL.
EOF
      exit 0
      ;;
    *)
      echo "FAIL unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

ENV_FILES=(
  ./.env.local
  "$HOME/.openclaw/workspace/.env.smirk"
  "$HOME/.openclaw/workspace/.env.operator"
  "$HOME/OpenClaw/.env.smirk"
  "$HOME/OpenClaw/.env.operator"
)

read_env_value() {
  local key="$1"
  local env_file raw
  for env_file in "${ENV_FILES[@]}"; do
    [ -f "$env_file" ] || continue
    raw="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    [ -n "$raw" ] || continue
    raw="${raw#*=}"
    raw="${raw%\"}"
    raw="${raw#\"}"
    raw="${raw%\'}"
    raw="${raw#\'}"
    if [ -n "$raw" ]; then
      printf '%s' "$raw"
      return 0
    fi
  done
  return 1
}

LANDING_APP_URL="${LANDING_APP_URL:-}"
if [ -z "$LANDING_APP_URL" ]; then
  LANDING_APP_URL="$(read_env_value LANDING_APP_URL || true)"
fi
if [ -z "$LANDING_APP_URL" ]; then
  echo "FAIL missing LANDING_APP_URL in shell environment and known operator env files" >&2
  exit 1
fi
if [[ "$LANDING_APP_URL" =~ manus\.space ]]; then
  echo "FAIL LANDING_APP_URL must point at the production marketing domain, not manus.space: $LANDING_APP_URL" >&2
  exit 1
fi
if [[ ! "$LANDING_APP_URL" =~ ^https://smirkcalls\.com/?$ ]]; then
  echo "FAIL LANDING_APP_URL must be exactly https://smirkcalls.com: $LANDING_APP_URL" >&2
  exit 1
fi

cmd=(railway variable set "LANDING_APP_URL=$LANDING_APP_URL")

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

"${cmd[@]}"
npm run -s check:launch-blockers
