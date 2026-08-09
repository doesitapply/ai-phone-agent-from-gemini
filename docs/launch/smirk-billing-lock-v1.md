# SMIRK Billing Lock V1

Locked: 2026-07-31

This is the commercial source of truth for the first paid SMIRK offer. It locks the business decision; it does not claim that customer policies are legally approved, Stripe is fully configured, checkout is live, production matches this repository, or revenue has been collected.

## The one offer

- **Name:** SMIRK Missed-Call Recovery
- **Price:** $197 USD per month
- **Billing:** Monthly recurring subscription, charged in advance
- **Customer:** One business
- **Service:** One recovery number

Included:

- Caller name, job need, urgency, and callback-number capture
- Owner email alerts
- Callback task queue
- Proof dashboard
- Standard setup
- Up to 200 calls or 500 minutes per billing month, whichever happens first

The usage limit is a hard stop. There are no overage charges. Service pauses at the first limit reached and resumes at the next paid billing period unless the owner separately approves a different plan in writing.

Not offered:

- Setup fee
- Free trial
- Annual contract or annual discount
- Coupon, promotion code, or introductory discount
- Add-on or overage purchase
- Public Founders, Pro, Agency, Enterprise, or custom-price lane
- Multiple businesses, multiple recovery numbers, or reseller use

## Billing rules

- The first $197 charge is due at checkout. Renewal is due on the monthly anniversary.
- The subscription is month-to-month and continues until canceled.
- Cancellation is effective at the end of the current paid period. There is no proration for unused time.
- A failed renewal gets a seven-calendar-day payment-recovery window. Service pauses if payment remains unpaid after that window and resumes only after successful payment.
- Duplicate or erroneous charges are refundable after verification. All other payments are non-refundable, except a documented material service outage may receive a discretionary prorated credit or refund approved by Cameron Doyle Church.
- $197 excludes any tax legally required at checkout. Sales remain disabled until Stripe tax settings and the launch jurisdiction are verified.
- The Stripe-hosted customer portal is the only self-service cancellation and payment-management path once its exact live configuration is verified.

## MRR definition

**Collected MRR = $197 × verified active paying subscriptions.**

A subscription counts only when it is live, its latest invoice is paid, it is not a test record, and it has not been fully refunded or disputed. Trials, free accounts, internal accounts, coupons, `past_due`, `unpaid`, and test-mode subscriptions contribute $0. A subscription set to cancel at period end counts through its paid-through date, then contributes $0. Taxes are excluded. ARR is collected MRR multiplied by 12.

| Paying customers | Collected MRR | ARR run rate |
| ---: | ---: | ---: |
| 1 | $197 | $2,364 |
| 5 | $985 | $11,820 |
| 10 | $1,970 | $23,640 |
| 25 | $4,925 | $59,100 |
| 50 | $9,850 | $118,200 |
| 51 | $10,047 | $120,564 |
| 100 | $19,700 | $236,400 |

Initial operating target: **10 verified paying customers and $1,970 collected MRR.** The first proof milestone remains one retained paying customer who receives useful callback-ready work and voluntarily renews.

## Unit-economics guardrail

At the planning benchmark of $0.11 per voice minute, the 500-minute cap limits modeled voice cost to $55 per customer-month. That leaves $142, or 72.1%, before messaging, email, infrastructure, support, refunds, and payment fees. This is a planning assumption, not a verified production margin; the actual blended cost must be measured before the cap or price changes.

## Stripe target state

Keep only this recurring live checkout candidate:

- Product: `prod_UXwxEQpWExYHqZ`
- Price: `price_1TYr3wIoSdlZwew1Ug8cbIRI`
- Payment Link: `plink_1TZWlrIoSdlZwew1hdlTxEGs`
- URL: `https://buy.stripe.com/4gMeVd5jBcUogCr4SK6Zy0f`

Before activation, that link must have:

- Promotion codes disabled
- Customer business name and phone required
- Terms acceptance required
- One verified canonical success redirect
- Exact SMIRK product, plan, and approved-policy-version metadata
- Automatic tax enabled only after the Stripe tax account and launch jurisdiction are verified

Cleanup target:

- Deactivate the other 12 live SMIRK Payment Links
- Disable all four active SMIRK promotion codes
- Archive superseded SMIRK products and prices only after the dashboard confirms they have no active subscriptions
- Remove public Pro, Agency, Enterprise, Founders, discount, and alternate-price routes from the application and deployment configuration

## Activation gates

This offer may be sold only after all of the following are independently verified:

1. The exact six customer-policy documents are published, reviewed, and owner-approved.
2. Stripe tax, customer portal, checkout fields, terms acceptance, redirect, and webhook behavior are verified in the correct live account.
3. Railway contains only the canonical Starter Payment Link and fulfillment IDs.
4. The deployed commit and public domain match this pricing and usage policy.
5. A real checkout, fulfillment, callback-ready result, and retained payment pass the qualifying-revenue verifier.

Until then, the commercial decision is locked but checkout remains closed.
