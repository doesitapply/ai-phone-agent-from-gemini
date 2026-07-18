# Customer Policy Approval Manifest

Current status: NOT APPROVED.

The compiled gate lives in `src/customer-policy-approval.js`. It is deliberately checked in with `approvalState: "not_approved"`, no version, no approver, no publication URLs, no content digests or markers, and no Enterprise usage decision. An environment value such as `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION=anything` cannot enable recurring checkout.

This file and the manifest are an approval mechanism, not legal terms. Codex, application code, and deployment scripts must not draft, infer, or mark these policies approved. The business owner and an appropriately qualified reviewer must complete the decisions in `docs/launch/first-dollar-policy-decisions.md` and publish the actual customer-facing documents first.

Before the checked-in manifest may change to approved, all of the following evidence is required:

- one exact policy version approved by the business owner, with the approver and timestamp recorded;
- six unique stable public HTTPS URLs on a trusted SMIRK production origin for the core Terms, Privacy, cancellation/refund, billing management, support, and data/recording-consent documents;
- the same exact version recorded for every document and in `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION`;
- a checked-in SHA-256 digest of the exact approved response bytes and a unique embedded marker containing the document name and approved version for every document;
- live verification that every URL returns the exact non-empty approved bytes and marker without redirects. A bodyless 2xx response, generic SPA index, wrong digest, or one page reused for multiple documents fails;
- explicit owner-approved machine-readable tax mode, cancellation mode, and cancellation proration behavior. The checked-in manifest keeps these values null until the owner and qualified reviewer choose them; this repository must not infer them;
- an explicit owner-approved Starter `hard_cap` usage rule with positive monthly call and minute caps that exactly equal the enabled `PLAN_LIMITS.starter` enforcement values. The current first-dollar path supports no overage model; if the owner chooses overages or different public copy, implementation and copy must change before approval rather than silently converting that choice to a hard stop;
- before Enterprise is enabled, a seventh unique public Enterprise document plus an explicit owner-approved, machine-readable Enterprise `hard_cap` rule and matching URL/digest/marker. The rule must provide positive integer monthly call and monthly minute caps that the runtime actually enforces; this repository must not choose them for the owner;
- exact equality between those approved Enterprise caps and an enabled shared runtime `PLAN_LIMITS.enterprise` enforcement record;
- an exact live Stripe Billing Portal configuration, verified with a dedicated restricted key distinct from the revenue-read key, with invoice history and payment-method update enabled and the approved Terms URL, Privacy URL, cancellation mode, and proration behavior bound exactly;
- every enabled hosted Payment Link requires Terms acceptance, required business-name and phone collection, and exactly matches the approved automatic-tax mode; native Checkout remains code-disabled for the first-dollar launch and would require a separately reviewed code/launch change plus explicit approval with the same buyer-identity and policy bindings;
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
