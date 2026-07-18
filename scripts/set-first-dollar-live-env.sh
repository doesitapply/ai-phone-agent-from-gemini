#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null
fi

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage (Starter-only first-dollar cutover):
  APP_URL='https://ai-phone-agent-production-6811.up.railway.app' \
  STRIPE_PAYMENT_LINK_STARTER=... \
  STRIPE_PAYMENT_LINK_STARTER_ID=plink_... \
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS=plink_... \
  DISABLE_STRIPE_PAYMENT_LINK_PRO=true \
  DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE=true \
  STRIPE_REVENUE_READ_KEY=rk_live_... \
  STRIPE_BILLING_PORTAL_KEY=rk_live_... \
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_... \
  PHONE_AGENT_PROVISIONING_SECRET=... \
  AUTO_FULFILL_PROVISIONING_REQUESTS=true \
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION='exact-version-from-approved-manifest' \
  RESEND_API_KEY=re_... \
  FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' \
  NOTIFICATION_EMAIL='operator@smirkcalls.com' \
  BOOKING_LINK='https://calendly.com/smirkcalls/smirk-setup' \
  LANDING_APP_URL='https://smirkcalls.com' \
  GOOGLE_OAUTH_CLIENT_ID='your-google-web-client-id.apps.googleusercontent.com' \
  TWILIO_ACCOUNT_SID='AC...' \
  TWILIO_AUTH_TOKEN='parent-account-token' \
  WORKSPACE_SECRET_ENCRYPTION_KEY='32-or-more-random-characters' \
  OPENROUTER_API_KEY='sk-or-v1-...' \
  OPENROUTER_ENABLED=true \
  FAST_LIVE_CALLS=false \
  CARTESIA_API_KEY='streaming-tts-key' \
  CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE='apply-smirk-first-dollar-live-env' \
  CONFIRM_SMIRK_REAL_STARTER_CHECKOUT='accept-buyer-initiated-starter-197-monthly' \
  ./scripts/set-first-dollar-live-env.sh [--dry-run]

To set Google auth separately first:
  npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com

Sets the live Railway first-dollar payment/email/auth env values and then re-checks readiness.
Reads values from the current shell environment.
APP_URL must be an exact allowlisted SMIRK production HTTPS origin; buyer invite tokens are never sent to arbitrary hosts.
The exact Starter Payment Link URL + live plink_ ID pair is required. This first-dollar setter cannot enable Pro or Enterprise and always clears both live URL + ID pairs in the same Railway write.
DISABLE_STRIPE_PAYMENT_LINK_PRO and DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE default to true and may not be false. Any supplied Pro/Enterprise URL or ID fails before mutation instead of being silently accepted.
Native Checkout is forced off in this Starter-only path so its shared session route cannot expose Pro or Enterprise.
STRIPE_REVENUE_READ_KEY must be a dedicated live restricted key with read access to Payment Links, Webhook Endpoints, Events, Checkout Sessions, Invoices, Invoice Payments, PaymentIntents, Charges, Balance Transactions, and Invoice line items.
STRIPE_BILLING_PORTAL_KEY must be a separate dedicated live restricted key with Billing Portal configuration read and session write access. STRIPE_BILLING_PORTAL_CONFIGURATION_ID must identify the exact active live configuration with invoice history, payment-method updates, and cancellation enabled.
The revenue-read and Billing Portal restricted keys must be different credentials. Native Checkout cannot be enabled through this Starter-only setter.
PHONE_AGENT_PROVISIONING_SECRET must match the landing app webhook secret.
AUTO_FULFILL_PROVISIONING_REQUESTS must be exactly true so a paid checkout activates durably without an unstaffed manual stop.
SMIRK_CUSTOMER_POLICY_APPROVED_VERSION must exactly match the checked-in owner-approved manifest after completing docs/launch/first-dollar-policy-decisions.md. The environment value cannot approve policy by itself.
LANDING_APP_URL is optional but strongly recommended so the buyer handoff points at the real production landing domain.
GOOGLE_OAUTH_CLIENT_ID is now required so workspace users can sign in without internal credentials.
Managed Twilio provisioning requires the parent AccountSid/token plus a dedicated WORKSPACE_SECRET_ENCRYPTION_KEY.
The real streaming call path requires OPENROUTER_ENABLED=true, FAST_LIVE_CALLS=false, and at least one enabled premium TTS credential.
At least one of NOTIFICATION_EMAIL, OWNER_ALERT_EMAIL, OWNER_EMAIL, or OPERATOR_EMAIL is required so paid-buyer lifecycle alerts have a real recipient.
The non-dry-run production write requires both CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env and CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly. The second confirmation corresponds only to the separately approved human Starter authority for buyer-initiated subscriptions at the existing $197/month price. Every proposed link is provider-verified before Railway mutation. Neither confirmation approves pricing or policy changes, outreach, an operator-initiated charge, Pro/Enterprise, or deployment of uncommitted code.
Before creating a new Google client, try:
  npm run find:google-auth-client-id
  npm run print:google-auth-setup
Use a verified smirkcalls.com sender after running npm run cutover:sender-domain -- --dry-run.
EOF
      exit 0
      ;;
    *)
      echo "FAIL unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

require_nonempty() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "FAIL missing $key in shell environment" >&2
    if [ "$key" = "GOOGLE_OAUTH_CLIENT_ID" ]; then
      echo "Local scan: npm run find:google-auth-client-id" >&2
      echo "Setup checklist: npm run print:google-auth-setup" >&2
    fi
    exit 1
  fi
}

validate_stripe_link() {
  local key="$1"
  local value="${!key}"
  if ! node ./scripts/check-payment-link-value.mjs url "$value"; then
    echo "FAIL $key must be one exact non-placeholder https://buy.stripe.com/... URL with no credentials, port, query, or fragment" >&2
    exit 1
  fi
}

validate_stripe_link_id() {
  local key="$1"
  local value="${!key}"
  if ! node ./scripts/check-payment-link-value.mjs id "$value"; then
    echo "FAIL $key must be the exact live Stripe Payment Link ID beginning with plink_" >&2
    exit 1
  fi
}

validate_from_email() {
  local value="$1"
  if ! node ./scripts/check-email-value.mjs mailbox "$value"; then
    echo "FAIL FROM_EMAIL must contain one strict non-placeholder sender mailbox" >&2
    exit 1
  fi
}

validate_operator_recipients() {
  local value="$1"
  if ! node ./scripts/check-email-value.mjs list "$value"; then
    echo "FAIL operator alert recipient must contain at least one strict non-placeholder mailbox" >&2
    exit 1
  fi
}

validate_url() {
  local key="$1"
  local value="${!key}"
  if [[ ! "$value" =~ ^https://[^[:space:]]+$ ]]; then
    echo "FAIL $key must be an https URL: $value" >&2
    exit 1
  fi
}

validate_app_url() {
  local value="$1"
  if [[ ! "$value" =~ ^https://(ai-phone-agent-production-6811\.up\.railway\.app|(www\.)?smirkcalls\.com)/?$ ]]; then
    echo "FAIL APP_URL must be an exact allowlisted SMIRK production HTTPS origin with no path, query, credentials, or custom port: $value" >&2
    exit 1
  fi
}

validate_resend_key() {
  local value="$1"
  if [[ ! "$value" =~ ^re_ ]]; then
    echo "FAIL RESEND_API_KEY must look like a Resend API key beginning with re_" >&2
    exit 1
  fi
}

validate_stripe_revenue_key() {
  local value="$1"
  if [[ ! "$value" =~ ^rk_live_ ]]; then
    echo "FAIL STRIPE_REVENUE_READ_KEY must be a dedicated live restricted Stripe key beginning with rk_live_" >&2
    exit 1
  fi
}

validate_stripe_portal_config_id() {
  local value="$1"
  if [[ ! "$value" =~ ^bpc_[A-Za-z0-9_]+$ ]]; then
    echo "FAIL STRIPE_BILLING_PORTAL_CONFIGURATION_ID must begin with bpc_" >&2
    exit 1
  fi
}

validate_auto_fulfill() {
  local value="$1"
  if [ "$value" != "true" ]; then
    echo "FAIL AUTO_FULFILL_PROVISIONING_REQUESTS must be exactly true for first-dollar activation readiness" >&2
    exit 1
  fi
}

mask_assignment() {
  local assignment="$1"
  case "$assignment" in
    PHONE_AGENT_PROVISIONING_SECRET=*|RESEND_API_KEY=*|STRIPE_REVENUE_READ_KEY=*|STRIPE_BILLING_PORTAL_KEY=*|TWILIO_AUTH_TOKEN=*|WORKSPACE_SECRET_ENCRYPTION_KEY=*|OPENROUTER_API_KEY=*|CARTESIA_API_KEY=*|ELEVENLABS_API_KEY=*|GOOGLE_TTS_API_KEY=*|GOOGLE_SERVICE_ACCOUNT_JSON=*|OPENAI_API_KEY=*)
      printf '%s=***' "${assignment%%=*}"
      ;;
    *)
      printf '%s' "$assignment"
      ;;
  esac
}

require_nonempty APP_URL
require_nonempty STRIPE_PAYMENT_LINK_STARTER
require_nonempty STRIPE_PAYMENT_LINK_STARTER_ID
require_nonempty STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS
if [ "${DISABLE_STRIPE_PAYMENT_LINK_STARTER:-false}" != "false" ]; then
  echo "FAIL this Starter-only setter cannot disable Starter while supplying its approved checkout pair" >&2
  exit 1
fi
validate_stripe_link STRIPE_PAYMENT_LINK_STARTER
validate_stripe_link_id STRIPE_PAYMENT_LINK_STARTER_ID
node ./scripts/check-payment-link-fulfillment-ids.mjs "$STRIPE_PAYMENT_LINK_STARTER_ID" "$STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS"

for plan in PRO ENTERPRISE; do
  url_key="STRIPE_PAYMENT_LINK_${plan}"
  id_key="STRIPE_PAYMENT_LINK_${plan}_ID"
  disable_key="DISABLE_STRIPE_PAYMENT_LINK_${plan}"
  if [ -n "${!url_key:-}" ] || [ -n "${!id_key:-}" ]; then
    echo "FAIL this Starter-only setter cannot enable ${plan}; remove $url_key and $id_key so the live pair can be cleared" >&2
    exit 1
  fi
  if [ "${!disable_key:-true}" != "true" ]; then
    echo "FAIL $disable_key must be true or omitted; this Starter-only setter always clears ${plan}" >&2
    exit 1
  fi
done
require_nonempty STRIPE_REVENUE_READ_KEY
require_nonempty STRIPE_BILLING_PORTAL_KEY
require_nonempty STRIPE_BILLING_PORTAL_CONFIGURATION_ID
require_nonempty PHONE_AGENT_PROVISIONING_SECRET
require_nonempty AUTO_FULFILL_PROVISIONING_REQUESTS
require_nonempty SMIRK_CUSTOMER_POLICY_APPROVED_VERSION
require_nonempty RESEND_API_KEY
require_nonempty FROM_EMAIL
require_nonempty BOOKING_LINK
require_nonempty GOOGLE_OAUTH_CLIENT_ID
require_nonempty TWILIO_ACCOUNT_SID
require_nonempty TWILIO_AUTH_TOKEN
require_nonempty WORKSPACE_SECRET_ENCRYPTION_KEY
require_nonempty OPENROUTER_API_KEY
require_nonempty OPENROUTER_ENABLED
require_nonempty FAST_LIVE_CALLS

streaming_tts_key=""
for candidate in CARTESIA_API_KEY ELEVENLABS_API_KEY GOOGLE_TTS_API_KEY GOOGLE_SERVICE_ACCOUNT_JSON OPENAI_API_KEY; do
  if [ -n "${!candidate:-}" ]; then
    streaming_tts_key="$candidate"
    break
  fi
done
if [ -z "$streaming_tts_key" ]; then
  echo "FAIL missing streaming TTS credential; set CARTESIA_API_KEY, ELEVENLABS_API_KEY, GOOGLE_TTS_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, or OPENAI_API_KEY" >&2
  exit 1
fi

operator_recipient_key=""
for candidate in NOTIFICATION_EMAIL OWNER_ALERT_EMAIL OWNER_EMAIL OPERATOR_EMAIL; do
  if [ -n "${!candidate:-}" ]; then
    operator_recipient_key="$candidate"
    break
  fi
done
if [ -z "$operator_recipient_key" ]; then
  echo "FAIL missing operator alert recipient; set NOTIFICATION_EMAIL, OWNER_ALERT_EMAIL, OWNER_EMAIL, or OPERATOR_EMAIL" >&2
  exit 1
fi

validate_app_url "$APP_URL"
validate_stripe_revenue_key "$STRIPE_REVENUE_READ_KEY"
validate_stripe_revenue_key "$STRIPE_BILLING_PORTAL_KEY"
if [ "$STRIPE_REVENUE_READ_KEY" = "$STRIPE_BILLING_PORTAL_KEY" ]; then
  echo "FAIL STRIPE_REVENUE_READ_KEY and STRIPE_BILLING_PORTAL_KEY must be distinct restricted keys" >&2
  exit 1
fi
if [ "${SMIRK_NATIVE_CHECKOUT_ENABLED:-false}" != "false" ]; then
  echo "FAIL this Starter-only setter requires SMIRK_NATIVE_CHECKOUT_ENABLED=false so the shared native route cannot expose Pro or Enterprise" >&2
  exit 1
fi
SMIRK_NATIVE_CHECKOUT_ENABLED=false
validate_stripe_portal_config_id "$STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
validate_auto_fulfill "$AUTO_FULFILL_PROVISIONING_REQUESTS"
if [[ ! "$SMIRK_CUSTOMER_POLICY_APPROVED_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$ ]]; then
  echo "FAIL SMIRK_CUSTOMER_POLICY_APPROVED_VERSION must identify the exact approved customer policy version" >&2
  exit 1
fi
node ./scripts/check-customer-policy-approval.mjs --verify-live --plan=starter
node ./scripts/check-proposed-payment-links.mjs
node ./scripts/check-exclusive-first-dollar-payment-links.mjs
validate_resend_key "$RESEND_API_KEY"
validate_from_email "$FROM_EMAIL"
validate_operator_recipients "${!operator_recipient_key}"
validate_url BOOKING_LINK
node ./scripts/check-first-dollar-voice-env.mjs

if [[ "$GOOGLE_OAUTH_CLIENT_ID" == *,* ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must be one browser client ID for the live frontend button, not a CSV list" >&2
  echo "Local scan: npm run find:google-auth-client-id" >&2
  echo "Setup checklist: npm run print:google-auth-setup" >&2
  exit 1
fi
if [[ ! "$GOOGLE_OAUTH_CLIENT_ID" =~ \.apps\.googleusercontent\.com$ ]]; then
  echo "FAIL GOOGLE_OAUTH_CLIENT_ID must look like a Google web client id ending in .apps.googleusercontent.com" >&2
  echo "Local scan: npm run find:google-auth-client-id" >&2
  echo "Setup checklist: npm run print:google-auth-setup" >&2
  exit 1
fi

validate_landing_app_url() {
  local value="$1"
  if [ -z "$value" ]; then
    return 0
  fi
  if [[ "$value" =~ manus\.space ]]; then
    echo "FAIL LANDING_APP_URL must point at the production marketing domain, not manus.space: $value" >&2
    exit 1
  fi
  if [[ ! "$value" =~ ^https://smirkcalls\.com/?$ ]]; then
    echo "FAIL LANDING_APP_URL must be exactly https://smirkcalls.com: $value" >&2
    exit 1
  fi
}

validate_landing_app_url "${LANDING_APP_URL:-}"

if [ -z "${RAILWAY_API_TOKEN:-}" ] && [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "FAIL Railway auth missing." >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "If you already saved a token, run: npm run -s load:railway-auth" >&2
  exit 1
fi

cmd=(railway variable set
  "APP_URL=$APP_URL"
  "STRIPE_REVENUE_READ_KEY=$STRIPE_REVENUE_READ_KEY"
  "STRIPE_BILLING_PORTAL_KEY=$STRIPE_BILLING_PORTAL_KEY"
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID=$STRIPE_BILLING_PORTAL_CONFIGURATION_ID"
  "SMIRK_NATIVE_CHECKOUT_ENABLED=$SMIRK_NATIVE_CHECKOUT_ENABLED"
  "PHONE_AGENT_PROVISIONING_SECRET=$PHONE_AGENT_PROVISIONING_SECRET"
  "AUTO_FULFILL_PROVISIONING_REQUESTS=$AUTO_FULFILL_PROVISIONING_REQUESTS"
  "SMIRK_CUSTOMER_POLICY_APPROVED_VERSION=$SMIRK_CUSTOMER_POLICY_APPROVED_VERSION"
  "RESEND_API_KEY=$RESEND_API_KEY"
  "FROM_EMAIL=$FROM_EMAIL"
  "$operator_recipient_key=${!operator_recipient_key}"
  "BOOKING_LINK=$BOOKING_LINK"
  "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
  "TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID"
  "TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN"
  "WORKSPACE_SECRET_ENCRYPTION_KEY=$WORKSPACE_SECRET_ENCRYPTION_KEY"
  "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
  "OPENROUTER_ENABLED=$OPENROUTER_ENABLED"
  "FAST_LIVE_CALLS=$FAST_LIVE_CALLS"
  "$streaming_tts_key=${!streaming_tts_key}"
  "STRIPE_PAYMENT_LINK_STARTER=$STRIPE_PAYMENT_LINK_STARTER"
  "STRIPE_PAYMENT_LINK_STARTER_ID=$STRIPE_PAYMENT_LINK_STARTER_ID"
  "STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS=$STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS"
  "STRIPE_PAYMENT_LINK_PRO="
  "STRIPE_PAYMENT_LINK_PRO_ID="
  "STRIPE_PAYMENT_LINK_ENTERPRISE="
  "STRIPE_PAYMENT_LINK_ENTERPRISE_ID="
)

case "$streaming_tts_key" in
  ELEVENLABS_API_KEY)
    cmd+=("ELEVENLABS_ENABLED=${ELEVENLABS_ENABLED:-true}")
    ;;
  GOOGLE_TTS_API_KEY|GOOGLE_SERVICE_ACCOUNT_JSON)
    cmd+=("GOOGLE_TTS_ENABLED=${GOOGLE_TTS_ENABLED:-true}")
    ;;
esac

if [ -n "${LANDING_APP_URL:-}" ]; then
  cmd+=("LANDING_APP_URL=$LANDING_APP_URL")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  for item in "${cmd[@]}"; do
    masked="$(mask_assignment "$item")"
    printf '%q ' "$masked"
  done
  printf '\n'
  echo 'Next checks:'
  echo '  npm run check:railway:first-dollar-env'
  echo '  npm run check:launch-blockers'
  echo '  npm run check:ship-live'
  exit 0
fi

if [ "${CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE:-}" != "apply-smirk-first-dollar-live-env" ]; then
  echo "FAIL production Railway mutation requires CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env" >&2
  echo "This approval is separate from deploy, Stripe webhook smoke, outreach, and customer-charge approval." >&2
  exit 1
fi

if [ "${CONFIRM_SMIRK_REAL_STARTER_CHECKOUT:-}" != "accept-buyer-initiated-starter-197-monthly" ]; then
  echo "FAIL exposing the Starter Payment Link requires CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly" >&2
  echo "This machine confirmation is valid only after the separate APPROVE_SMIRK_REAL_STARTER_CHECKOUT human authority for the existing Starter $197/month offer." >&2
  exit 1
fi

"${cmd[@]}"
npm run -s check:railway:first-dollar-env
npm run -s check:launch-blockers
npm run -s check:ship-live
