# SMIRK Competitive Readiness

Last checked: 2026-06-07

## Position

SMIRK should compete as a focused missed-call recovery product for local service businesses, not as a generic voice-agent builder or full front-office suite.

The strongest wedge is:

- Existing-number forwarding for calls the owner cannot answer.
- AI capture of caller name, phone, job details, urgency, and next action.
- Owner email alerts plus callback tasks.
- Recovery Desk controls for follow-up work.
- Urgent owner handoff when the caller explicitly needs a person.
- Proof dashboard showing the call record, summary, callback task, and operational readiness.

## Current Market Signals

| Competitor category | Current signal | SMIRK response |
| --- | --- | --- |
| Broad AI receptionist suites | Goodcall advertises no call-minute/token fees, team permissions, directory contacts for call transfer/notifications, Google Voice support, Zapier CRM connection, and performance/call-recording dashboard access. Source: https://www.goodcall.com/pricing | Do not try to out-suite them in v1. Win with proof-loop recovery, simple plans, and faster owner-visible callback evidence. |
| Hybrid/live answering services | Smith.ai includes CRM integrations, lead qualification, intake questions, call transfers, live-agent handoff, AI scheduling, dedicated numbers, recordings, transcripts, and instant call summaries. Source: https://smith.ai/pricing/ai-receptionist | Make urgent owner handoff records, callback queue, recordings/transcripts, and owner-controlled follow-up clear in the product surface. A third-party live-agent network remains a future add-on, not v1 scope. |
| Vertical specialists | Slang AI advertises restaurant-specific plans with missed-call capture, smart priority queues, human forwarding/text links, VIP handling, special requests, CSAT, same-day setup, and Premium starting at $599/location. Source: https://www.slang.ai/pricing | Stay out of restaurant reservation depth unless explicitly targeting restaurants. For trades, emphasize urgent job capture, callback priority, routed team handoff, and owner alerts. |
| Low-price front-office suites | My AI Front Desk advertises $99/mo business plan with voice, chat, SMS, CRM, automations, 200 voice minutes, Zapier, and fast setup. Source: https://www.myaifrontdesk.com/pricing | SMIRK must justify higher price with a narrower outcome: recovered missed jobs, operational proof, setup help, and service-business specific recovery workflow. |
| Voice-agent platforms | Vapi sells usage-based voice infrastructure and custom provider access; Retell sells pay-as-you-go voice agents, analytics/transcripts, simulation testing, webhooks/API access, and post-call analysis; Bland sells all-in per-minute voice infrastructure and transfer pricing. Sources: https://vapi.ai/pricing, https://www.retellai.com/pricing, https://www.retellai.com/features/post-call-analysis, https://www.bland.ai/pricing | SMIRK should sell the packaged business workflow, not raw voice infrastructure. Keep pricing understandable and show what the buyer gets after one proof call. |

## Changes Made From This Audit

- Public plan features now mention competitive strengths that already exist: existing-number forwarding, callback task queue, proof dashboard, handoff rules, and CRM/webhook integrations.
- Added `/compare` to explain SMIRK's category position without naming competitors on the buyer page.
- Landing page now points buyers to a competitive explanation and replaces weak "No SMS" hero stat copy with proof-loop positioning.
- Added public vertical pages for `/industries/hvac`, `/industries/plumbing`, `/industries/roofing`, `/industries/landscaping`, and `/industries/auto-repair` with workflow-specific capture and proof-loop examples.
- Fixed the guarded proof-call runner so it uses the real conversational `/api/test-call` path instead of the static Twilio connectivity test, and hardened owner-alert delivery for proof calls, callback-task calls, workspace notification emails, and display-name sender formats.
- Added an operator-facing Proof Call Lab in the dashboard so the proof loop readiness, counters, real conversational proof call, and static Twilio connectivity test are separated in the product UI.
- Ran the first live proof call to an approved allowlisted target; the call produced a call summary, owner email alert, callback tasks, and a correlated dashboard proof count. The guarded runner was extended because owner email proof arrived just after the old 5-minute wait window.
- Updated phone-agent pricing guidance and outbound sequence copy so buyer calls can quote the current plan ladder: Starter $197/month, Pro $397/month, Agency $697/month.
- Fixed human handoff routing so successful `escalate_to_human` tool calls preserve the routed team member phone through Twilio `<Dial>`, and name-aware routing can send explicit requests such as Jesse/Cameron to the configured person.
- Updated `/compare` and the Handoffs page so urgent owner handoffs, transferred handoff counts, routable team members, missing transfer numbers, recommended actions, and transcript snippets are visible rather than hidden backend behavior.
- Added a dashboard call intelligence surface backed by `/api/call-intelligence` so operators can see summary/transcript/recording coverage, QA pass rate, outcome and sentiment mix, and calls that deserve review.
- Added `/api/public-proof-snapshot` and live aggregate proof metrics to each vertical page so buyers can see production call, summary, callback-task, owner-alert, complete-proof, and transferred-handoff counters without exposing caller data.

## Remaining Competitive Gaps

- Keep proof-call verification recurring: the first production proof call incremented `completeProofCalls`, but future releases should continue running guarded proof calls after voice, task, owner-alert, or dashboard-counter changes.
- SMS remains intentionally out of first-dollar scope. That is defensible for compliance and cost, but competitors use SMS heavily. If buyers demand it, add a compliant SMS tier rather than reintroducing it silently.
- A Smith.ai-style third-party live-agent network is not built. SMIRK now supports routed transfer to the customer's own configured team; external 24/7 agent fallback should be an explicit Pro/Agency add-on if buyers demand it.
- Vertical pages now show aggregate production proof. The stronger version would show vertical-specific proof once enough verified calls are tagged by trade without leaking caller data.
