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

echo "[0/9] Auth regression + operational API protection"
if ! npm run -s check:auth; then
  echo
  echo "Current action required: fix exposed operational routes or auth regressions before treating SMIRK as shippable."
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

echo "[1/10] Stripe attach readiness"
if [ "$stripe_links_ready" -eq 3 ]; then
  echo "OK Stripe payment links already configured in env; skipping browser attach gate"
else
  if ! npm run -s check:stripe-attach; then
    echo
    echo "Current action required: open the logged-in Stripe session in attachable Chrome, approve any attach prompt, then rerun this audit."
    exit 1
  fi
fi

echo

echo "[2/10] Pricing consistency"
npm run -s check:pricing

echo

echo "[3/10] Railway auth + target access"
if ! npm run -s check:railway; then
  echo
  echo "Current action required: restore Railway auth and confirm CLI access before any live env/domain checks."
  echo "Auth helper: npm run -s print:railway-auth-setup"
  echo "If token already saved: npm run -s load:railway-auth"
  exit 1
fi

echo

echo "[4/10] Live Railway first-dollar env"
if ! npm run -s check:railway:first-dollar-env; then
  echo
  echo "Current action required: fill the required live Railway env values, then rerun this audit."
  echo "If LANDING_APP_URL is the only blocker: npm run set:landing-app-url"
  exit 1
fi

echo

echo "[5/11] SMIRK sender DNS"
if ! npm run -s check:smirk-sender-dns; then
  echo
  echo "Current action required: keep the three smirkcalls.com sender DNS records live in Namecheap until this check passes, then verify the domain in Resend."
  exit 1
fi

echo

echo "[6/11] Resend sender-domain readiness"
if ! npm run -s check:railway:resend-domain; then
  echo
  echo "Current action required: run npm run cutover:sender-domain -- --dry-run, add the smirkcalls.com DNS records in Namecheap, verify the domain in Resend, then set FROM_EMAIL to a verified smirkcalls.com sender."
  echo "Operator helper: npm run cutover:sender-domain -- --dry-run"
  echo "Operator runbook: $HOME/.openclaw/workspace/output/smirk-domain-cutover-click-path.md"
  exit 1
fi

echo

echo "[7/11] Live landing readiness"
if ! npm run -s check:landing-live; then
  echo
  echo "Current action required: populate the landing service env vars and redeploy it until /api/first-dollar-readiness returns green."
  exit 1
fi

if ! source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || ! railway variable list --json | node -e 'const fs=require("fs"); const vars=JSON.parse(fs.readFileSync(0,"utf8")); process.exit(String(vars.DASHBOARD_API_KEY||"").trim()?0:1)'; then
  echo
  echo "Current action required: restore Railway auth if needed, then set DASHBOARD_API_KEY in Railway so the live operator admin profile can authenticate."
  echo "Auth helper: npm run -s print:railway-auth-setup"
  echo "If token already saved: npm run -s load:railway-auth"
  exit 1
fi

echo

echo "[7/11] Live Google auth"
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

echo "[8/12] Deploy fingerprint"
npm run -s check:deploy-fingerprint || true

echo

echo "[9/12] Live buyer routes"
if ! npm run -s check:buyer-routes-live; then
  echo
  echo "Current action required: deploy the current app service to Railway until GET /api/version and the provisioning buyer routes pass the live audit."
  exit 1
fi

echo

echo "[10/12] Railway DB wiring"
if ! npm run -s check:railway-db-wiring; then
  echo
  echo "Current action required: reselect DATABASE_URL from the Railway Postgres service reference variable and confirm the app and Postgres services share the same project/environment."
  exit 1
fi

echo

echo "[11/12] Live DB health"
if ! npm run -s check:live-db-health; then
  echo
  echo "Current action required: fix Railway Postgres attachment/wiring before treating the buyer flow as live."
  exit 1
fi

echo

echo "OK no known launch blockers in pricing/env/payment audit"
