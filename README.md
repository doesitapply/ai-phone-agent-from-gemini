# SMIRK

A Twilio voice app with an LLM response loop for missed-call recovery.

SMIRK answers inbound calls for small businesses, collects caller details, writes call records, creates follow-up work, and gives an operator dashboard for reviewing what happened.

This repo is an overbuilt MVP. The core missed-call loop works, but the app has more moving parts than a clean first-dollar product should have: voice webhooks, LLM tool calling, multiple TTS providers, post-call intelligence, Stripe/provisioning code, compliance/DNC logic, contacts, tasks, handoffs, dashboards, and deployment guard scripts. Treat it as a working product under active development, not a minimal starter template.

## Current Status

- The narrow product being sold is missed-call recovery: answer, capture, summarize, alert the owner, and create callback/follow-up work.
- SMS/texting is intentionally out of scope for the first-dollar product.
- Production parity is verified with `npm run -s check:live-is-current`; that check must pass before claiming the checkout is live-current.
- As of 2026-07-02, the current branch is ahead of production. Local HEAD is `cecc5ce`; live Railway still reports `6f36e7c` because Railway CLI/API calls are currently rate-limited. Do not claim production is current until `npm run -s check:live-is-current` passes.
- The customer dashboard cleanup is implemented and server-enforced in the current branch: Starter/Basic workspace users get Calls, Contacts, and Tasks; Pro/Agency workspace users get the full customer suite; operator surfaces stay behind operator auth. `npm run -s check:plan-boundaries` locks pricing/provisioning plan mapping. `npm run -s check:live-workspace-entitlements` verifies the live workspace-token boundary only after production is reachable with a valid operator key and current deploy.
- Dependency audit is clean as of 2026-07-02: `npm audit --audit-level=moderate` reports `found 0 vulnerabilities`.
- Production deploys and production-write smoke tests are guarded by scripts and explicit approval phrases. See `SMIRK_FIRST_CUSTOMER_10_OF_10_RUNBOOK.md` for the current first-customer gate list.
- Local development can boot without `DATABASE_URL`, but persistence-backed APIs return errors until Postgres is configured.
- The app is close to an operator-assisted first customer, but the current checkout is not fully deployed or proven. It is not a hands-off SaaS 10/10 until the current branch is deployed, live gates pass, and an approved production checkout/provisioning smoke or real paid activation completes on that deployed build.

## What It Does

### Voice Flow

1. Twilio sends an incoming call to `/api/twilio/incoming`.
2. The app resolves caller/workspace context.
3. The AI agent responds through `/api/twilio/process`.
4. Tool calls can create leads, update contacts, schedule callback tasks, escalate to humans, or mark DNC.
5. Twilio status callbacks hit `/api/twilio/status`.
6. Post-call intelligence writes summaries, outcomes, tasks, and proof artifacts.

### Dashboard

The React dashboard is split by plan and role:

- Starter/Basic workspace users: Calls, Contacts, and Tasks.
- Pro/Agency workspace users: the full customer suite, including dashboard, review, calls, contacts, CRM, appointments, handoffs, recovery, tasks, and analytics.
- Operators/admins: machine-room tools, including settings/config, compliance, logs, workspaces, integrations, agent/voice configuration, prospecting, and health/proof surfaces.

The split is enforced in both places that matter: the UI navigation hides the unavailable tabs, and the server returns `PRO_SUITE_REQUIRED` for pro-suite APIs when a Starter/Basic workspace token calls them directly.

Current live production has a Pro workspace, so the live entitlement checker proves the Pro full-suite path today. Starter/Basic live-token blocking is contract-tested until an approved provisioning smoke or a real Starter/Basic customer creates a live Starter/Basic workspace.

Current caveat: while Railway is rate-limiting the CLI/API, live entitlement and Stripe env checks are unproven because the scripts cannot read live Railway variables.

### Compliance Behavior

- DNC is a hard outbound suppression signal.
- Inbound calls from DNC contacts are still reviewable.
- A contact is not automatically removed from DNC just because they call in.
- Removing DNC requires an operator-entered consent/correction note.
- Contact-level `do_not_call` and the global `dnc_list` are kept in sync by the current implementation.

## What It Is Not

- Not a generic AI receptionist platform.
- Not a full CRM.
- Not a dispatch system.
- Not a scheduling product, even though appointment/calendar code exists.
- Not an SMS product.
- Not a tiny MVP anymore.

## Architecture

```text
Twilio Voice
  -> Express webhook routes
  -> AI response loop
  -> tool execution
  -> Postgres persistence
  -> post-call intelligence
  -> React operator dashboard
```

Main runtime pieces:

- `server.ts` - Express app, webhook handling, route registration, auth, health.
- `src/routes/` - API route modules.
- `src/db.ts` - Postgres connection and schema init.
- `src/function-calling.ts` - AI tool declaration/dispatch.
- `src/tools.ts` - tool implementations used during calls.
- `src/intelligence.ts` - post-call summary/outcome/task extraction.
- `src/compliance.ts` - DNC, call-window checks, consent records, audit logs.
- `src/App.tsx` - dashboard UI.

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

## Local Setup

Requirements:

- Node.js 20+
- npm
- PostgreSQL if you want real app data
- Twilio credentials if you want real calls
- At least one configured AI path if you want the agent to answer intelligently

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

### No-DB Mode

If `DATABASE_URL` is missing, the server should still boot so you can inspect the public site, settings shell, and non-persistence health paths. Persistence-backed routes will fail with a clear database-disabled error.

This mode is for local inspection only. It is not a useful product demo.

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

First-dollar/deploy checks:

```bash
npm audit --audit-level=moderate
npm run -s check:plan-boundaries
npm run -s check:deploy-post-call-fix-ready
npm run -s check:live-deploy-readiness
npm run -s check:post-deploy-live
npm run -s check:live-is-current
npm run -s check:customer-dashboard
npm run -s check:first-customer-10of10
```

Safe Stripe/provisioning checks:

```bash
npm run -s check:stripe-webhook-signature-live
npm run -s check:stripe-webhook-handoff-live:preflight
npm run -s check:stripe-webhook-smoke-approval-ready
```

Real production-write and real-call checks are intentionally guarded:

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

For a manual proof verification window, capture:

```bash
export PROOF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PROOF_CALL_SID="<call-sid-from-the-placed-proof-call>"
```

The production proof is not complete until the live dashboard/proof checks show the expected `PROOF_CALL_SID` and the proof counters moved: `totalCalls`, `summariesGenerated`, `callbackTasksCreated`, `ownerEmailAlertsSent`, and `completeProofCalls`.

## Main API Surfaces

Public/buyer:

- `GET /health`
- `GET /api/system-health/public`
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

- The app is too broad for a clean MVP and should continue being narrowed around missed-call recovery.
- Local no-DB mode is only partially useful.
- The dashboard has many surfaces and needs continued UX pruning.
- Some integrations are present before they are fully productized.
- Production deploys require guarded approval and verification.
- Legal/compliance behavior is implemented conservatively but is not legal advice.

## Docker

Docker Compose includes an app and Postgres service:

```bash
cp .env.example .env
docker compose up -d --build
```

If `DATABASE_URL` is set in `.env`, it overrides the internal Compose default.

## License

MIT
