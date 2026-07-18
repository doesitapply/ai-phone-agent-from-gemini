# Stripe Payment Link Setup for SMIRK

Use this when logged into Stripe to create the two owner-approved live checkout links that unblock Starter/Pro paid signup. Agency/Enterprise stays disabled until its separate usage approval is complete.

These values must match the current live plan definitions in the app.

## Canonical plan values

### Starter
- Plan id: `starter`
- Label: `SMIRK AI Starter`
- Price: **$197/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Starter Plan**

### Pro
- Plan id: `pro`
- Label: `SMIRK AI Pro`
- Price: **$397/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Pro Plan**

### Enterprise
- Plan id: `enterprise`
- Label: `SMIRK AI Agency`
- Price: **$697/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Agency Plan**
- Usage terms: **not owner-approved yet**. Do not expose Enterprise checkout or describe it as unlimited until the checked-in manifest records the approved public rule.

## In Stripe

Create **two enabled recurring monthly payment links**:

1. `SMIRK AI Starter — $197/month`
2. `SMIRK AI Pro — $397/month`

Do not create or activate the `SMIRK AI Agency — $697/month` checkout yet. Its price may remain visible as a future plan, but its CTA and runtime entitlement stay disabled until the checked-in machine-readable hard caps are owner-approved and match enforcement.

Use:
- success URL: `https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}`
- cancel URL: `https://smirkcalls.com/pricing`

Enable:
- email collection
- card payments
- Apple Pay / Google Pay

Disable for V1:
- promo-code complexity
- upsells
- shipping
- trial periods
- quantity edits

Before activation, complete and approve `docs/launch/first-dollar-policy-decisions.md`. Configure the approved Terms, Privacy, cancellation/refund, tax, support, and billing-portal choices in Stripe and the public site; this runbook does not invent those business or legal terms.

## Authenticated Billing Portal (required before checkout)

Create one explicit live Stripe Billing Portal configuration and enable all three required customer features:

- invoice history;
- payment method update;
- subscription cancellation using the exact owner-approved cancellation behavior.

Record its exact `bpc_...` ID as `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Create `STRIPE_BILLING_PORTAL_KEY` as a separate dedicated `rk_live_...` restricted key with only Billing Portal configuration read and Billing Portal session write access. Do not use `STRIPE_SECRET_KEY` or the revenue-evidence key for this route.

The authenticated workspace Settings page calls `POST /api/billing/portal`. The server ignores body-supplied tenant/customer IDs, uses the authenticated workspace's stored `stripe_customer_id`, sets the exact configuration ID and trusted SMIRK return URL, and returns Stripe's short-lived hosted session. First-dollar readiness retrieves the configuration through the dedicated key, caches the proof briefly, and fails closed unless the configuration is live, active, and has all three features enabled.

Record the exact approved `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION` on each Payment Link as `smirk_customer_policy_version` in both the Payment Link metadata and its Subscription metadata. Native Checkout does this automatically; Payment Links remain fail-closed until the live verifier confirms both copies match the checked-in owner-approved manifest and every required public policy document is reachable.

## After creating the links

Copy the final Stripe checkout URLs and save them to Railway:

```bash
STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/..." \
STRIPE_PAYMENT_LINK_STARTER_ID="plink_..." \
STRIPE_PAYMENT_LINK_PRO="https://buy.stripe.com/..." \
STRIPE_PAYMENT_LINK_PRO_ID="plink_..." \
STRIPE_REVENUE_READ_KEY="rk_live_..." \
STRIPE_BILLING_PORTAL_KEY="rk_live_..." \
STRIPE_BILLING_PORTAL_CONFIGURATION_ID="bpc_..." \
SMIRK_CUSTOMER_POLICY_APPROVED_VERSION="exact-version-from-approved-manifest" \
FROM_EMAIL="SMIRK <alerts@smirkcalls.com>" \
NOTIFICATION_EMAIL="operator@smirkcalls.com" \
npm run cutover:sender-domain -- --dry-run
npm run set:first-dollar-live-env
```

Do not enable a pre-existing link until its amount, recurring interval, plan mapping, and success redirect have been checked against the values above. The public `buy.stripe.com` URL and the Stripe `plink_...` identifier are separate values; fulfillment requires both.

Create `STRIPE_REVENUE_READ_KEY` as a dedicated live restricted key with read access to Payment Links, Webhook Endpoints, Events, Checkout Sessions, Invoices, Invoice Payments, PaymentIntents, Charges, Balance Transactions, and Invoice line items. Do not substitute a broad secret key; this key is used only for read-only product, webhook-route, provider-delivery, and settled-revenue evidence.

Keep the Agency/Enterprise link inactive and unavailable while its checked-in approval has `ownerApproved: false` or its machine-readable hard caps do not exactly match the enabled runtime `PLAN_LIMITS`. The current production limits are deliberately zero and disabled; there is no `-1` unlimited sentinel.

Configure exactly one enabled live Stripe webhook endpoint at the canonical `APP_URL` plus `/api/stripe/webhook`. Enable the Checkout Session completion events plus subscription, invoice-payment, refund, dispute, and `payment_link.updated` events named by `npm run check:railway:first-dollar-env`. After the endpoint and Railway secret are set, make one explicit, harmless Payment Link update in Stripe. The check requires Stripe's `delivery_success=true` evidence for that provider-origin event within 24 hours, proving the deployed signing secret accepted a real Stripe delivery before checkout can be considered ready.

## Verify

Run:

```bash
npm run check:railway:first-dollar-env
```

Expected result:
- the 2 enabled public Starter/Pro `STRIPE_PAYMENT_LINK_*` URLs and exact `STRIPE_PAYMENT_LINK_*_ID` bindings pass
- `FROM_EMAIL` is no longer placeholder
- the signed webhook, database, and buyer-email activation path also pass the first-dollar readiness gates

## Why this matters

SMIRK cannot be fully shipped end-to-end until:
- a buyer can pay online
- the payment path matches the public pricing
- owner-email delivery has a real sender address
