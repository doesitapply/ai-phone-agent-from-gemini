# SMIRK First-Dollar Policy Decisions

This is the business-owner approval sheet for recurring live sales. It is not a Terms of Service, Privacy Policy, or legal opinion. Paid checkout must remain gated until the approved choices are reflected consistently in the customer-facing policy pages, Stripe Checkout or Payment Links, the billing-management surface, and support operations.

<!-- SMIRK_OWNER_POLICY_DECISION_CARD_START -->
## Owner Policy Decision Card

Copy, fill, and return this entire card after the exact customer-facing documents have been reviewed. Every blank means NOT APPROVED. The listed machine values are the choices the current first-dollar implementation can verify; none is selected by default.

Returning this card records business-owner decisions only. It does not draft or publish legal terms, update the checked-in manifest or live environment, enable checkout, authorize a deploy, send outreach, initiate a charge, or replace qualified review.

```text
SMIRK_OWNER_POLICY_DECISION_CARD_V1
policy_version=<required exact non-secret version; no default>
approved_by=<required business-owner name; no default>
approved_at_utc=<required ISO-8601 timestamp; no default>
qualified_reviewer_name_and_role=<required; no default>
qualified_review_completed_at_utc=<required ISO-8601 timestamp; no default>
tax_mode=<choose exactly stripe_automatic_tax OR stripe_automatic_tax_disabled>
cancellation_mode=<choose exactly at_period_end OR immediately>
cancellation_proration_behavior=<choose exactly none OR create_prorations>
starter_usage_decision=<choose exactly approve_existing_hard_cap_500_calls_1000_minutes OR request_separately_reviewed_change>
refund_policy_reference=<exact reviewed document/version plus refund approver and response target; no default>
billing_management_choice=<choose exactly stripe_hosted_customer_portal OR identify an exact reviewed authenticated alternative>
privacy_recording_retention_reference=<exact reviewed document/version and approved jurisdictions; no default>
support_identity=<support email; response target; escalation owner; customer-facing business identity; no default>
public_proof_workspace=<workspace ID plus SMIRK-owned-demo or explicit-consent basis; no default>
terms_url=<required exact reviewed public HTTPS URL; no default>
privacy_url=<required exact reviewed public HTTPS URL; no default>
cancellation_refund_url=<required exact reviewed public HTTPS URL; no default>
billing_management_url=<required exact reviewed public HTTPS URL; no default>
support_url=<required exact reviewed public HTTPS URL; no default>
data_consent_url=<required exact reviewed public HTTPS URL; no default>
final_owner_confirmation=<required explicit confirmation binding the exact version and six listed documents; no default>
```

After the exact reviewed documents are published, tooling may calculate their SHA-256 digests and prepare a manifest diff for review. It must not fill this card, select a choice, change `approvalState`, or treat a partial response as approval.
<!-- SMIRK_OWNER_POLICY_DECISION_CARD_END -->

## Decisions Cameron Must Approve

1. **Cancellation timing**
   - End access at the end of the already-paid billing period, or
   - end access immediately when cancellation is requested.
   - Record the exact approved cancellation mode and proration behavior in the checked-in manifest; neither value may remain null for core readiness.

2. **Refund handling**
   - Define whether the first payment, unused time, duplicate charges, service outages, and exceptional cases are refundable.
   - Name who can approve a refund and the support response target.

3. **Included usage**
   - Starter currently advertises 500 calls and 1,000 minutes per month.
   - Pro currently advertises 2,000 calls and 5,000 minutes per month.
   - Choose a hard stop, a disclosed overage price, or different public copy. Code, billing, alerts, and copy must use the same rule.
   - The current first-dollar code path can enforce only a hard stop for Starter. If that is the approved choice, record `hard_cap`, 500 monthly calls, and 1,000 monthly minutes in the checked-in `starterUsagePolicy`; checkout remains blocked unless those owner-approved values exactly match `PLAN_LIMITS.starter`. Choosing overages or different copy requires a separately reviewed implementation/copy change before approval—the repository must not translate that choice into a hard stop automatically.
   - Enterprise/Agency currently has no owner-approved usage rule and is disabled with zero runtime caps. Explicitly approve positive hard caps before that plan is exposed. Code does not accept an arbitrary string, an overage model it cannot enforce, or an internal `-1` value as an unlimited customer promise.

4. **Billing management**
   - Approve Stripe's hosted customer portal or specify another authenticated way for a customer to update a payment method, view invoices, and cancel.

5. **Privacy, recording, and retention**
   - Approve what SMIRK stores, how long calls/transcripts/summaries are retained, who can access them, and how deletion requests are handled.
   - Have a qualified reviewer confirm the recording and disclosure language for every state or jurisdiction SMIRK will serve.

6. **Taxes**
   - Decide who owns tax configuration and confirm whether Stripe automatic tax or another process will be used before checkout is enabled.
   - Record the exact approved tax mode in the checked-in manifest so hosted Payment Links and native Checkout can be verified against the same decision.

7. **Customer support identity**
   - Approve the support email, response target, escalation owner, and business identity shown to a buyer.

8. **Public proof data**
   - Confirm that the workspace selected by `PUBLIC_PROOF_WORKSPACE_ID` is SMIRK-owned demo data or has explicit owner consent for aggregate public proof.

## Launch Evidence Required

- Public Terms and Privacy URLs reviewed and approved by the business owner.
- Cancellation/refund/usage language matches the selected behavior.
- The hosted checkout surface links the approved policies and does not imply unavailable guarantees.
- Each hosted Payment Link requires explicit Terms acceptance, required business-name and phone collection, and matches the manifest's approved automatic-tax mode. Native Checkout is code-disabled for this launch; reopening it requires a separately reviewed code/launch change and explicit approval with the same buyer-identity and policy bindings.
- The one enabled SMIRK live Payment Link is Starter at $197/month, with its exact public URL + `plink_` ID pair and redirect to `https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}`. Pro and Enterprise Railway pairs are empty and every known older provider-side Pro/Agency link is inactive; a partial, broader, duplicate, or drifted pair fails first-dollar readiness.
- The authenticated `POST /api/billing/portal` path is proven with a non-customer test workspace before real sales; it must bind the signed-in workspace's exact Stripe customer to the exact active live portal configuration, approved Terms/Privacy URLs, cancellation mode/proration behavior, and trusted return URL. Its restricted key must be distinct from the revenue-read key.
- Support and deletion-request paths have named owners.
- The policy/version approved for the first live buyer is recorded with the deployment handoff.
- `src/customer-policy-approval.js` records the explicit core owner approval, approver, timestamp, exact shared version, all six required stable core policy URLs, and an explicit Starter usage decision bound exactly to the enforced 500-call/1,000-minute hard caps. The Enterprise usage rule remains a separate approval record and is required only before Enterprise is enabled.
- Railway has `SMIRK_CUSTOMER_POLICY_APPROVED_VERSION` set to that exact checked-in version. The environment value cannot approve policy by itself.
- The live policy verifier confirms six unique approved core URLs return the exact checked-in SHA-256 bytes and unique document/version markers without redirects before core buyer readiness can open. A seventh unique Enterprise policy URL is required only for the separately approved Enterprise launch path.

## Stop Rule

Do not describe SMIRK as ready for recurring self-serve sales, enable paid outreach, or count a checkout configuration as launch-ready while any decision above is unresolved. Product tests can continue; live charges, legal-policy publication, and pricing or refund changes require explicit Cameron approval.
