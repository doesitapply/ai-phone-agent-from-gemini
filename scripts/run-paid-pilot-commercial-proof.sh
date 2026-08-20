#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_HOST="127.0.0.1"
DB_PORT="5432"
DB_USER="${USER:-postgres}"
DB_SUFFIX="$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}"
DB_NAME="smirk_revenue_proof_test_${DB_SUFFIX}"
DB_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
OUT_DIR="artifacts/revenue/2026-07-31/raw"
mkdir -p "$OUT_DIR"

cleanup_database() {
  dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --if-exists --force "$DB_NAME"
}
trap 'cleanup_database >/dev/null 2>&1 || printf "Paid-pilot database cleanup failed for %s.\n" "$DB_NAME" >&2' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'SMIRK paid-pilot commercial proof\n'
printf 'Synthetic inputs only; no real charge, call, or external message.\n'
printf 'Started: '
date -u +%Y-%m-%dT%H:%M:%SZ

createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
npm run -s build:server
PORT=3320 SMIRK_PAID_PILOT_TEST_DATABASE_URL="$DB_URL" node scripts/check-paid-pilot-proof-local.mjs | tee "$OUT_DIR/paid-pilot-local-proof.json"
npm run -s check:self-serve-activation
npm run -s check:checkout-fulfillment-fixtures
npm run -s check:post-call-durability
node scripts/check-proof-owner-action-contract.mjs
npm run -s check:manual-setup-fallback

cleanup_database
trap - EXIT INT TERM
if [[ "$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -Atc "SELECT COUNT(*) FROM pg_database WHERE datname = '$DB_NAME'")" != "0" ]]; then
  printf 'Disposable paid-pilot database cleanup was not verified.\n' >&2
  exit 1
fi

printf 'Completed: '
date -u +%Y-%m-%dT%H:%M:%SZ
