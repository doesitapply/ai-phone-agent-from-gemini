# SMIRK 30-Day Market Validation Goal

Version: 2026-07-16
Owner: SMIRK operator
Primary market: home-service businesses
Primary offer: Starter at $197/month

## Goal

Run SMIRK as a bounded validation sprint until it reaches revenue, buyer interaction, or a clear stop condition.

Primary success:
- 1 paid Starter or Pro account completes checkout.
- The buyer reaches workspace activation without founder onboarding.
- The workspace shows dashboard access plus proof of a call record, summary, owner email alert, and callback task.

Secondary success:
- 10 qualified owner/operator conversations, or
- 3 scheduled proof walkthroughs, with source, segment, objection, and next step logged.

Negative stop:
- 500 researched outbound touches plus $500 paid spend produce 0 qualified replies.
- A self-serve activation blocker prevents scale.
- Any launch channel requires unsupported claims, cold texting, automated phone spam, or uncapped usage.

## Current Readiness Verdict

SMIRK is sellable as missed-call recovery now. It should not be described as fully hands-off SaaS until the first paid or approved production activation proves this exact loop:

1. Buyer picks Starter or Pro.
2. Buyer completes checkout.
3. Workspace is created or queued with a buyer-legible activation status.
4. Owner receives the next activation step by email.
5. Dashboard opens for the workspace.
6. A proof call creates a call record, summary, owner alert, callback task, and dashboard evidence.

If any step fails, pause paid launch spend and fix the product path before expanding channels.

## Market Basis

The wedge is not generic reception. The wedge is local service owners missing job calls while they are already working.

Useful source set:
- SBA small-business scale: https://advocacy.sba.gov/2026/02/03/frequently-asked-questions-about-small-business-2026/
- Handyman category: https://www.ibisworld.com/united-states/industry/handyman-services/4069/
- HVAC category: https://www.ibisworld.com/united-states/industry/heating-air-conditioning-contractors/1945/
- Plumbing category: https://www.ibisworld.com/united-states/industry/plumbers/1946/
- Electrician category: https://www.ibisworld.com/united-states/industry/electricians/189/
- Speed-to-lead framing: https://www.insidesales.com/response-time-matters/

Use directional missed-call and lost-revenue statistics carefully. Do not promise a recovered-dollar amount unless it comes from that buyer's actual calls.

## Competitive Position

Competitors and adjacent products:
- Smith.ai: https://smith.ai/pricing/ai-receptionist
- Goodcall: https://www.goodcall.com/pricing
- Bland: https://www.bland.ai/pricing
- Retell: https://www.retellai.com/pricing
- Vapi: https://vapi.ai/pricing
- Synthflow: https://synthflow.ai/pricing
- Zoom AI receptionist coverage: https://www.techradar.com/pro/zoom-will-let-you-add-an-ai-receptionist-at-work-as-businesses-shouldnt-have-to-replace-their-phone-system-to-benefit-from-ai

Adopt:
- Clear monthly pricing.
- Proof assets before trust claims.
- A simple first call-to-dashboard story.
- Vertical pages for trades with urgent phone demand.

Avoid:
- Generic front-office replacement positioning.
- Unlimited free trials.
- Broad developer-platform language.
- Lifetime AppSumo-style deals before usage caps and margins are proven.

## Offer And Messaging

One-line pitch:

> SMIRK catches missed calls, extracts the job details, alerts the owner, and creates the callback task before the lead moves on.

Landing-page promise:
- Existing-number forwarding path.
- Missed-call answer or capture flow.
- Owner email alerts.
- Callback task queue.
- Proof dashboard.

Do not say:
- SMIRK replaces staff.
- SMIRK guarantees recovered revenue.
- SMIRK is fully automated for every business.
- SMIRK handles every industry equally well.
- SMIRK uses texting for first-dollar acquisition.

## Launch Channels

### Manual Home-Service Outreach

Execution asset: `docs/launch/manual-outbound-playbook.md`.
First researched batch: `docs/launch/prospect-batch-001-reno.csv`.
Second researched batch: `docs/launch/prospect-batch-002-sacramento.csv`.

Prove launch analytics and checkout-start telemetry without creating a Stripe checkout session:

```bash
npm run check:launch-analytics-smoke
```

This writes synthetic, labeled `launch_page_view`, `cta_clicked`, and `checkout_started` events only. It does not create payments, ledger touches, SMS, or outreach.

Target:
- 200 researched businesses.
- Plumbers, HVAC, roofing, electricians, handymen, remodelers, cleaners, garage door repair, pest control, landscaping, and auto repair.
- 2-3 regions before expanding.

Approved channels:
- Email when a compliant contact path exists.
- Website contact form.
- LinkedIn message.
- Human-approved phone call.

Import researched rows:

```bash
npm run import:launch-ledger:batch
```

The default import command is a dry run. Applying the batch requires `CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT=import-researched-launch-prospects npm run import:launch-ledger:batch:apply`. Importing researched rows only records the queue in `/dashboard/launch`; it does not send outreach and does not count as a touch until a human sends an email, submits a contact form, sends a LinkedIn message, or makes a human-approved call.

Not approved:
- Cold texting.
- Automated phone spam.
- Purchased-list blasting.
- Claims about exact revenue recovery without buyer data.

Kill rule:
- Rewrite any segment/message after 100 touches and 0 qualified replies.
- Keep any segment/message above 3% qualified reply rate.

### Product Hunt

Execution asset: `docs/launch/platform-submission-kit.md`.

Source: https://www.producthunt.com/launch/preparing-for-launch

Launch only after:
- Public launch page is live.
- Pricing page is live.
- Demo clip or walkthrough screenshots are ready.
- Public screenshots have been captured with `npm run capture:launch-assets`.
- `output/playwright/launch-assets/manifest.json` has been reviewed for remaining Product Hunt blockers.
- First comment explains who SMIRK is for, what problem it solves, and what feedback is requested.

Goal:
- 50 visits, 10 interest actions, or 3 qualified conversations.

### Directories

Execution asset: `docs/launch/platform-submission-kit.md`.

G2:
- Source: https://sell.g2.com/create-a-profile
- Submit a product profile with accurate category and screenshots.

Capterra:
- Source: https://www.capterra.com/legal/listing-guidelines/
- Submit only if the product is actively marketed and sold.

AppSumo:
- Source: https://sell.appsumo.com/
- Delay until usage caps and margins are proven.
- Do not offer unlimited or lifetime voice usage.

### Paid Test

Execution asset: `docs/launch/paid-test-brief.md`.

Total cap: $500.

Budget:
- $200 Meta or Instagram lead/proof-walkthrough test.
- $150 Google Search for long-tail missed-call and AI receptionist terms.
- $100 retargeting.
- $50 reserve.

Spend does not start until:
- Landing page analytics are working.
- Checkout and activation events are trackable.
- Self-serve proof gate passes or the spend is explicitly marked as a pre-proof research test.

Tracking implementation:
- Public page views, CTA clicks, and checkout starts post to `/api/launch/events`.
- The operator-only summary lives at `/api/launch/summary`.
- Trackable events are `landing_page_view`, `launch_page_view`, `pricing_page_view`, `cta_clicked`, and `checkout_started`.
- Do not use this event stream for raw buyer email, phone, payment details, or contact-list storage.
- Treat `checkout_started` without a later activation as a product/onboarding defect to investigate before adding spend.

## Traction Ledger

Use `docs/launch/traction-ledger-template.csv`.

Required columns:
- source
- company
- vertical
- region
- owner_contact
- channel
- message_variant
- response
- objection
- proof_walkthrough_status
- checkout_status
- activation_status

Every interaction must have a next state:
- new
- researched
- contacted
- replied
- qualified
- proof_requested
- checkout_started
- paid
- activated
- lost
- do_not_contact

Daily status command:

```bash
npm run check:market-validation-status
```

This command checks live deploy parity, verifies there are no failed Railway deploys, reads `/api/launch/summary` and `/api/launch/ledger` through operator auth, writes `output/market-validation-status.json`, and reports whether the sprint should continue, pause for a product fix, or stop because a revenue, interaction, or negative-signal hard condition is met. It intentionally omits raw ledger rows so owner/contact fields are not printed into terminal logs.

## Content Sprint

Use `docs/launch/content-calendar.csv`.

Publish 20 posts over 30 days:
- Missed-call example.
- Owner callback workflow.
- Proof dashboard evidence.
- Trade-specific intake examples.
- Competitive comparison without naming unsupported claims.

Each post must point to one CTA:
- `/`
- `/pricing`
- `/launch`
- `/industries/hvac`
- `/industries/plumbing`
- `/industries/roofing`
- `/industries/landscaping`
- `/industries/auto-repair`

## SMS Guardrails

SMS is not part of the launch acquisition motion.

Any SMS test must remain:
- Dry-run by default.
- Allowlisted unless explicitly approved.
- A2P-approved before live non-allowlisted use.
- Capped by workspace daily volume.
- Capped by recipient daily volume.
- Capped by estimated daily spend.
- Protected by recipient cooldown.
- Logged as sent, dry-run, or blocked.

Never use texting to cold-prospect this sprint.

## Verification

Run before launch handoff:

```bash
npm run check:market-validation-launch
npm run check:market-validation-status
npm run check:no-texting-copy
npm run check:first-dollar-offer-scope
npm run check:self-serve-activation
npm run build
```

Run before spend:

```bash
npm run check:landing-live
npm run check:live-is-current
npm run check:paid-handoff-safety
```

The sprint is not ready for paid spend if any of those fail.
