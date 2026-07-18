# Stripe Payment Link Setup for SMIRK

Use this when logged into Stripe to create the one owner-approved live first-dollar checkout: Starter at $197/month. Pro and Agency/Enterprise are future offers only; keep their Stripe Payment Links inactive and their Railway URL/ID values empty until a separate post-first-dollar approval expands the launch.

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
- Current status: **future offer; checkout disabled during first-dollar validation**

### Enterprise
- Plan id: `enterprise`
- Label: `SMIRK AI Agency`
- Price: **$697/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Agency Plan**
- Current status: **future offer; checkout disabled during first-dollar validation**
- Usage terms: **not owner-approved yet**. Do not expose Enterprise checkout or describe it as unlimited until the checked-in manifest records the approved public rule.

## In Stripe

Create **exactly one enabled SMIRK recurring monthly Payment Link** for the current launch:

1. `SMIRK AI Starter — $197/month` (only first-dollar checkout)

Keep every Pro and Agency/Enterprise Payment Link inactive, including any older link whose public URL may have been shared. Their prices may remain documented as future plans, but their checkout lanes and runtime entitlements stay disabled until a separate post-first-dollar review and approval.

The enabled Starter offer must use an active live, licensed, per-unit $197 Price. Metered billing, attached meters, tiered/custom amounts, transformed quantities, and Price-level default trials are not the approved immediate first-dollar offer and fail verification.

Use:
- success URL: `https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}`
- cancel URL: `https://smirkcalls.com/pricing`

Enable:
- email collection
- required business-name collection
- required phone-number collection
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

Record the exact approved `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION` on the Starter Payment Link as `smirk_customer_policy_version` in both the Payment Link metadata and its Subscription metadata. Checkout remains fail-closed until the live verifier confirms both copies match the checked-in owner-approved manifest and every required public policy document is reachable.

## After creating the links

Copy the final Starter Stripe checkout URL and exact `plink_` ID and save that pair to Railway. Set `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS` to a comma-separated exact-ID allowlist containing the current Starter ID. If a prior Starter link already produced paid Sessions, retain its exact ID in this list only after the prior Stripe Payment Link is inactive. Keep both URL/ID values empty for Pro and Enterprise; any broader or partial pair blocks first-dollar readiness.

The first-dollar setter is intentionally an all-at-once staging tool: it validates every value shown below, then saves the complete reviewed set without redeploying production. Run it from a fresh shell, pass the values inline, replace every placeholder, and use `--dry-run` first. Do not rely on old exported values from another operation. The dry run masks secrets, provider-verifies the proposed Starter link through Stripe, makes no Railway change, and computes a SHA-256 over the exact Railway project/service/environment IDs, exact local HEAD, and complete ordered unmasked assignment set. It prints only the digest, commit, assignment count, ordered key names, and masked command—not secret values.

```bash
APP_URL="https://ai-phone-agent-production-6811.up.railway.app" \
STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/replace-with-exact-live-link" \
STRIPE_PAYMENT_LINK_STARTER_ID="plink_replace_with_exact_live_id" \
STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS="plink_replace_with_exact_live_id" \
DISABLE_STRIPE_PAYMENT_LINK_PRO="true" \
DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE="true" \
STRIPE_REVENUE_READ_KEY="rk_live_replace" \
STRIPE_BILLING_PORTAL_KEY="rk_live_replace_separate_key" \
STRIPE_BILLING_PORTAL_CONFIGURATION_ID="bpc_replace" \
SMIRK_NATIVE_CHECKOUT_ENABLED="false" \
PHONE_AGENT_PROVISIONING_SECRET="<generate-a-random-32-plus-character-secret-and-match-the-landing-app>" \
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

### Phase 1: stage the exact pending manifest without activating it

After the dry-run assignments and printed digest are exact, approve the precise staging statement printed by the script. It has this shape:

```text
APPROVE_SMIRK_FIRST_DOLLAR_ENV_STAGE: digest=<exact-sha256-from-dry-run>; commit=<exact-head>; target=90599f03-6d6f-4044-8933-e0301be67a82/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2/22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a; action=stage-with-skip-deploys-only
```

Rerun the same fresh-shell command without `--dry-run` and add:

```bash
CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE="apply-smirk-first-dollar-live-env" \
CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST="<exact-sha256-from-dry-run>" \
npm run set:first-dollar-live-env
```

Keep every assignment from the approved dry run in that same command; the abbreviated block above shows only the two confirmations. The setter recomputes the digest before mutation and fails if the exact target, HEAD, order, key set, or any unmasked value changed. It writes all reviewed values plus `SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST`, `SMIRK_PENDING_FIRST_DOLLAR_ENV_KEYS`, `SMIRK_PENDING_FIRST_DOLLAR_ENV_COMMIT`, and `SMIRK_PENDING_FIRST_DOLLAR_ENV_SCHEMA` with Railway `--skip-deploys`.

This staging phase does not restart production or expose the new checkout. It does not require or grant `CONFIRM_SMIRK_REAL_STARTER_CHECKOUT`. Neither staging confirmation approves pricing or policy changes, outreach, an operator-initiated charge, Pro/Enterprise, or deployment of uncommitted code. Run `npm run cutover:sender-domain -- --dry-run` separately before using a new `FROM_EMAIL`; do not let the first-dollar setter invent or approve a sender identity.

### Phase 2: separately approve the deploy that activates checkout

After staging, run this read-only inspection:

```bash
npm run -s print:first-dollar-pending-env-activation
```

It reads the exact pinned Railway target, recomputes the SHA-256 from every staged unmasked value in the recorded order, and requires the sentinel commit to equal current HEAD. Review the exact digest, commit, target IDs, ordered keys, and this human approval statement printed by the command:

```text
APPROVE_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY: digest=<exact-staged-sha256>; commit=<exact-staged-commit>; target=90599f03-6d6f-4044-8933-e0301be67a82/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2/22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a; action=deploy-and-activate-starter-197-only
```

Use only the complete activation command printed by the inspector. Any deploy while a pending manifest exists fails unless all of these are simultaneously present and exact:

- existing production-deploy authority;
- `CONFIRM_SMIRK_DEPLOY_COMMIT=<exact-staged-commit>`;
- `CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=<exact-staged-sha256>`;
- `CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY=activate-reviewed-first-dollar-pending-env`;
- `CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly` after the separate `APPROVE_SMIRK_REAL_STARTER_CHECKOUT` human authority for buyer-initiated Starter subscriptions at the existing $197/month price.

Because staging requires a commit already live, activation may be a same-commit redeploy. Immediately before upload, `deploy.sh` captures the exact-target Railway deployment IDs and generates a one-use nonce-bound upload message containing the exact pending digest and commit. After upload it accepts only the new deployment carrying that exact message; an unrelated concurrent deployment cannot satisfy the wait. The receipt command independently re-queries Railway for that exact successful deployment, reruns the full live ship gate, and re-reads the staged manifest before recording `SMIRK_ACTIVATED_FIRST_DOLLAR_ENV_DIGEST` with `--skip-deploys`. It preserves the four pending-manifest sentinels as durable evidence. A direct or premature receipt invocation therefore fails closed. A later identical deploy is ordinary only while the receipt, recomputed manifest, and staged values still match; a newly staged or drifted digest becomes pending again and requires the complete activation authority.

This first-dollar setter is intentionally Starter-only. It rejects supplied Pro or Enterprise URLs/IDs, always clears both of those live pairs in the same inert staging write, and forces `SMIRK_NATIVE_CHECKOUT_ENABLED=false`; a broader offer requires a separate future approval and launch path.

Clearing a Railway URL or ID does **not** deactivate the hosted Stripe URL. Before opening checkout, deactivate every old SMIRK Starter, Pro, Agency, and legacy Enterprise Payment Link in Stripe, then leave only the newly approved Starter link active. The guarded setter and live Railway gate run the read-only `npm run check:first-dollar-payment-link-exclusivity` proof and fail unless Stripe has exactly that one active SMIRK Payment Link. That proof also retrieves every non-current ID in `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS` and fails unless each historical link is live-mode and inactive.

Do not enable a pre-existing link until its amount, recurring interval, plan mapping, and success redirect have been checked against the values above. Before rotating the current Starter ID, append the prior exact ID to `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`, deactivate that prior Stripe link, and require the exclusivity proof to pass. Never add an arbitrary ID or an active historical link. The public `buy.stripe.com` URL and the Stripe `plink_...` identifier are separate values; fulfillment requires both.

Create `STRIPE_REVENUE_READ_KEY` as a dedicated live restricted key with read access to Payment Links, Webhook Endpoints, Events, Checkout Sessions, Invoices, Invoice Payments, PaymentIntents, Charges, Balance Transactions, and Invoice line items. Do not substitute a broad secret key; this key is used only for read-only product, webhook-route, provider-delivery, and settled-revenue evidence.

Keep `SMIRK_NATIVE_CHECKOUT_ENABLED=false` for this Payment Link path. The Starter-only setter and local/live gates reject `true`, and the first-dollar runtime keeps native Checkout disabled even if configuration drifts, so the verified hosted Starter link remains the only checkout lane.

Keep the Agency/Enterprise link inactive and unavailable while its checked-in approval has `ownerApproved: false` or its machine-readable hard caps do not exactly match the enabled runtime `PLAN_LIMITS`. The current production limits are deliberately zero and disabled; there is no `-1` unlimited sentinel.

Configure exactly one enabled live Stripe webhook endpoint at the canonical `APP_URL` plus `/api/stripe/webhook`. Enable the Checkout Session completion events plus subscription, invoice-payment, refund, dispute, and `payment_link.updated` events named by `npm run check:railway:first-dollar-env`. After the endpoint and Railway secret are set, make one explicit, harmless Payment Link update in Stripe. The check requires Stripe's `delivery_success=true` evidence for that provider-origin event within 24 hours, proving the deployed signing secret accepted a real Stripe delivery before checkout can be considered ready.

## Verify

Run:

```bash
npm run check:first-dollar-payment-link-exclusivity
npm run check:railway:first-dollar-env
```

Expected result:
- exactly one enabled SMIRK Payment Link is active: the public Starter $197/month URL and exact `STRIPE_PAYMENT_LINK_STARTER_ID` binding pass provider verification
- every enabled hosted checkout requires business name and phone so fulfillment can bind the paid subscription to the correct buyer workspace
- Pro and Agency/Enterprise Railway pairs are absent and every known older provider-side link for those offers is inactive
- partial, duplicate, or drifted Starter bindings fail closed
- `FROM_EMAIL` is no longer placeholder
- the signed webhook, database, and buyer-email activation path also pass the first-dollar readiness gates

## Why this matters

SMIRK cannot be fully shipped end-to-end until:
- a buyer can pay online
- the payment path matches the public pricing
- owner-email delivery has a real sender address
