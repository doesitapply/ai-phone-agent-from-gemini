#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null || true
fi

ENV_FILES=(
  ./.env.local
  "$HOME/.openclaw/workspace/.env.smirk"
  "$HOME/.openclaw/workspace/.env.operator"
  "$HOME/OpenClaw/.env.smirk"
  "$HOME/OpenClaw/.env.operator"
  ../../.env
  ../../.env.local
)

read_env_value() {
  local key="$1"
  local env_file raw
  for env_file in "${ENV_FILES[@]}"; do
    [ -f "$env_file" ] || continue
    raw="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    [ -n "$raw" ] || continue
    raw="${raw#*=}"
    raw="${raw%\"}"
    raw="${raw#\"}"
    raw="${raw%\'}"
    raw="${raw#\'}"
    if [ -n "$raw" ]; then
      printf '%s' "$raw"
      return 0
    fi
  done
  return 1
}

echo "SMIRK launch blocker audit"
echo

echo "[0/30] Auth regression + operational API protection"
if ! npm run -s check:auth; then
  echo
  echo "Current action required: fix exposed operational routes or auth regressions before treating SMIRK as shippable."
  exit 1
fi

echo

echo "[1/30] No-texting copy guard"
if ! npm run -s check:no-texting-copy; then
  echo
  echo "Current action required: remove customer-texting, dispatcher, or appointment-booking promises from public copy and prompts."
  exit 1
fi

echo

echo "[1b/30] First-dollar offer scope guard"
if ! npm run -s check:first-dollar-offer-scope; then
  echo
  echo "Current action required: keep default prompts and onboarding scoped to missed-call recovery, owner email alerts, callback tasks, and proof dashboard."
  exit 1
fi

echo

stripe_links_ready=0
for key in STRIPE_PAYMENT_LINK_STARTER STRIPE_PAYMENT_LINK_PRO STRIPE_PAYMENT_LINK_ENTERPRISE; do
  value="${!key:-}"
  if [ -z "$value" ]; then
    value="$(read_env_value "$key" || true)"
  fi
  if [ -n "$value" ] && [[ "$value" != "https://buy.stripe.com/..." ]]; then
    stripe_links_ready=$((stripe_links_ready + 1))
  fi
done
predeploy_stale_expected=0
deploy_preflight_json="$(npm run -s check:deploy-post-call-fix-ready 2>/dev/null || true)"
if printf '%s' "$deploy_preflight_json" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
try {
  const data = JSON.parse(raw);
  process.exit(data.ok === true && data.blocker === "stale-production-deploy" && (data.localDeployClean === true || process.env.SMIRK_PRE_DEPLOY_LAUNCH_AUDIT === "1") ? 0 : 1);
} catch {
  process.exit(1);
}
'; then
  predeploy_stale_expected=1
fi

echo "[2/30] First-dollar guard coverage"
if ! npm run -s check:first-dollar-guard-coverage; then
  echo
  echo "Current action required: keep the no-texting guard wired into deploy, launch, and post-deploy verification paths."
  exit 1
fi

echo

echo "[3/30] OpenAPI route inventory"
if ! npm run -s check:openapi; then
  echo
  echo "Current action required: regenerate openapi.yaml so route exposure and auth inventory match the Express route declarations."
  exit 1
fi

echo

echo "[4/30] Real proof-call docs"
if ! npm run -s check:real-call-docs; then
  echo
  echo "Current action required: keep real proof-call docs on guarded readiness, explicit target, and proof runner path."
  exit 1
fi

echo

echo "[5/30] Real proof-call target safety"
if ! npm run -s check:real-call-target-safety; then
  echo
  echo "Current action required: keep real proof-call target selection explicit, masked, and blocked by pending local deploy work."
  exit 1
fi

echo

echo "[6/30] Test-call allowlist safety"
if ! npm run -s check:test-call-allowlist-safety; then
  echo
  echo "Current action required: keep proof-call allowlist mutation explicitly confirmed and output masked."
  exit 1
fi

echo

echo "[7/30] Deploy approval handoff safety"
if ! npm run -s check:deploy-approval-handoff; then
  echo
  echo "Current action required: regenerate and repair the deploy approval bundle so it covers every non-generated deploy-relevant local file."
  exit 1
fi

echo

echo "[8/30] Paid handoff live-write safety"
if ! npm run -s check:paid-handoff-safety; then
  echo
  echo "Current action required: keep the live paid-handoff proof behind explicit write confirmation and cleanup guidance."
  exit 1
fi

echo

echo "[9/30] Stripe attach readiness"
if [ "$stripe_links_ready" -eq 3 ]; then
  echo "OK Stripe payment links already configured in local env; exact live plink_ product bindings are checked at the Railway env gate"
else
  if ! npm run -s check:stripe-attach; then
    echo
    echo "Current action required: open the logged-in Stripe session in attachable Chrome, approve any attach prompt, then rerun this audit."
    exit 1
  fi
fi

echo

echo "[10/30] Stripe webhook handoff preflight"
stripe_webhook_preflight_output="$(npm run -s check:stripe-webhook-handoff-live:preflight 2>&1)" || {
  printf '%s\n' "$stripe_webhook_preflight_output"
  if [ "$predeploy_stale_expected" -eq 1 ] && printf '%s' "$stripe_webhook_preflight_output" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
try {
  const data = JSON.parse(raw);
  process.exit(data.preflight === true && data.railwayEnvRetryableError === true ? 0 : 1);
} catch {
  process.exit(1);
}
'; then
    echo "WARN Stripe webhook preflight hit a retryable Railway env read error during pre-deploy audit; continuing because the guarded deploy preflight already passed and post-deploy checks remain strict."
    stripe_webhook_preflight_output=""
  else
    echo
    echo "Current action required: configure STRIPE_WEBHOOK_SECRET and keep production webhook smoke approval-gated before treating paid signup fulfillment as shippable."
    exit 1
  fi
}
if [ -n "${stripe_webhook_preflight_output:-}" ]; then
  printf '%s\n' "$stripe_webhook_preflight_output"
fi

echo

echo "[11/30] Stripe webhook smoke approval readiness"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP Stripe smoke approval readiness until the guarded deploy makes live current."
elif ! npm run -s check:stripe-webhook-smoke-approval-ready; then
  echo
  echo "Current action required: regenerate and repair the Stripe webhook smoke approval handoff before treating paid signup fulfillment as shippable."
  exit 1
fi

echo

echo "[12/30] Pricing consistency"
npm run -s check:pricing

echo

echo "[13/30] Self-serve activation contract"
if ! npm run -s check:self-serve-activation; then
  echo
  echo "Current action required: repair paid workspace activation, setup fields, checkout status, or proof-readiness contract before treating signup as shippable."
  exit 1
fi

echo

echo "[14/30] Client onboarding intake contract"
if ! npm run -s check:client-onboarding-intake; then
  echo
  echo "Current action required: repair voice onboarding intake, trusted caller authorization, deposit handoff, or provisioning queue visibility before treating activation as shippable."
  exit 1
fi

echo

echo "[15/30] Railway auth + target access"
if ! npm run -s check:railway; then
  echo
  echo "Current action required: restore Railway auth and confirm CLI access before any live env/domain checks."
  echo "Auth helper: npm run -s print:railway-auth-setup"
  echo "If token already saved: npm run -s load:railway-auth"
  exit 1
fi

echo

echo "[16/30] Live Railway first-dollar env"
if ! npm run -s check:railway:first-dollar-env; then
  echo
  echo "Current action required: fill the required live Railway env values, then rerun this audit."
  echo "If LANDING_APP_URL is the only blocker: npm run set:landing-app-url"
  exit 1
fi

echo

echo "[17/30] SMIRK sender DNS"
if ! npm run -s check:smirk-sender-dns; then
  echo
  echo "Current action required: keep the three smirkcalls.com sender DNS records live in Namecheap until this check passes, then verify the domain in Resend."
  exit 1
fi

echo

echo "[18/30] Resend sender-domain readiness"
if ! npm run -s check:railway:resend-domain; then
  echo
  echo "Current action required: run npm run cutover:sender-domain -- --dry-run, add the smirkcalls.com DNS records in Namecheap, verify the domain in Resend, then set FROM_EMAIL to a verified smirkcalls.com sender."
  echo "Operator helper: npm run cutover:sender-domain -- --dry-run"
  echo "Operator runbook: $HOME/.openclaw/workspace/output/smirk-domain-cutover-click-path.md"
  exit 1
fi

echo

echo "[19/30] Landing domain cutover"
if ! npm run -s check:domain-cutover:authoritative; then
  echo
  echo "Current action required: apply the reported Namecheap DNS records before treating the public buyer domain as live."
  echo "This gate checks Namecheap authoritative nameservers directly so cached recursive DNS cannot mask stale control-panel records."
  echo
  echo "Namecheap automation readiness:"
  npm run -s write:namecheap-api-request || true
  exit 1
fi

echo

echo "[20/30] Live landing readiness"
if ! npm run -s check:landing-live; then
  echo
  echo "Current action required: fix the landing service readiness failure now that DNS is expected to be cut over."
  exit 1
fi

if ! node scripts/read-railway-variable.mjs DASHBOARD_API_KEY >/dev/null; then
  echo
  echo "Current action required: restore Railway auth if needed, then set DASHBOARD_API_KEY in Railway so the live operator admin profile can authenticate."
  echo "Auth helper: npm run -s print:railway-auth-setup"
  echo "If token already saved: npm run -s load:railway-auth"
  exit 1
fi

echo

echo "[21/30] Live Google auth"
if ! npm run -s check:google-auth-live; then
  echo
  echo "Current action required: set GOOGLE_OAUTH_CLIENT_ID in Railway so workspace users can sign in without a workspace API key."
  echo "Operator helper: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com"
  echo "Alt helper:     npm run set:google-auth-env -- your-google-web-client-id.apps.googleusercontent.com"
  echo "Dry run:        npm run fix:google-auth-live:dry -- your-google-web-client-id.apps.googleusercontent.com"
  echo "Auto dry run:   npm run fix:google-auth-live:from-scan -- --dry-run"
  echo "Local scan:     npm run find:google-auth-client-id"
  echo "Setup checklist: npm run print:google-auth-setup"
  exit 1
fi

echo

echo "[22/30] Deploy fingerprint"
npm run -s check:deploy-fingerprint || true

echo

echo "[23/30] Live buyer routes"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP live buyer route audit until the guarded deploy makes live current."
elif ! npm run -s check:buyer-routes-live; then
  echo
  echo "Current action required: deploy the current app service to Railway until GET /api/version and the provisioning buyer routes pass the live audit."
  exit 1
fi

echo

echo "[24/30] Live operational auth"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP live operational auth audit until the guarded deploy makes live current."
elif ! npm run -s check:operational-auth-live; then
  echo
  echo "Current action required: lock down live operational routes until unauthenticated requests return 401/403 without leaking operational data."
  exit 1
fi

echo

echo "[25/30] Railway DB wiring"
if ! npm run -s check:railway-db-wiring; then
  echo
  echo "Current action required: reselect DATABASE_URL from the Railway Postgres service reference variable and confirm the app and Postgres services share the same project/environment."
  exit 1
fi

echo

echo "[26/30] Live DB health"
if ! npm run -s check:live-db-health; then
  echo
  echo "Current action required: fix Railway Postgres attachment/wiring before treating the buyer flow as live."
  exit 1
fi

echo

echo "[27/30] Live proof artifacts"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP live proof artifact inspection until the guarded deploy makes live current."
elif ! npm run -s check:proof-artifacts-live; then
  echo
  echo "Current action required: produce or reprocess one proof call that has a summary, owner email event, and callback task with the same call_sid."
  exit 1
fi

echo

echo "[28/30] Live post-call intelligence"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP live post-call intelligence inspection until the guarded deploy makes live current."
elif ! npm run -s check:post-call-intelligence-live; then
  echo
  echo "Current action required: fix live post-call summary or callback-task creation before treating SMIRK as first-dollar ready."
  exit 1
fi

echo

echo "[29/30] Live dashboard proof freshness"
if [ "$predeploy_stale_expected" -eq 1 ]; then
  echo "SKIP live dashboard proof freshness until the guarded deploy makes live current."
elif ! npm run -s check:dashboard-proof-live; then
  echo
  echo "Current action required: run an approved fresh proof call so dashboard/public proof counters are recent and complete."
  exit 1
fi

echo

echo "OK no known launch blockers in pricing/env/payment audit"
