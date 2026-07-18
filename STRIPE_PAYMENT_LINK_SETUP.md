# Stripe Payment Link Setup for SMIRK

Use this when logged into Stripe to create at least one owner-approved live Starter or Pro checkout link. One exact core offer is sufficient for the first-dollar path; every additional configured offer must pass the same checks. Agency/Enterprise stays disabled until its separate usage approval is complete.

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

Create **at least one enabled recurring monthly payment link**. The fastest path is the primary Starter offer; enable Pro too only when its full pair is ready:

1. `SMIRK AI Starter — $197/month` (primary first-dollar path)
2. `SMIRK AI Pro — $397/month` (optional second core offer)

Do not create or activate the `SMIRK AI Agency — $697/month` checkout yet. Its price may remain visible as a future plan, but its CTA and runtime entitlement stay disabled until the checked-in machine-readable hard caps are owner-approved and match enforcement.

Each enabled core offer must use an active live, licensed, per-unit Price. Metered billing, attached meters, tiered/custom amounts, transformed quantities, and Price-level default trials are not the published $197/$397 immediate first-dollar offer and fail verification.

Use:
- success URL: `https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}`
- cancel URL: `https://smirkcalls.com/pricing`

Enable:
- email collection
- card payments
- Apple Pay / Google Pay
- Terms of Service consent collection as required
- the exact automatic-tax setting selected in the approved checked-in policy manifest

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

Set the configuration's Terms and Privacy URLs plus cancellation mode and proration behavior to exactly match the approved checked-in policy manifest. Record its exact `bpc_...` ID as `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Create `STRIPE_BILLING_PORTAL_KEY` as a separate dedicated `rk_live_...` restricted key with only Billing Portal configuration read and Billing Portal session write access. It must be a different credential from `STRIPE_REVENUE_READ_KEY`; do not use `STRIPE_SECRET_KEY` for either role.

The authenticated workspace Settings page calls `POST /api/billing/portal`. The server ignores body-supplied tenant/customer IDs, uses the authenticated workspace's stored `stripe_customer_id`, sets the exact configuration ID and trusted SMIRK return URL, and returns Stripe's short-lived hosted session. First-dollar readiness retrieves the configuration through the dedicated key, caches the proof briefly, and fails closed unless the configuration is live, active, and has all three features enabled.

Record the exact approved `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION` on each Payment Link as `smirk_customer_policy_version` in both the Payment Link metadata and its Subscription metadata. Native Checkout does this automatically; Payment Links remain fail-closed until the live verifier confirms both copies match the checked-in owner-approved manifest and every required public policy document is reachable.

## After creating the links

Copy the final Stripe checkout URL and exact `plink_` ID for at least one core offer and save them to Railway. Omit both values for any core offer that is not enabled; a partial pair fails closed.

The first-dollar setter is intentionally an all-at-once production cutover tool: it validates and rewrites every value shown below. Run it from a fresh shell, pass the values inline, replace every placeholder, and use `--dry-run` first. Do not rely on old exported values from another operation. The dry run masks secrets, provider-verifies every proposed core link through Stripe, and makes no Railway change.

```bash
APP_URL="https://ai-phone-agent-production-6811.up.railway.app" \
STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/replace-with-exact-live-link" \
STRIPE_PAYMENT_LINK_STARTER_ID="plink_replace_with_exact_live_id" \
DISABLE_STRIPE_PAYMENT_LINK_PRO="true" \
DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE="true" \
STRIPE_REVENUE_READ_KEY="rk_live_replace" \
STRIPE_BILLING_PORTAL_KEY="rk_live_replace_separate_key" \
STRIPE_BILLING_PORTAL_CONFIGURATION_ID="bpc_replace" \
SMIRK_NATIVE_CHECKOUT_ENABLED="false" \
PHONE_AGENT_PROVISIONING_SECRET="replace-with-matching-landing-secret" \
AUTO_FULFILL_PROVISIONING_REQUESTS="true" \
SMIRK_CUSTOMER_POLICY_APPROVED_VERSION="exact-version-from-approved-manifest" \
RESEND_API_KEY="re_replace" \
FROM_EMAIL="SMIRK <alerts@smirkcalls.com>" \
NOTIFICATION_EMAIL="operator@smirkcalls.com" \
BOOKING_LINK="https://calendly.com/smirkcalls/smirk-setup" \
LANDING_APP_URL="https://smirkcalls.com" \
GOOGLE_OAUTH_CLIENT_ID="replace.apps.googleusercontent.com" \
TWILIO_ACCOUNT_SID="ACreplace" \
TWILIO_AUTH_TOKEN="replace-with-parent-token" \
WORKSPACE_SECRET_ENCRYPTION_KEY="replace-with-at-least-32-random-characters" \
OPENROUTER_API_KEY="sk-or-v1-replace" \
OPENROUTER_ENABLED="true" \
FAST_LIVE_CALLS="false" \
CARTESIA_API_KEY="replace-with-streaming-tts-key" \
npm run set:first-dollar-live-env -- --dry-run
```

After the dry-run assignments are exact and the business-owner policy approval is complete, rerun the same fresh-shell command without `--dry-run` and add both `CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE="apply-smirk-first-dollar-live-env"` and `CONFIRM_SMIRK_REAL_STARTER_CHECKOUT="accept-buyer-initiated-starter-197-monthly"`. The first token applies only the reviewed live environment write; the second corresponds only to the separately approved human authority to accept buyer-initiated Starter subscriptions at the existing $197/month price. Neither token approves pricing or policy changes, outreach, an operator-initiated charge, Pro/Enterprise, or deployment of uncommitted code. Run `npm run cutover:sender-domain -- --dry-run` separately before using a new `FROM_EMAIL`; do not let the first-dollar setter invent or approve a sender identity.

This first-dollar setter is intentionally Starter-only. It rejects supplied Pro or Enterprise URLs/IDs, always clears both of those live pairs in the same Railway write, and forces `SMIRK_NATIVE_CHECKOUT_ENABLED=false`; a broader offer requires a separate future approval and launch path.

Do not enable a pre-existing link until its amount, recurring interval, plan mapping, and success redirect have been checked against the values above. The public `buy.stripe.com` URL and the Stripe `plink_...` identifier are separate values; fulfillment requires both.

Create `STRIPE_REVENUE_READ_KEY` as a dedicated live restricted key with read access to Payment Links, Webhook Endpoints, Events, Checkout Sessions, Invoices, Invoice Payments, PaymentIntents, Charges, Balance Transactions, and Invoice line items. Do not substitute a broad secret key; this key is used only for read-only product, webhook-route, provider-delivery, and settled-revenue evidence.

Keep `SMIRK_NATIVE_CHECKOUT_ENABLED=false` for this Payment Link path. The Starter-only setter rejects `true` because the shared native Checkout route could expose plans outside the Starter approval scope.

Keep the Agency/Enterprise link inactive and unavailable while its checked-in approval has `ownerApproved: false` or its machine-readable hard caps do not exactly match the enabled runtime `PLAN_LIMITS`. The current production limits are deliberately zero and disabled; there is no `-1` unlimited sentinel.

Configure exactly one enabled live Stripe webhook endpoint at the canonical `APP_URL` plus `/api/stripe/webhook`. Enable the Checkout Session completion events plus subscription, invoice-payment, refund, dispute, and `payment_link.updated` events named by `npm run check:railway:first-dollar-env`. After the endpoint and Railway secret are set, make one explicit, harmless Payment Link update in Stripe. The check requires Stripe's `delivery_success=true` evidence for that provider-origin event within 24 hours, proving the deployed signing secret accepted a real Stripe delivery before checkout can be considered ready.

## Verify

Run:

```bash
npm run check:railway:first-dollar-env
```

Expected result:
- at least one enabled public Starter/Pro `STRIPE_PAYMENT_LINK_*` URL and exact `STRIPE_PAYMENT_LINK_*_ID` binding passes provider verification
- every additional configured core offer passes the same exact provider verification; partial or drifted pairs fail closed
- Enterprise is absent unless its separate owner approval, public usage policy, and matching runtime hard caps are complete
- `FROM_EMAIL` is no longer placeholder
- the signed webhook, database, and buyer-email activation path also pass the first-dollar readiness gates

## Why this matters

SMIRK cannot be fully shipped end-to-end until:
- a buyer can pay online
- the payment path matches the public pricing
- owner-email delivery has a real sender address
