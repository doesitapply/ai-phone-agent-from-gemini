# AI Phone Agent — Gemini + Twilio

A production-ready AI phone agent that handles both inbound and outbound phone calls using **Google Gemini** for intelligence and **Twilio** for telephony. Features a full-stack dashboard with call history, live conversation logs, configurable agent personas, and real-time stats.

## Features

- **Outbound Calls** — Dial any phone number directly from the dashboard
- **Inbound Calls** — Receive calls on your Twilio number and have Gemini handle them automatically
- **Configurable Agent Personas** — Create multiple agent configs with custom system prompts, greetings, voices, and languages
- **Persistent Call History** — All calls and conversations stored in SQLite (survives restarts)
- **Live Conversation Logs** — Real-time chat-style view of every call transcript
- **Call Stats Dashboard** — Total calls, active calls, avg duration, inbound/outbound breakdown
- **Amazon Polly Voices** — High-quality neural TTS voices via Twilio's Polly integration
- **Multi-language Support** — English (US/UK/AU), Spanish, French, German, Portuguese
- **End-of-call Detection** — Automatically hangs up on goodbye keywords
- **Status Webhooks** — Tracks call lifecycle (initiated → ringing → answered → completed)
- **Webhook URL Display** — Setup tab shows your exact webhook URLs with one-click copy

## Tech Stack

| Layer | Technology |
|---|---|
| AI / LLM | Google Gemini 2.0 Flash |
| Telephony | Twilio Voice API |
| Backend | Express + TypeScript |
| Frontend | React 19 + Vite + TailwindCSS |
| Database | SQLite (better-sqlite3) |
| TTS | Amazon Polly (via Twilio) |

## Quick Start

### Prerequisites

- Node.js 18+
- A [Twilio account](https://www.twilio.com) with a phone number
- A [Google Gemini API key](https://aistudio.google.com/apikey)
- [ngrok](https://ngrok.com) (for local development with Twilio webhooks)

### Setup

1. **Clone and install dependencies:**
   ```bash
   git clone https://github.com/doesitapply/ai-phone-agent-from-gemini.git
   cd ai-phone-agent-from-gemini
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and fill in your keys:
   ```env
   GEMINI_API_KEY=your_gemini_api_key
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_PHONE_NUMBER=+15551234567
   APP_URL=https://your-ngrok-url.ngrok.io
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

4. **Expose your local server for Twilio webhooks:**
   ```bash
   ngrok http 3000
   ```
   Copy the ngrok HTTPS URL and set it as `APP_URL` in `.env.local`.

5. **Configure Twilio:**
   - Go to your [Twilio Console](https://console.twilio.com)
   - Navigate to Phone Numbers → Manage → Active Numbers
   - Click your phone number
   - Under "Voice & Fax", set:
     - **A Call Comes In** → Webhook → `https://your-ngrok-url.ngrok.io/api/twilio/incoming`
     - **Call Status Changes** → `https://your-ngrok-url.ngrok.io/api/twilio/status`
   - Save changes

6. **Open the dashboard:** [http://localhost:3000](http://localhost:3000)

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/calls` | Initiate an outbound call |
| `GET` | `/api/calls` | List all call records |
| `GET` | `/api/calls/:sid/messages` | Get messages for a specific call |
| `POST` | `/api/twilio/incoming` | Twilio webhook: call connected |
| `POST` | `/api/twilio/process` | Twilio webhook: process speech |
| `POST` | `/api/twilio/status` | Twilio webhook: call status updates |
| `GET` | `/api/agents` | List agent configurations |
| `POST` | `/api/agents` | Create a new agent config |
| `PUT` | `/api/agents/:id` | Update an agent config |
| `PUT` | `/api/agents/:id/activate` | Set agent as active |
| `DELETE` | `/api/agents/:id` | Delete an agent config |
| `GET` | `/api/stats` | Get call statistics |
| `GET` | `/api/webhook-url` | Get current webhook URLs |

## Production Deployment

Build the frontend and run in production mode:

```bash
npm run build
NODE_ENV=production node server.ts
```

For cloud deployment (Railway, Render, Fly.io, etc.), set all environment variables in your platform's dashboard and ensure `APP_URL` points to your public domain.

## Architecture

```
Browser (React Dashboard)
        │
        ▼
Express Server (server.ts)
        │
        ├── /api/calls ──────────────► Twilio API (outbound call)
        │
        ├── /api/twilio/incoming ◄──── Twilio Webhook (call connected)
        │        │
        │        └── Greet caller with TwiML + Gather speech
        │
        ├── /api/twilio/process ◄───── Twilio Webhook (speech detected)
        │        │
        │        ├── Store user message in SQLite
        │        ├── Build conversation history
        │        ├── Call Gemini API for response
        │        ├── Store AI response in SQLite
        │        └── Return TwiML with Polly voice + next Gather
        │
        └── SQLite Database
                 ├── calls (call records + metadata)
                 ├── messages (full conversation transcripts)
                 └── agent_configs (persona configurations)
```

## Security

The following security measures are implemented:

| Layer | Mechanism |
|---|---|
| **HTTP Headers** | `helmet` sets secure headers (XSS, HSTS, etc.) |
| **Rate Limiting** | 10 calls/min for outbound calls; 200 req/min for all API routes |
| **Input Validation** | `zod` schemas validate all API inputs (phone format, prompt length, etc.) |
| **Dashboard Auth** | Optional `DASHBOARD_API_KEY` protects all `/api/*` routes |
| **Body Size Limit** | Request bodies capped at 10KB |
| **Twilio Webhooks** | Exempt from rate limiting (Twilio controls volume) |

To enable dashboard authentication, set `DASHBOARD_API_KEY` in `.env.local`. All API requests must then include the header `X-Api-Key: <your_key>`.

## Observability

| Feature | Detail |
|---|---|
| **Structured Logging** | JSON logs in production, colored console in dev |
| **Request IDs** | Every request gets a UUID, returned as `X-Request-ID` header |
| **AI Latency Tracking** | Gemini response time logged per call turn and shown in dashboard |
| **Request Log Table** | All API requests stored in SQLite `request_logs` table |
| **HTTP Access Logs** | `morgan` logs all HTTP traffic |
| **Call Correlation** | `callSid` attached to all log entries for easy tracing |

## Deployment

### Docker

```bash
# Build and run with Docker Compose
cp .env.example .env
# Fill in your values in .env
docker-compose up -d
```

### Manual Production Build

```bash
npm run build
NODE_ENV=production node server.ts
```

### Cloud Platforms

Deploy to any Node.js-compatible platform (Railway, Render, Fly.io, Google Cloud Run):

1. Set all environment variables in your platform's dashboard
2. Set `APP_URL` to your public domain
3. Set `DASHBOARD_API_KEY` to a strong random string
4. Configure Twilio webhooks to point to your public domain

### CI/CD

A GitHub Actions pipeline (`.github/workflows/ci.yml`) runs on every push:
- TypeScript type checking
- Frontend build verification
- Docker image build
- npm security audit

## License

MIT
