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
Usage:
  STRIPE_PAYMENT_LINK_STARTER=... \
  STRIPE_PAYMENT_LINK_PRO=... \
  STRIPE_PAYMENT_LINK_ENTERPRISE=... \
  PHONE_AGENT_PROVISIONING_SECRET=... \
  AUTO_FULFILL_PROVISIONING_REQUESTS=false \
  RESEND_API_KEY=re_... \
  FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' \
  BOOKING_LINK='https://calendly.com/smirkcalls/smirk-setup' \
  LANDING_APP_URL='https://smirkcalls.com' \
  GOOGLE_OAUTH_CLIENT_ID='your-google-web-client-id.apps.googleusercontent.com' \
  # or set Google auth separately first with:
  # npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com
  ./scripts/set-first-dollar-live-env.sh [--dry-run]

Sets the live Railway first-dollar payment/email/auth env values and then re-checks readiness.
Reads values from the current shell environment.
PHONE_AGENT_PROVISIONING_SECRET must match the landing app webhook secret.
AUTO_FULFILL_PROVISIONING_REQUESTS must be exactly true or false. Use false for tracked manual fallback.
LANDING_APP_URL is optional but strongly recommended so the buyer handoff points at the real production landing domain.
GOOGLE_OAUTH_CLIENT_ID is now required so workspace users can sign in without internal credentials.
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
  case "$value" in
    https://buy.stripe.com/*|https://checkout.stripe.com/*) ;;
    *)
      echo "FAIL $key does not look like a Stripe checkout link: $value" >&2
      exit 1
      ;;
  esac
}

validate_from_email() {
  local value="$1"
  if [[ "$value" == *"yourdomain.com"* ]] || [[ "$value" == *"example.com"* ]]; then
    echo "FAIL FROM_EMAIL still looks like a placeholder: $value" >&2
    exit 1
  fi
  if ! printf '%s' "$value" | grep -Eq '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$|^.+<[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+>$'; then
    echo "FAIL FROM_EMAIL must look like an email or display-name email: $value" >&2
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

validate_resend_key() {
  local value="$1"
  if [[ ! "$value" =~ ^re_ ]]; then
    echo "FAIL RESEND_API_KEY must look like a Resend API key beginning with re_" >&2
    exit 1
  fi
}

validate_auto_fulfill() {
  local value="$1"
  if [ "$value" != "true" ] && [ "$value" != "false" ]; then
    echo "FAIL AUTO_FULFILL_PROVISIONING_REQUESTS must be exactly true or false" >&2
    exit 1
  fi
}

mask_assignment() {
  local assignment="$1"
  case "$assignment" in
    PHONE_AGENT_PROVISIONING_SECRET=*|RESEND_API_KEY=*)
      printf '%s=***' "${assignment%%=*}"
      ;;
    *)
      printf '%s' "$assignment"
      ;;
  esac
}

require_nonempty STRIPE_PAYMENT_LINK_STARTER
require_nonempty STRIPE_PAYMENT_LINK_PRO
require_nonempty STRIPE_PAYMENT_LINK_ENTERPRISE
require_nonempty PHONE_AGENT_PROVISIONING_SECRET
require_nonempty AUTO_FULFILL_PROVISIONING_REQUESTS
require_nonempty RESEND_API_KEY
require_nonempty FROM_EMAIL
require_nonempty BOOKING_LINK
require_nonempty GOOGLE_OAUTH_CLIENT_ID

validate_stripe_link STRIPE_PAYMENT_LINK_STARTER
validate_stripe_link STRIPE_PAYMENT_LINK_PRO
validate_stripe_link STRIPE_PAYMENT_LINK_ENTERPRISE
validate_auto_fulfill "$AUTO_FULFILL_PROVISIONING_REQUESTS"
validate_resend_key "$RESEND_API_KEY"
validate_from_email "$FROM_EMAIL"
validate_url BOOKING_LINK

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
  "STRIPE_PAYMENT_LINK_STARTER=$STRIPE_PAYMENT_LINK_STARTER"
  "STRIPE_PAYMENT_LINK_PRO=$STRIPE_PAYMENT_LINK_PRO"
  "STRIPE_PAYMENT_LINK_ENTERPRISE=$STRIPE_PAYMENT_LINK_ENTERPRISE"
  "PHONE_AGENT_PROVISIONING_SECRET=$PHONE_AGENT_PROVISIONING_SECRET"
  "AUTO_FULFILL_PROVISIONING_REQUESTS=$AUTO_FULFILL_PROVISIONING_REQUESTS"
  "RESEND_API_KEY=$RESEND_API_KEY"
  "FROM_EMAIL=$FROM_EMAIL"
  "BOOKING_LINK=$BOOKING_LINK"
  "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
)

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

"${cmd[@]}"
npm run -s check:railway:first-dollar-env
npm run -s check:launch-blockers
npm run -s check:ship-live
