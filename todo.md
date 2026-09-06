# SMIRK Missed-Call Recovery — Active Delivery TODO

- [ ] Configure the GitHub Actions monthly-reset credential and prove an HTTP 200 reset. The September 1 scheduled run concluded green only after skipping the reset for a missing credential; this operational job does not block Railway source deployments. The issue-reporting path is fixed in `f794765f`, while credential and HTTP proof remain open.
- [x] Merge and deploy the actionable Handoffs, Velvet portal, and verified owner-operator access improvements in `96b6a9a6`.
- [x] Design a verified-owner-only chat tool policy with deny-by-default permissions and confirmation requirements.
- [ ] Make approved SMIRK chat actions and confirmations fail closed on durable audit persistence before describing action logs as immutable.
- [x] Validate owner-only access and action approval boundaries for the deployed release with focused authorization regressions.
- [x] Diagnose why the verified workspace owner is denied operator access in chat, then restore owner call authority without granting phone-call power to ordinary members or inbound callers.
- [x] Require a clear owner confirmation before any chat-initiated outbound call is placed and attempt a redacted post-action audit record; durable audit persistence remains open above.

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
- [x] Rebuild the signed-in owner desk into a mobile-first Calls, Tasks, Alerts, and tenant-scoped CRM operating model without breaking existing call, handoff, and proof functionality.
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
- [x] Make dark graphite the primary premium presentation and redesign the alternate theme as warm stone/graphite rather than bright white, preserving high contrast and accessible controls.
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

- [x] Implement the trade-floor visual system in the live public and owner-facing UI while preserving existing verified product behavior.
- [x] Remove the blank Starter Settings destination, expose tenant-scoped CRM and business context in the owner desk, and keep provider, agent, integration, and system settings operator-only.
- [x] Validate priority controls, tenant CRM access, operator Settings isolation, responsive behavior, and no-fabrication requirements for the deployed `96b6a9a6` interface; the closeout hotfixes do not change runtime UI code.
- [x] Restore a clear customer-owner Settings entry point and simplify the settings surface into plain-language sections without exposing internal-only administrative controls.
- [ ] Validate priority controls, settings access, responsive behavior, and no-fabrication requirements before release.

## Human-Centered Recovery Visuals

- [x] Create human-at-work visual assets that show service professionals unavailable on a job while SMIRK captures an incoming business opportunity.
- [x] Integrate the approved human-centered visual story into the public trade-floor interface without representing illustrative calls, customer details, revenue, or outcomes as real.
- [x] Validate the human-centered desktop and mobile presentation for clarity, accessibility, and no-fabrication compliance.

## Unified Contractor Workfloor Release

- [x] Consolidate the contractor-at-work public story and trade-floor owner interface into one clear visual system across the usable customer journey.
- [x] Resurface valuable existing customer capabilities behind plain-language owner controls, preserving restricted administrator features and consent-sensitive outreach functions behind appropriate access boundaries.
- [ ] Run release-readiness verification for builds, authorized API behavior, checkout readiness, owner chat authority, dashboard live-data state, and proof-call prerequisites.
- [x] Reconcile authorization-contract checks with the hardened no-fixture architecture, explicitly classify approved workspace-safe Knowledge Pack actions, and preserve deny-by-default operator boundaries.
- [x] Push the verified unified release through the reviewed `main` path and monitor Railway to the exact healthy `96b6a9a6` fingerprint; later closeout patches must repeat the same parity gate.
- [ ] Run the controlled production proof call and record the call, summary, alert, one callback/handoff outcome, and dashboard receipt before broad marketing or checkout exposure.

## Selective Caller Memory and Qualification

- [x] Audit every path that creates or enriches a durable contact, caller memory, task, handoff, or post-call intelligence record.
- [x] Separate auditable call evidence from reusable caller memory so low-information, spam, wrong-number, hangup, administrative, and test calls do not pollute future conversations.
- [x] Define deterministic caller-memory promotion reasons for qualified service intent, estimates, appointments, callback commitments, active customer issues, and explicit owner save actions.
- [x] Implement universal qualification essentials plus workspace/trade-specific question modules without diagnosing work, promising availability, quoting unapproved prices, or making warranty commitments.
- [ ] Add workspace controls and audit evidence for memory promotion, owner override, qualification completion, and escalation.
- [x] Add regression coverage for meaningful-lead promotion, nonmeaningful-call suppression, repeated-caller context, qualification stop rules, and authorized commitment boundaries.
- [x] Prevent inbound callers from using the live voice agent to place third-party outbound calls; retain owner-chat confirmation and screened human transfer as the only authorized dial paths.
- [x] Verify the currently deployed checkout, activation, proof snapshot, caller-memory, and owner-action readiness before declaring SMIRK sellable.
- [x] Classify SMIRK separately for founder-led selling, assisted onboarding, and autonomous self-service selling, with explicit blockers for each level.
- [x] Deliver the shortest evidence-based path from the current production state to first revenue without adding nonessential product scope.
- [x] Inventory every SMIRK backend capability, provider, route family, scheduled process, configuration gate, and customer-facing dependency.
- [x] Classify each backend capability as live, fully wired but unverified, partially wired, dormant, easily enabled, or requiring substantial integration work.
- [x] Estimate external vendor and usage costs for each paid capability using current primary-source pricing, separating fixed, usage-based, and implementation costs.
- [x] Map the practical product and revenue potential of each viable SMIRK configuration without overstating unproven outcomes.
- [x] Model regulatory and platform-shutdown scenarios for AI voice, recording, automated outreach, SMS, call forwarding, and automated decisions, including survivable fallback configurations.
- [x] Deliver a prioritized backend capability matrix that identifies what to sell now, enable next, defer, or remove.

## Economics and Operational Hardening

- [ ] Add auditable per-workspace usage and estimated provider-cost telemetry for call minutes, speech-recognition turns, generated voice, LLM usage where available, email, retries, and support-sensitive failure events.
- [ ] Add protective budget and anomaly controls that preserve the approved call/minute hard caps and surface abnormal cost drivers without inventing precision where providers do not return usage data.
- [ ] Complete and verify customer billing self-service with a SMIRK-scoped Stripe portal configuration and least-privilege credential path, without changing the approved Starter price or cancellation policy.
- [ ] Surface plain-language provider and connector health for the dependencies that can materially break answering, qualification, alerts, payment, or fulfillment.
- [ ] Validate a fresh buyer checkout-to-provisioning-to-activation chain using a controlled safe method before exposing unattended acquisition.
- [ ] Verify current database backup and restore capabilities and produce an operator recovery runbook instead of assuming Railway data recovery.
- [ ] Run the complete release-contract suite, deploy only the verified correction set, and record the remaining real-call or transaction proof gates.

## Durable Owner Access and Google Workspace Integrations

- [x] Reproduce and trace the production in-app agent denial for the approved admin account, including browser token state, server identity resolution, workspace membership, and access-mode selection.
- [x] Replace per-request browser-forwarded Google identity with a durable, secure, server-verified owner session for the approved admin account.
- [x] Give the verified admin profile access to the full implemented operator capability surface while retaining confirmation gates and immutable audit receipts for consequential actions.
- [x] Separate operator authentication from Google Sheets and Calendar integration OAuth so losing or refreshing an integration token cannot remove admin authority.
- [ ] Diagnose and repair Google Sheets/Calendar connection status, consent scopes, callback handling, token persistence, and plain-language reconnect behavior.
- [ ] Add regression coverage for session creation, expiry, revocation, workspace binding, full admin access, ordinary-member denial, and integration-token isolation.
- [ ] Deploy and verify the owner session plus Google Workspace connection flow before declaring admin access fixed.
- [x] Narrowed current scope: make Google dashboard sign-in authenticate `madeinreno775@gmail.com` as the full admin/operator and persist that authority reliably across chat and operator routes.
- [x] Keep Google Sheets and Calendar product integrations separate from dashboard authentication; native Sheets/Calendar OAuth repair is explicitly deferred from this login fix.

## Complete Frontend Replacement

- [x] Replace the legacy monolithic public frontend with a new component architecture based on the approved warm industrial SMIRK reference, rather than layering additional CSS over old layouts.
- [x] Replace the legacy signed-in shell with a new simple owner navigation and page hierarchy for Calls, Tasks, Alerts, Settings, and clearly separated advanced admin tools.
- [x] Preserve all verified backend routes, tenant boundaries, no-fabrication rules, confirmation gates, and evidence receipts while migrating the interface.
- [x] Integrate reliable Google admin sign-in into the new shell and ensure the approved admin account receives full operator capability without exposing the shared API key to the browser.
- [x] Remove or quarantine obsolete frontend components, duplicated navigation, decorative telemetry, and internal-only controls from customer surfaces.
- [ ] Validate every retained public and authenticated route at desktop and mobile breakpoints before replacing the production frontend.
- [ ] Deploy the verified frontend replacement and confirm the active Railway build serves the new shell rather than the legacy UI.

## Workfloor Visual Fidelity Correction

- [x] Treat the supplied black and ivory workfloor mockups as the exact visual acceptance target, not loose inspiration; reject conventional SaaS cards, soft editorial spacing, and generic landing-page composition.
- [x] Replace the softened V2 token system with machined black/ivory surfaces, clipped and chamfered panel geometry, restrained lime signal paths, amber approval states, engraved labels, monospace evidence text, physical fasteners, and receipt/instrument motifs.
- [x] Rebuild the public hero so its silhouette, information density, signal-to-context-to-decision visualization, and bottom workflow rail materially match the supplied SMIRK landing references without using fabricated live data.
- [x] Rebuild Today as the supplied SMIRK Intelligence Brief: narrow navigation, one dominant owner decision, a three-stage evidence rail, and one obvious next action sourced only from live workspace data.
- [x] Rebuild Calls as a ledger-plus-evidence-inspector layout that materially matches the supplied calls reference while preserving real call fields, explicit unavailable states, and evidence provenance.
- [x] Rebuild Tasks and handoffs as the supplied Recovery Queue grammar using only verified backend actions: acknowledge, queue callback, complete with an auditable resolution note.
- [x] Rebuild Settings and Business Knowledge Pack as an engineered control plane with source provenance, draft/active separation, safe-to-say, needs-owner-approval, and always-escalate states; do not imply inactive knowledge is caller-facing.
- [x] Preserve a genuine light trade-floor version and dark operator version of the same industrial system rather than two unrelated themes.
- [ ] Capture and inspect full-page desktop and mobile screenshots for public home, Google login, Today, Calls, Tasks, Settings, and Admin before release; correct any screen that does not visibly belong to the supplied reference family.
- [ ] Complete the replacement Google Web OAuth client only after the corrected interface passes visual and contract verification, then rotate production configuration and prove the approved admin can log in, retain operator authority, and log out.
- [ ] Replace the popup-only Google owner button with a full-page redirect exchange that validates Google's double-submit CSRF token, issues the same HTTP-only owner session, and returns to `/dashboard`; retain the JSON exchange route for compatible clients.

## Newly Surfaced P1 Release Blockers

- [x] Reconcile the current local frontend, owner-session, auth, and readiness changes onto GitHub `main`, which was 33 commits ahead of local `5680193`, without discarding newer acquisition, release-gate, mobile, callback, or public-route fixes.
- [x] Re-run the current-main build and focused release-contract suite after reconciliation before treating any local pass as release evidence.
- [x] Reproduce the checkout-readiness gap from merged PR #13 and prove whether Starter checkout can remain enabled when managed Twilio provisioning credentials or the workspace encryption key are absent.
- [x] Make managed-Twilio provisioning credentials and the workspace encryption key checkout-blocking prerequisites for the dedicated recovery-number offer; keep optional premium TTS diagnostics non-blocking only if that matches the actual fulfillment boundary.
- [x] Add deterministic readiness and checkout tests proving a buyer cannot be charged when the system cannot provision the advertised dedicated recovery number.
- [x] Reproduce the Velvet outcome-callback identifier gap from merged PR #12 for accepted external IDs including `velvet-lead-00000001`.
- [x] Replace identifier archaeology with an explicit persisted Velvet lead identifier where possible, or fail intake closed when the required identifier cannot be resolved; do not silently skip the promised outcome callback.
- [x] Add deterministic intake-to-outcome callback tests covering both the legacy numeric format and the repository's accepted `velvet-lead-*` example.
- [ ] Prepare a replacement delivery for `gawfer@icloud.com` using a hosted share link or compressed bundle rather than the rejected six-image attachment set, and request confirmation immediately before sending.
