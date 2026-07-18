#!/usr/bin/env bash
# deploy.sh — build and upload one reviewed local commit to Railway
# Usage: ./deploy.sh [optional commit message]
set -e

TARGET_BRANCH="$(git branch --show-current)"
TARGET_COMMIT="$(git rev-parse HEAD)"

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh
fi

FIRST_DOLLAR_ENV_FILE="${FIRST_DOLLAR_ENV_FILE:-$HOME/.openclaw/workspace/.env.smirk}"
if [ ! -f "$FIRST_DOLLAR_ENV_FILE" ]; then
  FIRST_DOLLAR_ENV_FILE="$HOME/.openclaw/workspace/.env"
fi

echo "=== Deploy target ==="
echo "Branch: $TARGET_BRANCH"
echo "Commit: $TARGET_COMMIT"

if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  echo "FAIL deploy requires a clean, reviewed exact commit." >&2
  echo "Commit the intended changes and regenerate the deploy approval bundle before requesting approval." >&2
  exit 1
fi

echo "=== Verifying deploy approval confirmation ==="
npm run confirm:post-call-fix-deploy

echo "=== Verifying pending first-dollar environment activation authority ==="
echo "If a pending manifest is staged, this recomputes it from the exact pinned Railway target and requires the same digest, exact commit, real Starter checkout authority, distinct activation-deploy authority, and existing deploy authority."
npm run -s check:first-dollar-pending-env-activation

echo "=== Verifying git remote sync before any deploy work ==="
git fetch origin main
git fetch origin "$TARGET_BRANCH" || true
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
BASE_HEAD="$(git merge-base HEAD origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  if [ "$BASE_HEAD" != "$REMOTE_HEAD" ]; then
    echo "FAIL local branch is not a fast-forward of origin/main." >&2
    echo "Local:  $LOCAL_HEAD" >&2
    echo "Remote: $REMOTE_HEAD" >&2
    echo "Run: git pull --rebase origin main  # or otherwise reconcile remote changes before deploy" >&2
    exit 1
  fi
fi
if git rev-parse --verify "origin/$TARGET_BRANCH" >/dev/null 2>&1; then
  REMOTE_TARGET_HEAD="$(git rev-parse "origin/$TARGET_BRANCH")"
  TARGET_BASE_HEAD="$(git merge-base HEAD "origin/$TARGET_BRANCH")"
  if [ "$TARGET_BASE_HEAD" != "$REMOTE_TARGET_HEAD" ]; then
    echo "FAIL local branch is not a fast-forward of origin/$TARGET_BRANCH." >&2
    echo "Local:  $LOCAL_HEAD" >&2
    echo "Remote: $REMOTE_TARGET_HEAD" >&2
    echo "Run: git pull --rebase origin $TARGET_BRANCH  # or otherwise reconcile remote branch changes before deploy" >&2
    exit 1
  fi
fi

echo "=== Verifying the saved approval packet still matches this exact commit ==="
npm run check:deploy-approval-handoff

echo "=== Verifying deploy preflight ==="
DEPLOY_PREFLIGHT_JSON="$(npm run -s check:deploy-post-call-fix-ready)" || {
  printf '%s\n' "$DEPLOY_PREFLIGHT_JSON"
  exit 1
}
printf '%s\n' "$DEPLOY_PREFLIGHT_JSON"

if [ -n "${SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY:-}" ]; then
  echo "=== Verifying narrow incomplete-first-dollar-env bootstrap authority ==="
  printf '%s' "$DEPLOY_PREFLIGHT_JSON" | node scripts/check-first-dollar-bootstrap-deploy.mjs
  echo "Bootstrap mode is armed only for the pre-upload live-env gate and deploy fingerprint stamp."
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

echo "=== Running pre-deploy launch-blocker audit ==="
echo "Live proof checks require the new Railway fingerprint, so this pre-upload check:launch-blockers run skips live-current proof inspection only after the guarded preflight proves stale production."
echo "Incomplete first-dollar env can be bypassed here only by the separately named exact-commit bootstrap mode; post-deploy checks remain strict."
SMIRK_PRE_DEPLOY_LAUNCH_AUDIT=1 npm run check:launch-blockers

echo "=== Verifying Railway healthcheck config matches a live route ==="
npm run check:railway:healthcheck

echo "=== Checking Railway DB wiring before build/upload ==="
npm run check:railway-db-wiring

echo "=== Building frontend + server bundle ==="
npm run build

if [ "$(git rev-parse HEAD)" != "$TARGET_COMMIT" ] || [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  echo "FAIL source commit or worktree changed after approval verification." >&2
  exit 1
fi

DEPLOY_BRANCH="$(git branch --show-current)"
DEPLOY_COMMIT="$(git rev-parse HEAD)"

echo ""
echo "=== Stamping Railway deploy fingerprint before final upload ==="
echo "Branch: $DEPLOY_BRANCH"
echo "Commit: $DEPLOY_COMMIT"
npm run stamp:deploy-fingerprint

echo ""
echo "=== Preparing reviewed exact-commit source archive ==="
DEPLOY_ARCHIVE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smirk-railway-deploy.XXXXXX")"
cleanup_deploy_archive() {
  case "$DEPLOY_ARCHIVE_DIR" in
    "${TMPDIR:-/tmp}"/smirk-railway-deploy.*) rm -rf -- "$DEPLOY_ARCHIVE_DIR" ;;
    *) echo "WARN refusing to clean unexpected deploy archive path: $DEPLOY_ARCHIVE_DIR" >&2 ;;
  esac
}
trap cleanup_deploy_archive EXIT
node ./scripts/prepare-exact-deploy-archive.mjs --commit "$TARGET_COMMIT" --output "$DEPLOY_ARCHIVE_DIR"

echo "=== Uploading reviewed exact commit to Railway ==="
npm run -s check:deploy-live-baseline
npm run -s check:deploy-archive-safety
echo "=== Capturing exact-target deployment baseline for any pending first-dollar activation ==="
PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$(npm run -s capture:first-dollar-pending-env-deployment-baseline)"
printf '%s\n' "$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON"
PENDING_ACTIVATION_UPLOAD_MESSAGE="$(node -e '
  const baseline = JSON.parse(process.argv[1]);
  if (baseline.pending === true && !/^smirk-first-dollar-activation:[a-f0-9]{40}:[a-f0-9]{64}:[a-f0-9]{24}$/.test(String(baseline.uploadMessage || ""))) {
    throw new Error("pending activation upload message is missing or invalid");
  }
  process.stdout.write(baseline.pending === true ? String(baseline.uploadMessage) : "");
' "$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON")"
if [ -z "$PENDING_ACTIVATION_UPLOAD_MESSAGE" ]; then
  PENDING_ACTIVATION_UPLOAD_MESSAGE="smirk-reviewed-deploy:$TARGET_COMMIT"
fi
if [ "$(git rev-parse HEAD)" != "$TARGET_COMMIT" ] || [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  echo "FAIL source commit or worktree changed before Railway upload." >&2
  exit 1
fi
railway up --detach --no-gitignore \
  --message "$PENDING_ACTIVATION_UPLOAD_MESSAGE" \
  --project 90599f03-6d6f-4044-8933-e0301be67a82 \
  --service 96bcd6e7-9487-4197-bcd1-a6bd0546e6b2 \
  --environment 22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a \
  "$DEPLOY_ARCHIVE_DIR"

echo ""
echo "=== Deploy triggered. Monitor at: ==="
echo "https://railway.com/project/90599f03-6d6f-4044-8933-e0301be67a82/service/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2"
echo ""
echo "=== Waiting for a new exact-target deployment when pending values are being activated ==="
SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON" npm run -s wait:first-dollar-pending-env-deployment

echo "=== Waiting for live app to match local HEAD ==="
if npm run wait:live-is-current; then
  echo "=== Live app now matches local HEAD ==="
else
  echo "WARN live app did not reach local HEAD before timeout; production is still stale."
  exit 1
fi

echo "=== Running full post-deploy ship check ==="
env -u SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY -u SMIRK_PRE_DEPLOY_LAUNCH_AUDIT npm run check:ship-live

echo "=== Recording the exact activated first-dollar manifest digest ==="
SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON="$PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON" npm run -s record:first-dollar-activation-receipt
echo "The activation receipt uses --skip-deploys and preserves the pending manifest as durable evidence."

echo ""
echo "If check:live-db-health fails with db-unreachable, follow RAILWAY_DB_WIRING_FIX.md before treating the deploy as live-ready."
