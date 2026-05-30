#!/usr/bin/env bash
set -euo pipefail

timeout_seconds="${1:-900}"
interval_seconds="${2:-30}"
deadline=$((SECONDS + timeout_seconds))
domain_check_script="${SMIRK_DOMAIN_CUTOVER_CHECK:-check:domain-cutover:authoritative}"

echo "Waiting for SMIRK landing DNS cutover for up to ${timeout_seconds}s..."
echo "Polling every ${interval_seconds}s with: npm run -s ${domain_check_script}"
echo

while true; do
  if npm run -s "$domain_check_script"; then
    echo
    echo "OK SMIRK landing DNS cutover is live."
    echo "Verifying public landing readiness..."
    npm run -s check:landing-live
    exit $?
  fi

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo
    echo "Timed out waiting for SMIRK landing DNS cutover."
    if [ "$domain_check_script" = "check:domain-cutover:authoritative" ]; then
      echo "Refreshing clipboard with the authoritative Namecheap DNS checklist..."
      npm run -s copy:domain-cutover:authoritative || true
    fi
    echo "Current action required: finish the Namecheap DNS changes, then rerun npm run -s wait:domain-cutover."
    exit 1
  fi

  remaining=$((deadline - SECONDS))
  echo
  echo "DNS not cut over yet. Rechecking in ${interval_seconds}s (${remaining}s remaining)..."
  sleep "$interval_seconds"
done
