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
  FROM_EMAIL='SMIRK <alerts@smirkcalls.com>' \
  LANDING_APP_URL='https://smirkcalls.com' \
  GOOGLE_OAUTH_CLIENT_ID='your-google-web-client-id.apps.googleusercontent.com' \
  # or set Google auth separately first with:
  # npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com
  ./scripts/set-first-dollar-live-env.sh [--dry-run]

Sets the live Railway first-dollar payment/email/auth env values and then re-checks readiness.
Reads values from the current shell environment.
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

require_nonempty STRIPE_PAYMENT_LINK_STARTER
require_nonempty STRIPE_PAYMENT_LINK_PRO
require_nonempty STRIPE_PAYMENT_LINK_ENTERPRISE
require_nonempty FROM_EMAIL
require_nonempty GOOGLE_OAUTH_CLIENT_ID

validate_stripe_link STRIPE_PAYMENT_LINK_STARTER
validate_stripe_link STRIPE_PAYMENT_LINK_PRO
validate_stripe_link STRIPE_PAYMENT_LINK_ENTERPRISE
validate_from_email "$FROM_EMAIL"

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
  "FROM_EMAIL=$FROM_EMAIL"
  "GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
)

if [ -n "${LANDING_APP_URL:-}" ]; then
  cmd+=("LANDING_APP_URL=$LANDING_APP_URL")
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: '
  printf '%q ' "${cmd[@]}"
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
