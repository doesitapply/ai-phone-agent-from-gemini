# SMIRK AI Phone Agent — Active Delivery TODO

- [ ] Repair the GitHub Actions monthly-reset secret/check failure that causes Railway source deployments to skip. The fix is committed locally, but GitHub rejected the push because the active integration lacks `workflows` permission.
- [ ] Merge and deploy the pending actionable Handoffs, Velvet portal, and verified owner-operator access improvements.
- [ ] Design a verified-owner-only chat tool policy with deny-by-default permissions and confirmation requirements.
- [ ] Implement approved SMIRK chat actions, confirmation workflow, and immutable audit logging.
- [ ] Validate owner-only access and action approval boundaries before production release.
- [x] Diagnose why the verified workspace owner is denied operator access in chat, then restore owner call authority without granting phone-call power to ordinary members or inbound callers.
- [x] Require a clear owner confirmation and immutable audit receipt before any chat-initiated outbound call is placed.

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

## Product UI and Brand Rebuild

- [x] Inventory every public, onboarding, and signed-in SMIRK surface and identify prototype-like visual debt, redundant navigation, and nonessential controls.
- [x] Establish a unified visual system that separates credible public marketing from the operational owner desk while retaining the verified Starter product scope.
- [x] Rebuild public landing, pricing, comparison, industry, policy, and setup surfaces around clear missed-call-recovery value and only verified claims; approved policy bodies remain byte-stable by design.
- [x] Rebuild the signed-in owner desk into a mobile-first Calls, Tasks, Alerts, and Settings operating model without breaking existing call, handoff, and proof functionality.
- [x] Validate desktop and mobile visual hierarchy, keyboard/accessibility basics, API behavior, and no-regression launch readiness before any production release.

## Commercial Packaging and Launch Integrity Audit

- [x] Research direct competitors’ current offer structure, public prices, usage limits, onboarding charges, and customer activation model.
- [x] Audit all public SMIRK packages, price references, checkout bindings, and policy documents for conflicting or generic SaaS packaging.
- [ ] Remove or quarantine disabled Pro, Agency, founders, and promotional purchase paths that conflict with the approved single-offer launch, unless a new owner-approved package contract and payment binding replaces them.
- [x] Define an outcome-based offer architecture for voicemail recovery, full phone-operations suite, and paid implementation without inventing unvalidated value claims.
- [x] Audit API routes and interface flows for placeholder, mock, fixture, seed, demo, or fabricated customer data that can reach a user-facing surface.
- [x] Remove all production mock-data fallbacks from workspace, dashboard, call, contact, task, and profile routes; return an explicit unavailable state instead of fabricated records when durable storage is unavailable.
- [x] Replace the remaining fabricated caller details in the public recovery preview with a clearly labeled workflow format that contains no mock customer data.
- [ ] Exercise authenticated and public launch-critical endpoints against the live service after Railway has an active current deployment, and record failures precisely.
- [x] Trace each launch-critical pipeline from checkout through provisioning, call intake, callback task, alert, and dashboard display; identify unproven transitions.
- [ ] Implement only the approved package, pricing, and reliability changes with payment-provider and regression-test verification.
- [x] Make guarded Railway deployment-setter fixtures respect an already supplied synthetic environment token so local safety tests neither require nor read a real Railway credential.
- [x] Remove any remaining voice-prompt instruction that lets a caller clear, complete, cancel, or otherwise mutate existing dashboard tasks or handoffs, and add a regression that prevents its reintroduction.
- [x] Define and apply one distinctive earned hacker-operations visual signature across public pages and the owner desk, tied to real system state and without decorative fake metrics, inaccessible contrast, or generic-template cues.
- [x] Validate the visual signature at desktop and mobile sizes against contrast, readability, and action-completion criteria.
- [ ] Make dark graphite the primary premium presentation and redesign the alternate theme as warm stone/graphite rather than bright white, preserving high contrast and accessible controls.
- [x] Reframe public and owner-facing primary surfaces around real call intelligence: signal received, context resolved, recommended owner action, confidence/provenance where available, and clear escalation when not available.
- [x] Create a distinct SMIRK interaction grammar for evidence, uncertainty, and next action so the product feels operationally intelligent without simulating activity or inventing model confidence.
- [x] Produce a complete designer-ready SMIRK mockup brief covering product truth, information architecture, visual language, screen inventory, state behavior, copy direction, and no-fabrication constraints.
- [x] Reconcile the current local source, GitHub main, Railway deployment record, and public-service fingerprint into an evidence-based release-status report.

## 2027 Visual Mockup Suite

- [x] Create a cohesive 2027-grade visual mockup suite for the public Home, Today Intelligence Brief, Calls Ledger/Inspector, Recovery Queue, and Business Knowledge Pack.
- [x] Ensure the mockups use an earned dark hacker-operations visual language with real-state semantics and no fabricated operational proof, customer data, or revenue claims.
- [x] Deliver the visual mockup assets and a concise creative-direction handoff for a designer or implementation team.

## Trade-Floor Light Mode Mockups

- [x] Create companion light-mode concepts for the public Home, Today Intelligence Brief, and Business Knowledge Pack using a warm industrial field-operations treatment rather than a bright generic SaaS theme.
- [x] Preserve the same signal, context, evidence, uncertainty, and human-decision grammar used in dark mode, with no fabricated data or ornamental “live” activity.
- [x] Deliver the trade-floor light-mode visual assets with the dark-mode suite as a paired design direction.

## Trade-Floor Interface Implementation

- [ ] Implement the trade-floor visual system in the live public and owner-facing UI while preserving existing verified product behavior.
- [x] Restore a clear customer-owner Settings entry point and simplify the settings surface into plain-language sections without exposing internal-only administrative controls.
- [ ] Validate priority controls, settings access, responsive behavior, and no-fabrication requirements before release.

## Human-Centered Recovery Visuals

- [x] Create human-at-work visual assets that show service professionals unavailable on a job while SMIRK captures an incoming business opportunity.
- [x] Integrate the approved human-centered visual story into the public trade-floor interface without representing illustrative calls, customer details, revenue, or outcomes as real.
- [x] Validate the human-centered desktop and mobile presentation for clarity, accessibility, and no-fabrication compliance.
