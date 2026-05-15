#!/usr/bin/env bash
set -euo pipefail

STARTER="${STRIPE_PAYMENT_LINK_STARTER:-${1:-}}"
PRO="${STRIPE_PAYMENT_LINK_PRO:-${2:-}}"
ENTERPRISE="${STRIPE_PAYMENT_LINK_ENTERPRISE:-${3:-}}"

usage() {
  echo "Usage:" >&2
  echo "  STRIPE_PAYMENT_LINK_STARTER=... STRIPE_PAYMENT_LINK_PRO=... STRIPE_PAYMENT_LINK_ENTERPRISE=... ./scripts/set-stripe-payment-links.sh" >&2
  echo "or" >&2
  echo "  ./scripts/set-stripe-payment-links.sh <starter-link> <pro-link> <enterprise-link>" >&2
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
validate_link STRIPE_PAYMENT_LINK_ENTERPRISE "$ENTERPRISE"

if [ -z "${RAILWAY_API_TOKEN:-}" ] && [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "FAIL Railway auth missing. Run: source ./scripts/load-railway-auth.sh" >&2
  exit 1
fi

railway variables set \
  STRIPE_PAYMENT_LINK_STARTER="$STARTER" \
  STRIPE_PAYMENT_LINK_PRO="$PRO" \
  STRIPE_PAYMENT_LINK_ENTERPRISE="$ENTERPRISE"

echo "Saved Stripe payment links to Railway."
echo "Next: railway run npm run check:first-dollar-env"
