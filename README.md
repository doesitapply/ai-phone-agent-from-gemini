# SMIRK — Enterprise AI Phone Agency Platform

A stateful AI phone operations platform that handles inbound and outbound calls using **Google Gemini 2.0 Flash** for intelligence and **Twilio** for telephony. Built with persistent caller memory, post-call intelligence, live tool invocation, and a full operations dashboard.

---

## 🚀 Core Capabilities

### 1. Advanced Telephony & AI
- **Sub-second latency** via Gemini 2.0 Flash native function calling.
- **Multi-Voice Support**: Google TTS, OpenAI TTS (Nova, Alloy), ElevenLabs, Cartesia.
- **Boss Mode**: Real-time call monitoring, "whisper" coaching to the AI mid-call, and live human takeover.
- **OpenClaw & OpenRouter**: Fallback routing and local LLM gateway support.

### 2. Built-in CRM & Intelligence
- **Post-Call Intelligence**: Automatic summarization, intent classification, and entity extraction (names, dates, prices).
- **Contact Memory**: The AI remembers past conversations, previous outcomes, and caller preferences across sessions.
- **Task Generation**: Automatically creates tasks (e.g., "Send quote to John") based on call context.
- **External CRM Sync**: Native integrations with **HubSpot, Salesforce, Airtable, and Notion**.

### 3. Prospecting & Lead Generation (Lead Hunter)
- **Apollo.io & Google Maps Integration**: Search for B2B leads directly from the dashboard.
- **AI Pitch Generator**: Automatically writes personalized sales pitches based on the lead's website and industry.
- **Auto-Dialer**: One-click campaign dialing with automatic outcome logging.

### 4. Enterprise Compliance & Routing
- **TCPA & State Law Compliance**: Automatic checking of recording laws (one-party vs. two-party consent) and time-of-day dialing restrictions.
- **DNC Management**: Built-in Do Not Call list with automatic opt-out detection from call transcripts.
- **Team Routing**: Intelligent call routing to the right human agent based on skills and availability.

### 5. Extensibility
- **Model Context Protocol (MCP)**: Connect external APIs and internal tools directly to the AI's function-calling brain.
- **Custom Tools**: Book appointments (Google Calendar), send SMS (Twilio), escalate to human, log notes, and more.
- **Webhooks**: Fire real-time events to Make/Zapier for external workflows.

---

## Architecture

```
Caller → Twilio → /api/twilio/incoming → Caller Identity Resolution
                                       → Do-Not-Call Check
                                       → Greeting (TTS)
                                       ↓
              → /api/twilio/process  → Gemini 2.0 Flash (function calling loop)
                                       → Tool Dispatch (book, reschedule, SMS, escalate...)
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
- **Prospecting** — Lead Hunter, Apollo/Maps search, auto-dialer campaigns
- **Agent Identity** — configure the AI's name, persona, and company details without touching code
- **Settings** — manage API keys, integrations, TTS engines, and compliance rules

---

## Health and diagnostics

- `GET /health` (public): fast liveness + configuration signals. Includes a `db` object `{ enabled, ok, latencyMs, error }`.
- `GET /api/system-health` (public): deeper connectivity checks (DB ping, OpenClaw gateway ping when enabled).

### No-DB mode (first-run friendly)

If `DATABASE_URL` is not set, the server boots in **no-db mode** so you can load the dashboard and verify config.
Persistence-backed APIs will return helpful errors until Postgres is configured.

---

## Live Tools (invoked during calls)

| Tool | What It Does |
|---|---|
| `create_lead` | Saves caller info + creates follow-up task |
| `update_contact` | Updates name/email/notes mid-call |
| `book_appointment` | Writes to appointments table, logs event, syncs to Google Calendar |
| `reschedule_appointment` | Updates most recent scheduled appointment |
| `cancel_appointment` | Marks appointment cancelled |
| `send_sms_followup` | Sends Twilio SMS with confirmation details |
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
