#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null
fi

DRY_RUN=0
FROM_NAME_VALUE="${FROM_NAME:-SMIRK}"

usage() {
  cat <<'EOF'
Usage:
  FROM_EMAIL=alerts@smirkcalls.com ./scripts/set-live-from-email.sh [--dry-run]
  FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' FROM_NAME='SMIRK' ./scripts/set-live-from-email.sh

Sets live Railway FROM_EMAIL (and FROM_NAME) after sender-domain verification, then re-checks Resend readiness.
Reads values from the current shell environment.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "FAIL unknown argument: $arg" >&2; exit 1 ;;
  esac
done

FROM_EMAIL_VALUE="${FROM_EMAIL:-}"
if [ -z "$FROM_EMAIL_VALUE" ]; then
  echo "FAIL missing FROM_EMAIL in shell environment" >&2
  exit 1
fi

if [[ "$FROM_EMAIL_VALUE" == *"yourdomain.com"* ]] || [[ "$FROM_EMAIL_VALUE" == *"example.com"* ]]; then
  echo "FAIL FROM_EMAIL still looks like a placeholder: $FROM_EMAIL_VALUE" >&2
  exit 1
fi

if ! printf '%s' "$FROM_EMAIL_VALUE" | grep -Eq '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$|^.+<[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+>$'; then
  echo "FAIL FROM_EMAIL must look like an email or display-name email: $FROM_EMAIL_VALUE" >&2
  exit 1
fi

cmd=(railway variable set
  "FROM_EMAIL=$FROM_EMAIL_VALUE"
  "FROM_NAME=$FROM_NAME_VALUE"
)

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

"${cmd[@]}"
npm run -s check:railway:resend-domain
