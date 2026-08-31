# SMIRK AI Phone Agent — Active Delivery TODO

- [ ] Repair the GitHub Actions monthly-reset secret/check failure that causes Railway source deployments to skip. The fix is committed locally, but GitHub rejected the push because the active integration lacks `workflows` permission.
- [ ] Merge and deploy the pending actionable Handoffs, Velvet portal, and verified owner-operator access improvements.
- [ ] Design a verified-owner-only chat tool policy with deny-by-default permissions and confirmation requirements.
- [ ] Implement approved SMIRK chat actions, confirmation workflow, and immutable audit logging.
- [ ] Validate owner-only access and action approval boundaries before production release.

## Mobile Revenue Operator Refocus

- [x] Audit dashboard navigation and operator surfaces: the mobile drawer currently exposes every primary and overflow tab in one flat list, while separate Prospecting, Lead Hunter, Campaigns, CRM, Tasks, Recovery, Handoffs, and Velvet surfaces overlap without a mobile revenue-action hierarchy.
- [x] Define a phone-first command path: Today, Calls, Recovery, Pipeline, and Velvet, with non-core capabilities preserved behind More tools.
- [x] Establish Velvet Alchemy as a review → qualify → approved-outreach operating loop, explicitly retaining source attribution and auto-outreach as pending until the receiver persists required data and consent evidence.
- [x] Implement the streamlined mobile drawer and mobile-friendly Velvet outreach controls that make revenue-critical actions first-class without removing advanced tools.

## Business Knowledge Pack Import

- [x] Audit the existing workspace, contact, company-profile, prompt, and CRM import paths for a reusable business-knowledge foundation.
- [x] Define a versioned Business Knowledge Pack contract for approved website facts, CRM exports, operating policies, service catalog entries, pricing, and escalation rules.
- [x] Add a user-triggered public-website import path that extracts business facts without treating unverified copy as autonomous commitments.
- [x] Add a review-and-activate workflow that applies an approved knowledge pack to one demo or customer workspace without affecting others.
- [ ] Add reliable CRM-import adapters for the smallest high-value export formats, beginning with CSV contact, company, and service data.
- [x] Bind the active workspace knowledge pack into live-call context with verified-answer, conditional-answer, and escalation behavior.
- [x] Add regression tests for workspace isolation, fact provenance, pricing guardrails, and uncertainty escalation.
