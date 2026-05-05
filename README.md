# SMIRK — Missed-Call Recovery Platform

A stateful AI phone operations platform for missed-call recovery. It answers inbound calls, captures lead details, creates callback-ready follow-up, and shows proof in the dashboard using **Google Gemini 2.0 Flash** for intelligence and **Twilio** for telephony.

---

## 🚀 Core Capabilities

### 1. Missed-Call Recovery Core
- **Answers inbound calls** with low-latency Gemini 2.0 Flash function calling.
- **Captures lead details** and stores them with call history.
- **Creates callback-ready follow-up** with task generation and handoff context.
- **Escalates to a human** when needed, with live monitoring and takeover support.

### 2. Built-in CRM & Intelligence
- **Post-Call Intelligence**: Automatic summarization, intent classification, and entity extraction (names, dates, prices).
- **Contact Memory**: The AI remembers past conversations, previous outcomes, and caller preferences across sessions.
- **Task Generation**: Automatically creates tasks (e.g., "Send quote to John") based on call context.
- **External CRM Sync**: Native integrations with **HubSpot, Salesforce, Airtable, and Notion**.

### 3. Prospecting & Lead Generation (Lead Hunter)
- **Secondary module**: outbound prospecting exists in the repo, but it is not the canonical first-dollar proof path.
- **Apollo.io & Google Maps Integration**: Search for B2B leads directly from the dashboard.
- **AI Pitch Generator**: Automatically writes personalized sales pitches based on the lead's website and industry.
- **Auto-Dialer**: One-click campaign dialing with automatic outcome logging.

### 4. Compliance & Routing
- **TCPA & State Law Compliance**: Automatic checking of recording laws (one-party vs. two-party consent) and time-of-day dialing restrictions.
- **DNC Management**: Built-in Do Not Call list with automatic opt-out detection from call transcripts.
- **Callback Routing**: Escalates the right missed-call follow-up to the right human with context.

### 5. Extensibility
- **Model Context Protocol (MCP)**: Connect external APIs and internal tools directly to the AI's function-calling brain.
- **Custom Tools**: Book appointments (Google Calendar), create callback tasks, escalate to human, log notes, and more.
- **Webhooks**: Fire real-time events to Make/Zapier for external workflows.

---

## Architecture

```
Caller → Twilio → /api/twilio/incoming → Caller Identity Resolution
                                       → Do-Not-Call Check
                                       → Greeting (TTS)
                                       ↓
              → /api/twilio/process  → Gemini 2.0 Flash (function calling loop)
                                       → Tool Dispatch (book, reschedule, callback, escalate...)
                                       → Response spoken via TTS
                                       ↓
              → /api/twilio/status   → Post-Call Intelligence Pipeline (async)
                                       → Summary, intent, outcome, entities
                                       → Task creation for unresolved calls
                                       → CRM sync & Webhook dispatch
```

---

## 🖥️ The Dashboard

The platform includes a React 19 + Vite dashboard for complete operational control:

- **Dashboard** — 12 stat cards: total calls, active, completed, avg duration, booking rate, transfer rate, avg resolution score, open tasks, AI latency
- **Calls** — expandable cards with AI summary, intent/outcome badges, tools invoked during call, full transcript
- **Contacts** — directory with call count, last outcome, open tasks badge, DNC flag
- **Tasks & Handoffs** — pending handoffs with urgency + recommended action, open tasks queue with one-click complete
- **Prospecting** — secondary outbound module for Lead Hunter, Apollo/Maps search, and auto-dialer campaigns
- **Agent Identity** — configure the AI's name, persona, and company details without touching code
- **Settings** — manage API keys, integrations, TTS engines, and compliance rules

---

## Health and diagnostics

- `GET /health` (public): minimal liveness endpoint with `twilioConfigured`, `aiConfigured`, uptime, and a `db` object `{ enabled, ok, latencyMs }`. It does not expose webhook URLs, DB error text, or operator/runtime detail.
- `GET /api/system-health` (authenticated dashboard): deeper connectivity checks for operators.
- `GET /api/system-health/public` (public): minimal public status endpoint with coarse liveness/config signals only.

### No-DB mode (first-run friendly)

If `DATABASE_URL` is not set, the server boots in **no-db mode** so you can load the dashboard and verify config.
Persistence-backed APIs will return helpful errors until Postgres is configured.

---

## Live Tools (invoked during calls)

| Tool | What It Does |
|---|---|
| `create_lead` | Saves caller info + creates follow-up task |
| `update_contact` | Updates name/email/notes mid-call |
| `book_appointment` | Writes to appointments table, logs event, syncs to Google Calendar when booking is enabled |
| `reschedule_appointment` | Updates most recent scheduled appointment |
| `cancel_appointment` | Marks appointment cancelled |
| `set_callback` | Creates a callback task with the right urgency and next-step context |
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
- Node.js 18+
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
