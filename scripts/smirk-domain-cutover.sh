#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null || true
fi

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/smirk-domain-cutover.sh [--dry-run]

Purpose:
  One-command operator checklist for the live smirkcalls.com sender-domain cutover.

What it does:
  1. Re-runs the live Railway/Resend sender-domain check.
  2. If still blocked, prints the exact Namecheap DNS URL, Resend URL, and runbook path.
  3. Shows the exact FROM_EMAIL command to run after verification.
EOF
      exit 0
      ;;
    *)
      echo "FAIL unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

RUNBOOK="$HOME/.openclaw/workspace/output/smirk-domain-cutover-click-path.md"
NAMECHEAP_URL="https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns"
RESEND_URL="https://resend.com/domains"
SETTER_CMD="FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' npm run set:live-from-email"
DKIM_HOST="resend._domainkey"
DKIM_VALUE="p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0edc1B1uu/AYprgFJ/7/aTkb5yd5fUvz0sLNnBR7Gf+BKQjZH1yg81+u2iUx5a4LXLozYbdg2lVhaZMj5xxysAU6KiouZnNhWIAElPxQfmwIutQ5fB/pSBfRRU6Ej+VM0Ye/+GVqffn3iqifVPIlbN/Ulfhv8VVymhZt6EszPMQIDAQAB"
MX_HOST="send"
MX_VALUE="feedback-smtp.us-east-1.amazonses.com"
MX_PRIORITY="10"
SPF_HOST="send"
SPF_VALUE="v=spf1 include:amazonses.com ~all"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN sender-domain cutover helper"
  echo "1) Run: npm run -s check:railway:resend-domain"
  echo "2) If blocked, open Namecheap DNS: $NAMECHEAP_URL"
  echo "   - TXT $DKIM_HOST = $DKIM_VALUE"
  echo "   - MX  $MX_HOST = $MX_VALUE (priority $MX_PRIORITY)"
  echo "   - TXT $SPF_HOST = $SPF_VALUE"
  echo "3) Then open Resend domains: $RESEND_URL"
  echo "4) Then run: $SETTER_CMD"
  echo "5) Run: npm run check:launch-blockers"
  echo "Runbook: $RUNBOOK"
  exit 0
fi

CHECK_EXIT=0
if ! npm run -s check:railway:resend-domain; then
  CHECK_EXIT=$?
fi

echo
printf 'Namecheap DNS: %s\n' "$NAMECHEAP_URL"
printf 'Add TXT %s = %s\n' "$DKIM_HOST" "$DKIM_VALUE"
printf 'Add MX  %s = %s (priority %s)\n' "$MX_HOST" "$MX_VALUE" "$MX_PRIORITY"
printf 'Add TXT %s = %s\n' "$SPF_HOST" "$SPF_VALUE"
printf 'Resend domains: %s\n' "$RESEND_URL"
printf 'Runbook: %s\n' "$RUNBOOK"
printf 'After verification run: %s\n' "$SETTER_CMD"
printf 'Then run: npm run check:launch-blockers\n'

exit "$CHECK_EXIT"
