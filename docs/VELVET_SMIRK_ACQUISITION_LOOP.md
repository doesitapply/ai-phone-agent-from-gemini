# Velvet -> SMIRK Acquisition Loop

## Current Boundary

This document describes source code on the hardening branches. It does not
prove either branch is deployed or configured. No SMS, email, call, callback,
provider mutation, or production migration is authorized by this design.

The system separates five concerns:

1. Velvet discovers a public business and stores public-source evidence.
2. A full SMIRK operator prepares and separately approves one bounded pull of
   already-audited Velvet records, or a Velvet administrator exports one
   reviewed prospect directly.
3. A SMIRK operator qualifies or rejects that prospect.
4. SMIRK prepares one recipient-specific email or manual call job for human
   approval.
5. A full operator separately submits one approved email or records one manual
   call.
6. Signed delivery, bounce, complaint, suppression, and reply events become
   measured facts.
7. One operator-confirmed callback can return one fact to Velvet.
8. Recorded outcomes become evaluation data; proposed policy changes remain
   human-reviewed candidates.

Cold SMS is not a supported channel. Automated prospect calls are not a
supported path. Email and Velvet callback execution are disabled by default
and require dedicated credentials, workspace locks, immutable hashes, and a
separate full-operator action for each record.

## Data Path

```text
Velvet lead
  -> classified evidence (`observed`, `measured`, or `inferred`)
  -> SMIRK PREPARED source request (20 maximum, $0, no contact)
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
  -> channel/variant scorecard
  -> CANDIDATE
  -> human APPROVED or REJECTED decision
  -> optional one-request learned segment, with a second SMIRK approval
  -> separate code/config release before automatic runtime policy changes
```

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

Each approved draft carries a `variantKey`. SMIRK scores only outcomes linked
to an executed job. Positive events are:

- email: replied, qualified, demo booked, or converted;
- call: connected, qualified, demo booked, or converted.

A challenger needs at least 10 linked outcomes and the current variant needs at
least 10. A candidate is created only when the challenger has positive measured
lift. Marking a candidate `APPROVED` records a human decision but returns
`policyChanged: false`. A full SMIRK operator may explicitly select
`latest_approved` for one source request; Velvet then applies only that
candidate's category or metro and batch-size ceiling. The candidate cannot
alter prompts, default routing, spending, or provider execution. Automatic
policy changes still require a separate reviewed release.

This is the practical self-improvement loop:

```text
versioned input -> immutable action -> measured outcome -> offline comparison
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

The command imports the real Velvet research, reviewed-batch, outcome, and
acquisition-learning modules together with the real SMIRK source client,
intake, outreach, outcome, and variant-learning modules. It traps all network
access and uses reserved synthetic contact data. It proves:

- source-request and response contract/hash agreement;
- one approved acquisition candidate narrows one bounded request;
- no-contact, zero-spend source semantics;
- research payload and hash agreement;
- stable external identity and changed-payload detection;
- `201 IMPORTED` and `200 DUPLICATE` response mapping;
- exact source-evidence lineage into one email and one manual-call brief;
- recipient-specific approval attestations and execution-window checks;
- SMS, bulk execution, and automated dialing remain disabled;
- one-email and one-callback provider requests are trapped and validated
  without network access;
- outcome payload, canonical hash, HMAC signature, and receipt agreement;
- exact replay semantics; and
- measured variant and sourcing proposals that still require human review.

This is not a database, deployment, provider-delivery, or revenue proof. Those
remain separate activation gates below.

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
8. With separate approval, enable the source client and prove one synthetic
   `EXPORTED` plus `DUPLICATE`, one `EMPTY`, one forged-hash rejection, one
   uncertain replay, and one partial-import recovery. Disable it again.
9. Verify hard-refresh queue persistence and absence of contact actions.
10. Prepare, preview, approve, reject, cancel, and expire synthetic jobs.
11. Verify the commercial disclosure, footer, channel-specific attestations,
   one-recipient cap, spend cap, suppression, and idempotency behavior.
12. Configure a dedicated prospect Resend key and signed webhook only for a
   synthetic gate. Prove provider acceptance, `delivered`, exact replay,
   forged-signature rejection, and suppression behavior.
13. Configure callback secrets, enable dispatch only for the synthetic gate,
    and prove `RECORDED` plus `DUPLICATE`.
14. Confirm the same external event ID with changed bytes returns `409`.
15. Disable source, email execution, and callback dispatch again until real
    outreach receives separate approval.

No bulk execution, automated phone spam, paid search, or cold SMS is part of
this activation plan.
