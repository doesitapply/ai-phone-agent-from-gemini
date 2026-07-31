# Velvet -> SMIRK Acquisition Loop

## Current Boundary

This document describes source code on the hardening branches. It does not
prove either branch is deployed or configured. No SMS, email, call, callback,
provider mutation, or production migration is authorized by this design.

The system separates the following concerns:

1. A read-only revenue-loop controller derives one next safe step from
   workspace-scoped durable state without executing or authorizing it.
2. A local checkpoint runner can read that controller with a dedicated,
   workspace-locked observer key, deduplicate unchanged checkpoints, and stop
   scheduling itself when a reply, qualification, demo, or conversion appears.
   It cannot execute the advisory next action.
3. A full SMIRK operator can prepare and separately approve one bounded,
   no-contact quote request to Velvet.
4. A Velvet administrator separately approves the exact quote and queues one
   public-source discovery under the provider-spend cap.
5. Velvet stores each accepted result as an audited review record and binds it
   to the opaque discovery request.
6. A full SMIRK operator prepares, approves, and dispatches one separate pull
   of exact discovery receipts or existing audited inventory.
7. A SMIRK operator qualifies or rejects each imported prospect.
8. For one active frozen experiment, SMIRK can prepare the entire assigned
   cohort as recipient-specific email or manual-call review jobs in one local
   transaction. Every job remains individually approval-gated.
9. A full operator separately submits one approved email or records one manual
   call.
10. Signed delivery, bounce, complaint, suppression, and reply events become
   measured facts.
11. One operator-confirmed callback can return one fact to Velvet.
12. Recorded outcomes become evaluation data. A human-approved message
   candidate still requires a second full-operator release before it becomes
   the control for a future experiment.

Cold SMS is not a supported channel. Automated prospect calls are not a
supported path. Email and Velvet callback execution are disabled by default
and require dedicated credentials, workspace locks, immutable hashes, and a
separate full-operator action for each record.

Every newly prepared outreach payload also carries an immutable deterministic
QC receipt. QC can make one exact draft eligible for human approval but cannot
approve, send, dial, or change policy. The transparent short-copy strategies,
advisory-model boundary, and controlled inbox-placement gate are documented in
[`PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md`](./PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md).
The local hardening branch now also contains a default-disabled, one-draft
OpenRouter review route with a dedicated key, rolling review/spend caps,
reservation-before-request, durable no-retry terminal states, and a separate
receipt bound again at approval and execution. No live model request or
production activation is proven by that source implementation.

## Evidence Matrix

| Layer | Current evidence | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Source contracts | `npm run -s check:velvet-smirk-closed-loop` imports both repositories' real modules with network trapped | Discovery, batch, intake, approval, outcome, replay, and candidate contracts agree | Databases, deployment, credentials, providers, or revenue |
| Velvet persistence | `DATABASE_URL=<loopback disposable MySQL> pnpm test:smirk:persistence` passes three tests | Bounded discovery receipts, batch reservation, signed outcomes, workspace isolation, candidate creation, human approval, and one learned zero-spend batch persist correctly | Real Maps, email, SMS, telephony, production migration, or commercial results |
| Cross-system local persistence | `npm run -s check:velvet-smirk:persistence` creates fresh disposable MySQL and Postgres databases, runs actual local HTTP routes, traps production network access, intercepts the advisory-QC and email-provider adapters, and drops both databases | The read-only Velvet runtime preflight verifies all required tables plus one separate admin-owned research and outcome key. Two authenticated connection-proof requests additionally prove exact dedicated scopes, one admin owner, distinct credentials, one workspace, a matching HMAC secret, and unchanged API-key usage state. The same run then proves one Velvet-discovered verified-email prospect, reviewed export, SMIRK import, qualification, deterministic call/email QC, two required immutable advisory receipts, exact advisory replay, changed-advisory-receipt execution rejection, a separate hash-bound three-scope call-compliance receipt, changed-compliance-receipt rejection, separate human approvals, a synthetic manual-call record inside the recipient-local window, one idempotent email-provider acceptance, signed delivery and reply webhooks, three deliberately out-of-order signed callbacks, exact replay, workspace isolation, and stable canonical `replied` state in both durable stores | Production token values, a live deploy, an actual registry lookup, legal authorization to contact, an actual model or phone call, an external email, real mailbox delivery or reply, a paid provider request, a customer response, or revenue |
| SMIRK revenue-loop controller | `GET /api/prospecting/revenue-loop` is exercised inside `npm run -s check:velvet-smirk:persistence` after the durable cross-system loop completes | One workspace-scoped read reports exact campaigns, qualified leads, outreach state, outcomes, callback state, connection readiness, immutable guardrails, and one next safe step without exposing credentials or taking an external action | Approval, execution, background automation, deployed parity, provider availability, contact, or revenue |
| Local checkpoint runner | `npm run -s check:prospect-revenue-loop-runner` exercises observer scoping, strict status parsing, local receipt permissions, unchanged-state deduplication, replay, and a positive-interaction stop with offline fixtures | A scheduler can repeatedly observe and record one workspace without being given contact, spend, provider, callback, or policy authority; a measured reply, qualification, demo, or conversion sets `shouldScheduleNextCheck: false` | Installation of the observer key, a deployed controller, a running scheduler, production state, contact, or revenue |
| Advisory outreach QC | `npm run -s check:prospect-outreach` exercises the dedicated provider adapter and route with trapped fetch fixtures | Deterministic failure stops before token reservation; one exact confirmation reserves capped cost before one strict-schema request; completed, failed, and uncertain states persist; exact replay is idempotent; automatic retry is blocked; required-review approval, flagged-review acknowledgment, and receipt tamper checks fail closed | A live provider key, production migration, model quality, provider funding, deployed parity, contact, delivery, response, or revenue |
| SMIRK revenue-loop controller UI | On 2026-07-30, the built frontend rendered synthetic intercepted controller data at 1280x900 and 390x844 in `output/playwright/revenue-loop-controller/desktop-controller.png` and `mobile-controller.png`; hard refresh preserved the panel, both widths had zero horizontal overflow, and `desktop-controller-error.png` showed an explicit failed-load state | The populated, responsive, hard-refresh, and error-state rendering paths are operable without a production API or provider | Live API/browser integration, deployed parity, real credentials, contact, or revenue |
| Production connection preflight | `npm run -s check:prospect-acquisition-connections` reads Railway production variables without mutation and returns only connection booleans, workspace IDs, email/QC caps, missing variable names, and explicit unproven boundaries | Whether SMIRK's production variable shape is internally valid, enabled, workspace-aligned, requires advisory QC before approval, and uses separate source/outcome, prospect/transactional-email, QC/general-OpenRouter, and observer/operator credentials | Velvet-side key scopes, matching cross-system secrets, OpenRouter funding or model quality, DNS, inbox placement, deployed parity, provider delivery, customer response, or revenue |
| Production authority handshake | `npm run -s check:prospect-acquisition-connections:remote` first validates the Railway variable shape, then can make exactly two bounded GET requests to Velvet's no-write connection-proof endpoint | When both reviewed commits are deployed and configured, the actual research and outcome tokens authenticate with their exact dedicated scopes, belong to one privileged owner, are distinct, target one workspace, and validate against the same outcome-signing secret without updating Velvet API-key usage state or authorizing contact, spend, or provider work | Provider funding, DNS, inbox placement, SMIRK deploy parity or migrations, delivery, customer response, conversion, or revenue. The 2026-07-31 production run failed before network access because the required variables were absent |
| SMIRK observational learning UI | On 2026-07-30, a disposable local Postgres workspace displayed 20 synthetic operator-selected jobs, exact content attribution, an advisory review queue, registered draft rendering, and `operator-custom-*` handling at desktop and 390x844 widths | The observational scorecard and draft controls were operable and content-bound | Candidate-grade controlled assignment, production parity, real-customer outcomes, provider delivery, or a superior commercial result |
| SMIRK controlled-message source gate | `npm run -s check:prospect-outreach` exercises an immutable operator-qualified eligible-population snapshot, deterministic balanced cohort selection, human activation, assignment replay, outside-cohort rejection, partial-enrollment closure rejection, protocol deviation, closed-cohort evaluation, full-operator recommendation approval, append-only next-control release and rollback contracts, legacy-candidate compatibility, and advisory decisions with external action trapped | The source contracts separate observational signals from candidate-grade frozen cohorts, prevent operators from cherry-picking enrollment after preparation, prevent a legacy observational row from becoming a recommendation, and require a second full-operator receipt before an approved winner can control a future experiment. Policy release still grants no contact, execution, or spend authority | Applied database migration, current browser rendering against Postgres, deployment, contact, response, or revenue |
| SMIRK inbox-placement persistence | `npm run -s check:prospect-inbox-placement:persistence` creates a disposable Postgres database, prepares exactly five allowlisted controlled seed jobs, uses the ordinary single-recipient approval and execution contracts with a fake Resend transport, records five immutable inspections, finalizes one PASS receipt, binds it to one matching email experiment, rejects a seed outcome at the write boundary, confirms zero market outcomes and zero Velvet callbacks, rejects replay drift, and drops the database | The 2/2/1 provider contract, hidden seed records, immutable folder/authentication receipts, exact variant binding, experiment activation gate, workspace isolation, and seed isolation persist without network access | Actual mailbox placement, DNS authentication, real provider acceptance, deployed migration, contact, or revenue |
| SMIRK controlled-message persistence | On 2026-07-30, `npm run -s check:prospect-message-experiments:persistence` created a loopback disposable Postgres database, ran one lifecycle test, and verified database removal | Real schema initialization and route handlers persisted one activated and closed experiment; rejected an off-protocol pre-enrollment and rolled back the attempted batch; prepared all 20 assigned review jobs through the cohort feeder; replayed the feeder without duplicate jobs or audit events; persisted one frozen candidate and full-operator decision; released the approved winner as the required control for the next immutable experiment; rejected the old control; append-only rolled the policy back; rejected activation of the now-stale prepared experiment; preserved workspace isolation; left all 20 existing jobs unchanged; and serialized simultaneous email/call activation so exactly one overlapping cohort became active. Both policy operations replayed idempotently. Network attempts, external messages, and spend remained zero | Production migration, deployed rendering, contact, response, or revenue |
| SMIRK controlled-message UI | On 2026-07-30, the built app ran with a scrubbed environment against disposable loopback Postgres at 1280x720 and emulated 390x844 widths. A synthetic full operator prepared and activated a no-contact experiment, saw the assigned arm and exact registered copy, triggered the off-protocol warning, and hard-refreshed `/dashboard/prospecting` without losing the active ledger. A browser-discovered stale campaign counter was repaired and rechecked as 21 card leads, 21 detail leads, and 21 persisted rows. A later closed cohort rendered as `APPROVED` and `ASSIGNED COHORT`; `Use for this draft` changed only the local reviewed subject, body, and registered strategy, the prepare action remained disabled without required compliance data, hard refresh retained the recommendation, and the 390-pixel layout had no horizontal overflow. A final local built-app run prepared all 20 assigned jobs as individual review drafts, persisted `20 enrolled, 20 awaiting review, 0 terminal` across hard refresh, and preserved zero horizontal overflow at 1280 and 390 pixels; screenshots are in `output/playwright/frozen-cohort-feeder/`. A separate local browser run with synthetic intercepted API data proved the current policy locks the next experiment control, release stays disabled until its exact attestation is checked, rollback requires its own reason and attestation, the append-only rollback version survives hard refresh, and the 390-pixel page has zero horizontal overflow; screenshots are in `output/playwright/message-policy-release/`. | The current experiment controls, assignment disclosure, protocol-deviation warning, eligible recommendation, opt-in draft application, cohort feeder, next-control release and rollback, responsive layout, authoritative campaign counts, and persisted hard-refresh path are operable in the local built app without provider contact | Production migration, deployed parity, provider delivery, customer response, or revenue |
| SMIRK dashboard chat safety | `npm run -s check:chat-safety` proves provider selection and action policy with fake adapters and source contracts | OpenRouter precedes Gemini, failover stops after any tool execution, raw provider errors are hidden, requests are bounded, cost-bearing actions are excluded from chat, and local contact/task writes are workspace-scoped | A funded provider, deployed parity, successful production chat, provider cost, or any external action |
| Production deployment | Not proven for these hardening commits | Nothing | Live parity, enabled credentials, migration state, or worker state |
| Contact and commercial proof | No real email, SMS, prospect call, spend, conversion, or payment was performed in this proof | Guardrails remained intact | Interest, deliverability, conversion, or revenue |

Treat movement between these rows as separate approval gates. A green source
or local-database gate cannot be promoted into a deployed, provider, contact,
or commercial claim.

### Production connection checkpoint

On 2026-07-31, the read-only production preflight returned `ok: false`. Velvet
discovery, Velvet source export, prospect email, the prospect-email webhook,
the five-mailbox inbox-placement array, required advisory QC, and the Velvet
outcome callback were all unavailable in the Railway production variable set.
The dedicated revenue-loop observer is also unavailable on the hardening
branch's expanded preflight. No acquisition workspace alignment, email caps,
or QC caps were established. The remote authority command also returned
`ok: false` with
`requestsPerformed: 0`: it made no call to Velvet because the two dedicated
tokens, aligned workspace IDs, exact Velvet origins, and signing secret were
not configured. The checks changed no variables, contacted no prospect, sent
no provider request, and spent nothing. This is a configuration and deploy
blocker, not evidence that any production connection is active.

### Checkpoint runner

The observer credential is separate from `DASHBOARD_API_KEY` and is accepted
only for `GET /api/prospecting/revenue-loop`. Both the SMIRK runtime and the
checkpoint process use the same dedicated key and workspace lock:

```text
PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY
PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID
PROSPECT_REVENUE_LOOP_BASE_URL=https://smirkcalls.com
```

Read and validate without writing a local receipt:

```bash
npm run -s run:prospect-revenue-loop -- --no-write
```

Writing `output/prospect-revenue-loop/latest.json` and the deduplicated local
`history.jsonl` additionally requires:

```text
CONFIRM_SMIRK_PROSPECT_REVENUE_LOOP_CHECKPOINT=write-one-local-checkpoint-v1
```

That confirmation authorizes only local checkpoint files. It does not approve
the controller's next action, contact, spend, provider requests, callbacks, or
policy changes. The command reports whether another observation should be
scheduled; it does not install or run a scheduler itself.

## Data Path

```text
GET /api/prospecting/revenue-loop
  -> one read-only, workspace-scoped aggregate
  -> exact connection readiness without secret values
  -> one advisory next safe step
  -> NO approval, send, dial, spend, callback, or policy mutation
local checkpoint runner
  -> GET only with a dedicated observer key locked to one workspace
  -> strict response validation + stable status hash
  -> append one local receipt only when durable state changes
  -> STOP_INTERACTION on reply / qualification / demo / conversion
  -> never execute the advisory next action
production authority handshake
  -> two bounded GET requests using the exact research and outcome keys
  -> exact dedicated scopes + same admin owner + distinct credentials
  -> one workspace + shared outcome-signing secret
  -> no API-key usage write, provider request, contact, spend, or policy change
SMIRK PREPARED discovery request (20 leads, $5 quote ceiling, no contact)
  -> full-operator APPROVED
  -> exact request submitted to Velvet
  -> Velvet PREPARED quote (no provider call)
  -> Velvet administrator APPROVED
  -> separate Velvet QUEUED action
  -> one default-disabled worker claim
  -> sequential provider requests under the exact approved cap
  -> READY / SKIPPED / FAILED discovery receipts
  -> SMIRK explicit status refresh
  -> SMIRK PREPARED reviewed pull bound to the discovery request
  -> full-operator APPROVED
  -> Velvet owner-scoped reservation receipt
  -> COMPLETED / EMPTY / PARTIAL SMIRK import receipt
  -> POST /api/integrations/velvet/prospects
  -> SMIRK research receipt + campaign + prospect
  -> operator review (`pending_review`, `qualified`, `rejected`)
  -> one PREPARED email or call job
  -> APPROVED / REJECTED / EXPIRED / CANCELLED
  -> email: full operator claims SENDING, then Resend accepts SENT
  -> call: operator manually dials and records external proof as SENT
  -> signed Resend webhook -> idempotent measured outcome
  -> signed Velvet callback outbox (PREPARED)
  -> full operator claims one callback SENDING
  -> Velvet owner-scoped outcome event
  -> observational registered-content scorecard (descriptive only)
  -> hidden five-mailbox PREPARED seed jobs for the exact two email variants
  -> five separate exact approvals and five separate controlled sends
  -> five immutable operator folder/authentication inspections
  -> seven-day PASS / FAIL inbox-placement receipt
  -> human PREPARED message experiment with frozen untouched population
  -> exact balanced cohort selected in the immutable definition
  -> email: full-operator ACTIVE only with the exact fresh PASS receipt
  -> call: full-operator ACTIVE after exact definition review
  -> full-operator cohort draft preparation (one local transaction)
  -> deterministic assignment stored in each immutable PREPARED job payload
  -> individual recipient review and approval remains mandatory
  -> protocol-matched SENT jobs + measured outcomes
  -> terminal-job gate + human CLOSED
  -> closed assigned-cohort evaluation
  -> CANDIDATE
  -> human APPROVED or REJECTED decision
  -> separate full-operator append-only message-policy release
  -> released winner becomes only the next experiment control
  -> immutable experiment definition binds the exact policy receipt
  -> append-only rollback can restore the prior control
  -> optional rendering of the exact approved strategy into one reviewed draft
  -> optional one-request learned segment, with a second SMIRK approval
  -> no automatic contact, execution, spend, or unregistered copy generation
```

## Bounded Discovery Contract

`smirk-velvet.discovery-request.v1` lets SMIRK request a deterministic quote
for one category and metro. It carries an opaque request ID, workspace ID,
immutable request hash, 1-20 lead limit, `contactActionAllowed: false`, and
`spendAuthorized: false`. SMIRK cannot approve provider spend through this
contract.

SMIRK stores local `PREPARED`, `APPROVED`, `SENDING`, and `SUBMITTED` state
separately from Velvet's `PREPARED`, `APPROVED`, `QUEUED`, `RUNNING`, and
terminal state. Preparing is local-only. Dispatch requires a second full
operator action and can only ask Velvet to persist a quote. Status refresh is
also explicit; there is no background polling or automatic import.

Velvet limits the quote to 20 leads and 500 cents. A privileged Velvet browser
session must approve the exact request hash, quote hash, and maximum amount,
then queue it in a separate action. The default-disabled worker executes one
job sequentially, reserves each provider cost before the request, checks the
global and owner kill switches, and never auto-retries uncertain work. The
executor creates public-source research records only and cannot call an email,
SMS, LLM, or telephony provider.

`velvet-smirk.discovery-status.v1` returns immutable request and quote hashes,
effective criteria, counts, provider-request count, and the exact amount
approved inside Velvet. A completed status still does not import anything.
SMIRK must prepare the separately approved reviewed-inventory pull below.

## Reviewed Lead Source Contract

`smirk-velvet.lead-batch-request.v1` lets SMIRK request one bounded batch from
Velvet's existing audited inventory. It does not invoke `/scrape`, `/pipeline`,
an LLM, a paid data source, or a contact provider.

Every request contains:

- an opaque request ID and immutable request hash;
- an `Idempotency-Key` header exactly matching that request ID;
- one workspace ID;
- a limit from 1 through 20;
- either a manual category/metro filter or `latest_approved` learning mode;
- `contactActionAllowed: false`; and
- `maxSpendCents: 0`.

SMIRK stores `PREPARED`, `APPROVED`, `SENDING`, `PARTIAL`, `COMPLETED`,
`EMPTY`, `FAILED`, `CANCELLED`, and `EXPIRED` separately. Approval requires a
full operator, the exact payload hash, the exact
`approve-one-velvet-source-request-v1` confirmation, and attestations that the
action authorizes neither contact nor spend. Dispatch requires a second full
operator action and `dispatch-one-velvet-source-request-v1`.

Velvet requires a dedicated admin-granted API key with only
`smirk:research`. It selects only the key owner's `audited` leads with a phone
or verified owner email, reserves each lead once, and stores the full response
for exact replay. `201 EXPORTED`/`EMPTY` and `200 DUPLICATE` are the only
successful receipts. The response contract,
`velvet-smirk.lead-batch-response.v1`, repeats the request hash and includes a
hash over the prospect list, applied learning-candidate provenance,
`contactActionAllowed: false`, and `spendAuthorized: false`.

When the pull follows a discovery, the additive
`sourceDiscoveryRequestId` field must contain that exact opaque request ID.
Velvet resolves it within the API-key owner's account and configured SMIRK
workspace, requires a `COMPLETED` or `PARTIAL` discovery, and selects only
`READY` lead receipts from that discovery. The response echoes the same ID.
SMIRK rejects missing or changed discovery provenance before importing.

SMIRK validates the response before importing each prospect through the
existing `velvet-smirk.prospect.v1` receiver store. Uncertain transport remains
`SENDING`; exact retry uses the same request ID. A short durable lease blocks
simultaneous dispatch while still allowing an exact retry after explicit
transport uncertainty or an abandoned lease. A failed subset becomes `PARTIAL`
and retries only missing records from the stored response.

SMIRK configuration is default-disabled:

```text
VELVET_LEAD_SOURCE_ENABLED=false
VELVET_LEAD_SOURCE_BASE_URL=https://velvetalchemy.manus.space
VELVET_LEAD_SOURCE_API_KEY
VELVET_LEAD_SOURCE_WORKSPACE_ID
VELVET_DISCOVERY_ENABLED=false
```

## Prospect Contract

`velvet-smirk.prospect.v1` uses a stable opaque external prospect ID. Every
evidence item includes:

- public source URL;
- observation timestamp;
- evidence kind;
- basis (`observed`, `measured`, or `inferred`);
- confidence.

The receiver rejects unclassified evidence. An import creates research records
only and returns `externalAction: "none"`. An email is accepted only with
`verified_owner_email` provenance. A phone is accepted only as
`operator_review_only`; it can never authorize SMS or automated dialing.

## Outreach Contract

`smirk.prospect-outreach.v2` supports only `email` and `call`.

Every job contains:

- one workspace, campaign, and prospect;
- one normalized recipient;
- one message variant;
- exact source-evidence hash;
- exact immutable payload hash;
- maximum cost in cents;
- opaque approval ID;
- preparer, approver, timestamps, and expiry;
- an append-only transition audit.

`POST /api/prospecting/learning/experiments/:experimentId/prepare-drafts`
accepts only the exact active frozen definition hash, channel, explicit
no-contact confirmation, and complete compliance data. It renders each
prospect's assigned registered strategy, applies the ordinary evidence and QC
checks, and writes the complete cohort atomically. Any selected-prospect drift,
missing evidence, invalid assignment, channel reservation, or QC failure rolls
back the batch. Exact replay returns the existing opaque approval IDs.

This route is a batch preparation convenience, not bulk outreach. It has no
provider call and returns `contactAuthorized: false`,
`executionAuthorized: false`, and `spendAuthorized: false`. Each resulting
`PREPARED` job still requires its own human approval, and email execution still
requires a separate one-recipient confirmation. Call jobs remain manual-dial
only.

An email payload also contains the exact sender identity, commercial-message
disclosure, physical postal address, and opt-out instructions that will appear
in the approved content.
Approval requires recipient review, suppression review, and confirmation of
those three fields. A call brief requires recipient review, suppression and
do-not-call checks across federal, state, and SMIRK-internal scopes, an IANA
recipient timezone, and an explicit manual-dial-only attestation. Each scope
requires an operator-supplied source and reference. The server stores that
evidence and an immutable receipt bound to the workspace, lead, job, approval,
recipient, authenticated operator principal, and approval time. The receipt
expires at the earlier of 24 hours after the checks or the job expiry.

The receipt records what the operator reviewed. It does not prove that an
external registry was queried correctly, establish consent, authorize contact,
or certify legal compliance. SMIRK does not call a DNC provider in this path.

States are:

```text
PREPARED -> APPROVED -> SENT             (manual call record only)
    |           |
    |           +-> SENDING -> SENT       (one-email provider acceptance)
    |                        \-> FAILED
    +-> REJECTED, EXPIRED, or CANCELLED
```

The `/execute` endpoint can submit one approved email only when every dedicated
provider variable is configured and execution is enabled. It requires the
opaque approval ID, exact payload hash, exact second confirmation, full
operator access, unchanged verified recipient, active suppression check,
workspace lock, rolling recipient cap, rolling reserved-spend cap, and a
deterministic Resend idempotency key. A workspace advisory lock serializes cap
reservations across concurrent jobs. It cannot submit SMS, bulk email, or
calls. A provider acceptance records `SENT`; it does not claim delivery.

`record-execution` records proof of one manual call an operator completed
outside SMIRK; it does not perform the action. It rejects email jobs, rechecks
the stored compliance receipt hash, three DNC scopes, evidence age, recipient,
qualification, and manual-dial controls. It also computes the supplied
occurrence time in the stored recipient timezone and permits only 09:00
inclusive through 17:00 exclusive. It requires the exact
`record-one-manual-call-v1` confirmation.
The direct `APPROVED -> SENT` transition is reserved for that call-only path.
The operator supplies a structured `manual:` proof reference.
The occurrence time must be after approval, before expiry, and no more than five
minutes in the future. An exact retry is idempotent; changed execution facts
under the same approval return `409`.

Approvals created before this receipt contract are intentionally not
executable. Cancel the old job and prepare and approve a new brief after fresh
checks; never backfill evidence that was not actually reviewed.

The proof reference is stored separately from any future provider message ID.
Direct status edits cannot invent contacted, interested, or converted states.
Those states require an idempotent outcome event.

The guarded email lane requires:

```text
PROSPECT_EMAIL_EXECUTION_ENABLED=true
PROSPECT_EMAIL_EXECUTION_MODE=single-recipient-reviewed-v1
PROSPECT_EMAIL_RESEND_API_KEY
PROSPECT_EMAIL_FROM
PROSPECT_EMAIL_REPLY_TO
PROSPECT_EMAIL_WORKSPACE_ID
PROSPECT_EMAIL_DAILY_RECIPIENT_CAP
PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS
PROSPECT_EMAIL_UNIT_COST_CENTS
```

The prospect key must differ from the transactional `RESEND_API_KEY`.

Before an email experiment can activate, the exact five controlled seed
mailboxes must also be configured:

```text
PROSPECT_INBOX_SEED_ALLOWLIST
```

The allowlist contains exactly two Google Workspace addresses, two Microsoft
365 addresses, and one Yahoo/AOL address. It permits seed preparation only.
Each seed still passes through one immutable approval and one separate
one-recipient send confirmation. An all-pass seven-day receipt gates only the
same workspace, campaign, control strategy, and challenger strategy. It does
not authorize prospect contact or spend.

Signed delivery, failure, suppression, or reply facts for a controlled seed are
retained as provider evidence. They cannot create a prospect outcome, mutate a
prospect status, enter either learning scorecard, or prepare/dispatch a Velvet
outcome callback. The outcome writer and Velvet outbox routes enforce this
boundary even if a seed identifier is submitted directly.

## Provider Outcome Contract

The raw-body endpoint `/api/prospecting/resend/webhook` verifies Resend's
`svix-id`, `svix-timestamp`, and `svix-signature` headers with the dedicated
webhook secret. It stores a unique provider-event receipt before recording any
outcome. Exact replay is idempotent; a reused event ID with changed bytes is a
conflict.

```text
PROSPECT_EMAIL_WEBHOOK_ENABLED=true
PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET
```

`email.delivered`, `email.bounced`, `email.complained`, `email.failed`, and
`email.suppressed` must match the dedicated outreach sender and exact stored
provider message ID. Bounce, complaint, and suppression facts add an active
internal suppression. Signed inbound mail must target the dedicated reply
mailbox and map to exactly one recent outreach job; zero or multiple matches
stop at `REVIEW_REQUIRED`. The receiver does not fetch message bodies or
attachments.

## Outcome Contract

`smirk-velvet.outcome.v1` links:

- Velvet external prospect ID;
- SMIRK external event ID;
- outreach approval ID;
- channel and variant-derived payload;
- evidence and outreach payload hashes;
- outcome and occurrence time.

SMIRK stores callback payloads in `velvet_outcome_outbox`. One callback can be
dispatched only by a full operator using the exact outbox ID, payload hash, and
second confirmation. `PREPARED`, `SENDING`, `DISPATCHED`, and `FAILED` remain
separate, and uncertain transport stays `SENDING` for a same-payload retry.
The sender requires all of:

```text
VELVET_BASE_URL=https://velvetalchemy.manus.space
VELVET_OUTCOME_API_KEY
VELVET_OUTCOME_SIGNING_SECRET
VELVET_OUTCOME_WORKSPACE_ID
VELVET_OUTCOME_DISPATCH_ENABLED=true
```

Velvet separately requires:

```text
SMIRK_OUTCOME_SIGNING_SECRET
```

Velvet also requires a dedicated API key with `outcome:write`. It verifies the
HMAC signature, five-minute timestamp window, API-key owner, exact external
lead identity, required outreach approval and payload hashes, a prior
successful research receipt for the same SMIRK workspace, event payload hash,
and idempotency key. `201 RECORDED` and `200 DUPLICATE` are the only successful
receipts.

Each outreach job can record a given outcome type at most once. Email-only
outcomes cannot be attached to call jobs, and call-only outcomes cannot be
attached to email jobs. Replaying the same external event ID with exact bytes is
idempotent; reusing it with changed facts returns `409`.

Setting variables is a separate approval gate. Do not enable dispatch until the
exact commits are deployed and one synthetic callback passes without any
contact action.

## Learning Loop

Each registered strategy contains a versioned key, channel, operator-facing
label, hypothesis, and renderer for the actual subject/body or manual call
brief. SMIRK attributes a prepared job to that strategy only when the submitted
content exactly matches the registered rendering for the reviewed prospect
context. A caller-supplied label cannot override the content check.

If an operator edits the subject or content, SMIRK persists a content-specific
`operator-custom-<hash>` key. Custom or otherwise unregistered copy remains
reviewable and preparable, but its outcomes are excluded from registered
strategy scorecards and cannot create a promotion candidate. This prevents the
loop from optimizing labels while unrelated copy was actually sent or spoken.

The general scorecard is observational. Operators chose which prospect and
message to use, so its rates are descriptive signals only. It is labeled
`studyDesign: observational`, returns `candidateEligible: false`, and cannot
create a learning candidate.

Candidate-grade evidence uses a separate workspace-scoped experiment ledger:

1. A full operator prepares one campaign/channel experiment containing exactly
   two registered strategies and an even cohort size from 20 to 200.
2. Preparation snapshots every currently untouched, operator-qualified,
   evidence-backed prospect eligible for that channel. Email eligibility also
   requires a verified owner email and no active suppression. Call eligibility
   requires an E.164 number explicitly marked `operator_review_only`.
3. The immutable definition stores the sorted eligible prospect IDs,
   population count and hash, deterministic selected-prospect hash, and exact
   balanced control/challenger cohort. Selection uses the experiment ID and
   prospect ID, not operator choice.
4. Activation requires the exact definition hash, exact confirmation, and
   attestations that the frozen cohort, content, and assignment were reviewed
   and that no contact or spend was authorized. SMIRK rechecks that every
   selected prospect is still untouched and eligible and rejects overlap with
   another active frozen cohort.
5. While `ACTIVE`, only selected prospects can enter the experiment. The
   selected prospects are reserved across email and call experiments so a
   competing channel cannot silently contaminate the cohort. The
   assignment receipt, definition hash, bucket, assigned strategy, actual
   strategy, and protocol status are stored inside the outreach job's
   immutable hashed payload.
6. One prospect can enroll only once per experiment. Replaying preparation
   returns the existing enrollment. A database uniqueness constraint enforces
   the same rule under concurrency.
7. The operator may still choose different or custom copy. That preserves
   human judgment, but the immutable receipt marks it off protocol.
8. The experiment cannot close until every selected prospect has exactly one
   enrollment and no enrolled job is `PREPARED`, `APPROVED`, or `SENDING`.
   Closure requires the exact definition hash plus attestations that enrollment
   stopped, every job is terminal, and the outcome window was reviewed.
9. Candidate evaluation requires `CLOSED`, re-verifies the complete frozen
   cohort, every job payload, and every assignment, and rejects duplicate
   enrollment or any executed off-protocol job.

Both observational and experiment scorecards count only registered strategies
linked to executed outreach jobs. Each job contributes exactly one sample even
when its lifecycle records multiple events. Transport events, engagement
events, and business outcomes collapse to one canonical result: a later
delivery event cannot overwrite a reply, and the latest business-level result
determines the final measured outcome. The UI shows unique executed jobs
separately from raw event count.
Positive events are:

- email: replied, qualified, demo booked, or converted;
- call: connected, qualified, demo booked, or converted.

The assigned challenger and control each need at least 10 protocol-matched,
executed jobs with measured outcomes. Repeated events for one job cannot
satisfy the gate. A candidate is created only when the challenger has positive
measured lift. The result is labeled
`studyDesign: deterministic-eligible-cohort-v1`. It is not described as a
fully randomized market estimate because operators still decide which leads
are qualified and whether each selected recipient is safe to approve and
execute. Selection and assignment are deterministic; human safety decisions
and resulting attrition remain visible limitations.

Marking a candidate `APPROVED` records a human decision but returns
`policyChanged: false`. The SMIRK Prospecting page exposes the observational
scorecard, experiment ledger, assigned strategy in each prospect drawer,
closed-cohort evaluator, and human decision queue. A decision requires an
explicit evidence-review checkbox. An approved recommendation remains opt-in
for each individual draft through `Use for this draft`; that action renders
the registered strategy's actual subject and content into the draft. Switching
to a call strategy renders a separate operator brief that states manual
dialing is required. None of these actions rewrites existing jobs, sends,
dials, spends, or changes runtime policy. Reads and decisions are
workspace-scoped and return a storage error instead of false success when the
database is unavailable.

An approved deterministic candidate can change the campaign's message policy
only through a second full-operator action bound to the exact proposal hash.
That action appends an immutable, versioned release; it does not edit the
candidate, existing drafts, prior experiments, or outcomes. The release grants
only one authority: its registered winner must be the control when the next
experiment is prepared. The new experiment stores the exact release ID, hash,
version, and champion in its immutable definition.

Rollback is another append-only full-operator release with an exact current
receipt, reviewed target, and reason. It restores the prior registered control
for future experiment preparation. A prepared experiment whose embedded
receipt is no longer current cannot activate and must be cancelled and
reprepared. Promotion and rollback are both single-use, idempotent,
workspace-scoped, and explicitly authorize no contact, execution, or spend.
The operator still selects a registered challenger; SMIRK does not invent or
deploy new copy autonomously.

A full SMIRK operator may explicitly select
`latest_approved` for one source request; Velvet then applies only that
candidate's category or metro and batch-size ceiling. The candidate cannot
alter prompts, default routing, spending, or provider execution. Automatic
policy changes still require a separate reviewed release.

Velvet's sourcing scorecard uses one canonical lifecycle result per unique
prospect. Multiple delivery, reply, call, qualification, or conversion events
for one lead remain auditable but contribute only one sourcing sample. The
candidate and comparison segment each require at least 10 distinct prospects,
so a busy lifecycle cannot masquerade as broad market evidence.

This is the practical self-improvement loop:

```text
versioned input -> human-activated deterministic assignment
-> immutable human-approved action -> measured outcome
-> closed assigned-cohort comparison -> human message candidate
-> second human release -> next experiment control only
-> human sourcing candidate -> one separately approved research request
-> more reviewed inputs -> no automatic contact or policy mutation
```

## Local Cross-Repository Gate

Run the source-level compatibility proof from the SMIRK repository while the
Velvet repository is available as its sibling:

```bash
npm run -s check:velvet-smirk-closed-loop
```

Use `VELVET_REPO_PATH=/absolute/path/to/velvet-alchemy-landing` when the
repositories are not siblings. Add `-- --require-clean` to bind the report to
two exact clean commits.

The command imports the real Velvet discovery, research, reviewed-batch,
outcome, and acquisition-learning modules together with the real SMIRK
discovery, source, intake, outreach, outcome, and variant-learning modules. It
traps all network access and uses reserved synthetic contact data. It proves:

- discovery request, quote, status, and exact spend-cap agreement;
- a completed discovery can prepare only a separately approved reviewed pull;
- the reviewed pull is bound to the exact discovery and changed provenance is
  rejected;
- source-request and response contract/hash agreement;
- one approved acquisition candidate narrows one bounded request;
- no-contact, zero-spend source semantics;
- research payload and hash agreement;
- stable external identity and changed-payload detection;
- `201 IMPORTED` and `200 DUPLICATE` response mapping;
- exact source-evidence lineage into registered email content and a distinct
  manual-dial-only call brief;
- changed subject/body content is not attributed to an unrelated registered
  strategy;
- operator-selected scorecards remain observational and candidate-ineligible;
- one reviewed experiment definition freezes the untouched eligible
  population, selects an exact balanced cohort, and produces stable
  per-prospect assignments;
- prospects outside that cohort cannot enroll and a partial cohort cannot
  close;
- exact replay preserves the same enrollment and assignment receipt;
- executed off-protocol content blocks a message-learning candidate;
- active experiments cannot be evaluated and nonterminal jobs prevent closure;
- recipient-specific approvals plus a hash-bound three-scope DNC and
  recipient-timezone receipt whose tampering blocks execution;
- SMS, bulk execution, and automated dialing remain disabled;
- one-email and one-callback provider requests are trapped and validated
  without network access;
- outcome payload, canonical hash, HMAC signature, and receipt agreement;
- exact replay semantics; and
- closed assigned-cohort message proposals and canonicalized sourcing proposals
  that still require human review, with repeated lifecycle events collapsed to
  one sample per executed outreach job or unique sourced prospect.

This is not a database, deployment, provider-delivery, or revenue proof. Those
remain separate activation gates below.

Run the full cross-database HTTP persistence proof when local MySQL and
Postgres are available:

```bash
npm run -s check:velvet-smirk:persistence
```

The command finds a sibling `velvet-alchemy-landing` repository by default.
Set `VELVET_REPO_PATH=/absolute/path/to/velvet-alchemy-landing` when it lives
elsewhere. It creates uniquely named loopback-only disposable databases,
applies Velvet's tracked migrations, initializes the actual SMIRK schema, and
drives the production route handlers through loopback HTTP. Calls aimed at the
canonical Velvet origin are intercepted and rewritten to the fixture server;
the single email-provider adapter request is captured in memory, and any other
non-loopback request fails the run. It proves one Velvet-discovered
verified-email prospect can be imported and separately approved for a
synthetic manual-call record and one-recipient email-provider acceptance. It
then records signed delivery and reply webhooks, dispatches all three resulting
outcome callbacks out of order, verifies exact replay, and confirms both stores
retain the canonical `replied` state with cross-workspace denial. It also calls
Velvet's actual no-write connection-proof route with both generated dedicated
credentials and verifies exact scopes, same owner, credential separation,
workspace alignment, shared-secret signatures, and unchanged `lastUsedAt`
values. The route uses domain-separated proof HMACs and does not sign outcome
payloads. The command does not dial, send an external email or SMS, use a paid
provider, write production data, or deploy. Both disposable databases are
dropped in `finally`, including on a failed assertion.

Run the controlled-message persistence gate only against a disposable loopback
Postgres database whose name begins with `smirk_experiment_test_`:

```bash
SMIRK_EXPERIMENT_TEST_DATABASE_URL='postgresql://127.0.0.1:5432/smirk_experiment_test_example' \
  npm run -s check:prospect-message-experiments:persistence
```

The test refuses non-loopback hosts and non-test database names. It initializes
the actual prospecting schema and calls the actual experiment and outreach
route handlers with synthetic data while network access is trapped. Create a
fresh disposable database before the run and drop it afterward.

## Activation Gates

1. Review and commit both hardening branches.
2. Reconcile each branch with its upstream branch.
3. Review the exact startup DDL and approve a backup plus database change.
   `initProspectorSchema` runs at service startup, so deploying this SMIRK
   commit also attempts the new tables, columns, and indexes. The DDL has not
   been applied by this source-code checkpoint. The guarded deploy command
   fails unless both `CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE` and
   `CONFIRM_SMIRK_PROSPECT_SCHEMA_BACKUP` carry their exact reviewed values.
4. Deploy SMIRK and prove its live commit fingerprint.
5. Deploy Velvet and prove its live build fingerprint.
6. Create separate Velvet `smirk:research` and `outcome:write` keys under the
   same privileged owner, configure the aligned workspace and HMAC secret, and
   leave discovery, source, email, callback, and worker switches disabled.
7. Run `npm run -s check:prospect-acquisition-connections:remote` and require
   both the local variable preflight and signed two-key authority proof to pass.
8. Configure the separate Velvet-to-SMIRK research credential and run one
   synthetic import plus exact replay.
9. With separate approval, enable the discovery and source clients and prove
   one no-contact quote, Velvet-side approve/queue, bounded synthetic discovery,
   terminal status, exact discovery-bound reviewed pull, and changed-provenance
   rejection. Disable the discovery worker again.
10. With separate approval, prove one synthetic
   `EXPORTED` plus `DUPLICATE`, one `EMPTY`, one forged-hash rejection, one
   uncertain replay, and one partial-import recovery. Disable it again.
11. Verify hard-refresh queue persistence and absence of contact actions.
12. Prepare, preview, approve, reject, cancel, and expire synthetic jobs.
13. Verify the commercial disclosure, footer, channel-specific attestations,
    one-recipient cap, spend cap, suppression, and idempotency behavior.
14. Configure a dedicated prospect Resend key and signed webhook only for a
    synthetic gate. Prove provider acceptance, `delivered`, exact replay,
    forged-signature rejection, and suppression behavior.
15. Configure callback secrets, enable dispatch only for the synthetic gate,
    and prove `RECORDED` plus `DUPLICATE`.
16. Confirm the same external event ID with changed bytes returns `409`.
17. Disable discovery, source, email execution, and callback dispatch again
    until real
    outreach receives separate approval.

No bulk execution, automated phone spam, paid search, or cold SMS is part of
this activation plan.
