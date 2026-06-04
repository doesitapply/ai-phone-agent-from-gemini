# Scalability Roadmap: 10 Clients to 1,000 Clients

Date: 2026-06-04

## What Breaks First

At 10 clients, the current system can operate with hands-on monitoring. At 1,000 clients, the first failure points are not LLM intelligence; they are isolation, telephony lifecycle, queueing, observability, cost accounting, and integration credential scoping.

## Scale Assumptions

- 1,000 clients.
- 1 phone number per client.
- 20 inbound calls/client/month average.
- 5 minutes/call average.
- 20,000 calls/month, 100,000 voice minutes/month.
- Estimated Gemini 2.5 Flash LLM cost about $0.011 per 5-minute intake before provider markup.
- Estimated Twilio local inbound voice cost about $0.0425 per 5-minute intake.

At this shape, voice minutes cost materially more than LLM tokens. A 10% error in call duration, orphaned phone numbers, or repeated callbacks matters more than prompt-token optimization.

## Phase 1: Stop Cost and Tenant Leaks

Timeline: 1-2 weeks

Required work:

- Fail closed on workspace phone lookup in SaaS mode.
- Add Twilio release/close lifecycle to workspace cancellation and deletion.
- Store Twilio release outcome before deleting DB rows.
- Add scheduled Twilio inventory reconciliation: Twilio subaccounts/numbers vs `workspace_phone_numbers`.
- Encrypt workspace AI and integration keys at rest.
- Require explicit `workspace_id` for all tenant routes and helpers.
- Pass workspace ID into plugin tool and MCP loaders.
- Add CI checks for unscoped tenant queries in high-risk tables.

Exit criteria:

- No workspace can be deleted without Twilio resource disposition.
- Test/smoke provisioning cannot buy phone numbers.
- Unknown phone number cannot route to workspace `1` in production SaaS mode.
- Plugin tools are workspace-scoped.

## Phase 2: Make Calls Queue-Backed

Timeline: 2-4 weeks

Current risk:

- Webhook handlers perform meaningful orchestration directly.
- Some state lives in process memory.
- Post-call intelligence, webhooks, and CRM sync run in immediate async callbacks.

Required work:

- Add Redis or a managed queue for post-call intelligence, CRM sync, webhook delivery, and cleanup.
- Move transient TTS audio to object storage or a shared cache.
- Persist pending TwiML/call state fully outside process memory.
- Add idempotency keys for every post-call job: `call_sid + job_type`.
- Split API/webhook workers from background workers.

Exit criteria:

- A server restart during a call or post-call job does not lose the job.
- Multiple app instances can process calls without duplicate summaries/tasks/webhooks.
- Backpressure exists when AI/CRM providers slow down.

## Phase 3: Prove Source-to-Task

Timeline: 2-3 weeks

Required work:

- Add `source_message_ids`, `transcript_snippet`, `extraction_confidence`, `extraction_model`, and `verified_at` to task and lead records.
- Make the post-call extraction prompt return snippet evidence for every task, not just custom fields.
- Add a pre-write verifier that rejects or downgrades extracted fields/tasks without transcript support.
- Add dashboard evidence view: "why this task exists."

Exit criteria:

- Every generated task can be traced to a call, message IDs, and transcript quote.
- Investor/legal reviewer can inspect source evidence without reading logs.

## Phase 4: Unit Economics Accounting

Timeline: 1-2 weeks

Required work:

- Persist AI usage per request:
  - provider
  - model
  - workspace_id
  - call_sid
  - prompt_tokens
  - completion_tokens
  - cached_tokens
  - cost_usd
  - latency_ms
- Persist TTS usage:
  - provider
  - characters or audio tokens
  - cost_usd
  - latency_ms
- Reconcile Twilio usage from provider invoice/export, not only local call duration.
- Add margin dashboard by workspace and plan.

Exit criteria:

- Average token-per-intake can be calculated from production data.
- Gross margin can be reported by workspace, plan, and month.

## Phase 5: Enterprise Integration Layer

Timeline: 4-8 weeks

Required work:

- Move integration credentials from global env to per-workspace encrypted records.
- Add connector templates for ServiceTitan and Clio:
  - OAuth/token setup.
  - Customer lookup.
  - Job/matter creation.
  - Appointment/task sync.
  - Sandbox test harness.
- Add mapping UI for fields and custom objects.
- Add retry/dead-letter queue for CRM failures.
- Add replay by call SID.

Exit criteria:

- A non-engineer can connect HubSpot/Salesforce/ServiceTitan/Clio through setup.
- Failed syncs are visible, replayable, and tenant-isolated.

## Phase 6: Operational Readiness

Timeline: 2-4 weeks

Required work:

- Define SLOs:
  - call answer TwiML under 1 second
  - AI response under 3 seconds p95 for normal turns
  - post-call summary under 2 minutes p95
  - webhook delivery success over 99%
- Add alerting:
  - Twilio balance low
  - orphaned phone numbers
  - AI provider error rate
  - queue backlog
  - high-cost workspace anomaly
  - failed CRM syncs
- Add load test scripts:
  - Twilio webhook simulation
  - 100 concurrent calls
  - 10,000 post-call intelligence jobs
  - webhook retry storm

Exit criteria:

- 1,000-client simulation passes without data leakage or uncontrolled spend.
- Investor data room contains current operational metrics, not only code claims.

## Final Recommendation

Do not scale to 1,000 clients by only increasing Railway resources. The product needs tenant safety, queue-backed orchestration, Twilio lifecycle controls, and cost accounting before horizontal scaling. The core product logic is usable; the scale work is mostly operational hardening and diligence-grade controls.
