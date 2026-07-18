#!/usr/bin/env bash
set -euo pipefail

STARTER="${STRIPE_PAYMENT_LINK_STARTER:-${1:-}}"
PRO="${STRIPE_PAYMENT_LINK_PRO:-${2:-}}"

usage() {
  echo "Usage:" >&2
  echo "  STRIPE_PAYMENT_LINK_STARTER=... STRIPE_PAYMENT_LINK_PRO=... ./scripts/set-stripe-payment-links.sh" >&2
  echo "or" >&2
  echo "  ./scripts/set-stripe-payment-links.sh <starter-link> <pro-link>" >&2
  echo "Enterprise is deliberately excluded until owner-approved hard caps match runtime enforcement." >&2
}

validate_link() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "FAIL missing $name" >&2
    usage
    exit 1
  fi
  case "$value" in
    https://buy.stripe.com/*|https://checkout.stripe.com/*) ;;
    *)
      echo "FAIL $name does not look like a Stripe checkout link: $value" >&2
      exit 1
      ;;
  esac
}

validate_link STRIPE_PAYMENT_LINK_STARTER "$STARTER"
validate_link STRIPE_PAYMENT_LINK_PRO "$PRO"

if [ -z "${RAILWAY_API_TOKEN:-}" ] && [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "FAIL Railway auth missing." >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "If you already saved a token, run: npm run -s load:railway-auth" >&2
  exit 1
fi

railway variables set \
  STRIPE_PAYMENT_LINK_STARTER="$STARTER" \
  STRIPE_PAYMENT_LINK_PRO="$PRO"

echo "Saved enabled Starter/Pro Stripe payment links to Railway; Enterprise remains disabled."
echo "Next: railway run npm run check:first-dollar-env"
