# SMIRK + Velvet End-to-End Service Requirements

## Scope

This checklist covers the canonical acquisition and revenue path:

1. Velvet discovers public home-service prospects.
2. Velvet stores source evidence and, when enabled, verifies one owner email.
3. SMIRK imports reviewed records into a workspace-scoped queue.
4. A human reviews one recipient and prepares one email or one manual call brief.
5. A full operator separately approves and executes that one action.
6. Delivery, reply, call, demo, checkout, and activation outcomes are persisted.
7. SMIRK sends one signed outcome record back to Velvet.
8. Deterministically assigned message experiments can produce a human-review
   recommendation. They never change runtime policy or execute outreach.

Cold SMS, bulk email, automated prospect dialing, purchased-list blasting, and
unapproved provider spend are outside this architecture.

Repository configuration proves that a variable is recognized. It does not
prove that a secret is installed, funded, authorized, reachable, or configured
at the responsible provider.

## Canonical Flow

```text
Velvet Maps discovery
  -> source evidence and optional Hunter owner-email verification
  -> reviewed Velvet inventory
  -> dedicated smirk:research API
  -> SMIRK research queue
  -> recipient-specific human review
  -> exact five-mailbox inbox-placement PASS for the selected email variants
  -> one approved Resend email OR one manual-dial call brief
  -> provider/manual outcome
  -> SMIRK attribution and controlled message experiment
  -> signed outcome:write callback to Velvet
  -> trade/metro learning for the next reviewed discovery request
  -> Stripe Starter checkout and buyer activation
```

## P0: Required Platform Services

### SMIRK Runtime

| Requirement | Variables or provider configuration | Why it is required |
| --- | --- | --- |
| Railway web service | `NODE_ENV=production`, `APP_URL`, `PORT` | Runs the API, webhooks, and dashboard on one trusted HTTPS origin. |
| Durable Postgres | `DATABASE_URL` | Workspaces, calls, prospects, approvals, outcomes, experiments, checkout receipts, and audit history. |
| Full-admin authentication | `DASHBOARD_API_KEY` | Protects full-operator routes. Use a dedicated high-entropy value. |
| Revenue-loop observer | `PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY`, `PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID` | Gives a scheduler GET-only access to one workspace's controller status without reusing the full-admin key. |
| Workspace-secret encryption | `WORKSPACE_SECRET_ENCRYPTION_KEY` | Encrypts tenant-specific provider credentials. Use at least 32 random characters and do not reuse another key. |
| Public origin | Railway custom domain for `https://smirkcalls.com` | Twilio, Stripe, Resend, Velvet, invites, and browser routing require a stable HTTPS origin. |

Optional Google operator login uses `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_ADMIN_EMAILS`, `DEMO_OPERATOR_API_KEY`, and
`DEMO_OPERATOR_EMAILS`. API-key operator login and buyer invite tokens can
operate without Google OAuth.

### Read-only Revenue-loop Observer

The optional checkpoint process uses:

```text
PROSPECT_REVENUE_LOOP_BASE_URL=https://smirkcalls.com
PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY=<same dedicated 32+ character key installed in SMIRK>
PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID=<same exact locked workspace>
```

The observer key is accepted only for
`GET /api/prospecting/revenue-loop`. It cannot authenticate any approval,
send, manual-call record, provider, callback, policy, billing, or settings
route. It must not equal `DASHBOARD_API_KEY` or `DEMO_OPERATOR_API_KEY`. The
runner writes only local checkpoint files after the separate exact confirmation
`write-one-local-checkpoint-v1`; without that confirmation it fails closed
unless `--no-write` is supplied.

### Velvet Runtime

Velvet currently depends on the Manus runtime. These values are system-injected
there and must be replaced with equivalent services before hosting elsewhere.

| Requirement | Variables | Why it is required |
| --- | --- | --- |
| Durable MySQL/TiDB | `DATABASE_URL` | Leads, audits, approvals, discovery leases, API keys, receipts, costs, and learning. |
| Session authentication | `JWT_SECRET`, `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `OWNER_OPEN_ID` | Owner/admin browser sessions and privileged approval controls. |
| Manus service proxy | `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` | Current server-side Maps, storage, screenshot, and built-in AI access. |
| Frontend service proxy | `VITE_FRONTEND_FORGE_API_URL`, `VITE_FRONTEND_FORGE_API_KEY` | Current browser-side Maps components. |
| Public HTTPS origin | Current `https://velvetalchemy.manus.space` or an approved replacement | SMIRK-to-Velvet API calls and callbacks. |

### Public Landing, Demo, And Provisioning

If a separate landing or signup service calls SMIRK, configure two different
server-to-server credentials:

```text
PHONE_AGENT_API_KEY
PHONE_AGENT_PROVISIONING_SECRET
LANDING_APP_URL=https://smirkcalls.com
```

`PHONE_AGENT_API_KEY` may authorize only the bounded demo-call contract.
`PHONE_AGENT_PROVISIONING_SECRET` may authorize only workspace provisioning.
Neither value may equal `DASHBOARD_API_KEY`, a workspace access token, or a
Velvet integration token. The browser must never receive either secret.

`PAGES_ALLOWED_ORIGIN` is needed only while an approved separate static landing
origin calls the demo API. `PUBLIC_PROOF_WORKSPACE_ID` is needed only for the
explicit public proof workspace. Neither is a substitute for buyer
authentication.

## P0: Voice And AI Services

### Twilio Voice

Required for SMIRK customer missed-call recovery and proof calls:

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
APP_URL
WORKSPACE_SECRET_ENCRYPTION_KEY
```

Provider-side configuration must include:

- the purchased number;
- incoming voice webhook to the production SMIRK incoming-call route;
- status callback routes on the same HTTPS origin;
- parent-account credentials permitted to provision customer subaccounts or
  numbers if self-serve provisioning is enabled;
- a funded balance and a low-balance alert;
- geographic permissions restricted to supported countries;
- no prospect auto-dial job or cold-SMS campaign.

`HUMAN_TRANSFER_NUMBER`, `OPERATOR_ALERT_NUMBER`, `BUSINESS_TIMEZONE`, and the
business identity variables are operating configuration, not API credentials.

### AI Reasoning

The phone path supports several providers:

```text
OPENROUTER_API_KEY
OPENROUTER_ENABLED=true
OPENROUTER_MODEL
```

The current first-customer streaming readiness gate expects OpenRouter plus one
streaming TTS provider. `GEMINI_API_KEY` and `GEMINI_MODEL` are the current
fallback.

On the hardening branch, dashboard chat prefers an enabled OpenRouter
configuration and falls back to Gemini only before any tool execution. A
workspace-owned key that fails authentication does not silently consume a
global fallback provider. Provider errors return a stable `503` response
instead of exposing raw quota or billing payloads.

The chat action boundary is separate from model availability. Calls, messages,
calendar writes, settings changes, prompt edits, and live briefing injection
are excluded from every chat tool allowlist and must use their dedicated
guarded dashboard workflows. Local CRM contact and task writes remain
workspace-scoped and report success only when the expected row changes.

Run the no-network contract and unit proof with:

```bash
npm run -s check:chat-safety
```

This is source evidence only. Production still requires the exact hardening
commit, an enabled and funded provider, billing alerts, and a harmless
authenticated chat check before the dashboard can claim provider readiness.

Optional phone-provider alternatives:

```text
OPENCLAW_ENABLED
OPENCLAW_GATEWAY_URL
OPENCLAW_GATEWAY_TOKEN
OPENCLAW_AGENT_ID
OPENCLAW_MODEL
OPENAI_API_KEY
ANTHROPIC_API_KEY
GOOGLE_AI_API_KEY
```

Do not configure several paid primaries without an explicit routing and budget
policy.

### Text To Speech

Twilio Polly `<Say>` is a provider-side fallback. The first-customer streaming
gate expects at least one enabled premium provider:

```text
CARTESIA_API_KEY              # optional voice/model IDs
ELEVENLABS_API_KEY            # optional voice/model IDs
GOOGLE_TTS_API_KEY            # or GOOGLE_SERVICE_ACCOUNT_JSON
OPENAI_API_KEY                # optional OpenAI TTS model/voice
```

Choose one primary. Keep the others disabled or designated as bounded
fallbacks so a provider failure cannot multiply spend.

## P0: Velvet Discovery And Enrichment

The canonical discovery provider is the Maps path behind the Manus service
proxy:

```text
ENABLE_MAPS_RESEARCH=true
MAPS_COST_CENTS_PER_REQUEST=<reviewed positive integer>
ENABLE_SMIRK_DISCOVERY_WORKER=true
```

The discovery worker must remain one-job-at-a-time, global/owner kill-switch
aware, and capped at 20 leads and a quoted maximum of 500 cents per request.
Provider cost is reserved before each network call.

Automatic owner-email enrichment is optional but becomes necessary when a
prospect has no already verified public owner email:

```text
ENABLE_HUNTER_OWNER_ENRICHMENT=true
HUNTER_API_KEY
HUNTER_COST_CENTS_PER_CREDIT=<reviewed positive integer>
```

Hunter may return one reviewed owner email. It does not grant send authority.
If Hunter is not enabled, the email lane must use another documented verified
source or remain unavailable for that prospect.

Velvet draft/audit AI needs the Manus built-in LLM or one explicitly selected
fallback:

```text
BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY
GOOGLE_AI_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

`ENABLE_PIPELINE_WORKER=true` is required only for the general background
pipeline. It is separate from the guarded SMIRK discovery worker.

## P0: Cross-System Credentials

Use separate random secrets for each direction and capability.

### Velvet Pushes One Reviewed Prospect To SMIRK

| Velvet | SMIRK | Required relationship |
| --- | --- | --- |
| `SMIRK_BASE_URL=https://smirkcalls.com` | `APP_URL=https://smirkcalls.com` | Exact production origin. |
| `SMIRK_RESEARCH_API_KEY` | `VELVET_ALCHEMY_RESEARCH_API_KEY` | Same dedicated research-only token, at least 32 characters. |
| `SMIRK_RESEARCH_WORKSPACE_ID` | `VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID` | Same exact SMIRK workspace ID. |

This receiver imports a reviewed research record only. It cannot send, call,
text, or create a callback task.

### SMIRK Requests Discovery Or Pulls Reviewed Velvet Inventory

Velvet must create an owner-scoped API key with the `smirk:research` scope.
Store that key only in SMIRK:

```text
VELVET_LEAD_SOURCE_ENABLED=true
VELVET_LEAD_SOURCE_BASE_URL=https://velvetalchemy.manus.space
VELVET_LEAD_SOURCE_API_KEY=<dedicated Velvet smirk:research key>
VELVET_LEAD_SOURCE_WORKSPACE_ID=<exact SMIRK workspace>
VELVET_DISCOVERY_ENABLED=true
```

`VELVET_DISCOVERY_ENABLED` permits only a bounded request and status path. A
Velvet administrator still approves the quote and separately queues the
worker. A completed discovery still requires a separate reviewed-inventory
pull.

### SMIRK Sends One Outcome Back To Velvet

Velvet must create a separate API key with the `outcome:write` scope.

| SMIRK | Velvet | Required relationship |
| --- | --- | --- |
| `VELVET_BASE_URL` | public Velvet origin | Exact HTTPS origin. |
| `VELVET_OUTCOME_API_KEY` | API key stored by Velvet | Dedicated `outcome:write` key. |
| `VELVET_OUTCOME_SIGNING_SECRET` | `SMIRK_OUTCOME_SIGNING_SECRET` | Same separate HMAC secret, at least 32 characters. |
| `VELVET_OUTCOME_WORKSPACE_ID` | `SMIRK_RESEARCH_WORKSPACE_ID` | Same exact workspace boundary. |
| `VELVET_OUTCOME_DISPATCH_ENABLED=true` | outcome receiver enabled by configuration | Enables only the full-operator, one-record dispatch route. |

The synthetic call-shaped handoff pair, `SMIRK_API_KEY` /
`SMIRK_WORKSPACE_ID` and `VELVET_ALCHEMY_HANDOFF_API_KEY` /
`VELVET_ALCHEMY_WORKSPACE_ID`, is not required for the real prospect loop. Its
current `caller` contract is synthetic-test-only and must not represent a
business prospect as an inbound caller.

## P0: Recipient-Specific Email

Owner alerts and prospect email use separate Resend credentials.

### Owner And Buyer Email

```text
RESEND_API_KEY
FROM_EMAIL
OWNER_EMAIL or workspace owner_email
```

### Prospect Email

```text
PROSPECT_EMAIL_EXECUTION_ENABLED=true
PROSPECT_EMAIL_EXECUTION_MODE=single-recipient-reviewed-v1
PROSPECT_EMAIL_RESEND_API_KEY=<dedicated transactional key>
PROSPECT_EMAIL_FROM=SMIRK <outreach@smirkcalls.com>
PROSPECT_EMAIL_REPLY_TO=<dedicated monitored reply mailbox>
PROSPECT_EMAIL_WORKSPACE_ID=<exact workspace>
PROSPECT_EMAIL_DAILY_RECIPIENT_CAP=<initially 1>
PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS=<initially 2>
PROSPECT_EMAIL_UNIT_COST_CENTS=<conservative reservation>
PROSPECT_EMAIL_WEBHOOK_ENABLED=true
PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET=<dedicated signing secret>
PROSPECT_INBOX_SEED_ALLOWLIST=<exact five controlled addresses>
```

Provider and DNS requirements:

- verify `smirkcalls.com` or an approved sending subdomain in Resend;
- publish the exact SPF and DKIM records Resend supplies;
- configure a custom return path when supported;
- configure the signed webhook for delivery, bounce, complaint, suppression,
  and inbound reply events;
- route the reply mailbox to a monitored inbox or signed inbound receiver;
- maintain the physical postal address and opt-out text in every commercial
  message;
- keep the transactional owner-alert key distinct from the prospect key;
- maintain exactly two controlled Google Workspace, two Microsoft 365, and one
  Yahoo/AOL seed mailbox;
- require all five exact seed messages to reach the primary/default inbox with
  SPF, DKIM, DMARC, From alignment, plain text, no tracking pixel, no unexpected
  links, and a clean footer before activating a matching email experiment.

The five-address allowlist permits preparation only. The seed jobs are hidden
from normal prospect inventory. Their signed provider facts remain auditable,
but the outcome writer rejects them before any prospect status mutation,
market-learning event, or Velvet callback can be created. Every seed requires
its own immutable approval and separate one-recipient send confirmation.
Finalization creates a seven-day PASS or FAIL receipt; PASS gates only the same
workspace, campaign, control strategy, and challenger strategy and grants no
prospect contact or spend authority.

SMTP credentials are not required when using the Resend HTTP API.

## P0: Stripe Revenue And Self-Serve Activation

The guarded launch uses one hosted Starter Payment Link, not native Checkout:

```text
STRIPE_PAYMENT_LINK_STARTER
STRIPE_PAYMENT_LINK_STARTER_ID
STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS
STRIPE_REVENUE_READ_KEY
STRIPE_WEBHOOK_SECRET
SMIRK_CUSTOMER_POLICY_APPROVED_VERSION
AUTO_FULFILL_PROVISIONING_REQUESTS=true
APP_URL
DATABASE_URL
RESEND_API_KEY
FROM_EMAIL
```

The restricted revenue key needs only the reviewed Stripe read permissions
used by the readiness and revenue verifiers. The webhook endpoint must point
to SMIRK's production Stripe webhook route and subscribe to the reviewed
checkout and payment lifecycle events.

Buyer billing management additionally requires:

```text
STRIPE_BILLING_PORTAL_KEY
STRIPE_BILLING_PORTAL_CONFIGURATION_ID
```

`STRIPE_SECRET_KEY` is not required for the guarded hosted-link lane and should
remain absent unless a separately approved native-Checkout feature needs it.
Pro, Enterprise, founders, discounts, lifetime deals, and additional active
Starter links remain outside the first-dollar launch boundary.

Stripe success does not by itself prove activation. The system must verify:

- signed live checkout;
- exact active Payment Link and amount;
- approved policy version and Terms acceptance;
- unique customer identity;
- durable workspace provisioning;
- buyer invite delivery;
- buyer-authenticated activation;
- dashboard access and proof/callback artifact;
- no refund, dispute, or excluded owner/team identity.

## P1: Optional Feature Integrations

These are not required for the canonical first revenue loop:

| Feature | Variables |
| --- | --- |
| Optional Google Calendar record integration | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_TZ` |
| Calendly fallback/webhook | `CALENDLY_URL`, `CALENDLY_SIGNING_SECRET`, `BOOKING_LINK` |
| Legacy SMIRK lead search | `GOOGLE_PLACES_API_KEY`, `SERPER_API_KEY`, `BRAVE_API_KEY`, `APOLLO_API_KEY` |
| CRM exports | `AIRTABLE_*`, `HUBSPOT_ACCESS_TOKEN`, `SALESFORCE_*`, `NOTION_*` |
| OpenClaw phone brain | `OPENCLAW_ENABLED`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT_ID`, `OPENCLAW_MODEL` |
| Telegram callback receiver | `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS` |

Telegram is not needed for the dashboard approval flow. The current receiver
variables do not provide a complete outbound bot-notification system. Do not
make Telegram a launch dependency until the bot delivery, preview, reject,
expiry, single-use approval, and audit path are separately proven.

## Explicitly Disabled

Keep these absent, false, or allowlist-only unless a separately approved test
requires them:

```text
SMS_ENABLED=false
SMS_SEND_MODE=disabled
SMS_ALLOW_NON_ALLOWLISTED=false
PROSPECT_EMAIL_EXECUTION_ENABLED=false   # until exact send gate approval
VELVET_OUTCOME_DISPATCH_ENABLED=false    # until exact callback gate approval
VELVET_LEAD_SOURCE_ENABLED=false         # until paired deploy/config proof
VELVET_DISCOVERY_ENABLED=false           # until paired deploy/config proof
ENABLE_SMIRK_DISCOVERY_WORKER=false      # until provider budget approval
ENABLE_PIPELINE_WORKER=false             # until worker budget approval
SMIRK_NATIVE_CHECKOUT_ENABLED=false
ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV=false
```

No Twilio Messaging Service, A2P campaign, SMS marketing API, automated
prospect dialer, or bulk-email endpoint is required for this system.

## Local Cross-System Proof

With local MySQL and Postgres running and the Velvet repository available as a
sibling, run:

```bash
npm run -s check:velvet-smirk:persistence
```

This command creates fresh disposable databases, migrates Velvet, initializes
the actual SMIRK schema, and exercises the local HTTP contracts from synthetic
Velvet discovery through reviewed export, SMIRK import, deterministic QC,
human approval, a synthetic manual-call record, signed outcome callback, exact
replay, and cross-workspace denial. It traps and reports all network-capable
boundaries and requires zero email, SMS, phone, paid-provider, production
network, and production-write actions. It drops both disposable databases
before exit. This is local integration evidence only; it does not establish
deployment parity, configured production credentials, provider acceptance,
customer interaction, or revenue.

Run the separate no-network inbox and deterministic-cohort persistence proofs:

```bash
npm run -s check:prospect-inbox-placement:persistence
npm run -s check:prospect-message-experiments:persistence
```

Both commands create and remove a disposable Postgres database. The inbox proof
uses a fake Resend transport and confirms five immutable seed inspections plus
exact experiment binding with zero real recipients, external messages, or
spend. The experiment proof freezes an untouched eligible population,
deterministically selects an exact balanced 20-prospect cohort, rejects
outside-cohort and incomplete closure paths, and persists one advisory learning
candidate without network access.

Run the no-network observer and scheduler-checkpoint proof:

```bash
npm run -s check:prospect-revenue-loop-runner
```

The CLI tests use offline status fixtures, prove exact replay deduplication,
verify local receipt permissions, and stop future checks when a measured
reply, qualification, booked demo, or conversion appears. They make no HTTP
request and authorize no contact, provider request, spend, callback, or policy
change.

## Webhook And Domain Inventory

Before launch, verify each endpoint at the provider without printing secrets:

1. `smirkcalls.com` resolves to the intended Railway service.
2. Twilio incoming voice reaches the exact SMIRK deployment and validates the
   Twilio signature.
3. Twilio status callbacks reach the exact workspace-scoped routes.
4. Stripe sends signed events to the SMIRK Stripe webhook.
5. Resend sends signed delivery, bounce, complaint, suppression, and reply
   events to the SMIRK prospect-email webhook.
6. Velvet accepts the dedicated research and discovery API keys with only
   their intended scopes.
7. SMIRK accepts the dedicated Velvet research token only for the locked
   workspace.
8. Velvet validates the SMIRK outcome timestamp, HMAC signature, API key,
   lead identity, research receipt, and idempotency key.
9. CORS and trusted-return origins contain only the approved production and
   preview hosts.

## Activation Order

1. Verify funded provider accounts and billing alerts without mutating app
   configuration.
2. Back up both production databases and review pending migrations.
3. Deploy the exact reviewed SMIRK and Velvet commits with all execution
   switches still false.
4. Create the dedicated workspace-locked revenue-loop observer key, run one
   read-only checkpoint, and verify that the key is rejected by every other
   route.
5. Create dedicated cross-system API keys and HMAC secrets.
6. Configure exact URLs, workspace IDs, and receiver credentials.
7. Run one synthetic discovery, reviewed import, exact replay, and signed
   outcome callback.
8. Verify audit receipts, idempotency, workspace isolation, and zero contact.
9. Enable and test one funded phone-agent call using an allowlisted number.
10. Configure one funded dashboard-chat primary, cap its spend, and verify the
   hardening branch's provider failover with a harmless authenticated request.
11. Configure Resend DNS, webhooks, and the exact five controlled seed
    mailboxes.
12. Separately approve and send each controlled seed, record folder and raw
    header evidence, and require one all-pass receipt.
13. Prepare the matching two-arm email experiment, review its frozen eligible
    population and exact balanced cohort, then activate it.
14. Authorize exactly one reviewed prospect email.
15. Verify reply, bounce, complaint, and suppression handling.
16. Verify one hosted Stripe checkout through buyer-authenticated activation.
17. Only after those proofs, approve a bounded Velvet discovery quote.
18. Keep daily recipient and provider-spend caps at their minimum during the
    first measured cohort.

## Current Known Gap

The observed production dashboard chat reaches Gemini but receives
`429 RESOURCE_EXHAUSTED` because the selected Google AI Studio project's
prepayment credits are depleted. That proves the old production key and request
path exist; it does not prove usable AI capacity.

The hardening branch now implements OpenRouter-first, Gemini-second provider
selection, bounded request history and output, stable error responses, and
server-enforced action limits. It is not deployed. Production chat remains
blocked until the reviewed commit is deployed and one funded provider is
configured under an explicit budget.
