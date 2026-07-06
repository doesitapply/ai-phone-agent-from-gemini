# SMIRK

SMIRK is a missed-call recovery system for local service businesses.

It answers inbound calls when a business owner or crew cannot pick up, captures the caller's problem, writes the call record, creates callback work, alerts the owner, and shows proof in a dashboard.

The narrow product is simple:

```text
Missed call -> SMIRK answers -> useful summary -> owner alert -> callback task -> dashboard proof
```

This repo is not a tiny starter app. It is a working, overbuilt MVP with voice webhooks, AI tool calling, post-call intelligence, contacts, tasks, DNC/compliance controls, Stripe/provisioning, plan-gated dashboards, and guarded production scripts.

## Current Verified Status

Source of truth is always the commands in this section. The snapshot below records the most recent verified production evidence for this branch; rerun the commands after every commit or deploy before claiming live parity.

| Area | Status | Evidence |
| --- | --- | --- |
| Live deploy | Must be checked | `npm run -s check:live-is-current` proves whether production is running the current commit. |
| First-customer gate | Must be checked | `npm run -s check:first-customer-10of10` is the launch-readiness bundle. It requires a clean worktree and live parity. |
| Dependency audit | Must be checked | `npm audit --audit-level=moderate` should return `found 0 vulnerabilities`. |
| Customer dashboard scope | Contract-tested | `npm run -s check:customer-dashboard` confirms customer UI hides operator surfaces and sanitizes owner-visible failures. |
| Plan boundaries | Contract-tested | `npm run -s check:plan-boundaries` confirms Starter/Basic and Pro/Agency pricing, provisioning, and entitlement behavior stay aligned. |
| No-DB local demo | Contract-tested | `npm run build && npm run -s check:no-db-demo-mode` proves local demo calls, contacts, transcripts, tasks, and review items load without Postgres. |
| Live Basic entitlement proof | Needs real Basic token | `npm run -s check:live-workspace-entitlements` has proven the live Pro path. A real Starter/Basic token is still required for live Basic chaos proof. |
| Stripe/provisioning proof | Guarded | Stripe webhook/provisioning smoke proof is approval-gated and must match the current live deploy artifact. |
| Smoke cleanup | Guarded | `APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces` should match 0 smoke workspaces before first customer. |

Blunt status: SMIRK is no longer just "close." The core loop is proven on the deployed build when the readiness bundle passes. The remaining product risk is whether the product surface, onboarding, live Basic isolation, and positioning stay narrow enough for normal contractors to understand and buy.

## Who This Is For

This README is written for multiple audiences because SMIRK sits between a real software system and a very non-technical buyer.

| Audience | What they care about | What SMIRK means to them | How close we are |
| --- | --- | --- | --- |
| Homeowners | Someone answers fast, understands the problem, and gets them a callback. | SMIRK is invisible. It should feel like the business responded instead of ignoring the call. | 8/10 for phone-call capture. Not a homeowner-facing booking marketplace. |
| Handymen and solo tradespeople | They are on a ladder, under a sink, or driving. They miss calls and lose jobs. | SMIRK is a backup front desk that catches the caller and tells them who to call back. | 8.5/10 for the missed-call product. Local setup and onboarding still need to feel easier. |
| Contractors: plumbing, HVAC, roofing, electrical, solar | Speed-to-lead, job value, owner alerts, and callback accountability. | SMIRK turns missed calls into callback-ready work and proof. | 8.5/10 for inbound phone recovery. 4/10 for web-form/SMS lead funnel automation. |
| SMB owners outside home services | They need fewer dropped leads and a simple view of follow-up work. | SMIRK can work when the business has phone-driven demand. | 7/10. The strongest fit is still local service, not every SMB. |
| Office managers and dispatchers | Who called, what they needed, urgency, and whether it was handled. | SMIRK is a call summary and task queue, not another bloated CRM. | 8/10. Calls, contacts, review, and tasks exist. More workflow polish still helps. |
| Agencies and multi-location operators | Proof, dashboards, workspace provisioning, and repeatable client onboarding. | SMIRK is a recoverable lead system they can package for clients. | 7.5/10. Workspaces, plans, and Stripe/provisioning exist; self-serve operations still need hard usage in the wild. |
| Developers | Routes, auth boundaries, schema behavior, tests, deploy gates, and how not to break production. | SMIRK is a Node/React/Postgres/Twilio app with guarded live checks. | 8/10. The codebase is functional but broad and still needs pruning. |
| Software/product critics | Honest scope, market wedge, UX clarity, and whether this is a product or an ops cockpit. | SMIRK is a real missed-call product trapped inside a larger AI phone platform. | 7.5/10. The core works; the product must keep hiding machinery from non-technical users. |
| Compliance reviewers | DNC behavior, audit logs, consent/correction notes, and no reckless SMS claims. | SMIRK treats DNC as suppression, keeps audit trails, and avoids SMS as the first-dollar product. | 7/10. Useful controls exist, but this is not legal advice or a complete compliance program. |
| Operators/admins | Provisioning, proof, logs, workspaces, health, and recovery controls. | SMIRK OS has the machine room for running the business. | 8/10. Powerful, but it must stay out of the customer dashboard unless the user is Pro/operator. |

### Plain-English Translation By Audience

Homeowners do not buy SMIRK. They experience it indirectly when a business answers faster and calls back prepared. The homeowner value is speed, clarity, and not being ignored.

Handymen and solo operators buy back their missed calls. They do not need a platform pitch; they need to know that if they miss a call while working, the caller does not disappear.

Contractor owners care about revenue leakage. SMIRK should be explained as a simple lead-recovery layer: missed calls become summaries, owner alerts, and callback tasks.

Office managers and dispatchers care about work clarity. The dashboard should help them sort calls, contacts, review items, and tasks without exposing the whole operator cockpit.

SMB owners outside home services should only be sold SMIRK when phone calls are a meaningful source of revenue. If the business does not lose money from missed calls, this is not the strongest wedge.

Agencies and multi-location operators care about repeatability. They need proof, provisioning, plan boundaries, and a clean client-facing dashboard more than they need another experimental AI feature.

Developers care about contracts. They should trust the commands in this README more than the prose: if the checks fail, the claim is not true.

Critics should judge the product by whether it stays honest. SMIRK is valuable when it is a narrow missed-call recovery product; it becomes weaker when it tries to sound like a universal AI business platform.

Compliance reviewers should treat the built-in controls as useful guardrails, not a legal blessing. DNC and audit behavior exists, but production messaging and outbound automation still need careful policy review.

## What It Does Today

### For a Business Owner

SMIRK helps answer five questions:

1. Who called?
2. What did they need?
3. How urgent was it?
4. Who needs to call them back?
5. Did we handle it?

Starter/Basic users should see the basic dashboard: Calls, Contacts, and Tasks.

Pro/Agency users get the broader suite: dashboard, review, calls, contacts, CRM, appointments, handoffs, recovery, tasks, analytics, and other customer tools.

Operators/admins get the machine room: workspaces, logs, compliance, integrations, agent config, voice config, prospecting, health, and deployment/proof surfaces.

### For a Developer

Main runtime loop:

```text
Twilio Voice
  -> Express webhook routes
  -> AI response loop
  -> tool execution
  -> Postgres persistence
  -> post-call intelligence
  -> owner alert / callback task
  -> React dashboard
```

Important files:

| File | Purpose |
| --- | --- |
| `server.ts` | Express app, auth, route registration, health, webhook entry points. |
| `src/routes/` | API route modules. |
| `src/db.ts` | Postgres connection and schema initialization. |
| `src/function-calling.ts` | AI tool declaration and dispatch. |
| `src/tools.ts` | Tool implementations used during calls. |
| `src/intelligence.ts` | Post-call summary, outcome, task, and proof extraction. |
| `src/compliance.ts` | DNC, call-window checks, consent records, audit logs. |
| `src/App.tsx` | React dashboard, customer/operator views, plan-gated navigation. |
| `scripts/` | Readiness, deploy, Stripe, cleanup, proof, and safety checks. |
| `docs/SMIRK_1000_ROADMAP.md` | Current final-mile roadmap from 875/1000 to 1000/1000, including the database reliability path. |

## How Close Is This To The LEAD-LOCK / LeadGoblin Brief?

The pasted LEAD-LOCK idea is a broader local-contractor lead engine:

```text
Website form lead -> instant local AI triage -> fast SMS response -> dispatch alert
plus
autonomous outbound leak audits for local contractors
```

SMIRK overlaps with that market but is not the same system yet.

| LEAD-LOCK component | Current SMIRK reality | Readiness |
| --- | --- | --- |
| Local home-service contractor market | The positioning and pricing fit this market well. The product is strongest for plumbers, HVAC, roofing, electrical, solar, and handymen. | 8.5/10 |
| Instant inbound lead capture | Strong for inbound phone calls through Twilio. Weak for website forms as the primary source. | 7/10 overall, 9/10 for phone, 3/10 for forms |
| AI triage and qualification | Post-call summaries, outcomes, urgency, contacts, tasks, and owner action proof exist. | 7.5/10 |
| Immediate SMS response | Intentionally out of scope for the first-dollar product. The README and checks should not sell SMS as live. | 1/10 |
| Dispatch/owner alert | Owner email alerts, handoffs, callback tasks, and dashboard proof exist. Discord/Telegram-style alerting is not the current product. | 7/10 |
| Local Ollama/Llama/Mistral zero-cost AI | Not the current architecture. SMIRK uses configured cloud/hosted AI paths such as OpenClaw/OpenRouter/Gemini-style routes. | 1/10 |
| Autonomous leak scraper/auditor | Prospecting and lead-hunter surfaces exist, but a safe, compliant autonomous form-testing/outbound audit engine is not productized here. | 3/10 |
| Stripe SaaS checkout and provisioning | Stripe, workspace provisioning, buyer routes, signed webhook proof, and guarded smoke checks exist and are verified. | 8.5/10 |
| Plan-gated customer dashboard | Implemented and checked. Basic gets the simple dashboard; Pro/Agency gets the broader suite, and customer sessions do not mount operator-only pages. | 9/10 |
| Hands-off SaaS | First-customer gate is proven, but the product still needs real buyer repetitions before calling it frictionless. | 7.5/10 |

Verdict: SMIRK is much closer to a sellable missed-call recovery SaaS than it is to the full LEAD-LOCK autonomous web-form/SMS/outbound-audit engine. The smart move is to sell the proven phone-call wedge first, then add web-form ingestion and opt-in response automation only after the first customer loop has real usage.

## Competitive Positioning

This market is active. The useful way to think about competitors is by product shape, not by logo.

| Category | Examples to watch | What they usually sell | Where SMIRK should position against them |
| --- | --- | --- | --- |
| Post-missed-call messaging tools | Allo, Upfirst-style post-call messaging, GoHighLevel-style missed-call automations | Detect unanswered calls and send an automated message afterward, sometimes with AI answering or booking layered in. | SMIRK should lead with live inbound backup: answer the call, capture the problem, create callback work, and avoid selling messaging as the first-dollar product. |
| Broad AI receptionist platforms | RingCentral AI Receptionist and other front-office AI tools | 24/7 AI call handling, routing, appointment setup, FAQ/company-knowledge answering, analytics, and wider phone-system workflows. | SMIRK should avoid the universal receptionist fight and stay the narrow revenue shield for local service calls. |
| Automated callback systems | Voksha-style missed-call callback recovery | Call missed callers back automatically after a delay, often with an AI voice that qualifies or books. | SMIRK should position as lower-friction inbound coverage: the caller stays in the original call flow instead of receiving a surprise robot callback. |
| Contractor lead-response suites | LeadTruffle-style home-service lead-response products | Home-service focused qualification, CRM routing, and lead follow-up claims. | SMIRK should compete on call-first urgency, owner proof, plan-gated simplicity, and compliance-conservative positioning. |

SMIRK's advantage is not that it has the most features. Its advantage is that the backend is overbuilt while the customer-facing promise stays narrow:

```text
We catch the missed call, understand the job, alert the owner, create the callback task, and prove it happened.
```

That positioning matters because a plumber, roofer, HVAC tech, electrician, or handyman does not want to operate a software platform while doing field work. They want to know which caller is money, what the caller needs, how urgent it is, and what to do next.

## Internal Scorecard

Current internal score: `875 / 1000`.

This is not a formal company valuation. It is an operator score for market readiness, product focus, and engineering proof.

| Area | Points | Why |
| --- | ---: | --- |
| Production-grade contract security | 350 | First-customer gate passes, real proof-call guard exists, production-write smokes are guarded, Stripe/provisioning proof exists, and plan boundaries are codified. |
| Positioning clarity | 300 | The wedge is narrow: missed-call recovery for local service businesses, not a generic AI receptionist platform. |
| Compliance posture | 225 | The product is inbound-first, DNC is treated as a hard suppression signal, and SMS/texting is not sold as the first-dollar product. |

Remaining gap: `125 / 1000`.

| Gap | Points locked | What has to improve |
| --- | ---: | --- |
| Machine-room overlap | 50 | Customer navigation is sanitized and operator pages are short-circuited out of customer renders. More real-user polish still helps. |
| Live Basic workspace gap | 40 | Starter/Basic entitlement blocking now has a chaos script, but it still needs a real Basic workspace token to prove live behavior. |
| No-DB/demo limitations | 35 | Local No-DB mode now loads a high-fidelity Basic demo with calls, contacts, transcripts, DNC state, and callback tasks. |

Bottom line: the core routes and data model do not need a rewrite to sell the missed-call recovery wedge. The next leverage is real-world buyer repetition, ruthless customer-surface simplicity, and evidence from a live Starter/Basic workspace.

## What It Is Not

- Not a generic AI receptionist platform.
- Not a full CRM.
- Not a dispatch system.
- Not a scheduling product, even though appointment/calendar code exists.
- Not an SMS product.
- Not a local-only Ollama app.
- Not a finished autonomous outbound lead-audit machine.
- Not legal advice or a substitute for compliance counsel.

## Plan And Dashboard Boundaries

The plan split is part of the product strategy.

| Plan / role | Intended experience |
| --- | --- |
| Starter / Basic workspace | Simple dashboard: Calls, Contacts, Tasks. |
| Pro / Agency workspace | Full customer suite. |
| Operator/admin | Full SMIRK OS machine room. |

The boundary is enforced in the UI and server-side APIs. Pro-suite APIs return `PRO_SUITE_REQUIRED` when a Starter/Basic workspace token calls them directly.

Current live caveat: live production currently has a Pro workspace. Starter/Basic blocking is contract-tested until a real Starter/Basic customer or approved smoke creates a live Starter/Basic workspace.

## Compliance Behavior

- DNC is a hard outbound suppression signal.
- Inbound calls from DNC contacts are still reviewable.
- A contact is not automatically removed from DNC just because they call in.
- Removing DNC requires an operator-entered consent/correction note.
- Contact-level `do_not_call` and the global `dnc_list` are kept in sync.
- SMS/texting is not part of the first-dollar product claim.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js, Express, TypeScript |
| Frontend | React 19, Vite, Tailwind CSS |
| Database | PostgreSQL via `postgres.js` |
| Telephony | Twilio Voice |
| AI | OpenClaw/OpenRouter/Gemini paths exist |
| TTS | Google, OpenAI, ElevenLabs, Cartesia paths exist |
| Billing/provisioning | Stripe + workspace provisioning routes |
| Email/alerts | Owner email alert path exists when configured |

## Local Setup

Requirements:

- Node.js 20+
- npm
- PostgreSQL for real app data
- Twilio credentials for real calls
- At least one configured AI path for intelligent call handling

Install:

```bash
git clone https://github.com/doesitapply/ai-phone-agent-from-gemini.git
cd ai-phone-agent-from-gemini
npm install
cp .env.example .env.local
```

Run:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### No-DB Mode

If `DATABASE_URL` is missing, the server still boots and opens a local Basic demo workspace at:

```text
http://localhost:3000/dashboard
```

The demo uses `src/data/mockDbData.json` and includes realistic Reno trade scenarios: emergency plumbing, urgent HVAC, and commercial electrical. Calls, contacts, transcripts, DNC status, and callback tasks load without Postgres.

No-DB mode is still read-only. Creating, deleting, or mutating persistence-backed records requires a real database.

## Environment

Important variables:

```text
DATABASE_URL
DASHBOARD_API_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
PHONE_AGENT_API_KEY
PHONE_AGENT_PROVISIONING_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
OPENCLAW_ENABLED
OPENCLAW_GATEWAY_URL
OPENROUTER_API_KEY
GEMINI_API_KEY
RESEND_API_KEY
FROM_EMAIL
```

See `.env.example` for the full list.

## Twilio Setup

For local voice testing, expose the app with ngrok or another tunnel and configure the Twilio phone number:

```text
A Call Comes In:
https://<your-public-url>/api/twilio/incoming

Call Status Changes:
https://<your-public-url>/api/twilio/status
```

Do not place real proof calls or paid smoke tests without following the guarded scripts in this repo.

## Useful Commands

Basic local checks:

```bash
npm run lint
npm run build
npm run -s check:openapi
npm run -s check:auth-regression
npm run -s check:cors-security
npm run -s check:contact-management
```

Product scope and dashboard checks:

```bash
npm run -s check:first-dollar-offer-scope
npm run -s check:customer-dashboard
npm run -s check:plan-boundaries
```

No-DB demo check:

```bash
npm run build
npm run -s check:no-db-demo-mode
```

Basic isolation chaos check:

```bash
SMIRK_BASIC_CHAOS_WORKSPACE_ID=<basic-workspace-id> \
SMIRK_BASIC_CHAOS_TOKEN=<basic-workspace-token> \
npm run -s check:basic-chaos
```

This check intentionally refuses anonymous/operator mode. It must run with a real Starter/Basic workspace token, or with explicit approval to create a temporary Starter workspace:

```bash
ALLOW_SMIRK_BASIC_CHAOS_PROVISION=1 DASHBOARD_API_KEY=<operator-key> npm run -s check:basic-chaos
```

That proves Pro-suite endpoints return `PRO_SUITE_REQUIRED` under Basic identity instead of only proving static contracts.

Local manual-review acquisition audit:

```bash
mkdir -p input
cp docs/outbound-auditor-targets.example.json input/outbound-auditor-targets.json
python3 scripts/outbound_auditor.py
```

This writes reviewable audit drafts under `outputs/outbound-audits/`. It does not send email, submit forms, or scrape search results.

Interactive goal tracker:

```text
docs/SMIRK_1000_TRACKER.html
```

Live readiness checks:

```bash
npm audit --audit-level=moderate
npm run -s check:live-is-current
npm run -s check:live-workspace-entitlements
npm run -s check:first-customer-10of10
```

Stripe/provisioning safety checks:

```bash
npm run -s check:stripe-webhook-signature-live
npm run -s check:stripe-webhook-handoff-live:preflight
npm run -s check:stripe-webhook-smoke-approval-ready
```

Production-write and real-call checks are guarded:

```bash
npm run -s check:real-call-readiness
npm run -s print:real-call-setup
```

## Real Proof Call Guard

Do not dial a real proof call from memory, a copied phone number, or an env var shortcut. Use the guarded path.

1. Print readiness and setup guidance:

```bash
npm run check:real-call-readiness
npm run -s print:real-call-setup
```

2. Pick a safe target only from the masked `allowlistedTargetHints` output.

3. Verify that exact safe target:

```bash
npm run check:real-call-readiness -- <safe-number>
```

4. Place the proof call only through the proof runner:

```bash
npm run proof:real-call -- <safe-number>
```

The proof runner must pass `check:pre-proof-call-live` before it dials.

After the call, pin the proof window and exact call before judging artifacts:

```bash
PROOF_STARTED_AT=<iso-start-time> PROOF_CALL_SID=<twilio-call-sid> npm run -s check:proof-artifacts-live
```

The proof dashboard counters that must stay coherent are `totalCalls`, `summariesGenerated`, `callbackTasksCreated`, `ownerEmailAlertsSent`, and `completeProofCalls`.

## Main API Surfaces

Public/buyer:

- `GET /health`
- `GET /api/system-health/public`
- `GET /api/pricing`
- `GET /api/public-proof-snapshot`
- `POST /api/provisioning/request`
- `POST /api/provisioning/checkout-status`
- `POST /api/checkout/create`
- `POST /api/stripe/webhook`

Twilio:

- `POST /api/twilio/incoming`
- `POST /api/twilio/process`
- `POST /api/twilio/status`
- `POST /api/twilio/amd`

Dashboard/operator:

- `/dashboard`
- `GET /api/operator/session`
- `GET /api/calls`
- `GET /api/call-intelligence`
- `GET /api/contacts`
- `PATCH /api/contacts/:id`
- `POST /api/contacts/:id/dnc`
- `DELETE /api/contacts/:id/dnc`
- `GET /api/tasks`
- `GET /api/handoffs`
- `GET /api/compliance/dnc`
- `GET /api/compliance/audit`
- `POST /api/compliance/check`

OpenAPI route inventory is generated into `openapi.yaml`.

## Known Limitations

- The app is still broader than the clean product wedge.
- No-DB mode is useful for local demo reads, but it is read-only and does not prove production persistence.
- The customer dashboard is much cleaner than before, but the operator product is still large.
- Starter/Basic live-token blocking has a chaos script, but it still needs proof from an actual live Starter/Basic workspace.
- Web-form ingestion is not the main product loop yet.
- SMS/text response automation is intentionally not sold as live.
- Autonomous outbound leak auditing is not productized. The included local auditor is draft-only and manual-review by design.
- Some integrations exist before they are fully productized.

## Docker

Docker Compose includes an app and Postgres service:

```bash
cp .env.example .env
docker compose up -d --build
```

If `DATABASE_URL` is set in `.env`, it overrides the internal Compose default.

## License

MIT
