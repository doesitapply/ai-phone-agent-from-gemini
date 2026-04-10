# AI Phone Agent (SMIRK) — Current State, Target State, and Monetization Readiness

Date: 2026-04-09 (America/Los_Angeles)

## Executive summary
You have a working inbound-call AI agent with persistence and a dashboard. You are close to a paid pilot, but not yet at ‘buyer-safe’ because onboarding and two-way SMS are not productized.

## Repo state (canonical)
- Repo: doesitapply/ai-phone-agent-from-gemini
- Local path: /Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini
- Branch: feat/onboarding-wizard
- HEAD: 776dd56

## Production health snapshot (Railway)
Endpoint: https://ai-phone-agent-production-6811.up.railway.app/health

```json
{
  "status": "ok",
  "timestamp": "2026-04-10T00:11:57.272Z",
  "webhookUrl": "https://ai-phone-agent-production-6811.up.railway.app/api/twilio/incoming",
  "activeAgent": "SMIRK",
  "twilioConfigured": true,
  "geminiConfigured": true,
  "openClawEnabled": false,
  "gatewayBridgeActive": false,
  "aiBrain": "OpenRouter (google/gemini-flash-1.5)",
  "ttsEngine": "OpenAI TTS (nova)",
  "uptime": 4037
}
```

## Backend: as-is
### What is implemented (real)
- Twilio inbound webhook flow for voice calls.
- AI response generation (OpenRouter-based in prod today).
- Postgres persistence for calls/messages/events/contacts/leads.
- Dashboard API endpoints for stats, calls, config status, system health.
- Integration framework via outbound webhooks (Zapier/Make-friendly) with retries.
- Google Calendar integration exists.

### What is present but not product-complete
- SMS: outbound sends exist, but no inbound SMS webhook, no threads, no STOP/HELP compliance handling, no delivery status callbacks.
- Handoff/escalation: partially present, needs a clean user-facing workflow.
- Billing: pricing/plan concept exists, but not a sellable billing surface (even if you defer Stripe, you need usage visibility).

### What we just shipped (ready for UI wiring)
- Test endpoints on branch `feat/onboarding-wizard`:
  - POST /api/twilio/test-sms (dashboard-auth)
  - POST /api/twilio/test-call (dashboard-auth, allowlisted)

## Frontend: as-is
### What is implemented
- Dashboard and Settings UI exist.
- Settings are driven by grouped schema (src/settings.ts).
- Health/config status endpoints already exist and are used for banners.
- Webhook URLs are now shown for both incoming + status callback (on feat/onboarding-wizard).

### Primary UX gaps (why it still feels like ‘your agent’)
- No onboarding wizard (non-technical users hit a dense settings wall).
- Required settings are not conditional (false ‘setup incomplete’ signals).
- No guided “test your setup” flow inside the UI.

## Target state (sellable v1)
### Core promise (HVAC/plumbing)
“Never miss a call again. We answer, qualify, and book. We text confirmations. We escalate to a human when needed.”

### Required product surfaces
1) Setup wizard (no terminal)
2) Health check page + step-by-step fix instructions
3) Test SMS + Test Call buttons
4) SMS v1 (inbound + threading + STOP/HELP/START + status callbacks)
5) Zapier/Make integration docs + payload copy tools
6) HVAC/plumbing template (intake fields + booking + confirmations)

## How far are we from money?
### You can charge for a pilot when these are true
- Setup can be done by a non-technical owner in under 15 minutes.
- A test call and test SMS can be run from the UI.
- Missed-call recovery works (SMS) and opt-out compliance is handled.
- One integration path works end-to-end (Webhook → Zapier/Sheets).

### Time estimate
- With focused work: 7–14 days to a paid pilot (HVAC/plumbing) if we ship wizard + SMS v1 + demo flow.

## Next build order (recommended)
1) Finish the onboarding wizard UI and wire it to existing test/health endpoints.
2) Implement SMS v1 (inbound webhook + storage + STOP/HELP + status callback + thread UI).
3) Add integrations UX polish (copy payload samples, retry visibility).
4) Add basic Usage screen (minutes/SMS/AI usage summaries).

