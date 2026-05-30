#!/usr/bin/env bash
set -euo pipefail

open_namecheap=0
open_wait=0
apply_cutover=0
apply_or_open=0
wait_timeout="${SMIRK_DOMAIN_CUTOVER_WAIT_TIMEOUT:-900}"
wait_interval="${SMIRK_DOMAIN_CUTOVER_WAIT_INTERVAL:-30}"

usage() {
  cat <<'EOF'
Usage: bash scripts/prepare-domain-cutover.sh [options]

Builds the SMIRK Namecheap DNS cutover packet, writes the operator files,
and refreshes the clipboard with the authoritative DNS checklist.

Options:
  --open             Open Namecheap Advanced DNS after preparing the packet
  --wait             Poll authoritative DNS, then run live landing readiness
  --apply            Apply DNS via Namecheap API, then wait for cutover.
                    Requires CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com
  --apply-or-open    Apply via API if credentials and confirmation exist, otherwise open Namecheap
  --wait-timeout N   Override wait timeout seconds (default: 900)
  --wait-interval N  Override wait interval seconds (default: 30)
  --help             Show this help

Common commands:
  npm run -s prepare:domain-cutover
  npm run -s prepare:domain-cutover:finish
  npm run -s prepare:domain-cutover:finish-wait
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --open) open_namecheap=1 ;;
    --wait) open_wait=1 ;;
    --apply) apply_cutover=1 ;;
    --apply-or-open) apply_or_open=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    --wait-timeout)
      shift
      wait_timeout="${1:?missing value for --wait-timeout}"
      ;;
    --wait-interval)
      shift
      wait_interval="${1:?missing value for --wait-interval}"
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

echo "Preparing SMIRK domain cutover packet..."
echo

npm run -s write:domain-cutover-json || true
echo
npm run -s write:domain-cutover-runbook || true
echo
npm run -s write:namecheap-api-request || true
echo
npm run -s copy:domain-cutover:authoritative || true

if [ "$open_namecheap" -eq 1 ]; then
  echo
  echo "Opening Namecheap Advanced DNS..."
  open "https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns" || true
fi

if [ "$apply_or_open" -eq 1 ]; then
  if npm run -s check:namecheap-api-env >/dev/null && [ "${CONFIRM_NAMECHEAP_DNS_CUTOVER:-}" = "smirkcalls.com" ]; then
    apply_cutover=1
  else
    echo
    echo "Namecheap API credentials or explicit confirmation are missing; opening Namecheap Advanced DNS for manual cutover instead."
    open "https://ap.www.namecheap.com/domains/domaincontrolpanel/smirkcalls.com/advancedns" || true
  fi
fi

if [ "$apply_cutover" -eq 1 ]; then
  echo
  echo "Applying Namecheap DNS cutover via API..."
  if [ "${CONFIRM_NAMECHEAP_DNS_CUTOVER:-}" != "smirkcalls.com" ]; then
    echo "Missing confirmation: set CONFIRM_NAMECHEAP_DNS_CUTOVER=smirkcalls.com after approval to apply DNS via API." >&2
    exit 1
  fi
  npm run -s apply:domain-cutover:live
  open_wait=1
fi

if [ "$open_wait" -eq 1 ]; then
  echo
  echo "Starting DNS cutover wait after packet preparation..."
  npm run -s wait:domain-cutover -- "$wait_timeout" "$wait_interval"
  exit $?
fi

cat <<'EOF'

Domain cutover packet ready:
- /Users/cameronchurch/.openclaw/workspace/output/smirk-domain-cutover.json
- /Users/cameronchurch/.openclaw/workspace/output/smirk-domain-cutover-click-path.md
- /Users/cameronchurch/.openclaw/workspace/output/namecheap-api-credential-request.md
- macOS clipboard refreshed with the authoritative Namecheap DNS checklist

Current action required:
Apply the Namecheap DNS records manually, or add NAMECHEAP_* credentials and automate the cutover.
EOF
