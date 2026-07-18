#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null
fi

DRY_RUN=0
PRODUCTION_PROJECT_ID="90599f03-6d6f-4044-8933-e0301be67a82"
PRODUCTION_SERVICE_ID="96bcd6e7-9487-4197-bcd1-a6bd0546e6b2"
PRODUCTION_ENVIRONMENT_ID="22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a"
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
  NOTIFICATION_EMAIL='one-reviewed-operator@smirkcalls.com' \
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
  CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST='exact-sha256-from-dry-run' \
  ./scripts/set-first-dollar-live-env.sh [--dry-run]

To set Google auth separately first:
  npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com

Sets the live Railway first-dollar payment/email/auth env values and then re-checks readiness.
Reads values from the current shell environment.
The write and follow-up read are pinned to Railway project 90599f03-6d6f-4044-8933-e0301be67a82, service 96bcd6e7-9487-4197-bcd1-a6bd0546e6b2, production environment 22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a. A stale local Railway link cannot redirect the approved target.
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
NOTIFICATION_EMAIL is the one reviewed operator mailbox for the first-dollar cutover. The setter writes that same mailbox to NOTIFICATION_EMAIL, OWNER_ALERT_EMAIL, OWNER_EMAIL, and OPERATOR_EMAIL so a stale Railway alias cannot silently receive paid-buyer PII.
Railway variables are written with --skip-deploys. The write does not restart or redeploy production; activation requires a separate, explicit production-deploy approval after the pending values are re-verified.
The non-dry-run staging write requires CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env plus CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST set to the exact SHA-256 printed by --dry-run. The digest binds the exact target IDs, exact local HEAD, and complete ordered unmasked assignment set without printing secret values. Staging does not expose checkout and therefore does not require real-checkout authority.
A later production deploy that would activate the pending values separately requires the same digest, exact commit, existing deploy authority, distinct activation-deploy authority, and CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly. Every proposed link is provider-verified before Railway mutation. Staging approves neither pricing or policy changes, outreach, an operator-initiated charge, Pro/Enterprise, nor deployment of uncommitted code.
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

validate_operator_recipient() {
  local value="$1"
  if ! node ./scripts/check-email-value.mjs mailbox "$value"; then
    echo "FAIL NOTIFICATION_EMAIL must contain one strict non-placeholder operator mailbox" >&2
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

validate_provisioning_secret() {
  local value="$1"
  local normalized
  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  if [ "${#value}" -lt 32 ] || [[ "$normalized" =~ ^(change|replace|example|fixture|secret|password) ]] || [[ "$normalized" == *'<'* ]] || [[ "$normalized" == *'>'* ]] || [[ "$normalized" == *'...'* ]]; then
    echo "FAIL PHONE_AGENT_PROVISIONING_SECRET must be a dedicated non-placeholder secret of at least 32 characters" >&2
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

require_nonempty NOTIFICATION_EMAIL
for candidate in OWNER_ALERT_EMAIL OWNER_EMAIL OPERATOR_EMAIL; do
  if [ -n "${!candidate:-}" ] && [ "${!candidate}" != "$NOTIFICATION_EMAIL" ]; then
    echo "FAIL $candidate conflicts with the reviewed NOTIFICATION_EMAIL recipient; unset it or make it exactly equal before the dry run" >&2
    exit 1
  fi
done

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
validate_provisioning_secret "$PHONE_AGENT_PROVISIONING_SECRET"
if [[ ! "$SMIRK_CUSTOMER_POLICY_APPROVED_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$ ]]; then
  echo "FAIL SMIRK_CUSTOMER_POLICY_APPROVED_VERSION must identify the exact approved customer policy version" >&2
  exit 1
fi
node ./scripts/check-customer-policy-approval.mjs --verify-live --plan=starter
node ./scripts/check-proposed-payment-links.mjs
node ./scripts/check-exclusive-first-dollar-payment-links.mjs
validate_resend_key "$RESEND_API_KEY"
validate_from_email "$FROM_EMAIL"
validate_operator_recipient "$NOTIFICATION_EMAIL"
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

node ./scripts/check-exact-railway-production-target.mjs

assignments=(
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
  "NOTIFICATION_EMAIL=$NOTIFICATION_EMAIL"
  "OWNER_ALERT_EMAIL=$NOTIFICATION_EMAIL"
  "OWNER_EMAIL=$NOTIFICATION_EMAIL"
  "OPERATOR_EMAIL=$NOTIFICATION_EMAIL"
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
    assignments+=("ELEVENLABS_ENABLED=${ELEVENLABS_ENABLED:-true}")
    ;;
  GOOGLE_TTS_API_KEY|GOOGLE_SERVICE_ACCOUNT_JSON)
    assignments+=("GOOGLE_TTS_ENABLED=${GOOGLE_TTS_ENABLED:-true}")
    ;;
esac

if [ -n "${LANDING_APP_URL:-}" ]; then
  assignments+=("LANDING_APP_URL=$LANDING_APP_URL")
fi

PENDING_COMMIT="$(git rev-parse HEAD)"
manifest_output="$(
  printf '%s\0' "${assignments[@]}" |
    SMIRK_PENDING_TARGET_PROJECT_ID="$PRODUCTION_PROJECT_ID" \
    SMIRK_PENDING_TARGET_SERVICE_ID="$PRODUCTION_SERVICE_ID" \
    SMIRK_PENDING_TARGET_ENVIRONMENT_ID="$PRODUCTION_ENVIRONMENT_ID" \
    SMIRK_PENDING_TARGET_COMMIT="$PENDING_COMMIT" \
    node ./scripts/compute-first-dollar-pending-env-manifest.mjs
)"

PENDING_DIGEST=""
PENDING_KEY_LIST=""
PENDING_ASSIGNMENT_COUNT=""
while IFS='=' read -r manifest_key manifest_value; do
  case "$manifest_key" in
    digest) PENDING_DIGEST="$manifest_value" ;;
    key_list) PENDING_KEY_LIST="$manifest_value" ;;
    commit) PENDING_COMMIT="$manifest_value" ;;
    assignment_count) PENDING_ASSIGNMENT_COUNT="$manifest_value" ;;
  esac
done <<< "$manifest_output"

if [[ ! "$PENDING_DIGEST" =~ ^[a-f0-9]{64}$ ]] || [[ ! "$PENDING_COMMIT" =~ ^[a-f0-9]{40}$ ]] || [ -z "$PENDING_KEY_LIST" ] || [[ ! "$PENDING_ASSIGNMENT_COUNT" =~ ^[0-9]+$ ]]; then
  echo "FAIL pending first-dollar manifest computation returned incomplete metadata" >&2
  exit 1
fi

cmd=(railway variable set
  --service "$PRODUCTION_SERVICE_ID"
  --environment "$PRODUCTION_ENVIRONMENT_ID"
  --skip-deploys
  "${assignments[@]}"
  "SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST=$PENDING_DIGEST"
  "SMIRK_PENDING_FIRST_DOLLAR_ENV_KEYS=$PENDING_KEY_LIST"
  "SMIRK_PENDING_FIRST_DOLLAR_ENV_COMMIT=$PENDING_COMMIT"
  "SMIRK_PENDING_FIRST_DOLLAR_ENV_SCHEMA=1"
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN TARGET: project=$PRODUCTION_PROJECT_ID service=$PRODUCTION_SERVICE_ID environment=$PRODUCTION_ENVIRONMENT_ID"
  echo "PENDING ENV COMMIT: $PENDING_COMMIT"
  echo "PENDING ENV ASSIGNMENT COUNT: $PENDING_ASSIGNMENT_COUNT"
  echo "PENDING ENV ORDERED KEY LIST: $PENDING_KEY_LIST"
  echo "PENDING ENV SHA-256: $PENDING_DIGEST"
  printf 'DRY RUN: '
  for item in "${cmd[@]}"; do
    masked="$(mask_assignment "$item")"
    printf '%q ' "$masked"
  done
  printf '\n'
  echo "Exact staging approval: APPROVE_SMIRK_FIRST_DOLLAR_ENV_STAGE: digest=$PENDING_DIGEST; commit=$PENDING_COMMIT; target=$PRODUCTION_PROJECT_ID/$PRODUCTION_SERVICE_ID/$PRODUCTION_ENVIRONMENT_ID; action=stage-with-skip-deploys-only"
  echo "Exact staging command confirmation: CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=$PENDING_DIGEST ./scripts/set-first-dollar-live-env.sh"
  echo 'Next checks:'
  echo '  npm run check:railway:first-dollar-env'
  echo '  npm run -s print:first-dollar-pending-env-activation'
  echo '  # No production process changes in this step; staging does not require or grant real-checkout authority.'
  exit 0
fi

if [ "${CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE:-}" != "apply-smirk-first-dollar-live-env" ]; then
  echo "FAIL production Railway mutation requires CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env" >&2
  echo "This approval is separate from deploy, Stripe webhook smoke, outreach, and customer-charge approval." >&2
  exit 1
fi

if [ "${CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST:-}" != "$PENDING_DIGEST" ]; then
  echo "FAIL production Railway staging requires CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=$PENDING_DIGEST" >&2
  echo "Re-run --dry-run after any target, commit, or assignment change and confirm that exact digest." >&2
  exit 1
fi

echo "=== Requiring current exact live source immediately before the non-deploying environment write ==="
npm run -s check:live-is-current

"${cmd[@]}"
npm run -s check:railway:first-dollar-env
echo "OK reviewed first-dollar Railway variables are saved with --skip-deploys."
echo "Production has not restarted; checkout has not been exposed by this staging write."
echo "Inspect the exact digest-bound activation request with: npm run -s print:first-dollar-pending-env-activation"
echo "A later deploy must separately confirm the same digest, exact commit, real Starter checkout authority, activation-deploy authority, and existing deploy authority."
