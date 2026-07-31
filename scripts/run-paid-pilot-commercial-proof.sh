#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_NAME="smirk_revenue_proof_20260731"
DB_URL="postgresql://cameronchurch@localhost/${DB_NAME}"
OUT_DIR="artifacts/revenue/2026-07-31/raw"
mkdir -p "$OUT_DIR"

printf 'SMIRK paid-pilot commercial proof\n'
printf 'Synthetic inputs only; no real charge, call, or external message.\n'
printf 'Started: '
date -u +%Y-%m-%dT%H:%M:%SZ

dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"
npm run -s build:server
PORT=3320 DATABASE_URL="$DB_URL" node scripts/check-paid-pilot-proof-local.mjs | tee "$OUT_DIR/paid-pilot-local-proof.json"
npm run -s check:self-serve-activation
npm run -s check:checkout-fulfillment-fixtures
npm run -s check:post-call-durability
node scripts/check-proof-owner-action-contract.mjs
npm run -s check:manual-setup-fallback

printf 'Completed: '
date -u +%Y-%m-%dT%H:%M:%SZ
