# SMIRK / CaseFlow Technical Readiness Report

Prepared for: Lead investor diligence  
Scope: `/Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini`  
Date: 2026-06-04

## Executive Readiness View

SMIRK is a working missed-call recovery and intake product with real telephony, workspace accounts, per-call persistence, tool execution, post-call intelligence, webhook/CRM sync, and an operator dashboard. The strongest technical asset is the "call spine": Twilio call SID connects calls, messages, summaries, tasks, handoffs, tool executions, webhooks, and CRM sync.

The platform is not yet diligence-clean for a 1,000-client acquisition story. It is best characterized as an MVP-to-early-SaaS system, not a hardened multi-tenant compliance platform. The gaps are specific and fixable: stronger tenant enforcement, provable extraction provenance, billing/resource lifecycle controls, async queues, and integration credential scoping.

Important correction: this checkout does not use Drizzle schema files. The schema source of truth is handwritten Postgres DDL in `src/db.ts` and SaaS DDL in `src/saas.ts`.

## Architecture

### What Exists

- Core records are Postgres-backed: `calls`, `messages`, `contacts`, `call_summaries`, `tasks`, `handoffs`, `tool_executions`, `webhook_deliveries`, and custom fields are created in `src/db.ts` (`src/db.ts:73`, `src/db.ts:95`, `src/db.ts:117`, `src/db.ts:241`, `src/db.ts:267`, `src/db.ts:301`, `src/db.ts:317`, `src/db.ts:331`, `src/db.ts:346`).
- SaaS workspaces exist in `src/saas.ts`, with plan limits, usage counters, API keys, per-workspace Twilio fields, AI keys, webhook URL, business profile, and setup state (`src/saas.ts:22`, `src/saas.ts:75`, `src/saas.ts:84`, `src/saas.ts:87`, `src/saas.ts:101`, `src/saas.ts:103`, `src/saas.ts:106`, `src/saas.ts:121`).
- Workspace isolation columns are added across legacy tables: `calls`, `contacts`, `tasks`, `appointments`, `agent_configs`, `call_summaries`, `handoffs`, `plugin_tools`, `mcp_servers`, `field_definitions`, `contact_custom_fields`, `workspace_knowledge_sources`, and `sms_messages` (`src/db.ts:458` to `src/db.ts:479`).
- Workspace indexes exist for the main tables (`src/db.ts:524` to `src/db.ts:528`).
- Dedicated customer phone numbers route inbound calls to workspaces through `workspace_phone_numbers` (`server.ts:388` to `server.ts:434`).

### Multi-Tenant Isolation Assessment

Current isolation is application-enforced, not database-enforced.

Evidence:
- `getWorkspaceId` trusts `X-Workspace-Id` and defaults to workspace `1`; the code comment says every data query must use this to prevent leakage (`server.ts:374` to `server.ts:381`).
- Twilio lookup by `To` number is the stronger path for live calls, but it has single-tenant fallback behavior and even fails open to workspace `1` on errors (`server.ts:411` to `server.ts:434`).
- Many schema changes add `workspace_id INTEGER NOT NULL DEFAULT 1`, which preserves legacy data but increases the risk of accidental cross-tenant reads if a query omits the workspace predicate (`src/db.ts:458` to `src/db.ts:479`).
- Some plugin/tool query helpers currently load enabled tools without workspace filtering (`src/plugin-tools.ts:57` to `src/plugin-tools.ts:64`), even though the schema has `workspace_id`.

Investor interpretation: tenant separation is present but immature. The architecture can become multi-tenant safe, but it needs a tenant-enforcement pass before enterprise diligence.

## Per-Workspace AI Keys

### Storage

Workspace rows store `openrouter_api_key`, `elevenlabs_api_key`, and `gemini_api_key` (`src/saas.ts:41` to `src/saas.ts:43`, `src/saas.ts:106` to `src/saas.ts:108`). Twilio subaccount auth token is stored on the workspace as `twilio_auth_token` (`src/saas.ts:38` to `src/saas.ts:40`, `src/saas.ts:103` to `src/saas.ts:105`).

### Runtime Resolution

Per-workspace key resolution exists with a 5-minute TTL cache. Workspace keys take priority over global env keys, and workspace-key authentication failures do not silently fall back to global keys (`src/workspace-ai-keys.ts:1` to `src/workspace-ai-keys.ts:16`, `src/workspace-ai-keys.ts:64` to `src/workspace-ai-keys.ts:105`, `src/workspace-ai-keys.ts:154` to `src/workspace-ai-keys.ts:169`).

The call runtime resolves workspace AI keys before generating the call response (`server.ts:2733` to `server.ts:2740`). OpenRouter config is built from workspace keys when present (`server.ts:1688` to `server.ts:1693`).

### Rotation and Isolation Gaps

- Cache invalidation exists (`src/workspace-ai-keys.ts:108` to `src/workspace-ai-keys.ts:112`), but the audit did not find a complete operator-facing key-rotation workflow with audit history.
- AI keys appear stored as plaintext workspace columns. Twilio subaccount tokens are encrypted during managed provisioning (`src/twilio-provisioning.ts:24` to `src/twilio-provisioning.ts:31`, `src/twilio-provisioning.ts:61` to `src/twilio-provisioning.ts:71`), but equivalent encryption-at-rest is not evident for OpenRouter/Gemini/ElevenLabs workspace keys.
- Tenant separation depends on every route and helper passing the right workspace ID.

Readiness grade: B- for MVP SaaS, C for acquisition-grade controls.

## Orchestration Logic

### Runtime Brain

The repo implements a layered call brain:

1. Twilio receives a call and routes by phone number to a workspace (`server.ts:2442` to `server.ts:2462`).
2. The system resolves caller identity, DNC status, call classification, and context snapshot (`server.ts:2499` to `server.ts:2540`).
3. The call prompt is assembled from workspace profile, workspace knowledge, temporary owner context, date/time, and hard rules (`server.ts:2709` to `server.ts:2794`).
4. AI generation attempts OpenClaw, then OpenRouter, then Gemini fallback (`server.ts:1673` to `server.ts:1732`, `server.ts:1735` to `server.ts:1906`).
5. The tool loop exposes built-in tools, HTTP plugin tools, and MCP tools; each tool call gets timeout, parse recovery, isolated failure handling, and per-tool circuit breaker (`server.ts:1747` to `server.ts:1889`).

### Knot Framework Finding

No `Knot` framework references were found in this checkout. The concrete orchestration implementation is OpenClaw/OpenRouter/Gemini plus the local tool dispatcher, plugin tools, and MCP bridge. Any data-room claim about "Knot framework" should either point to another repository or be removed.

### Verification Loops / Auditor Agents

There are two verification-like mechanisms:

- Runtime tool discipline: function declarations require specific fields before actions like lead capture or booking (`src/function-calling.ts:55` to `src/function-calling.ts:69`, `src/function-calling.ts:86` to `src/function-calling.ts:109`, `src/function-calling.ts:232` to `src/function-calling.ts:243`).
- Post-call adversarial evaluator: after the call ends, the evaluator grades resolution, tool appropriateness, information capture, duration, and escalation behavior (`src/intelligence.ts:648` to `src/intelligence.ts:697`, `src/reward-system.ts:1` to `src/reward-system.ts:15`, `src/reward-system.ts:85` to `src/reward-system.ts:123`).

Critical limitation: the evaluator runs after persistence and is non-blocking. It does not prevent hallucinated lead extraction before `call_summaries` and `contact_custom_fields` are written.

Readiness grade: B for operational workflow, C+ for hallucination prevention.

## Unit Economics

### What The Code Tracks

- Workspace usage records calls and rounded call minutes (`src/saas.ts:281` to `src/saas.ts:304`).
- Ops monitor estimates monthly Twilio and AI spend from local logs, but notes provider invoices remain the source of truth (`server.ts:7170` to `server.ts:7184`).
- OpenRouter responses may log `tokensUsed`, but the code does not persist input/output token split per call as first-class usage (`server.ts:7196` to `server.ts:7204`, `src/openrouter.ts:36`, `src/openrouter.ts:103`).

### Current Pricing Assumptions

Vendor pricing verified 2026-06-04:

- Gemini 2.5 Flash: $0.30 per 1M text/image/video input tokens, $2.50 per 1M output tokens.
- Gemini 2.5 Flash-Lite: $0.10 per 1M text/image/video input tokens, $0.40 per 1M output tokens.
- Gemini 2.5 Pro: $1.25 per 1M input tokens and $10.00 per 1M output tokens for prompts at or under 200k tokens.
- Twilio US Programmable Voice local calls: $0.0085/min receive, $0.0140/min make.

Sources:
- Google Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Twilio US Programmable Voice pricing: https://www.twilio.com/en-us/voice/pricing/us

### Estimated Token-Per-Intake

The repository cannot calculate true historical average input/output tokens without more complete per-call token accounting. The following is the diligence estimate for a normal 5-minute intake:

| Component | Input tokens | Output tokens | Notes |
| --- | ---: | ---: | --- |
| Live call, 8 turns | 20,000 | 640 | System prompt + workspace context + rolling transcript, short phone replies |
| Post-call intelligence | 4,000 | 900 | Transcript-to-JSON extraction with max 2,048 output tokens |
| Total | 24,000 | 1,540 | Estimate, not measured average |

Estimated Gemini 2.5 Flash cost:

- Input: 24,000 / 1,000,000 * $0.30 = $0.0072
- Output: 1,540 / 1,000,000 * $2.50 = $0.0039
- Total LLM: about $0.011 per intake

Estimated Twilio local inbound voice cost:

- 5 minutes * $0.0085 = $0.0425

Approximate floor cost per 5-minute inbound intake before TTS premiums, recordings, transcription, outbound callbacks, emails, infra, and OpenRouter markup: about $0.054.

Investor interpretation: LLM cost is not the economic bottleneck. Telephony minutes, phone-number lifecycle, TTS provider choice, failed retries, and runaway calls matter more.

## Twilio / VoIP Pipeline

Strengths:

- Incoming webhook responds with TwiML and uses Twilio `<Gather>` with speech input, barge-in, `phone_call` model, enhanced recognition, and no-speech handling (`server.ts:2630` to `server.ts:2645`).
- There is a 15-minute kill switch to protect API spend and runaway calls (`server.ts:2561` to `server.ts:2573`).
- A hard response timeout guard exists near the Twilio processing path (`server.ts:2665`).
- Streaming TTS pipeline can generate LLM text and TTS chunks in parallel, falling back to Twilio/Polly speech (`server.ts:1452` to `server.ts:1546`, `server.ts:2828` to `server.ts:2856`).
- Managed provisioning creates Twilio subaccounts and buys local numbers (`src/twilio-provisioning.ts:61` to `src/twilio-provisioning.ts:126`).

Scalability concerns:

- The runtime is request/response webhook based, not a dedicated realtime media-stream architecture.
- The `pending_twiml` and in-memory maps help cross-instance TwiML handoff, but several runtime constructs still depend on process memory for timers/audio stores.
- Twilio resource lifecycle was recently exposed as a live cost risk: test workspaces can provision paid numbers unless guarded. The new test guard helps, but cancellation/deletion still needs first-class Twilio release.
- The system allows calls when usage-limit checks fail (`server.ts:2463` to `server.ts:2476`), which is customer-friendly but cost-risky at scale.

Readiness grade: B for MVP reliability, C+ for 1,000-client throughput.

## Data Provenance & Compliance

### Source-to-Task Mapping

The strongest provenance object is `call_sid`.

Supported mappings:

- `calls.call_sid` is unique and links to messages, summaries, tasks, handoffs, tool executions, webhooks, and CRM sync (`src/db.ts:117` to `src/db.ts:135`, `src/db.ts:240` to `src/db.ts:264`, `src/db.ts:267` to `src/db.ts:313`, `src/db.ts:317` to `src/db.ts:328`).
- `tool_executions` records input payload, output payload, status, error, and duration by `call_sid` (`src/db.ts:301` to `src/db.ts:313`, `src/tools.ts:25` to `src/tools.ts:45`).
- `contact_custom_fields` can store `confidence`, `transcript_snippet`, and `call_sid` (`src/db.ts:348` to `src/db.ts:360`).
- Post-call intelligence requests exact evidence snippets for extracted entities (`src/intelligence.ts:90` to `src/intelligence.ts:106`) and persists those snippets into custom fields (`src/intelligence.ts:407` to `src/intelligence.ts:429`).
- Handoffs capture a transcript snippet when escalated (`src/function-calling.ts:452` to `src/function-calling.ts:467`, `src/tools.ts:308` to `src/tools.ts:330`).

Limit:

Tasks are linked to `call_sid`, but task rows do not require or store transcript snippets. `create_lead` creates a `lead_follow_up` task from tool arguments and `call_sid`, but not a supporting transcript quote (`src/tools.ts:47` to `src/tools.ts:87`). Post-call task creation similarly needs review for snippet-level provenance.

Answer to diligence question: the system can usually prove which call generated a task. It cannot consistently prove the exact transcript snippet that generated every task.

## Integration Readiness

Integration surface area is broad:

- Webhook payloads include call, contact, summary, extracted entities, transcript URL, appointments, tasks, and handoffs (`src/webhooks.ts:171` to `src/webhooks.ts:286`).
- Webhook delivery supports HMAC-SHA256 signing, retry on 5xx, timeout, and delivery logging (`src/webhooks.ts:99` to `src/webhooks.ts:169`, `src/webhooks.ts:289` to `src/webhooks.ts:328`).
- Native CRMs exist for HubSpot, Salesforce, Airtable, and Notion (`src/crm.ts:1` to `src/crm.ts:15`, `src/crm.ts:48` to `src/crm.ts:180`, `src/crm.ts:181` to `src/crm.ts:470`).
- Operator-defined HTTP plugin tools allow custom endpoints to become live AI-callable functions (`src/plugin-tools.ts:1` to `src/plugin-tools.ts:17`, `src/plugin-tools.ts:160` to `src/plugin-tools.ts:254`).
- MCP servers can be registered and exposed as tools (`src/db.ts:434` to `src/db.ts:450`, `server.ts:5934` onward).

CRM readiness ratings:

| Target | Rating | Reason |
| --- | --- | --- |
| HubSpot | High | Native upsert and call log exist. |
| Salesforce | Medium | Native API path exists, but Account mapping is simplified and credentials are env/global. |
| Airtable / Notion | Medium | Native basic upsert/log paths exist. |
| Zapier / Make | High | Generic signed webhook payload is well suited. |
| ServiceTitan | Medium-Low | Generic webhook/plugin path can integrate, but no native OAuth, tenant mapping, job/customer schema, or sandbox harness is present. |
| Clio | Medium-Low | Same as ServiceTitan; legal-specific intake agent exists conceptually, but no native Clio connector is present. |

## Overall Readiness Score

| Area | Score | Investor Translation |
| --- | --- | --- |
| Product execution | B | Real working vertical MVP. |
| Multi-tenant architecture | C+ | Present but application-enforced and legacy-defaulted. |
| Brain/orchestration | B | Practical multi-provider/tool-loop implementation. |
| Hallucination controls | C+ | Strong prompts and post-hoc grading, but no pre-write auditor. |
| Unit economics instrumentation | C | Estimable, not yet auditable per intake. |
| Telephony scalability | C+ | Good MVP pipeline, needs queue/media/resource lifecycle hardening. |
| Provenance/compliance | B- | Strong call spine, incomplete snippet-to-task proof. |
| Integration readiness | B- | Strong generic webhooks/tools; native industry CRMs incomplete. |

## Diligence Position

SMIRK is credible as an acquisition/investment target if positioned as a focused missed-call recovery SaaS with strong early traction potential. It should not yet be positioned as a fully hardened enterprise AI intake platform. The diligence story should emphasize the real call spine, workspace-aware runtime, tool bus, post-call intelligence, and CRM/webhook extensibility while acknowledging the exact hardening roadmap.
