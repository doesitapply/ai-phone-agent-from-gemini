# AI Phone Agent (SMIRK) — Current State, Target State, and Monetization Readiness

Date: 2026-04-09 (America/Los_Angeles)

## Executive summary
You have a working inbound-call AI agent with persistence and a dashboard. You are close to a paid pilot, but not yet at buyer-safe because payment, provisioning, and first-call proof still need end-to-end verification.

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
- Handoff/escalation: partially present, needs a clean user-facing workflow.
- Billing: pricing/plan concept exists, but not a sellable billing surface (even if you defer Stripe, you need usage visibility).

### What we just shipped (ready for UI wiring)
- Test endpoints on branch `feat/onboarding-wizard`:
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
“Never miss a call again. We answer, qualify, email you the lead, create a callback task, and show proof in your dashboard.”

### Required product surfaces
1) Setup wizard (no terminal)
2) Health check page + step-by-step fix instructions
3) Test Call button
4) Owner email alert delivery
5) Callback task creation and completion flow
6) Dashboard proof of captured leads, summaries, and open callbacks
7) HVAC/plumbing template (intake fields + callback workflow)

## How far are we from money?
### You can charge for a pilot when these are true
- Setup can be done by a non-technical owner in under 15 minutes.
- A test call can be run from the UI.
- Missed-call recovery creates a useful owner email and callback task.
- The dashboard shows the captured call, summary, and callback status.
- One integration path works end-to-end (Webhook → Zapier/Sheets).

### Time estimate
- With focused work: 7–14 days to a paid pilot (HVAC/plumbing) if we ship payment, provisioning, owner email alerts, callback tasks, and a proof-call demo flow.

## Next build order (recommended)
1) Finish the onboarding wizard UI and wire it to existing test/health endpoints.
2) Verify Stripe checkout into workspace activation or tracked manual fallback.
3) Verify owner email alert delivery after a qualified missed call.
4) Verify callback task creation and dashboard proof for the first production test call.
5) Add integrations UX polish only after the core paid proof loop works.
