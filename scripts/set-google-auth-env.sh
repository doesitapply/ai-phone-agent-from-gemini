#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null
fi

DRY_RUN=0
POSITIONAL_CLIENT_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage:
  GOOGLE_OAUTH_CLIENT_ID='...' ./scripts/set-google-auth-env.sh [--dry-run]
  ./scripts/set-google-auth-env.sh your-client-id.apps.googleusercontent.com [--dry-run]
  GOOGLE_OAUTH_CLIENT_ID='...' GOOGLE_ADMIN_EMAILS='owner@example.com,ops@example.com' ./scripts/set-google-auth-env.sh [--dry-run]

Sets live Railway Google auth env so workspace users can sign in without a workspace API key.
Before creating a new Google client, try:
  npm run find:google-auth-client-id
  npm run fix:google-auth-live:from-scan -- --dry-run
  npm run print:google-auth-setup
GOOGLE_ADMIN_EMAILS is optional, but enables admin/operator Google sign-in when DASHBOARD_API_KEY is already set.
EOF
      exit 0
      ;;
    *)
      if [ -z "$POSITIONAL_CLIENT_ID" ]; then
        POSITIONAL_CLIENT_ID="$1"
      else
        echo "FAIL unknown argument: $1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -n "$POSITIONAL_CLIENT_ID" ] && [ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ]; then
  GOOGLE_OAUTH_CLIENT_ID="$POSITIONAL_CLIENT_ID"
fi

require_nonempty() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "FAIL missing $key in shell environment" >&2
    if [ "$key" = "GOOGLE_OAUTH_CLIENT_ID" ]; then
      echo "Local scan: npm run find:google-auth-client-id" >&2
      echo "Auto dry run: npm run fix:google-auth-live:from-scan -- --dry-run" >&2
      echo "Setup checklist: npm run print:google-auth-setup" >&2
    fi
    exit 1
  fi
}

require_nonempty GOOGLE_OAUTH_CLIENT_ID

if [[ "${GOOGLE_OAUTH_CLIENT_ID}" == *,* ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must be one browser client ID for the live frontend button, not a CSV list" >&2
  echo "Local scan: npm run find:google-auth-client-id" >&2
  echo "Auto dry run: npm run fix:google-auth-live:from-scan -- --dry-run" >&2
  echo "Setup checklist: npm run print:google-auth-setup" >&2
  exit 1
fi
if [[ ! "${GOOGLE_OAUTH_CLIENT_ID}" =~ \.apps\.googleusercontent\.com$ ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must look like a Google web client id ending in .apps.googleusercontent.com" >&2
  echo "Local scan: npm run find:google-auth-client-id" >&2
  echo "Auto dry run: npm run fix:google-auth-live:from-scan -- --dry-run" >&2
  echo "Setup checklist: npm run print:google-auth-setup" >&2
  exit 1
fi

if [ -n "${GOOGLE_ADMIN_EMAILS:-}" ]; then
  if printf '%s' "$GOOGLE_ADMIN_EMAILS" | tr ',' '\n' | sed '/^\s*$/d' | grep -Ev '^[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+$' >/dev/null; then
    echo "FAIL GOOGLE_ADMIN_EMAILS must be a comma-separated list of email addresses" >&2
    exit 1
  fi
fi

if [ -z "${RAILWAY_API_TOKEN:-}" ] && [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "FAIL Railway auth missing." >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "If you already saved a token, run: npm run -s load:railway-auth" >&2
  exit 1
fi

cmd=(railway variable set "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID")
if [ -n "${GOOGLE_ADMIN_EMAILS:-}" ]; then
  cmd+=("GOOGLE_ADMIN_EMAILS=$GOOGLE_ADMIN_EMAILS")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  printf '%q ' "${cmd[@]}"
  printf '\n'
  echo 'Next checks:'
  echo '  npm run check:google-auth-live'
  echo '  npm run check:launch-blockers'
  echo '  npm run check:post-deploy-live'
  exit 0
fi

"${cmd[@]}"
npm run -s check:google-auth-live
npm run -s check:launch-blockers
npm run -s check:post-deploy-live
