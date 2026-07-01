# SMIRK — Missed-Call Recovery Assistant

SMIRK answers missed calls, captures lead details, emails the business a callback-ready summary, creates a callback task, and shows proof in the dashboard. The first-dollar MVP is intentionally narrow: missed-call recovery, not customer texting, broad dispatch, or full call-center automation.

---

## Core Capabilities

### 1. Missed-Call Capture
- Answers when the business cannot pick up.
- Collects caller name, phone number, need, urgency, location, and preferred callback window.
- Keeps the call focused on creating a useful owner callback.

### 2. Owner Alert + Callback Task
- Sends the owner a callback-ready lead email.
- Creates a callback task so follow-up is tracked.
- Generates call summaries and extracts key lead details after the call.

### 3. Dashboard Proof
- Shows calls, summaries, contacts, open callback tasks, and handoffs.
- Gives the owner a simple view of captured opportunities.
- Separates buyer-safe health from authenticated operator diagnostics.

### 4. Safe Operating Scope
- Customer texting is out of the MVP.
- Requested callback windows are captured for owner follow-up; appointment booking is not part of the first-dollar promise.
- Operational routes and deeper diagnostics require authentication.

### 5. First-Dollar Path
- Online payment and provisioning handoff.
- Setup wizard for business basics, owner email alerts, callback queue, and proof call.
- Production proof loop: call record, summary, owner email, callback task, dashboard proof.

---

## Architecture

```
Caller → Twilio → /api/twilio/incoming → Caller Identity Resolution
                                       → Do-Not-Call Check
                                       → Greeting (TTS)
                                       ↓
              → /api/twilio/process  → Gemini 2.0 Flash (function calling loop)
                                       → Tool Execution (lead capture, callback task, escalation...)
                                       → Response spoken via TTS
                                       ↓
              → /api/twilio/status   → Post-Call Intelligence Pipeline (async)
                                       → Summary, intent, outcome, entities
                                       → Task creation for unresolved calls
                                       → Owner alert + dashboard proof
```

---

## The Dashboard

The app includes a React 19 + Vite dashboard focused on missed-call recovery proof:

- **Dashboard** — calls captured, summaries generated, callback tasks, owner-alert readiness, proof-loop status
- **Calls** — expandable cards with AI summary, intent/outcome badges, tools invoked during call, full transcript
- **Contacts** — directory with call count, last outcome, open tasks badge, DNC flag
- **Tasks & Handoffs** — pending handoffs with urgency + recommended action, open tasks queue with one-click complete
- **Setup** — business basics, voice webhook, owner email test, test call, system health
- **Settings** — manage API keys, integrations, TTS engines, and compliance rules

---

## Health and diagnostics

- `GET /health` (public): fast liveness + configuration signals.
- `GET /api/system-health/public` (public): minimal buyer-safe service status.
- `GET /api/system-health` (authenticated): deeper operator checks, including the proof-loop verdict used for live ship verification.

## First real proof call

Before calling SMIRK "shipped," run one real production proof call end-to-end.

First print the guarded first-dollar approval packet:

```bash
npm run -s print:first-dollar-approval-packet
```

If the packet shows `Approval 0: Branch Reconciliation`, stop there and print the dedicated branch handoff:

```bash
npm run -s print:branch-reconcile-approval
```

The only approval to request is `APPROVE_SMIRK_BRANCH_RECONCILE`, and that approval authorizes only the branch reconciliation command printed in the dedicated packet. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach. After reconciliation, regenerate the packet and rerun deploy readiness before requesting production deploy approval.

1. Find the safe target path:
   - `npm run check:real-call-readiness`
   - `npm run print:real-call-setup`
   - If readiness reports `allowlistedTargetHints`, choose one of those safe numbers privately. The hints are masked on purpose.
2. Verify readiness for the exact safe number:
   - `npm run check:real-call-readiness -- <safe-number>`
3. Place the live proof call:
   - `npm run proof:real-call -- <safe-number>`
   - The guarded proof runner re-runs `check:pre-proof-call-live` and stops before dialing unless the deployed app passes the non-mutating live safety audit. `check:post-deploy-live` still verifies proof artifacts, post-call intelligence, and dashboard proof freshness after a call.
4. Verify proof artifacts and dashboard proof:
   - `export PROOF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"` before a manual call
   - `export PROOF_CALL_SID="<call-sid-from-the-placed-proof-call>"` after the call is placed
   - `npm run check:proof-artifacts-live -- "$PROOF_STARTED_AT"`
   - `npm run check:post-call-intelligence-live -- "$PROOF_STARTED_AT"`
   - `npm run check:dashboard-proof-live`

Do not treat green config checks as done until production shows one fresh real call record, summary, owner email, callback task, and increased `totalCalls`, `summariesGenerated`, `callbackTasksCreated`, `ownerEmailAlertsSent`, and `completeProofCalls` dashboard counters for the placed `PROOF_CALL_SID`. Timestamp-only proof is not enough when recovering a manual run.

## Deploy Readiness

Use these local gates before asking Cameron/main-agent to apply live infrastructure changes:

```bash
npm run lint
npm run build
npm run -s check:deploy-post-call-fix-ready
npm run -s check:live-deploy-readiness
npm run -s check:launch-blockers
```

`check:deploy-post-call-fix-ready` verifies the first-dollar deploy evidence before any production deploy approval: no-texting copy, OpenAPI route inventory, auth regression, paid handoff safety, self-serve activation, client onboarding intake, Stripe webhook preflight, Stripe smoke approval readiness, live operational auth, proof artifacts, post-call intelligence, approval handoff freshness, Railway access, branch sync, and stale-production status. `check:live-deploy-readiness` and `check:pre-proof-call-live` keep the payment, activation, auth, and non-mutating live safety guards wired before any proof call; `check:post-deploy-live` then verifies proof artifacts, post-call intelligence, and dashboard proof freshness. `check:live-deploy-readiness` and `check:launch-blockers` are read-only audits; if they stop on Namecheap/domain cutover, do not apply DNS automatically unless Cameron/main-agent explicitly approves that live change.

### No-DB mode (first-run friendly)

If `DATABASE_URL` is not set, the server boots in **no-db mode** so you can load the dashboard and verify config.
Persistence-backed APIs will return helpful errors until Postgres is configured.

---

## Live Tools (invoked during calls)

| Tool | What It Does |
|---|---|
| `create_lead` | Saves caller info + creates follow-up task |
| `update_contact` | Updates name/email/notes mid-call |
| `schedule_callback_confirmation` | Creates a callback task when follow-up is needed |
| `escalate_to_human` | Creates handoff record with urgency + transcript snippet, transfers call |
| `create_support_ticket` | Creates task with priority level |
| `mark_do_not_call` | Sets DNC flag; future calls blocked at the webhook |
| `qualify_lead` | Extracts BANT criteria during the call |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **AI / LLM** | Google Gemini 2.0 Flash, OpenRouter, OpenClaw |
| **Telephony** | Twilio Voice API |
| **TTS Engines** | Google, OpenAI, ElevenLabs, Cartesia |
| **Backend** | Express + TypeScript (Node.js) |
| **Frontend** | React 19 + Vite + TailwindCSS |
| **Database** | PostgreSQL (via `postgres.js`) / SQLite fallback |
| **Validation** | Zod |

---

## 📦 Quick Start

### Prerequisites
- Node.js 20+
- A [Twilio account](https://www.twilio.com) with a phone number
- A [Google Gemini API key](https://aistudio.google.com/apikey)
- PostgreSQL database (set `DATABASE_URL`)
- [ngrok](https://ngrok.com) for local development

### Setup

```bash
git clone https://github.com/doesitapply/ai-phone-agent-from-gemini.git
cd ai-phone-agent-from-gemini
npm install
cp .env.example .env.local
```

Edit `.env.local` with your API keys.
Make sure `DATABASE_URL` points at a reachable Postgres instance.

### Run Locally
```bash
npm run dev
```

### Twilio Webhook Configuration

In your Twilio console, set your phone number's webhook:
- **A Call Comes In** → Webhook → `https://your-ngrok-url.ngrok.io/api/twilio/incoming`
- **Call Status Changes** → `https://your-ngrok-url.ngrok.io/api/twilio/status`

---

## Docker (App + Postgres)

If you just want it to boot locally with a working database, Docker is the easiest path.
This repo's `docker-compose.yml` includes a `db` (Postgres) service and will default `DATABASE_URL` to the internal Compose hostname if you do not set one.

```bash
cp .env.example .env
# Optional: fill in keys. Minimum for a clean boot is leaving DATABASE_URL unset.
# Start Docker Desktop first.
docker compose up -d --build
```

Notes:
- If you set `DATABASE_URL` in `.env`, it will override the internal default.
- `DASHBOARD_API_KEY` defaults to `dev` in compose for local-only use.

---

## License

MIT
