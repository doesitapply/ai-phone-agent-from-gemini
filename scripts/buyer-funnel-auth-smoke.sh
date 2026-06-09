#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-https://ai-phone-agent-production-6811.up.railway.app}"
APP_URL="${APP_URL%/}"
REQUIRED_WRITE_CONFIRMATION="create-live-smirk-buyer-auth-smoke"

if [[ "${CONFIRM_SMIRK_BUYER_AUTH_LIVE_WRITE:-}" != "$REQUIRED_WRITE_CONFIRMATION" ]]; then
  cat >&2 <<EOF
{
  "ok": false,
  "error": "missing-live-write-confirmation",
  "message": "This smoke creates a live SMIRK Smoke Test provisioning request to prove the buyer funnel reaches a tracked manual fallback without browser auth.",
  "requiredEnv": "CONFIRM_SMIRK_BUYER_AUTH_LIVE_WRITE",
  "requiredValue": "$REQUIRED_WRITE_CONFIRMATION",
  "nextAction": "Run only after explicit approval: CONFIRM_SMIRK_BUYER_AUTH_LIVE_WRITE=$REQUIRED_WRITE_CONFIRMATION npm run smoke:buyer-auth",
  "cleanupDryRunCommand": "npm run cleanup:smoke-workspaces",
  "cleanupApplyCommand": "CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply"
}
EOF
  exit 1
fi

tmp_headers="$(mktemp)"
tmp_body="$(mktemp)"
cleanup() {
  rm -f "$tmp_headers" "$tmp_body"
}
trap cleanup EXIT

request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  : >"$tmp_headers"
  : >"$tmp_body"

  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "$APP_URL$path" \
      -H "content-type: application/json" \
      -D "$tmp_headers" \
      -o "$tmp_body" \
      --data "$data"
  else
    curl -sS -X "$method" "$APP_URL$path" \
      -D "$tmp_headers" \
      -o "$tmp_body"
  fi
}

assert_public() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  request "$method" "$path" "$data"

  local status
  status="$(awk 'NR==1 {print $2}' "$tmp_headers")"
  if [[ "$status" == "401" ]] || rg -qi '^www-authenticate:' "$tmp_headers"; then
    echo "[smoke:buyer-auth] $method $path is still protected by browser/basic auth" >&2
    sed -n '1,20p' "$tmp_headers" >&2
    exit 1
  fi
  if [[ "$status" == "404" ]]; then
    echo "[smoke:buyer-auth] $method $path is missing on $APP_URL" >&2
    sed -n '1,20p' "$tmp_headers" >&2
    sed -n '1,20p' "$tmp_body" >&2
    exit 1
  fi

  echo "[smoke:buyer-auth] ok $method $path -> HTTP $status"
}

current_status() {
  awk 'NR==1 {print $2}' "$tmp_headers"
}

is_rate_limited() {
  [[ "$(current_status)" == "429" ]] && rg -qi "too many demo requests|too many requests|try again later" "$tmp_body"
}

assert_public GET "/pricing"
assert_public POST "/api/provisioning/request" '{"business_name":"SMIRK Smoke Test","owner_email":"smoke+buyer@example.com","phone":"+15555550123","plan":"starter","source":"buyer-auth-smoke"}'
if is_rate_limited; then
  echo "[smoke:buyer-auth] rate-limited POST /api/provisioning/request still reachable without browser/basic auth"
else
  node - "$tmp_body" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const body = JSON.parse(fs.readFileSync(file, "utf8"));
if (body.workspace || body.status === "workspace_created" || body.status === "workspace_and_line_created") {
  console.error("[smoke:buyer-auth] smoke provisioning created a real workspace");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}
if (body.status !== "manual_fallback_required") {
  console.error("[smoke:buyer-auth] expected capture-only manual_fallback_required status");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}
NODE
fi
assert_public POST "/api/provisioning/checkout-status" '{"email":"smoke+buyer@example.com"}'
if is_rate_limited; then
  echo "[smoke:buyer-auth] rate-limited POST /api/provisioning/checkout-status still reachable without browser/basic auth"
fi
assert_public GET "/api/system-health/public"
node - "$tmp_body" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const body = JSON.parse(fs.readFileSync(file, "utf8"));
const allowed = new Set(["status", "timestamp", "service"]);
const forbidden = [
  "appUrl",
  "version",
  "branch",
  "uptime",
  "db",
  "twilioConfigured",
  "aiConfigured",
  "paymentLinksConfigured",
  "ownerEmailDeliveryConfigured",
  "ownerEmailSenderDomain",
  "ownerEmailNextAction",
];
const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
const leaked = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
if (unexpected.length || leaked.length) {
  console.error("[smoke:buyer-auth] public system health exposes operational fields");
  console.error(JSON.stringify({ unexpected, leaked, body }, null, 2));
  process.exit(1);
}
NODE

echo "[smoke:buyer-auth] buyer-facing public auth smoke passed for $APP_URL"
