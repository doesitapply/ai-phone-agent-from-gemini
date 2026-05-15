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
  GOOGLE_OAUTH_CLIENT_ID='...' ./scripts/set-google-auth-env.sh [--dry-run]
  GOOGLE_OAUTH_CLIENT_ID='...' GOOGLE_ADMIN_EMAILS='owner@example.com,ops@example.com' ./scripts/set-google-auth-env.sh [--dry-run]

Sets live Railway Google auth env so workspace users can sign in without a workspace API key.
GOOGLE_ADMIN_EMAILS is optional, but enables admin/operator Google sign-in when DASHBOARD_API_KEY is already set.
EOF
      exit 0
      ;;
    *)
      echo "FAIL unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

require_nonempty() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "FAIL missing $key in shell environment" >&2
    exit 1
  fi
}

require_nonempty GOOGLE_OAUTH_CLIENT_ID

if [[ "${GOOGLE_OAUTH_CLIENT_ID}" == *,* ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must be one browser client ID for the live frontend button, not a CSV list" >&2
  exit 1
fi
if [[ ! "${GOOGLE_OAUTH_CLIENT_ID}" =~ \.apps\.googleusercontent\.com$ ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must look like a Google web client id ending in .apps.googleusercontent.com" >&2
  exit 1
fi

if [ -n "${GOOGLE_ADMIN_EMAILS:-}" ]; then
  if printf '%s' "$GOOGLE_ADMIN_EMAILS" | tr ',' '\n' | sed '/^\s*$/d' | grep -Ev '^[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+$' >/dev/null; then
    echo "FAIL GOOGLE_ADMIN_EMAILS must be a comma-separated list of email addresses" >&2
    exit 1
  fi
fi

cmd=(railway variable set "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID")
if [ -n "${GOOGLE_ADMIN_EMAILS:-}" ]; then
  cmd+=("GOOGLE_ADMIN_EMAILS=$GOOGLE_ADMIN_EMAILS")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

"${cmd[@]}"
npm run -s check:google-auth-live
npm run -s check:post-deploy-live
