# SMIRK Operations Status — 2026-08-18

## Purpose

This record separates **verified technical evidence** from **authorization to take customer money**. It is an operational status document, not legal advice, a customer policy, or an approval to enable recurring billing.

## Verified Evidence

| System | Verified state | Boundary |
|---|---|---|
| Railway callback deployment | Healthy after a controlled restart; the health endpoint reported `ok`. | This proves the active container is running, not that it matches local source. |
| Stripe Test mode | A separate SMIRK Starter $197/month product, Payment Link, and sandbox subscription completed. Stripe emitted checkout, subscription, invoice, invoice-payment, payment-intent, and charge success events. | No real money moved and no production workspace was provisioned. |
| Velvet inbound receiver | A synthetic authenticated receipt returned `201`; an exact replay returned `200 DUPLICATE` with the same handoff/task; an invalid bearer returned `401`. | The synthetic proof created no real prospect, call, SMS, email, or paid action. |
| Starter limits | Runtime denies admission when either 500 calls or 1,000 minutes is reached. | This is an enforcement invariant, not an approved public usage policy by itself. |
| Recording behavior | Standard call handling does not enable general recording; voicemail artifacts and outbound consent disclosures are separate paths. | Retention settings never substitute for recording consent or jurisdiction-specific review. |

## Live Billing Gate

The owner’s business choices are recorded in [`launch/owner-policy-decisions-2026-08-15-v1.md`](./launch/owner-policy-decisions-2026-08-15-v1.md). They authorize implementation and sandbox validation only. The compiled customer-policy approval manifest remains **not approved**.

Live recurring checkout must remain disabled until a qualified reviewer completes the customer-policy package, six distinct public HTTPS documents are published on the trusted SMIRK origin, Stripe Terms acceptance and Billing Portal settings match the approved policy version, the signed live Stripe webhook has current provider-delivery proof, and an explicitly approved production fulfillment proof is recorded.

## Release Path Risk

The active direct Railway callback deployment is healthy, but GitHub-sourced release eligibility is degraded. The scheduled Monthly Usage Reset workflow calls the correct endpoint with an empty `PHONE_AGENT_PROVISIONING_SECRET`, receives `401`, and records a failed commit check. Railway may skip a source deployment when that failed check is attached to the candidate commit.

The required repair has two independent parts. First, the repository owner must store the same provisioning credential already configured in Railway as the **GitHub Actions Secret** `PHONE_AGENT_PROVISIONING_SECRET`; never copy the value into a document or commit. Second, push the prepared workflow change that converts a failed monthly maintenance run into an explicit maintenance issue/alert instead of a release-blocking commit check. The active GitHub integration currently lacks both workflow-file and Actions-secret write permission.

## Source-Deployment Reconciliation

The deployed Velvet receiver is proven live, but the current `main` checkout does not contain the Velvet route or its environment contract. This is source/deployment drift. Before a normal source-driven release is considered reliable, the receiver implementation must be reconciled into the repository, reviewed, tested, and deployed through the repaired GitHub-to-Railway path.

## Immediate Next Actions

1. Give the release operator or GitHub integration permission to modify workflows and Actions secrets, then set the missing scheduled-reset secret without revealing it.
2. Push the isolated monthly-reset workflow repair and confirm the next GitHub-sourced Railway deployment is eligible and healthy.
3. Reconcile the deployed Velvet receiver source into `main`; preserve distinct inbound and outcome-only credentials.
4. Complete qualified policy review and publish the customer-policy documents before enabling live recurring checkout.
5. Run the explicitly approved live Stripe webhook/provisioning proof only after the preceding gates are satisfied.
