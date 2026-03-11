# AI Phone Agent — Gemini + Twilio

A stateful AI phone operations platform that handles inbound and outbound calls using **Google Gemini 2.0 Flash** for intelligence and **Twilio** for telephony. Built with persistent caller memory, post-call intelligence, live tool invocation, and a full operations dashboard.

---

## What This Is

Most voice AI demos are stateless — every call starts from zero. This system maintains a persistent **Operational Memory Graph** across every call:

- **Caller identity** — phone numbers resolve to contacts; returning callers get their history loaded into the AI's context automatically
- **Live tool invocation** — during a call, Gemini uses native function calling to book appointments, create leads, send SMS confirmations, escalate to humans, and mark do-not-call in real time
- **Post-call intelligence** — after every call, Gemini analyzes the transcript and extracts intent, outcome, sentiment, resolution score, and next action
- **Task and handoff tracking** — unresolved calls automatically create follow-up tasks; escalations create handoff records with urgency and recommended actions

---

## Architecture

```
Caller → Twilio → /api/twilio/incoming → Caller Identity Resolution
                                       → Do-Not-Call Check
                                       → Greeting (Amazon Polly TTS)
                                       ↓
              → /api/twilio/process  → Gemini 2.0 Flash (function calling loop)
                                       → Tool Dispatch (book, reschedule, SMS, escalate...)
                                       → Response spoken via Polly TTS
                                       ↓
              → /api/twilio/status   → Post-Call Intelligence Pipeline (async)
                                       → Summary, intent, outcome, entities
                                       → Task creation for unresolved calls
                                       → Contact record updated
```

---

## Features

### Telephony
- Inbound and outbound calls via Twilio Voice API
- Amazon Polly neural TTS (8 voices, multi-language)
- Enhanced speech recognition (`phone_call` model)
- Twilio signature validation in production
- Webhook deduplication (prevents double-processing)
- Max-turn watchdog (configurable per agent)
- Dead-air detection and re-prompt

### AI & Intelligence
- **Google Gemini 2.0 Flash** — fast, accurate, low latency
- **Live function calling** — AI invokes tools during the call, not just after
- **Post-call pipeline** — structured JSON extraction: intent (11 categories), outcome (11 categories), sentiment, resolution score (0–1), next action, 7 entity fields
- AI retry with exponential backoff (3 attempts)

### Live Tools (invoked during calls)

| Tool | What It Does |
|---|---|
| `create_lead` | Saves caller info + creates follow-up task |
| `update_contact` | Updates name/email/notes mid-call |
| `book_appointment` | Writes to appointments table, logs event |
| `reschedule_appointment` | Updates most recent scheduled appointment |
| `cancel_appointment` | Marks appointment cancelled |
| `send_sms_confirmation` | Sends Twilio SMS with confirmation details |
| `escalate_to_human` | Creates handoff record with urgency + transcript snippet |
| `create_support_ticket` | Creates task with priority level |
| `mark_do_not_call` | Sets DNC flag; future calls blocked at the webhook |

### Operational Memory Graph (12 tables)

| Table | Purpose |
|---|---|
| `contacts` | Persistent caller identity — phone → name, history, DNC flag |
| `calls` | Call records with contact link, turn count, resolution score |
| `messages` | Full transcript per call |
| `call_summaries` | AI-generated: intent, outcome, sentiment, score, next action, entities |
| `call_events` | 23 event types logged throughout every call lifecycle |
| `tasks` | Auto-created for unresolved calls; completable from dashboard |
| `appointments` | Booked/rescheduled/cancelled by the AI during calls |
| `tool_executions` | Full audit log of every tool run, with input/output/duration |
| `handoffs` | Escalation records with urgency and recommended action |
| `agent_configs` | Multiple agent personas with vertical and max-turn config |
| `request_logs` | HTTP request audit trail |

### Security
- `helmet` — 11 secure HTTP headers (XSS, HSTS, clickjacking protection)
- Rate limiting — 10 req/min for outbound calls, 200 req/min for API
- `zod` input validation on every endpoint
- Optional `DASHBOARD_API_KEY` — all `/api/*` requests require `X-Api-Key` header
- Twilio signature validation in production
- Request body capped at 10KB

### Observability
- Structured JSON logging (production) / colored console (dev)
- UUID request IDs on every request (`X-Request-ID` response header)
- AI latency tracked per turn, stored and shown in dashboard
- Persistent request log in SQLite `request_logs` table
- `morgan` HTTP access logging
- `callSid` correlated on all log entries

### Dashboard (6 tabs)
- **Dashboard** — 12 stat cards: total calls, active, completed, avg duration, booking rate, transfer rate, avg resolution score, open tasks, AI latency
- **Call History** — expandable cards with AI summary, intent/outcome badges, tools invoked during call, full transcript
- **Contacts** — directory with call count, last outcome, open tasks badge, DNC flag
- **Tasks** — pending handoffs with urgency + recommended action, open tasks queue with one-click complete
- **Agent Config** — create/edit/activate agents with vertical selector and max turns
- **Setup** — webhook URLs with copy buttons, env var reference

### Deployment
- `Dockerfile` — multi-stage build, non-root user, health check
- `docker-compose.yml` — single command with persistent SQLite volume
- `.github/workflows/ci.yml` — 4-job CI pipeline (typecheck, build, Docker, security audit)

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI / LLM | Google Gemini 2.0 Flash (native function calling) |
| Telephony | Twilio Voice API |
| TTS | Amazon Polly via Twilio |
| Backend | Express + TypeScript |
| Frontend | React 19 + Vite + TailwindCSS |
| Database | SQLite (better-sqlite3, WAL mode) |
| Validation | Zod |
| Security | Helmet, express-rate-limit |
| Logging | Morgan, structured JSON logger |

---

## Quick Start

### Prerequisites
- Node.js 18+
- A [Twilio account](https://www.twilio.com) with a phone number
- A [Google Gemini API key](https://aistudio.google.com/apikey)
- [ngrok](https://ngrok.com) for local development

### Setup

```bash
git clone https://github.com/doesitapply/ai-phone-agent-from-gemini.git
cd ai-phone-agent-from-gemini
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
GEMINI_API_KEY=your_gemini_api_key
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+15551234567
APP_URL=https://your-ngrok-url.ngrok.io

# Optional
DASHBOARD_API_KEY=your_secret_dashboard_key
PORT=3000
```

```bash
npm run dev
```

### Twilio Webhook Configuration

In your Twilio console, set your phone number's webhook:

- **A Call Comes In** → Webhook → `https://your-ngrok-url.ngrok.io/api/twilio/incoming`
- **Call Status Changes** → `https://your-ngrok-url.ngrok.io/api/twilio/status`

The **Setup** tab in the dashboard shows your exact webhook URLs with one-click copy.

---

## Docker

```bash
cp .env.example .env
# Fill in your values in .env
docker-compose up -d
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `TWILIO_ACCOUNT_SID` | Yes (for calls) | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes (for calls) | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Yes (for calls) | Your Twilio phone number (E.164) |
| `APP_URL` | Yes (for calls) | Public URL for Twilio webhooks |
| `DASHBOARD_API_KEY` | No | If set, all `/api/*` requests require `X-Api-Key` header |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | `development` or `production` |
| `DB_PATH` | No | SQLite database path (default: `./calls.db`) |

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/calls` | Initiate outbound call |
| `GET` | `/api/calls` | List all calls with summaries |
| `GET` | `/api/calls/:sid/messages` | Get transcript + events for a call |
| `GET` | `/api/contacts` | List all contacts |
| `GET` | `/api/contacts/:id` | Get contact detail |
| `GET` | `/api/tasks` | List tasks (filter by `?status=open`) |
| `PUT` | `/api/tasks/:id` | Update task status |
| `GET` | `/api/handoffs` | List handoff records |
| `PUT` | `/api/handoffs/:id/acknowledge` | Acknowledge a handoff |
| `GET` | `/api/summaries` | List post-call summaries |
| `GET` | `/api/stats` | Dashboard analytics |
| `GET` | `/api/agents` | List agent configs |
| `POST` | `/api/agents` | Create agent config |
| `PUT` | `/api/agents/:id` | Update agent config |
| `PUT` | `/api/agents/:id/activate` | Set active agent |
| `DELETE` | `/api/agents/:id` | Delete agent config |
| `POST` | `/api/twilio/incoming` | Twilio webhook: call connected |
| `POST` | `/api/twilio/process` | Twilio webhook: speech received |
| `POST` | `/api/twilio/status` | Twilio webhook: call status update |
| `GET` | `/api/webhook-url` | Get configured webhook URL |
| `GET` | `/api/logs` | Request log history |

---

## Project Structure

```
├── server.ts                  # Main Express server — all routes and middleware
├── src/
│   ├── db.ts                  # Database schema (12 tables), migrations, seed
│   ├── contacts.ts            # Caller identity resolution and context building
│   ├── function-calling.ts    # Gemini function-calling loop and tool dispatch
│   ├── intelligence.ts        # Post-call AI analysis pipeline
│   ├── tools.ts               # 9 structured action tools
│   ├── events.ts              # Call event logging (23 event types)
│   ├── App.tsx                # React dashboard (6 tabs)
│   └── main.tsx               # React entry point
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── .github/
    └── workflows/
        └── ci.yml             # GitHub Actions CI pipeline
```

---

## License

MIT
