#!/usr/bin/env bash
# deploy.sh — build locally and push to Railway
# Usage: ./deploy.sh [optional commit message]
set -e

MSG="${1:-deploy: $(date '+%Y-%m-%d %H:%M')}"

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh
fi

FIRST_DOLLAR_ENV_FILE="${FIRST_DOLLAR_ENV_FILE:-$HOME/.openclaw/workspace/.env.smirk}"
if [ ! -f "$FIRST_DOLLAR_ENV_FILE" ]; then
  FIRST_DOLLAR_ENV_FILE="$HOME/.openclaw/workspace/.env"
fi

echo "=== Verifying Railway access ==="
npm run check:railway

echo "=== Checking local first-dollar env file (advisory only) ==="
if [ -f "$FIRST_DOLLAR_ENV_FILE" ]; then
  if ENV_FILE="$FIRST_DOLLAR_ENV_FILE" node ./scripts/check-first-dollar-env.mjs; then
    echo "Local env file looks first-dollar ready."
  else
    echo "WARN local env file is incomplete; continuing because live Railway env is the deploy gate."
  fi
else
  echo "WARN no local first-dollar env file found at $FIRST_DOLLAR_ENV_FILE; continuing because live Railway env is the deploy gate."
fi

echo "=== Running unified launch-blocker audit ==="
npm run check:launch-blockers

echo "=== Verifying Railway healthcheck config matches a live route ==="
npm run check:railway:healthcheck

echo "=== Checking Railway DB wiring before build/upload ==="
npm run check:railway-db-wiring

echo "=== Building frontend + server bundle ==="
npm run build

echo ""
echo "=== Committing source changes ==="
git add -A
git diff --cached --quiet || git commit -m "$MSG"
git push origin main

echo ""
echo "=== Uploading built bundle to Railway ==="
railway up --detach

echo ""
echo "=== Deploy triggered. Monitor at: ==="
echo "https://railway.com/project/90599f03-6d6f-4044-8933-e0301be67a82/service/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2"
echo ""
echo "Post-deploy verification (run after ~2 min):"
echo "npm run check:post-deploy-live"
echo ""
echo "If check:live-db-health fails with db-unreachable, follow RAILWAY_DB_WIRING_FIX.md before treating the deploy as live-ready."
