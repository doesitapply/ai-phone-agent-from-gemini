# AI Phone Agent (HVAC/Plumbing) — Productization Plan

## Offer (what we sell)
**“Stop losing calls. We answer, qualify, and book.”**
- AI receptionist/dispatcher for owner-operated home services (HVAC + plumbing v1)
- Answers inbound calls, captures job details, books appointments, sends SMS confirmations, escalates to human when needed
- Pushes clean structured data into existing stack (Zapier/Make/webhook, Google Sheets, CRM)

## Pricing (simple + defensible)
### Platform fee (covers “everything works”)
- **Starter:** $299/mo (single location)
- **Pro:** $599/mo (multi-agent routing + advanced workflows)
- **Enterprise:** custom

### Usage passthrough (hard costs + margin)
- Twilio minutes + SMS
- AI usage (OpenRouter/OpenAI/Gemini)

### Optional onboarding
- **Done-for-you setup:** $499–$1,500 one-time
  - Configure Twilio, webhooks, calendar, templates, test calls/SMS, and first Zapier flow

## MVP scope to sell (must work)
1) **Onboarding Wizard (no terminal)**
   - Business basics
   - Twilio connect (copy webhook URLs + webhook self-test)
   - Choose AI brain (OpenRouter default)
   - Test SMS button
   - Test outbound call button
   - Final system health check

2) **SMS v1 (commercial-ready)**
   - Inbound SMS webhook
   - STOP/HELP/START handling (DNC + compliance)
   - SMS persistence + threading
   - Delivery status callbacks

3) **Integration v1: Webhook → Zapier/Make**
   - Signed payload option
   - Copy sample payload button
   - Docs: “Call → Google Sheet row in 10 minutes”

4) **Deterministic call flow**
   - Clear state machine: intake → qualify → schedule/dispatch → confirm → follow-up
   - Human escalation rules

## Build order (next 4 ticks)
1) Wizard + conditional required settings + webhook UX
2) Test SMS + Test Call endpoints + UI buttons
3) SMS inbound + sms_messages table + unified send helper
4) Zapier doc + payload samples + demo script

## Demo (what we show on sales calls)
- Call in from a phone: agent answers as “<Business Name>”, collects address/issue/urgency
- Books slot (Calendar)
- Sends SMS confirmation
- Dashboard shows summary + structured fields
- Webhook fires to Zapier catch hook → Google Sheet row

## Success metric
- “Recovered revenue” estimate: missed calls/week → booked jobs/month
- Target proof: 1 saved job per month covers platform fee
