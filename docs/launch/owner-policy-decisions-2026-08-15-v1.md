# SMIRK First-Dollar Owner Decision Record — 2026-08-15-v1

> **Status: implementation-authorized; qualified review pending; live recurring checkout remains disabled.**
>
> This records the business choices supplied by Cameron Church. It is not a Terms of Service, Privacy Policy, legal review, customer-policy approval manifest, or authorization to activate live recurring charges.

The corresponding non-activating machine-readable record is [`customer-policy-business-choices-2026-08-15-v1.json`](./customer-policy-business-choices-2026-08-15-v1.json).

## Confirmed Business Choices

| Area | Decision |
|---|---|
| Policy version | `2026-08-15-v1` |
| Business owner | Cameron Church |
| Tax handling | Stripe Automatic Tax |
| Cancellation | Effective at the end of the current paid billing period |
| Cancellation proration | None |
| Starter included usage | 500 calls and 1,000 minutes per monthly billing period |
| Starter enforcement | A hard stop occurs when **either** the call limit or minute limit is reached; the allowances are independent, not cumulative |
| Refund handling | No pro-rata refunds. Duplicate charges, billing errors, and verified service failures are reviewed within two business days. |
| Billing management | Stripe-hosted customer portal |
| Default operational-data retention | Call recordings and related operational data retained for 90 days by default |
| Operational-data access | Customer account personnel and authorized SMIRK personnel only, for support and security purposes |
| Deletion requests | Submitted through support and processed subject to legal and security retention requirements |
| Public proof | SMIRK-owned demo workspace only unless a customer separately gives express permission |

## Recording Is a Separate Compliance Gate

The 90-day retention decision does **not** authorize recording. Recording must remain disabled, or an appropriate disclosure/consent workflow must be used, where law, state configuration, customer policy, or call context requires it. The live implementation must continue to evaluate recording consent separately from storage and retention.

## Still Required Before Live Recurring Charges

The following remain explicitly unresolved and must not be inferred by code:

1. The owner-approval timestamp for the final reviewed documents.
2. The qualified reviewer's name, role, and review-completion timestamp.
3. The finalized public Terms, Privacy, cancellation/refund, billing management, support, and data/recording-consent documents.
4. Exact support identity: support email, response target, escalation owner, and customer-facing business identity.
5. The six stable `https://smirkcalls.com/...` document URLs, their exact response-byte SHA-256 digests, and unique version markers.
6. Stripe Billing Portal configuration proof, Payment Link terms acceptance and buyer-field configuration, webhook proof, and completed test-mode fulfillment proof.

## Required Implementation Invariants

- `PLAN_LIMITS.starter` must remain exactly `500` calls and `1,000` minutes, with both limits enabled.
- Workspace admission must deny a new call when `calls_this_month >= monthly_call_limit` **or** `minutes_this_month >= monthly_minute_limit`.
- No policy environment variable, decision record, or date string can independently activate live checkout.
- The checked-in `CUSTOMER_POLICY_APPROVAL_MANIFEST` remains `not_approved` until final documents and qualified review are complete.

## Implementation Verification

The active `PLAN_LIMITS.starter` record is `500` calls and `1,000` minutes. Workspace admission denies a call when the monthly call count is at or above its call cap, and separately denies a call when monthly minutes are at or above the minute cap. The implementation therefore applies the approved **either-limit** hard-stop rule.

Standard SMIRK call handling does not enable a general Twilio call-recording instruction. The production recording path currently concerns voicemail artifacts. Outbound prospecting separately derives an all-party-consent disclosure requirement from the dialed number's state and injects the disclosure into the agent instruction. This is an operational control, not a substitute for the final customer-facing data/recording-consent policy or jurisdiction-specific review.

## Stripe Sandbox Validation — 2026-08-15

A separate Stripe Test-mode product and Payment Link were created for `SMIRK Starter — Test` at `$197.00` per month. The link collects a full name, business name, and phone number. A sandbox Visa `4242` subscription completed successfully with the test buyer identity `smirk-checkout-test@example.com`.

Stripe emitted `checkout.session.completed`, `customer.subscription.created`, `invoice.paid`, `invoice_payment.paid`, `payment_intent.succeeded`, and `charge.succeeded` events for the `$197.00` test transaction. This validates Stripe-side subscription collection, customer creation, invoice creation, and event emission.

The production fulfillment path correctly does **not** accept this test transaction: it requires an allowlisted live Payment Link, a `cs_live_...` Checkout Session, a live restricted verification key, customer-policy approval, and provider proof. This is intentional fail-closed behavior. No production workspace was provisioned from the sandbox purchase, and none should be until the live gate conditions in this document are satisfied.
