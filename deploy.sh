#!/usr/bin/env bash
# deploy.sh — build locally and push to Railway
# Usage: ./deploy.sh [optional commit message]
set -e

MSG="${1:-deploy: $(date '+%Y-%m-%d %H:%M')}"

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
echo "Health check (run after ~2 min):"
echo "curl https://ai-phone-agent-production-6811.up.railway.app/health"
