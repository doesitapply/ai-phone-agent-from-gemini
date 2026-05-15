# Stripe Payment Link Setup for SMIRK

Use this when logged into Stripe to create the three live checkout links that unblock paid signup.

These values must match the current live plan definitions in the app.

## Canonical plan values

### Starter
- Plan id: `starter`
- Label: `SMIRK AI Starter`
- Price: **$299/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Starter Plan**

### Pro
- Plan id: `pro`
- Label: `SMIRK AI Pro`
- Price: **$599/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Pro Plan**

### Enterprise
- Plan id: `enterprise`
- Label: `SMIRK AI Enterprise`
- Price: **$1499/month**
- Billing: **Recurring monthly subscription**
- CTA text: **Start Enterprise Plan**

## In Stripe

Create **three recurring monthly payment links**:

1. `SMIRK AI Starter — $299/month`
2. `SMIRK AI Pro — $599/month`
3. `SMIRK AI Enterprise — $1499/month`

Use:
- success URL: `https://smirkcalls.com/success`
- cancel URL: `https://smirkcalls.com/pricing`

Enable:
- email collection
- customer portal access
- card payments
- Apple Pay / Google Pay

Disable for V1:
- promo-code complexity
- upsells
- shipping
- trial periods
- quantity edits

## After creating the links

Copy the final Stripe checkout URLs and save them to Railway:

```bash
STRIPE_PAYMENT_LINK_STARTER="https://buy.stripe.com/..." \
STRIPE_PAYMENT_LINK_PRO="https://buy.stripe.com/..." \
STRIPE_PAYMENT_LINK_ENTERPRISE="https://buy.stripe.com/..." \
FROM_EMAIL="SMIRK <alerts@smirkcalls.com>" \
npm run cutover:sender-domain -- --dry-run
npm run set:first-dollar-live-env
```

## Verify

Run:

```bash
npm run check:railway:first-dollar-env
```

Expected result:
- all 3 `STRIPE_PAYMENT_LINK_*` values pass
- `FROM_EMAIL` is no longer placeholder

## Why this matters

SMIRK cannot be fully shipped end-to-end until:
- a buyer can pay online
- the payment path matches the public pricing
- owner-email delivery has a real sender address
