# Starter Checkout Configuration Record

**Date:** 2026-08-26  
**Scope:** First-dollar SMIRK Calls launch

## Legacy Link — Do Not Use for the New Public Flow

| Field | Verified value |
|---|---|
| Stripe account | GlassBox ai, live mode |
| Legacy link ID | `plink_1TZWlrIoSdlZwew1hdlTxEGs` |
| Legacy URL | `https://buy.stripe.com/4gMeVd5jBcUogCr4SK6Zy0f` |
| Price | $197/month |
| Status | Active |
| Defects | Does not collect business name or phone, does not require terms acceptance, has no SMIRK policy metadata, and uses Stripe’s default completion page. |

The legacy link must remain active only until the replacement has been created, validated, connected to SMIRK, and successfully tested. It must then be deactivated to preserve a single public checkout lane.

## Replacement Link — Approved Configuration

| Field | Required setting |
|---|---|
| Product | SMIRK Starter — Missed-Call Recovery |
| Price | $197 USD/month; one fixed recurring line item |
| Product promise | Up to 500 calls and 1,000 minutes/month, call summaries, and callback-ready follow-up tasks |
| Automatic tax | Off |
| Business name | Required |
| Phone number | Required |
| Terms acceptance | Required |
| Trial | Disabled |
| Promotion codes | Disabled |
| Address collection | Disabled |
| Tax ID collection | Disabled |
| Managed Payments | Disabled |
| Customer portal | Enabled only after policy verification and webhook testing |
| Completion | Redirect to `https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}` |
| Metadata | `smirk_customer_policy_version=1.0.0` on both Payment Link and subscription |

The replacement is being built in live mode against a copied product so that the legacy checkout remains unchanged until validation completes.

## Replacement Link — Current State

| Field | Verified value |
|---|---|
| Link ID | `plink_1U8tw3IoSdlZwew1jZOl3zKS` |
| URL | `https://buy.stripe.com/7sYaEX4fx4nScmbfxo6Zy0m` |
| Mode | Live |
| Product and price | SMIRK Starter — Missed-Call Recovery; $197/month |
| Required business name | Enabled |
| Required phone number | Enabled |
| Automatic tax | Disabled |
| Legacy checkout | Remains active until its replacement passes all checks |
| Still outstanding | Stripe terms acceptance, policy metadata, configured post-checkout redirect, and link-to-runtime binding |

The GlassBox live account has no active Account Status tasks. Its global public business settings are shared across unrelated GlassBox activity, so they must not be changed merely to configure SMIRK checkout.

## Shared Account Constraint

Stripe’s hosted Terms-of-Service checkbox requires a valid Terms URL in the account-level Public details. The currently authenticated live account is configured as **GlassBox ai** with business site `https://glass-box-ai-site.vercel.app/`, legal name Cameron Church, and shared support phone `(775) 420-4485`. Its public-details editor is account-wide, not Payment-Link-specific.

Do not replace that business name, website, or shared support details solely to make a SMIRK payment link pass a validation check. Any account-wide legal-link change must be deliberately compatible with all live GlassBox offers or use an account architecture that isolates SMIRK.

## Stripe Checkout Constraint

Stripe’s documentation states that its Payment Link Terms-of-Service checkbox requires a valid account-level Terms URL in Public details. Because the account-level public profile is shared with GlassBox, SMIRK cannot safely use that checkbox without a deliberate shared-account legal-link decision.

The replacement SMIRK link can still collect business name and phone, keep automatic tax off, and hold the SMIRK policy version metadata. For this shared-account launch, SMIRK should record and require buyer acknowledgement of its published terms in the SMIRK-owned checkout-entry experience rather than falsely representing a Stripe account-wide Terms configuration that does not exist.

## Catalog Reconciliation — 2026-08-26

The shared GlassBox live Payment Links catalog contains the **canonical** active launch lane:

- `SMIRK Starter — Missed-Call Recovery` — active, **$197/month**, created August 26.

It also contains an older active `SMIRK Starter` link at **$197/month**, created May 21, plus multiple historical deactivated SMIRK links at $49, $99, $149, $299, $397, $499, $599, $797, and $1,499.

Only the August 26 `SMIRK Starter — Missed-Call Recovery` link may be connected to SMIRK’s public conversion flow. The active May 21 $197 link must be inspected and deactivated only after the new canonical link is successfully verified and bound in production. No unrelated GlassBox links may be changed.

## Canonical Link Settings Observed

The canonical link is configured for a single `$197.00 USD / month` subscription. Its live checkout preview shows **business name, email, and phone** collection. Its product tax code is `General - Electronically Supplied Services`; **tax is not included in price** and the link’s automatic-tax setting is intentionally kept off under the approved Starter policy. The link must not collect shipping, tax IDs, optional products, quantity changes, promotions, or a trial.

Stripe’s canonical-link editor confirms: business-name collection and required phone collection are enabled; customer-name collection is off; product is not optional; customer address, trial, payment limits, custom fields, promotions, business tax IDs, and saved-payment-details are off. Stripe’s native Terms checkbox remains off because it requires a shared account-level legal URL, so SMIRK uses its own required landing acknowledgement bound to policy version `1.0.0`.

The canonical live URL is `https://buy.stripe.com/7sYaEX4fx4nScmbfxo6Zy0m`. It is active, has no promotion codes, does not collect addresses, uses the default Stripe confirmation page, and currently carries `smirk_customer_policy_version=1.0.0`. SMIRK must add the scoped acknowledgement and email-activation metadata before its runtime verifier binds this URL.

The canonical link exposes a Payment Link–specific **Edit metadata** control. This allows SMIRK’s policy version, landing acknowledgement mode, and email-activation mode to be bound without editing the shared GlassBox account profile or any unrelated payment link.

## Deployment Configuration Surface

The production `ai-phone-agent` Railway service exposes 68 service variables, including `APP_URL`, `AUTO_FULFILL_PROVISIONING_REQUESTS`, `FROM_EMAIL`, `FROM_NAME`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_ENABLED`. The canonical Starter Payment Link binding must be updated only through the SMIRK-specific Stripe variables; no generic GlassBox account or unrelated product configuration may be changed.

Railway’s current `STRIPE_PAYMENT_LINK_STARTER` points to stale URL `https://buy.stripe.com/4gMeVd5jBcUogCr4SK6Zy0f`, not the canonical August 26 $197 link. It must be replaced with `https://buy.stripe.com/7sYaEX4fx4nScmbfxo6Zy0m`; the canonical `STRIPE_PAYMENT_LINK_STARTER_ID` must be `plink_1U8tw3IoSdlZwew1jZOl3zKS`, and fulfillment must accept only that ID after cutover.

The Railway service exposes all three required SMIRK-specific keys together: `STRIPE_PAYMENT_LINK_STARTER`, `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`, and `STRIPE_PAYMENT_LINK_STARTER_ID`. They must be cut over atomically to the canonical August 26 link to prevent successful payment on a legacy link from attaching to the wrong fulfillment contract.
