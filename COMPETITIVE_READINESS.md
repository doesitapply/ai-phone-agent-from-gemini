# SMIRK Competitive Readiness

Last checked: 2026-06-07

## Position

SMIRK should compete as a focused missed-call recovery product for local service businesses, not as a generic voice-agent builder or full front-office suite.

The strongest wedge is:

- Existing-number forwarding for calls the owner cannot answer.
- AI capture of caller name, phone, job details, urgency, and next action.
- Owner email alerts plus callback tasks.
- Recovery Desk controls for follow-up work.
- Proof dashboard showing the call record, summary, callback task, and operational readiness.

## Current Market Signals

| Competitor category | Current signal | SMIRK response |
| --- | --- | --- |
| Broad AI receptionist suites | Goodcall advertises quick setup, knowledge sources, appointment automation, CRM/calendar sync, lead sharing by SMS/email/Sheets/CRM, and analytics. Source: https://www.goodcall.com/ | Do not try to out-suite them in v1. Win with proof-loop recovery, simple plans, and faster owner-visible callback evidence. |
| Hybrid/live answering services | Smith.ai includes CRM integrations, lead qualification, intake questions, call transfers, live-agent handoff, AI scheduling, dedicated numbers, recordings, transcripts, and spam filtering. Source: https://smith.ai/pricing/ai-receptionist | Make handoffs, callback queue, recordings, transcripts, and owner-controlled follow-up clear in the product surface. Live-agent network is a future partner/add-on, not v1 scope. |
| Vertical specialists | Slang AI starts around $399/location for restaurant answering and includes reservation management, text links, VIP handling, special requests, CSAT, real-time alerts, missed-call capture, and priority queues. Source: https://www.slang.ai/pricing | Stay out of restaurant reservation depth unless explicitly targeting restaurants. For trades, emphasize urgent job capture, callback priority, and owner alerts. |
| Low-price front-office suites | My AI Front Desk advertises $99/mo business plan with voice, chat, SMS, CRM, automations, 200 voice minutes, Zapier, and fast setup. Source: https://www.myaifrontdesk.com/pricing | SMIRK must justify higher price with a narrower outcome: recovered missed jobs, operational proof, setup help, and service-business specific recovery workflow. |
| Voice-agent platforms | Bland, Vapi, and Synthflow position around voice infrastructure, provider choices, per-minute usage, telephony options, compliance, and builder flexibility. Sources: https://www.bland.ai/pricing, https://docs.vapi.ai/faq, https://synthflow.ai/pricing | SMIRK should sell the packaged business workflow, not raw voice infrastructure. Keep pricing understandable and show what the buyer gets after one proof call. |

## Changes Made From This Audit

- Public plan features now mention competitive strengths that already exist: existing-number forwarding, callback task queue, proof dashboard, handoff rules, and CRM/webhook integrations.
- Added `/compare` to explain SMIRK's category position without naming competitors on the buyer page.
- Landing page now points buyers to a competitive explanation and replaces weak "No SMS" hero stat copy with proof-loop positioning.

## Remaining Competitive Gaps

- Real proof-call counter is still the strongest completion gap: the live dashboard proof check shows call records and summaries, but complete proof calls and owner emails need real production evidence before claiming the loop is fully proven.
- SMS remains intentionally out of first-dollar scope. That is defensible for compliance and cost, but competitors use SMS heavily. If buyers demand it, add a compliant SMS tier rather than reintroducing it silently.
- Live human fallback is not built. If Smith.ai-style fallback becomes important, implement partner/live-transfer fallback as an explicit Pro/Agency add-on.
- Public site should eventually add vertical pages for HVAC, plumbing, roofing, landscaping, and auto repair with workflow-specific proof examples.
