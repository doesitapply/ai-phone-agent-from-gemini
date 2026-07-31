# Velvet -> SMIRK Acquisition Loop

## Current Boundary

This document describes source code on the hardening branches. It does not
prove either branch is deployed or configured. No SMS, email, call, callback,
provider mutation, or production migration is authorized by this design.

The system separates the following concerns:

1. A read-only revenue-loop controller derives one next safe step from
   workspace-scoped durable state without executing or authorizing it.
2. A full SMIRK operator can prepare and separately approve one bounded,
   no-contact quote request to Velvet.
3. A Velvet administrator separately approves the exact quote and queues one
   public-source discovery under the provider-spend cap.
4. Velvet stores each accepted result as an audited review record and binds it
   to the opaque discovery request.
5. A full SMIRK operator prepares, approves, and dispatches one separate pull
   of exact discovery receipts or existing audited inventory.
6. A SMIRK operator qualifies or rejects each imported prospect.
7. SMIRK prepares one recipient-specific email or manual call job for human
   approval.
8. A full operator separately submits one approved email or records one manual
   call.
9. Signed delivery, bounce, complaint, suppression, and reply events become
   measured facts.
10. One operator-confirmed callback can return one fact to Velvet.
11. Recorded outcomes become evaluation data; proposed policy changes remain
   human-reviewed candidates.

Cold SMS is not a supported channel. Automated prospect calls are not a
supported path. Email and Velvet callback execution are disabled by default
and require dedicated credentials, workspace locks, immutable hashes, and a
separate full-operator action for each record.

Every newly prepared outreach payload also carries an immutable deterministic
QC receipt. QC can make one exact draft eligible for human approval but cannot
approve, send, dial, or change policy. The transparent short-copy strategies,
advisory-model boundary, and controlled inbox-placement gate are documented in
[`PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md`](./PROSPECT_QC_AND_DELIVERABILITY_RUNBOOK.md).

## Evidence Matrix

| Layer | Current evidence | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Source contracts | `npm run -s check:velvet-smirk-closed-loop` imports both repositories' real modules with network trapped | Discovery, batch, intake, approval, outcome, replay, and candidate contracts agree | Databases, deployment, credentials, providers, or revenue |
| Velvet persistence | `DATABASE_URL=<loopback disposable MySQL> pnpm test:smirk:persistence` passes three tests | Bounded discovery receipts, batch reservation, signed outcomes, workspace isolation, candidate creation, human approval, and one learned zero-spend batch persist correctly | Real Maps, email, SMS, telephony, production migration, or commercial results |
| Cross-system local persistence | `npm run -s check:velvet-smirk:persistence` creates fresh disposable MySQL and Postgres databases, runs actual local HTTP routes, traps production network access, intercepts the email-provider adapter, and drops both databases | The read-only Velvet runtime preflight verifies all required tables plus one separate admin-owned research and outcome key; the same run proves one Velvet-discovered verified-email prospect, reviewed export, SMIRK import, qualification, separate call/email QC receipts and human approvals, a synthetic manual-call record, one idempotent email-provider acceptance, signed delivery and reply webhooks, three deliberately out-of-order signed callbacks, exact replay, workspace isolation, and stable canonical `replied` state in both durable stores | Matching raw cross-system token values, a live deploy, an actual call, an external email, real mailbox delivery or reply, a paid provider request, a customer response, or revenue |
| SMIRK revenue-loop controller | `GET /api/prospecting/revenue-loop` is exercised inside `npm run -s check:velvet-smirk:persistence` after the durable cross-system loop completes | One workspace-scoped read reports exact campaigns, qualified leads, outreach state, outcomes, callback state, connection readiness, immutable guardrails, and one next safe step without exposing credentials or taking an external action | Approval, execution, background automation, deployed parity, provider availability, contact, or revenue |
| SMIRK revenue-loop controller UI | On 2026-07-30, the built frontend rendered synthetic intercepted controller data at 1280x900 and 390x844 in `output/playwright/revenue-loop-controller/desktop-controller.png` and `mobile-controller.png`; hard refresh preserved the panel, both widths had zero horizontal overflow, and `desktop-controller-error.png` showed an explicit failed-load state | The populated, responsive, hard-refresh, and error-state rendering paths are operable without a production API or provider | Live API/browser integration, deployed parity, real credentials, contact, or revenue |
| Production connection preflight | `npm run -s check:prospect-acquisition-connections` reads Railway production variables without mutation and returns only connection booleans, workspace IDs, email caps, missing variable names, and explicit unproven boundaries | Whether SMIRK's production variable shape is internally valid, enabled, workspace-aligned, and uses separate source/outcome and prospect/transactional credentials | Velvet-side key scopes, matching cross-system secrets, DNS, inbox placement, deployed parity, provider delivery, customer response, or revenue |
| SMIRK observational learning UI | On 2026-07-30, a disposable local Postgres workspace displayed 20 synthetic operator-selected jobs, exact content attribution, an advisory review queue, registered draft rendering, and `operator-custom-*` handling at desktop and 390x844 widths | The observational scorecard and draft controls were operable and content-bound | Candidate-grade controlled assignment, production parity, real-customer outcomes, provider delivery, or a superior commercial result |
| SMIRK controlled-message source gate | `npm run -s check:prospect-outreach` exercises immutable experiment definitions, deterministic assignment, human activation, assignment replay, protocol deviation, terminal-job closure, closed-cohort evaluation, full-operator recommendation approval, legacy-candidate rejection, and advisory decisions with external action trapped | The source contracts separate observational signals from candidate-grade assigned cohorts, prevent a legacy observational row from becoming a recommendation, and preserve human contact gates | Applied database migration, current browser rendering against Postgres, deployment, contact, response, or revenue |
| SMIRK inbox-placement persistence | `npm run -s check:prospect-inbox-placement:persistence` creates a disposable Postgres database, prepares exactly five allowlisted controlled seed jobs, uses the ordinary single-recipient approval and execution contracts with a fake Resend transport, records five immutable inspections, finalizes one PASS receipt, binds it to one matching email experiment, rejects a seed outcome at the write boundary, confirms zero market outcomes and zero Velvet callbacks, rejects replay drift, and drops the database | The 2/2/1 provider contract, hidden seed records, immutable folder/authentication receipts, exact variant binding, experiment activation gate, workspace isolation, and seed isolation persist without network access | Actual mailbox placement, DNS authentication, real provider acceptance, deployed migration, contact, or revenue |
| SMIRK controlled-message persistence | On 2026-07-30, `SMIRK_EXPERIMENT_TEST_DATABASE_URL=<loopback disposable Postgres> npm run -s check:prospect-message-experiments:persistence` passed one lifecycle test against a clean database, then that database was dropped | Real schema initialization and route handlers persisted one activated and closed experiment, 20 uniquely enrolled assigned jobs, one frozen candidate, exact full-operator approval, eligible readback, replay behavior, and workspace isolation without network access | Production migration, deployed rendering, contact, response, or revenue |
| SMIRK controlled-message UI | On 2026-07-30, the built app ran with a scrubbed environment against disposable loopback Postgres at 1280x720 and emulated 390x844 widths. A synthetic full operator prepared and activated a no-contact experiment, saw the assigned arm and exact registered copy, triggered the off-protocol warning, and hard-refreshed `/dashboard/prospecting` without losing the active ledger. A browser-discovered stale campaign counter was repaired and rechecked as 21 card leads, 21 detail leads, and 21 persisted rows. A later closed cohort rendered as `APPROVED` and `ASSIGNED COHORT`; `Use for this draft` changed only the local reviewed subject, body, and registered strategy, the prepare action remained disabled without required compliance data, hard refresh retained the recommendation, and the 390-pixel layout had no horizontal overflow. | The current experiment controls, assignment disclosure, protocol-deviation warning, eligible recommendation, opt-in draft application, responsive layout, authoritative campaign counts, and persisted hard-refresh path are operable in the local built app without provider contact | Production migration, deployed parity, provider delivery, customer response, or revenue |
| SMIRK dashboard chat safety | `npm run -s check:chat-safety` proves provider selection and action policy with fake adapters and source contracts | OpenRouter precedes Gemini, failover stops after any tool execution, raw provider errors are hidden, requests are bounded, cost-bearing actions are excluded from chat, and local contact/task writes are workspace-scoped | A funded provider, deployed parity, successful production chat, provider cost, or any external action |
| Production deployment | Not proven for these hardening commits | Nothing | Live parity, enabled credentials, migration state, or worker state |
| Contact and commercial proof | No real email, SMS, prospect call, spend, conversion, or payment was performed in this proof | Guardrails remained intact | Interest, deliverability, conversion, or revenue |

Treat movement between these rows as separate approval gates. A green source
or local-database gate cannot be promoted into a deployed, provider, contact,
or commercial claim.

### Production connection checkpoint

On 2026-07-30, the read-only production preflight returned `ok: false`. Velvet
discovery, Velvet source export, prospect email, the prospect-email webhook,
the five-mailbox inbox-placement array, and the Velvet outcome callback were
all unavailable in the Railway production variable set. No acquisition
workspace alignment or email caps were established. The check changed no
variables, contacted no prospect, sent no provider request, and spent nothing.
This is a configuration blocker, not evidence that any production connection
is active.

## Data Path

```text
GET /api/prospecting/revenue-loop
  -> one read-only, workspace-scoped aggregate
  -> exact connection readiness without secret values
  -> one advisory next safe step
  -> NO approval, send, dial, spend, callback, or policy mutation
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
  -> human PREPARED message experiment
  -> email: full-operator ACTIVE only with the exact fresh PASS receipt
  -> call: full-operator ACTIVE after exact definition review
  -> deterministic 50/50 assignment stored in each immutable job payload
  -> protocol-matched SENT jobs + measured outcomes
  -> terminal-job gate + human CLOSED
  -> closed assigned-cohort evaluation
  -> CANDIDATE
  -> human APPROVED or REJECTED decision
  -> optional rendering of the exact approved strategy into one reviewed draft
  -> optional one-request learned segment, with a second SMIRK approval
  -> separate code/config release before automatic runtime policy changes
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

An email payload also contains the exact sender identity, commercial-message
disclosure, physical postal address, and opt-out instructions that will appear
in the approved content.
Approval requires recipient review, suppression review, and confirmation of
those three fields. A call brief requires recipient review, suppression and
do-not-call checks, a recipient-local calling-window check, and an explicit
manual-dial-only attestation. The attestations are stored with the approval.

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
the stored DNC, calling-window, manual-dial, recipient, and qualification
controls, and requires the exact `record-one-manual-call-v1` confirmation.
The direct `APPROVED -> SENT` transition is reserved for that call-only path.
The operator supplies a structured `manual:` proof reference.
The occurrence time must be after approval, before expiry, and no more than five
minutes in the future. An exact retry is idempotent; changed execution facts
under the same approval return `409`.

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
   two registered strategies and a fixed 50/50 allocation.
2. The immutable definition receives a SHA-256 hash. Activation requires that
   exact hash, an exact confirmation, and attestations that the content and
   deterministic assignment were reviewed and that no contact or spend was
   authorized.
3. While `ACTIVE`, SMIRK deterministically assigns each prospect to one arm
   from the experiment definition and prospect ID. The assignment receipt,
   definition hash, bucket, assigned strategy, actual strategy, and protocol
   status are stored inside the outreach job's immutable hashed payload.
4. One prospect can enroll only once per experiment. Replaying preparation
   returns the existing enrollment. A database uniqueness constraint enforces
   the same rule under concurrency.
5. The operator may still choose different or custom copy. That preserves
   human judgment, but the immutable receipt marks it off protocol.
6. The experiment cannot close while any enrolled job is `PREPARED`,
   `APPROVED`, or `SENDING`. Closure requires an exact definition hash plus
   attestations that enrollment stopped, every job is terminal, and the
   outcome window was reviewed.
7. Candidate evaluation requires `CLOSED`, re-verifies every job payload and
   assignment, rejects duplicate enrollment, and rejects any executed
   off-protocol job.

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
`studyDesign: deterministic-assignment-v1`; it is not described as a fully
randomized causal estimate because operators still choose which prospects to
enroll.

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
- one reviewed experiment definition produces stable per-prospect assignments;
- exact replay preserves the same enrollment and assignment receipt;
- executed off-protocol content blocks a message-learning candidate;
- active experiments cannot be evaluated and nonterminal jobs prevent closure;
- recipient-specific approval attestations and execution-window checks;
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
retain the canonical `replied` state with cross-workspace denial. The command
does not dial, send an external email or SMS, use a paid provider, write
production data, or deploy. Both disposable databases are dropped in `finally`,
including on a failed assertion.

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
6. Configure dedicated research credentials and run one synthetic import plus
   exact replay.
7. Create a dedicated Velvet `smirk:research` key, leave SMIRK source execution
   disabled, and verify configuration reporting.
8. With separate approval, enable the discovery and source clients and prove
   one no-contact quote, Velvet-side approve/queue, bounded synthetic discovery,
   terminal status, exact discovery-bound reviewed pull, and changed-provenance
   rejection. Disable the discovery worker again.
9. With separate approval, prove one synthetic
   `EXPORTED` plus `DUPLICATE`, one `EMPTY`, one forged-hash rejection, one
   uncertain replay, and one partial-import recovery. Disable it again.
10. Verify hard-refresh queue persistence and absence of contact actions.
11. Prepare, preview, approve, reject, cancel, and expire synthetic jobs.
12. Verify the commercial disclosure, footer, channel-specific attestations,
    one-recipient cap, spend cap, suppression, and idempotency behavior.
13. Configure a dedicated prospect Resend key and signed webhook only for a
    synthetic gate. Prove provider acceptance, `delivered`, exact replay,
    forged-signature rejection, and suppression behavior.
14. Configure callback secrets, enable dispatch only for the synthetic gate,
    and prove `RECORDED` plus `DUPLICATE`.
15. Confirm the same external event ID with changed bytes returns `409`.
16. Disable discovery, source, email execution, and callback dispatch again
    until real
    outreach receives separate approval.

No bulk execution, automated phone spam, paid search, or cold SMS is part of
this activation plan.
