# SMIRK API and Backend Context for AI Agents

Last reviewed from this checkout: 2026-07-08.

This document is a repo-grounded handoff for another AI agent. It explains the backend, API surface, auth boundaries, data model, product gates, local demo mode, and operational checks without requiring the agent to infer the full system from scattered files.

This is not a secrets document. Do not paste real API keys, Railway tokens, Stripe secrets, Twilio auth tokens, workspace bearer tokens, or customer private data into prompts or docs.

## Source of Truth

Use these files first:

| File | What it tells you |
| --- | --- |
| `openapi.yaml` | Canonical generated API inventory. It currently exposes 161 API paths and 197 concrete operations from Express route declarations. |
| `scripts/generate-openapi.mjs` | Generator for `openapi.yaml`, including security classification for signed webhooks, workspace routes, operator routes, and provisioning routes. |
| `server.ts` | Express app bootstrap, global middleware, auth middleware, route registration, Twilio voice loop, health checks, and static app serving. |
| `src/routes/*.ts` | Modular API handlers by product/backend domain. |
| `src/saas.ts` | Workspaces, plans, usage limits, invites, activation events, Stripe webhook handling, and SaaS schema. |
| `src/db.ts` | Postgres connection and schema initialization. |
| `src/mock-db.ts` and `src/data/mockDbData.json` | No-DB local demo mode data and helpers. |
| `src/App.tsx` | React app, public pages, customer dashboard, operator surfaces, and plan-gated navigation. |
| `README.md` | Human-facing status, product scope, verification commands, and market framing. |
| `SMIRK_FOR_DUMMIES.md` | Plain-English product state and limitations. |
| `SMIRK_GRANT_MATRIX.md` | Secret/workspace separation and operator credential boundaries. |

Regenerate/check the API inventory with:

```bash
npm run -s generate:openapi
npm run -s check:openapi
```

## Product Shape

SMIRK is a missed-call recovery SaaS for local service businesses.

The narrow product loop is:

```text
Missed call
  -> SMIRK answers through Twilio
  -> AI captures caller details and urgency
  -> Backend stores call, messages, summary, contact, task, and events
  -> Owner gets alert / callback work
  -> Dashboard proves what happened
```

The codebase also contains broader operator tooling: agents, compliance, integrations, prospecting, lead search, system health, admin maintenance, workspace provisioning, and proof gates. Treat those as machine-room surfaces unless the user explicitly asks for operator/admin work.

## Runtime Architecture

```text
React/Vite frontend
  -> Express API in server.ts
  -> route modules in src/routes
  -> Postgres via src/db.ts
  -> SaaS workspace layer in src/saas.ts
  -> Twilio voice webhooks
  -> AI providers / OpenRouter / Gemini / OpenClaw paths
  -> TTS, email alerts, CRM/webhooks, Stripe billing
```

`server.ts` owns global middleware:

- Helmet security headers.
- HTTPS redirect/HSTS on public production hosts.
- Static serving from `/public`.
- Raw body exemption for Stripe webhooks.
- JSON/urlencoded request parsing.
- Production CORS restricted to configured app/landing origins.
- Request IDs and request logging.
- Rate limits for API, health, demo, and call initiation paths.
- Workspace resolution through `X-Workspace-Id` and authenticated workspace tokens.

## Auth and Access Boundaries

There are four practical auth classes.

| Class | Mechanism | Used for |
| --- | --- | --- |
| Public/signed webhook | Provider signature or route-specific validation. Some dev paths may be unsigned locally. | Twilio webhooks, Stripe webhook, Calendly webhook, public pricing/version/proof/health. |
| Operator API key | `X-Api-Key: <DASHBOARD_API_KEY>` through `dashboardAuth`. | Admin, logs, config, agents, compliance, integrations, prospecting, workspace admin, destructive maintenance. |
| Workspace bearer token | `Authorization: Bearer <workspace.api_key>` through `dashboardAuth`. | Customer dashboard, calls, contacts, tasks, profile, knowledge, recovery, overview, proof status. |
| Provisioning/test secrets | `Authorization: Bearer <PHONE_AGENT_PROVISIONING_SECRET>` or explicit test-call secret. | Provisioning automation and guarded test-call routes. |

Important middleware:

- `dashboardAuth` in `server.ts`: accepts operator `X-Api-Key` or workspace bearer token. In No-DB mode it also accepts the mock workspace token and allows `GET /api/workspaces` to bootstrap the local demo.
- `requireOperator` in `server.ts`: requires operator auth mode. Workspace users should never pass this.
- `requireProSuite` in `server.ts`: lets operators through, lets `pro`, `enterprise`, and `agency` workspaces through, and blocks Basic/Starter workspaces with `code: "PRO_SUITE_REQUIRED"`.
- `api-middleware.ts`: applies route-specific rate limits and Twilio validation middleware.

Do not loosen these without tests. The product depends on Basic users seeing a simple customer dashboard while operators keep the machine room.

## Plans and UI Partitioning

The SaaS plan source is `PLAN_LIMITS` in `src/saas.ts`:

| Plan | Meaning |
| --- | --- |
| `free` | Demo/trial style access with small limits. |
| `starter` | Basic customer dashboard tier. |
| `pro` | Full customer suite tier. |
| `enterprise` | Agency/high-volume tier. |

Product language often calls the low tier Basic/Starter and the higher tier Pro/Agency. In code, expect `starter`, `pro`, and `enterprise`.

Rules:

- Starter/Basic customers should get Calls, Contacts, Tasks, basic proof, and alert setup.
- Pro/Agency customers can access the broader customer suite.
- Operator/admin tools must stay behind `requireOperator` and should not mount for customer sessions.
- Restricted Pro-suite APIs should return `PRO_SUITE_REQUIRED`, not raw failures.

Validate with:

```bash
npm run -s check:customer-dashboard
npm run -s check:plan-boundaries
npm run -s check:auth-regression
```

## API Surface Map

`openapi.yaml` is the full operation inventory. The table below explains the route families and intent.

| Module | Route family | Access shape | Purpose |
| --- | --- | --- | --- |
| `server.ts` | `/api/twilio/incoming`, `/api/twilio/process`, `/health`, `/livez` | Twilio/public health | Core voice webhook loop, AI turn processing, health checks. |
| `buyer-routes.ts` | `/api/version`, `/api/health`, `/api/first-dollar-readiness`, `/api/pricing`, `/api/checkout/create`, `/api/stripe/webhook`, `/api/invite/:token` | Public/signed/Stripe | Buyer pricing, checkout, Stripe webhook, invite acceptance. |
| `provisioning-routes.ts` | `/api/provisioning/*`, `/api/provision/workspace` | Public intake, operator review, provisioning secret | Signup/provisioning requests, checkout status, workspace creation. |
| `workspace-admin-routes.ts` | `/api/workspaces*` | Operator except No-DB bootstrap | Workspace CRUD, invites, members, usage, API key retrieval. |
| `workspace-overview-routes.ts` | `/api/workspace-overview` | Workspace/operator | Dashboard overview, masked workspace data, plan limits, setup readiness. |
| `workspace-profile-routes.ts` | `/api/workspace/profile`, `/api/workspace/generate-prompt`, `/api/workspace/website-scan`, `/api/workspace/greeting-preview`, `/api/workspace/provision-number` | Workspace/operator | Business identity, alert routing, AI prompt/greeting helpers, website scan, Twilio number provisioning. |
| `workspace-activation-routes.ts` | `/api/workspace/proof-call-request`, `/api/workspace/activation-events`, `/api/workspace/activation-status` | Workspace/operator | Customer activation/proof-call workflow. |
| `workspace-knowledge-routes.ts` | `/api/workspace/knowledge*` | Workspace/operator | Workspace-scoped knowledge import/list/delete. |
| `dashboard-routes.ts` | `/api/stats`, `/api/call-intelligence`, `/api/triage` | Workspace/operator | Dashboard metrics, review queues, triage state. |
| `call-routes.ts` | `/api/calls*`, `/api/recordings/:sid/audio`, `/api/tts/:id` | Workspace reads, operator destructive actions | Call list, active calls, transcripts, messages, recordings, stale call repair, reprocess/delete. |
| `outbound-call-routes.ts` | `/api/calls`, `/api/test-call` | Workspace/operator plus guarded test secret | Start outbound call and guarded test-call flow. |
| `contact-routes.ts` | `/api/contacts*`, `/api/field-definitions*` | Workspace for contacts, operator for DNC/field definitions | Contacts, contact detail, custom fields, contact status, DNC toggles. |
| `task-routes.ts` | `/api/tasks*` | Workspace/operator | Callback/follow-up tasks, completion, bulk completion. |
| `recovery-routes.ts` | `/api/recovery/*` | Workspace/operator, direct dial operator-only | Missed-call recovery queue, close/callback actions, stats. |
| `calendar-routes.ts` | `/api/appointments*`, `/api/calendar/events`, `/api/calendar/test-booking` | Workspace reads, operator writes/test booking | Appointments and calendar surfaces. |
| `calendly-routes.ts` | `/api/calendly/webhook`, `/api/calendly/config` | Signed/public webhook, workspace config read | Calendly webhook and config exposure. |
| `operations-routes.ts` | `/api/handoffs`, `/api/summaries` | Workspace handoffs, operator summaries | Handoff acknowledgment and operator summary list. |
| `proof-routes.ts` | `/api/events`, `/api/public-proof-snapshot` | Operator events, public proof snapshot | Proof/event feed and public masked snapshot. |
| `settings-routes.ts` | `/api/settings*`, `/api/logs`, `/api/agent/identity`, `/api/config-status` | Operator | Settings, logs, service tests, agent identity. |
| `agent-routes.ts` | `/api/agents*` | Operator | Agent configurations and activation. |
| `operator-routes.ts` | `/api/operator/session`, `/api/openclaw/*` | Operator | Operator session and OpenClaw bridge controls. |
| `system-health-routes.ts` | `/api/system-health` | Operator | Internal health and diagnostics. |
| `integrations-routes.ts` | `/api/integrations/*`, `/api/tools*`, `/api/mcp*`, `/api/plugin-tools*` | Operator | Webhooks, CRM tests, tool registry, MCP/plugin integrations. |
| `prospecting-routes.ts` | `/api/prospecting/*` | Operator | Prospecting campaigns, leads, sequences, autodial controls. |
| `lead-routes.ts` | `/api/leads*`, `/api/chat*`, `/api/campaigns*` | Operator | Lead search, maps/Apollo lookup, personalization, campaign/chat tools. |
| `compliance-routes.ts` | `/api/compliance/*`, `/api/analytics/agents` | Operator | DNC, audit, compliance checks, analytics. |
| `admin-maintenance-routes.ts` | `/api/admin/*`, `/api/system-health/public`, `/api/scheduled/monthly-usage-reset` | Operator/public/provisioning secret | DB checks, migrations, webhook lag, smoke cleanup, monthly usage reset. |
| `twilio-ops-routes.ts` | `/api/twilio/amd`, `/api/twilio/test-*` | Twilio/operator | Answering-machine detection and test Twilio paths. |
| `twilio-status-routes.ts` | `/api/twilio/status` | Twilio | Twilio call status callback processing. |
| `twilio-live-routes.ts` | Twilio live helper routes | Twilio | Live telephony support paths. |
| `twiml-routes.ts` | TwiML route family | Twilio | TwiML responses and voice call control. |
| `demo-routes.ts` | `/api/demo*` | Public/demo API key depending route | Demo call/sample lead endpoints. |
| `auth-routes.ts` | `/api/auth/google/*` | Public exchange/config | Google login config and exchange. |
| `team-routes.ts` | `/api/team*` | Operator | Team/on-call management. |
| `boss-mode.ts` | `/api/boss/*` | Operator | Boss-mode settings, context, audit, metrics. |

When changing endpoints, update code first, then regenerate `openapi.yaml`, then run `check:openapi`.

## Core Data Domains

High-level entities another agent should understand:

- `workspaces`: tenant/business account, plan, owner, API key, telephony credentials, AI keys, alert routing, business identity.
- `workspace_members`: invited users and roles.
- `workspace_usage`: monthly calls, minutes, token/character style metering.
- `provisioning_requests`: pre/post-checkout workspace creation pipeline.
- `activation_events`: setup/proof-call/customer activation event history.
- `workspace_phone_numbers`: maps Twilio destination numbers to workspace IDs.
- `calls`: call records and status/direction/duration metadata.
- `messages`: transcript/turn history for calls.
- `call_summaries`: intent, outcome, sentiment, resolution/confidence, next action.
- `tasks`: callback/follow-up/handoff work generated from calls.
- `contacts`: caller/customer records, status, DNC flag, business/contact metadata.
- `contact_custom_fields`: extracted structured fields and confidence.
- `appointments`: scheduling records.
- `handoffs`: human handoff/acknowledgment workflow.
- `call_events` / `request_logs` / audit tables: proof, operations, diagnostics, compliance trail.
- Prospecting/sequence/lead tables: operator-only outbound/prospecting surfaces.

Every tenant-scoped query should use the resolved workspace ID. Cross-workspace leakage is a launch-blocking bug.

## No-DB Local Demo Mode

If `DATABASE_URL` is absent, `DB_ENABLED` is false and the app should boot in local demo mode.

Source files:

- `src/mock-db.ts`
- `src/data/mockDbData.json`

Behavior:

- Mock workspace token: `smirk_mock_basic_demo_key`.
- Mock workspace plan: `starter`.
- Dashboard data comes from high-ticket trade scenarios in `mockDbData.json`.
- Secrets are masked on workspace overview.
- Customer mode should load without Postgres.
- Basic/Starter plan boundaries should still hold.

Validate with:

```bash
npm run -s check:no-db-demo-mode
```

## Main Flows

### Inbound Missed-Call Recovery

```text
Twilio sends call to /api/twilio/incoming
  -> backend resolves workspace from To number
  -> TwiML/voice response starts the AI flow
  -> /api/twilio/process handles caller turns
  -> AI/tool layer captures details and updates state
  -> call/messages persist
  -> post-call intelligence creates summary, contact updates, tasks, alerts, proof events
  -> dashboard reads stats/calls/tasks/triage
```

Important files: `server.ts`, `src/function-calling.ts`, `src/tools.ts`, `src/intelligence.ts`, `src/call-classifier.ts`, `src/reward-system.ts`, `src/handoff-transfer.ts`.

### SaaS Buyer and Provisioning

```text
Public pricing / checkout request
  -> Stripe Checkout
  -> /api/stripe/webhook validates event
  -> src/saas.ts handles subscription/customer state
  -> provisioning request / workspace creation
  -> invite / workspace API key / activation status
  -> customer dashboard
```

Important files: `src/routes/buyer-routes.ts`, `src/routes/provisioning-routes.ts`, `src/saas.ts`, `src/twilio-provisioning.ts`, `src/monetization-alerts.ts`.

### Customer Dashboard

```text
Workspace bearer token
  -> dashboardAuth
  -> workspace-scoped APIs
  -> Starter/Basic sees simplified dashboard
  -> Pro/Agency sees broader suite
  -> operator-only pages stay inaccessible and unmounted for customers
```

Important files: `src/App.tsx`, `src/routes/workspace-overview-routes.ts`, `src/routes/dashboard-routes.ts`, `src/routes/call-routes.ts`, `src/routes/contact-routes.ts`, `src/routes/task-routes.ts`.

### Operator Machine Room

```text
X-Api-Key: DASHBOARD_API_KEY
  -> dashboardAuth sets authMode=operator
  -> requireOperator route families unlock
  -> admin/proof/logs/config/compliance/prospecting/deploy support surfaces
```

Operator routes are not customer product. Treat them as internal operations.

## External Services

Configured integrations visible in code include:

- Twilio: inbound calls, outbound/test calls, call status callbacks, TwiML, recordings, phone provisioning.
- Stripe: Checkout and webhook-driven subscription/provisioning state.
- Resend/email: owner alerts, provisioning/monetization alerts, prospecting sequences.
- Google/Gemini: prompt generation and AI paths.
- OpenRouter/OpenClaw: alternate AI/runtime bridge paths.
- ElevenLabs/TTS paths: voice/greeting preview and audio generation support.
- Calendly/Google calendar style paths: appointment/calendar integration surfaces.
- CRM/webhook/MCP/plugin tools: operator-configured integrations.
- Serper/Brave/search/maps/Apollo style lead lookup paths: operator prospecting/lead search.
- Railway/public host runtime: deployment target for production checks.

Only claim an integration is live when its env vars are configured and the relevant readiness check passes.

## Security and Compliance Guardrails

Do not expose:

- `DASHBOARD_API_KEY`
- `PHONE_AGENT_API_KEY`
- `PHONE_AGENT_PROVISIONING_SECRET`
- `TEST_CALL_SECRET`
- Stripe secrets/webhook secret
- Twilio auth token
- Railway token
- GitHub PAT
- Workspace bearer tokens
- Customer phone numbers/transcripts outside masked proof contexts

Important safety behaviors:

- Production CORS defaults to known app/landing origins.
- Webhooks should use provider signatures/secrets in production.
- DNC routes exist and are operator-controlled.
- DNC/compliance controls are guardrails, not legal advice.
- Destructive smoke cleanup and live proof/write checks are guarded by explicit env confirmations.
- Basic/Starter workspaces must not see Pro/operator data.
- Public proof snapshots must stay masked.

## Verification Commands

Use the narrowest check for the thing you changed:

```bash
npm run -s check:openapi
npm run -s check:no-db-demo-mode
npm run -s check:customer-dashboard
npm run -s check:plan-boundaries
npm run -s check:auth-regression
npm run build
```

Launch/live parity checks:

```bash
npm run -s check:smirk-1000-final-mile
npm run -s check:live-is-current
npm run -s check:first-customer-10of10
```

Guarded live-write checks require explicit user approval and env confirmations. Do not run them casually.

## How Another AI Should Work In This Repo

1. Read this file.
2. Read `openapi.yaml` for the current endpoint inventory.
3. Read the specific route module for the endpoint being changed.
4. Trace auth middleware from `server.ts`.
5. Trace tenant/workspace behavior through `src/saas.ts` and `getWorkspaceId`.
6. If frontend is involved, inspect `src/App.tsx` for plan/customer/operator mounting.
7. Run the smallest relevant checks.
8. If endpoints changed, regenerate and check OpenAPI.
9. Never infer production readiness from local checks alone; live parity is separate.

## Known Boundaries

- This doc describes the local checkout. It does not prove production is running this commit.
- `openapi.yaml` exposes route inventory and rough security labels, not exact request/response schemas.
- Some legacy/operator/prospecting surfaces are broader than the narrow customer product.
- No-DB mode is a local demo and debugging path, not a replacement for production persistence.
- Live Stripe/Twilio/Railway proof depends on configured external accounts and explicit approvals.

