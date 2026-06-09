#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
DEPLOY_BRANCH="$(git branch --show-current 2>/dev/null || true)"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
if [ "$DEPLOY_BRANCH" = "main" ]; then
  DEPLOY_COMMAND="CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix"
else
  DEPLOY_COMMAND="CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=$DEPLOY_BRANCH npm run deploy:post-call-fix"
fi

TMP_INPUT="$(mktemp)"
trap 'rm -f "$TMP_INPUT"' EXIT
cat > "$TMP_INPUT"

TARGET_FILE="${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}" \
KEY_NAME="${KEY_NAME:-RAILWAY_API_TOKEN}" \
SKIP_CHECK="${SKIP_CHECK:-0}" \
bash "$SCRIPT_DIR/bootstrap-railway-auth.sh" < "$TMP_INPUT"

if [ "${SKIP_CHECK:-0}" = "1" ] || [ "$SKIP_DEPLOY" = "1" ]; then
  echo "Deploy skipped"
  echo "Next: npm run -s check:railway"
  echo "Then: npm run -s check:deploy-post-call-fix-ready"
  echo "Then: npm run write:deploy-approval-bundle"
  echo "Then: $DEPLOY_COMMAND"
  exit 0
fi

echo "Running: npm run write:deploy-approval-bundle"
npm run write:deploy-approval-bundle

if [ "${CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY:-}" != "deploy-post-call-fix" ]; then
  echo "Deploy confirmation missing; not deploying automatically."
  echo "After explicit approval, run: $DEPLOY_COMMAND"
  exit 0
fi

echo "Running: npm run deploy:post-call-fix"
npm run deploy:post-call-fix
