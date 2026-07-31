# Prospect QC And Inbox-Placement Runbook

## Status

Implemented locally:

- deterministic, evidence-bound QC runs before a new outreach job can enter
  the approval ledger;
- the QC receipt is stored inside the immutable outreach payload and therefore
  covered by the payload hash;
- the operator dashboard shows the receipt;
- receipt-less historical jobs remain readable for analytics but cannot be
  newly approved or executed;
- advisory model output has a strict JSON parser and no execution authority;
- three transparent, no-link micro email strategies are registered;
- Resend receives `text` only. The prospect provider request contains no HTML,
  tracking pixel, CC, BCC, SMS, or call instruction;
- a durable five-inbox gate prepares hidden seed jobs, records immutable
  per-message inspections, and issues a seven-day PASS or FAIL receipt;
- email experiment activation requires a fresh PASS receipt for the same
  workspace, campaign, control strategy, and challenger strategy;
- seed jobs are excluded from normal prospect lists and blocked at the outcome
  write boundary: signed seed delivery/reply facts remain provider receipts but
  cannot change prospect state, enter market learning, or prepare a Velvet
  callback;
- a reply, qualified response, booked demo, or conversion creates one
  immutable positive-outcome review item and pauses scheduled acquisition;
- a full operator can clear that pause only by acknowledging the exact payload
  hash with a single-use receipt. The acknowledgment sends nothing, performs no
  follow-up, changes no policy, and makes no provider request.

Local synthetic browser proof:

- `output/ui-proof/prospect-inbox-placement-desktop-viewport.png`;
- `output/ui-proof/prospect-inbox-placement-actions-desktop.png`;
- `output/ui-proof/prospect-inbox-placement-mobile.png`;
- `output/ui-proof/prospect-inbox-placement-actions-mobile.png`.

These screenshots use intercepted synthetic API data. They prove the built UI
states and responsive layout only, not deployment, provider configuration, or
mailbox placement.

Not activated:

- no live LLM QC provider call is wired or enabled;
- no seed email has been sent;
- no real-prospect experiment has been activated;
- no outreach, dialing, provider spend, or production deployment is authorized
  by this runbook.

## Authority Boundary

```text
Velvet evidence
  -> writer or registered strategy
  -> deterministic QC
  -> optional advisory model review
  -> immutable QC receipt
  -> one-recipient human approval
  -> separate one-email send confirmation OR manual operator dial
  -> provider/manual outcome
  -> positive interaction pause
  -> exact full-operator review receipt
  -> deduplicated learning event
```

QC can produce only:

- `ELIGIBLE_FOR_HUMAN_APPROVAL`; or
- `REVISION_REQUIRED`.

QC always records:

- `humanApprovalRequired: true`;
- `contactAuthorized: false`;
- `executionAuthorized: false`;
- `automatedSendingAuthorized: false`;
- `automatedDialingAuthorized: false`.

An LLM result is `advisory-only`. A flagged or malformed advisory result raises
review priority and requires a separate operator acknowledgment. It cannot
override deterministic failure, approve a recipient, send an email, or dial a
number.

## Deterministic Rules

The current rule version checks:

1. unresolved template placeholders;
2. prohibited or unsupported business-outcome claims;
3. public-site observations against the reviewed evidence excerpt;
4. obvious cross-industry copy mismatch;
5. blocked spam phrases, excessive exclamation marks, and excessive all-caps
   wording;
6. at most one link for general drafts and zero links for touch-one micro
   strategies;
7. SMIRK identification and a 30-word body ceiling for registered micro
   strategies;
8. sender identity, commercial disclosure, postal address, and opt-out text for
   email;
9. preservation of the human approval and manual-call boundaries.

DNC status and recipient-local calling time are volatile. Draft-time QC does
not claim they passed. Call approval still requires DNC, calling-window, and
manual-dial attestations, and the operator must recheck them at the time of the
manual call.

## Registered Micro Strategies

All three identify SMIRK and contain no link.

### Micro A: After-Hours Coverage

Subject:

```text
after-hours call coverage
```

Body:

```text
Hi - Cameron with SMIRK. When after-hours calls come in, does someone answer, or do they reach voicemail?
```

### Micro B: Urgent-Call Workflow

Subject:

```text
urgent [resolved industry] calls
```

Body:

```text
Hi - Cameron with SMIRK. How does your team handle urgent after-hours [resolved industry] calls when everyone is already on a job?
```

### Micro C: Weekend Work

Subject:

```text
weekend [resolved industry] work
```

Body:

```text
Hi - Cameron with SMIRK. Are you currently taking emergency weekend [resolved industry] work, or only weekday calls?
```

The payload builder appends the reviewed commercial disclosure, sender
identity, physical postal address, and opt-out instructions after the body.
Those required fields are excluded from the micro-body word count but are never
removed from the delivered message.

## Experiment Design

The controlled engine is intentionally two-arm. Preparation snapshots the
untouched operator-qualified population, deterministically selects an even
20-200 prospect cohort, and binds exactly half to each arm. A `50/50/50`
experiment is not a valid allocation and is not supported.

Use sequential champion-versus-challenger tests:

1. Micro A versus Micro B.
2. Prepare the experiment only after enough untouched eligible prospects
   exist. Review its population hash, selected-prospect hash, and exact 50/50
   split before activation.
3. Use the frozen-cohort feeder to render and atomically prepare every assigned
   prospect as a recipient-specific review job. Any drift rolls back the whole
   preparation transaction. Prospects outside the cohort are rejected while it
   is active.
4. Close the cohort only after every selected prospect is enrolled, all jobs
   are terminal, and the outcome window is reviewed.
5. Require at least 10 measured, protocol-matched prospects per arm and
   positive challenger lift.
6. Human-review the resulting recommendation.
7. Test the approved winner versus Micro C in a new immutable experiment.

This removes post-preparation cherry-picking of who enters the cohort. It does
not turn the result into a fully randomized market estimate: qualification,
per-recipient approval, and execution remain human safety decisions, and any
resulting attrition must remain visible.

The feeder is not a bulk approval or execution route. It performs no provider
request, contact, dialing, or spend. Exact replay is idempotent. Every prepared
job still requires an individual human decision, and every approved email still
requires its own separate one-recipient execution confirmation. Calls remain
manual-dial only.

Do not use opens as the primary outcome. The provider intentionally has no
tracking pixel, and mailbox privacy features make open data unreliable. Primary
market outcomes are reply, qualified reply, demo booked, and conversion.

## Controlled Inbox-Placement Gate

Server acceptance and a low bounce rate do not establish inbox placement.
Before another real-prospect cohort, configure
`PROSPECT_INBOX_SEED_ALLOWLIST` with exactly five addresses controlled by
Cameron or explicitly authorized testers:

- two Google Workspace mailboxes;
- two Microsoft 365 mailboxes;
- one Yahoo or AOL mailbox.

The dashboard route `GET /api/prospecting/inbox-placement` returns configuration
status, masked recipients, exact stored copy, QC receipts, job states, provider
message IDs, inspections, and final receipts. It never returns the raw
allowlist.

`POST /api/prospecting/inbox-placement` requires:

- one target campaign;
- two different registered email strategies;
- the exact 2/2/1 provider mix;
- an exact hash match to the five-address environment allowlist;
- complete sender, disclosure, physical-address, and opt-out fields;
- the preparation confirmation and four no-contact/no-spend attestations.

Preparation creates five hidden `PREPARED` jobs using deterministic 3/2
strategy coverage. It makes no provider request and authorizes no contact or
spend.

Each seed then uses the ordinary single-recipient outreach state machine:

1. review exact masked recipient, subject, body, QC receipt, suppression
   status, sender, footer, and cost ceiling;
2. approve exactly one immutable payload;
3. separately confirm and send exactly one controlled email;
4. reconcile provider acceptance and message ID;
5. inspect that controlled mailbox and its raw headers;
6. record one immutable inspection.

There is no bulk approve, bulk send, or five-recipient execution route.
Deployment, allowlist configuration, test preparation, and draft approval are
not send authorization.

For each seed address, record:

| Field | Required value |
| --- | --- |
| seed address label | non-secret label, not the address in tracked artifacts |
| provider | Google, Microsoft, Yahoo, or AOL |
| strategy key | exact registered variant key |
| approval ID | exact SMIRK approval UUID |
| payload hash | exact immutable payload hash |
| provider message ID | Resend message ID |
| provider acceptance | accepted or not accepted |
| folder | primary, promotions, spam, junk, other, or missing |
| SPF | PASS, FAIL, or NOT_CHECKED |
| DKIM | PASS, FAIL, or NOT_CHECKED |
| DMARC | PASS, FAIL, or NOT_CHECKED |
| From alignment | aligned or not aligned |
| body format | plain text only or not |
| tracking pixel | absent or present |
| unexpected links | absent or present |
| visible footer | rendered cleanly or not |
| inspected at | timestamp |
| inspected by | operator identity |

Inspect authentication from each message's raw headers. Do not infer SPF, DKIM,
DMARC, or folder placement from a Resend `200` response.

Inspection requires the exact `SENT` job and matching provider message ID. A
second identical inspection is idempotent; a different replay is rejected.

## Seed Acceptance

The seed gate passes only when:

- all five messages used the exact production-equivalent plain-text path;
- all five have immutable inspections;
- all five are in the primary/default inbox;
- SPF, DKIM, and DMARC pass and align on every received seed;
- the compliance footer is visible and clean;
- no tracking pixel, hidden HTML, or unexpected link is present;
- every exact provider message ID matches the durable SENT job;
- one operator records the exact evidence.

An all-pass finalization creates a receipt valid for seven days. That receipt
authorizes only activation of an email experiment with the exact same
workspace, campaign, control strategy, and challenger strategy. It explicitly
records:

- `authorizesContact: false`;
- `authorizesSpend: false`;
- `authorizesAutomaticSending: false`.

If the gate fails:

- pause real-prospect sends;
- do not rewrite copy based only on a folder-placement defect;
- repair DNS, sender reputation, mailbox configuration, or provider setup;
- repeat a newly approved controlled seed test.

Passing five seeds is useful evidence, not a guarantee that every prospect will
receive mail in the primary inbox.

## Positive Interaction Pause And Resume

Positive outcomes are deliberately separate from historical reporting:

- `positiveOutcomeJobs` is the lifetime measured count;
- `unreviewedPositiveOutcomeJobs` is the current hard-stop count.

A signed reply or operator-recorded `qualified`, `demo_booked`, or `converted`
event creates one `PENDING` review row bound to the exact outcome event,
outreach job, recipient-specific approval UUID, workspace, prospect, payload,
and SHA-256 hash. Historical positive events missing a review row are
backfilled at schema initialization with a 10,000-row safety ceiling.

The dashboard lists the pending queue at
`GET /api/prospecting/positive-outcomes`. A storage failure renders a blocking
error and must never look like an empty queue.

Only a full operator may call
`POST /api/prospecting/positive-outcomes/:reviewId/acknowledge`. The request
requires:

- the opaque review UUID;
- the exact immutable payload hash;
- the exact acknowledgment confirmation;
- one review resolution and optional note;
- attestations that the interaction was reviewed, acknowledgment contacted no
  one, and any follow-up remains a separate action.

The acknowledgment records the operator-key fingerprint, timestamp, request
hash, receipt hash, resolution, and append-only audit event. Exact replay is
idempotent; a changed replay is rejected. It cannot send email, dial, dispatch
Velvet, spend, approve another job, or mutate learning policy.

After every pending positive interaction is acknowledged, the scheduled
checkpoint may resume. Lifetime outcomes remain in analytics and learning.

## Pending Advisory Model Activation

The structured model contract exists, but no live QC call is active. Activating
it requires a separate implementation and approval packet containing:

- dedicated provider key and model name;
- one-draft-only execution mode;
- explicit operator confirmation;
- per-audit and daily cost caps;
- timeout and response-size limits;
- no tools and no contact-provider access;
- immutable prospect evidence and draft hashes;
- provider, model, prompt hash, latency, and estimated cost in the receipt;
- fail-closed behavior for quota exhaustion, timeout, malformed JSON, and
  provider errors.

The production screenshot showing Gemini `429 RESOURCE_EXHAUSTED` is a current
blocker for a Gemini-backed QC adapter. Funding or replacing that provider is a
separate configuration decision and does not weaken the deterministic gate.

## Safe Next Sequence

1. Merge only after code review and deploy approval.
2. Configure no new provider until its key and spend cap are approved.
3. Configure the exact five-address allowlist without committing addresses.
4. Prepare five controlled seed drafts.
5. Review and approve each seed payload separately.
6. Obtain and execute one exact send confirmation per controlled seed.
7. Record folder and authentication evidence for each exact provider message.
8. Finalize the immutable PASS or FAIL receipt.
9. Prepare and activate one matching two-arm micro experiment only after PASS.
10. Prepare the exact frozen cohort into the review queue. This is a local
    no-contact transaction.
11. Review and approve real recipients one at a time.
12. Close only after terminal jobs and an observed outcome window.
13. Stop on any positive interaction and record one exact human review receipt.
14. Resume only after the pending review count returns to zero.
15. Promote nothing without the existing closed-cohort evidence gate.
