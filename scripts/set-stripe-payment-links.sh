#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
FAIL scripts/set-stripe-payment-links.sh is deprecated and performs no Railway writes.

The legacy setter accepted URL-only Starter and Pro values, could write placeholders,
and could not bind signed fulfillment to exact Stripe plink_ IDs. Use the guarded
first-dollar setter with at least one complete core URL + ID pair instead:

  STRIPE_PAYMENT_LINK_STARTER='https://buy.stripe.com/exact-live-link' \
  STRIPE_PAYMENT_LINK_STARTER_ID='plink_exact_live_id' \
  DISABLE_STRIPE_PAYMENT_LINK_PRO=true \
  DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE=true \
  npm run set:first-dollar-live-env

Use the complete Pro pair instead if Pro is the selected first-dollar offer. The
guarded setter rejects placeholders, partial pairs, and disable-plus-set conflicts.
EOF

exit 1
