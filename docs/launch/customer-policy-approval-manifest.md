# Customer Policy Approval Manifest

Current status: NOT APPROVED.

The compiled gate lives in `src/customer-policy-approval.js`. It is deliberately checked in with `approvalState: "not_approved"`, no version, no approver, no publication URLs, no content digests or markers, and no Enterprise usage decision. An environment value such as `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION=anything` cannot enable recurring checkout.

This file and the manifest are an approval mechanism, not legal terms. Codex, application code, and deployment scripts must not draft, infer, or mark these policies approved. The business owner and an appropriately qualified reviewer must complete the decisions in `docs/launch/first-dollar-policy-decisions.md` and publish the actual customer-facing documents first.

Before the checked-in manifest may change to approved, all of the following evidence is required:

- one exact policy version approved by the business owner, with the approver and timestamp recorded;
- seven unique stable public HTTPS URLs on a trusted SMIRK production origin for Terms, Privacy, cancellation/refund, billing management, support, data/recording consent, and Enterprise usage;
- the same exact version recorded for every document and in `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION`;
- a checked-in SHA-256 digest of the exact approved response bytes and a unique embedded marker containing the document name and approved version for every document;
- live verification that every URL returns the exact non-empty approved bytes and marker without redirects. A bodyless 2xx response, generic SPA index, wrong digest, or one page reused for multiple documents fails;
- an explicit owner-approved, machine-readable Enterprise `hard_cap` rule and matching public URL/digest/marker. The rule must provide positive integer monthly call and monthly minute caps that the runtime actually enforces; this repository must not choose them for the owner;
- exact equality between those approved Enterprise caps and an enabled shared runtime `PLAN_LIMITS.enterprise` enforcement record;
- an exact live Stripe Billing Portal configuration, verified with its dedicated restricted key, with invoice history, payment-method update, and cancellation enabled;
- Stripe Payment Link and Subscription metadata updated to the exact approved version only after the publication gate passes.

Until then:

- `/api/first-dollar-readiness` must report `customerPolicyReady=false` and list the blockers;
- `/api/checkout/create` must reject recurring checkout before creating a charge;
- the pricing surface must not claim Enterprise is uncapped and must show checkout as unavailable;
- Agency/Enterprise runtime limits remain zero and disabled until the owner approves concrete caps; no `-1` value is interpreted as a commercial unlimited promise;
- no readiness script may treat a regex-shaped environment marker as owner approval.

After genuine approval and publication, update the manifest in a reviewed change, set the exact matching environment version, and run:

```bash
npm run check:customer-policy-approval
npm run check:customer-policy-approval:live
npm run check:railway:first-dollar-env
```
