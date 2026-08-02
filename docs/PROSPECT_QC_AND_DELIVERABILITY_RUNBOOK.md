# Prospect QC And Inbox-Placement Runbook

## Status

Implemented locally:

- deterministic, evidence-bound QC runs before a new outreach job can enter
  the approval ledger;
- a deterministic failure is stored in the separate immutable QC revision
  ledger as `REVISION_REQUIRED`; it receives no approval ID, model-review
  authority, provider route, contact authority, or execution authority;
- exact failed-draft replay returns the existing revision receipt. An operator
  may load its exact copy into the editor, reject it with a single-use audited
  action, or prepare changed copy. A passing replacement supersedes open
  revisions only after the approval-ledger row is durably created;
- the QC receipt is stored inside the immutable outreach payload and therefore
  covered by the payload hash;
- research-evidence receipts recursively canonicalize object keys before
  hashing, so a Postgres `JSONB` round trip cannot make unchanged evidence look
  modified during advisory review;
- the receipt schema requires exactly one result for every registered rule and
  recomputes the receipt ID from the rule version, draft hash, evidence hash,
  and evaluation time;
- the operator dashboard shows the receipt;
- receipt-less historical jobs remain readable for analytics but cannot be
  newly approved or executed;
- an optional one-draft OpenRouter adapter requests strict structured output
  only after deterministic QC passes and a durable cost reservation exists;
- each advisory result is stored in a separate immutable receipt, bound to the
  workspace, approval ID, payload, draft, evidence, provider, model, and cost;
- provider uncertainty is terminal for automatic replay. A retry requires a
  newly reviewed draft or other explicit corrective action;
- the operator dashboard requires a separate one-draft confirmation before
  the model request and still requires human approval afterward;
- three transparent, no-link micro email strategies are registered;
- Resend receives `text` only. The prospect provider request contains no HTML,
  tracking pixel, CC, BCC, SMS, or call instruction;
- a durable five-inbox gate prepares hidden seed jobs, records immutable
  per-message inspections, and issues a seven-day PASS or FAIL receipt;
- email experiment activation requires a fresh PASS receipt for the same
  workspace, campaign, control strategy, and challenger strategy;
- the revenue-loop controller distinguishes that exact match from unrelated
  workspace PASS records and does not advertise activation readiness until the
  prepared campaign and both strategies match;
- the revenue-loop controller exposes mandatory advisory-QC and signed email
  webhook readiness as separate fail-closed connections. Exact inbound reply
  retrieval is a third connection. The controller will not point an
  operator toward draft review when required QC is unavailable, or toward a
  new email send when signed delivery measurement or provider-backed reply
  content review is unavailable;
- the controller counts open QC revisions and points the operator to the exact
  workspace-scoped receipt before it proposes more outreach preparation;
- the provider execution route independently enforces the signed webhook for a
  newly approved email. An already `SENDING` request remains eligible only for
  same-key reconciliation so an uncertain external result is not abandoned;
- active experiments are advertised as closure-ready only when the frozen
  cohort is exactly enrolled and no assigned job remains PREPARED, APPROVED,
  or SENDING; the closure route independently rechecks the same boundary;
- mutable operator actions may carry a tenant-scoped ID-only pointer to the
  exact prospect, approval job, positive-interaction review, learning
  candidate, Velvet callback, source/discovery request, or message experiment;
  the dashboard opens and highlights that persisted record without changing
  state;
- the controller and dashboard label a message winner as releasable only when
  its closed experiment, definition hash, registry, strategy attribution, and
  zero-deviation/sample evidence satisfy the stored recommendation-eligibility
  predicate; the policy route still independently revalidates the full schema
  and immutable definition before release, and legacy or sample-drifted
  approvals cannot strand the loop or expose a false release action;
- seed jobs are excluded from normal prospect lists and blocked at the outcome
  write boundary: signed seed delivery/reply facts remain provider receipts but
  cannot change prospect state, enter market learning, or prepare a Velvet
  callback;
- every signed inbound email creates one immutable classification review and
  pauses scheduled acquisition before any reply outcome is recorded. A full
  operator must invoke one bounded, dedicated-key Resend GET from SMIRK. The
  route verifies the immutable provider ID, sender, receiver, workspace, and
  plain-text limit; stores plain text plus a content receipt; and discards
  HTML, raw MIME, headers, and attachments. Exact replay performs no second
  provider read. The operator then binds the receipt to an immutable outreach
  candidate when applicable and classifies it as reply, verified opt-out, or
  not actionable. Verified opt-outs always create suppression;
  only an exactly matched outreach record can also receive a DNC outcome. This
  resolution path never sends or follows up;
- a human-classified reply, qualified response, booked demo, or conversion
  creates one immutable positive-outcome review item and keeps scheduled
  acquisition paused;
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

- the local advisory provider path is wired but no production key, enablement,
  spend approval, deployment, or live model call is established by this
  runbook;
- no seed email has been sent;
- no real-prospect experiment has been activated;
- no outreach, dialing, provider spend, or production deployment is authorized
  by this runbook.

## Authority Boundary

```text
Velvet evidence
  -> writer or registered strategy
  -> deterministic QC
       -> FAIL: immutable revision receipt -> human revise or reject
       -> PASS: continue
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

## QC Revision Ledger

`prospect_qc_revision_items` is deliberately separate from
`prospect_outreach_jobs`. A failed draft therefore cannot accidentally satisfy
an approval, send, experiment-enrollment, or provider query. Its states are:

- `REVISION_REQUIRED`: exact draft and receipt await human correction or
  rejection;
- `REJECTED`: an operator rejected the exact payload hash with a recorded
  actor, reason, and timestamp;
- `SUPERSEDED`: a changed draft passed deterministic QC and produced a normal
  `PREPARED` approval-ledger job.

Every transition appends `prospect_qc_revision_events`. Rejection is
workspace-scoped, bound to an opaque revision ID and payload hash, reports
success only after one expected row changes, and treats only the exact same
actor/reason replay as idempotent. Full and spend-restricted demo operators
receive distinct audit labels bound to a non-secret operator-key fingerprint.
The revision module contains no network, email, SMS, or dialing adapter.

Local UI proof uses only synthetic browser data. Start the built preview at
`http://127.0.0.1:4180`, then run
`npm run -s check:prospect-qc-revision-ui`. The Playwright check captures
desktop and mobile receipts in `output/ui-proof/`, verifies the failed rule is
visible, and fails if an approve or send button exists inside the revision
card. It also captures `prospect-inbound-reply-desktop.png` and
`prospect-inbound-reply-mobile.png`, verifies classification begins locked,
performs exactly one intercepted content-retrieval request, confirms the
provider-backed text becomes visible, and rejects browser errors or horizontal
overflow.

## Deterministic Rules

The current rule version checks:

1. unresolved template placeholders;
2. prohibited or unsupported business-outcome claims;
3. public-site observations against the reviewed evidence excerpt;
4. obvious cross-industry copy mismatch;
5. blocked spam phrases, excessive exclamation marks, and excessive all-caps
   wording;
6. at most one link for general drafts and zero links for touch-one micro
   strategies, including bare `www.` addresses;
7. no HTML tags, embedded data images, Markdown images, or tracking-style
   links in email copy;
8. SMIRK identification and a 30-word body ceiling for registered micro
   strategies;
9. sender identity, commercial disclosure, postal address, and opt-out text for
   email;
10. preservation of the human approval and manual-call boundaries.

The receipt also verifies the current advisory prompt hash. A receipt from an
older rule version, a missing or duplicate rule result, a forged receipt ID, or
a changed prompt hash fails parsing before approval or execution.

DNC status and recipient-local calling time are volatile. Draft-time QC does
not claim they passed. Call approval requires fresh operator evidence for
federal, state, and internal DNC scopes plus the recipient's IANA timezone. The
server creates a hash-bound receipt that expires after at most 24 hours and
still does not authorize contact. Before recording a completed manual call,
SMIRK revalidates that receipt and enforces the fixed 09:00-17:00
recipient-local window. The operator remains responsible for rechecking any
volatile fact before dialing outside SMIRK.

## Advisory Model Review

The advisory review is a separate, explicit action for one `PREPARED` draft:

```text
POST /api/prospecting/outreach/:approvalId/qc-model-review
confirmation=review-one-prospect-draft-with-advisory-model-v1
```

The route is full-operator-only and runs in this order:

1. verify the exact opaque approval ID and payload hash;
2. re-parse the immutable payload and deterministic QC receipt;
3. re-hash the reviewed evidence;
4. stop before provider spend if any deterministic rule failed;
5. acquire the workspace mutation lock;
6. enforce rolling review-count and reserved-spend caps;
7. persist `SENDING` with the exact request hash before network access;
8. make at most one bounded provider request;
9. persist `COMPLETED`, `DEFINITIVE_FAILURE`, or `OUTCOME_UNKNOWN`;
10. reject automatic replay unless the exact prior result is already
    `COMPLETED`.

Configuration is default-disabled:

```text
PROSPECT_QC_MODEL_REVIEW_ENABLED=false
PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL=false
PROSPECT_QC_MODEL_REVIEW_MODE=single-draft-advisory-v1
PROSPECT_QC_OPENROUTER_API_KEY=<dedicated key>
PROSPECT_QC_OPENROUTER_MODEL=google/gemini-2.5-flash
PROSPECT_QC_MODEL_WORKSPACE_ID=<exact workspace>
PROSPECT_QC_MODEL_DAILY_REVIEW_CAP=1
PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS=1
PROSPECT_QC_MODEL_RESERVED_COST_CENTS=1
PROSPECT_QC_MODEL_TIMEOUT_MS=5000
```

The dedicated key must differ from the general `OPENROUTER_API_KEY`. The model
is restricted to the reviewed Gemini Flash allowlist. OpenRouter documents
strict JSON-schema responses through `response_format` and reports token/cost
usage on non-streaming responses; the implementation requests strict schema
support with `provider.require_parameters=true` and stores the returned usage
only as provider-reported accounting:

- <https://openrouter.ai/docs/guides/features/structured-outputs>
- <https://openrouter.ai/docs/cookbook/administration/usage-accounting>

`PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL=true` is fail closed. The exact
draft cannot be approved unless the provider configuration is ready for the
same workspace and a valid `COMPLETED` receipt exists. With the flag false,
deterministic-only approval remains available. Any completed `FLAGGED` or
`ERROR` receipt still requires the operator to acknowledge the advisory flags.

Approval stores the advisory review ID and receipt hash on the outreach job.
Email execution and manual-call proof recording re-verify that same receipt
before accepting the approved action. The model never receives recipient send
authority, tools, dialing capability, or a bulk route.

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
   are terminal, every sent job has a measured outcome, and the enforced
   observation window has elapsed (seven days after the last email or three
   days after the last manual call).
5. Require every assigned prospect in both arms to have one executed,
   protocol-matched job with a measured outcome. Both arms therefore have at
   least 10 samples. Then require positive challenger lift and the exact
   one-sided Fisher confidence gate (`p <= 0.05`). Store cohort coverage, the
   test name, p-value, and threshold in the immutable recommendation evidence.
6. Human-review the resulting recommendation.
7. Test the approved winner versus Micro C in a new immutable experiment.

The operator defaults enforce that sequence. Before any policy release, new
email drafts, inbox-placement tests, and experiments start with Micro A, with
Micro B as the preferred challenger. After a reviewed winner is released, that
winner becomes the required control and the measured prior control is skipped,
making Micro C the preferred next challenger. Registered long-form variants
remain available for deliberate operator selection.

This removes post-preparation cherry-picking of who enters the measured
cohort. It does not turn the result into a population-wide market estimate:
qualification remains a human safety decision before the cohort is frozen.
After assignment, rejecting or cancelling a recipient is always allowed and
never pressures contact, but the resulting attrition makes that experiment
ineligible to promote a message winner.

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

The revenue-loop controller treats the open test as a first-class workflow. It
points to one exact seed for review, one separately confirmed controlled-email
request, uncertain-provider reconciliation, one mailbox inspection, or final
receipt review. It does not describe the five-email test as one action. The
only controller transition with an external effect reports
`one_controlled_seed_email`; every preparation, inspection, and finalization
transition reports no external effect.

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

The pause is also enforced at direct route boundaries. While any review is
`PENDING`, SMIRK rejects new Velvet discovery/source preparation and approval,
new direct Velvet research imports, legacy campaign creation or activation,
manual lead imports, new experiment preparation/activation/draft
generation/closure, new outreach preparation or approval, first-time email
execution, first-time Velvet outcome dispatch, and learning
candidate/decision/policy-release actions. This prevents an operator,
integration, or alternate client from bypassing the scheduler.

Safety and truth-preserving actions remain available during the pause:

- record provider or operator outcomes;
- acknowledge the exact positive interaction;
- reject or cancel prepared outreach;
- cancel an experiment or Velvet request;
- roll back an already released message policy;
- record a manual action that already happened; and
- reconcile an already `SENDING` provider, Velvet callback, discovery, or
  source request with the same idempotency key.

An exact replay of an already imported Velvet research payload remains
available and returns `DUPLICATE`; it is reconciliation, not new acquisition.
Campaign pause/completion transitions also remain available. A new direct
research payload, campaign, activation, or lead import remains blocked.

If the pause query fails, acquisition fails closed with
`PROSPECT_ACQUISITION_PAUSE_UNAVAILABLE`; a storage error cannot silently
resume the loop.

The middleware read is an early rejection only. The authoritative check runs
inside each mutation transaction while holding one shared, workspace-scoped
PostgreSQL advisory transaction lock. Positive-outcome creation and
acknowledgment use the same lock before taking row locks, and schema-time
historical review backfill takes it before inserting each missing review.
Stateful dispatch paths take it before loading their job or request, then count
pending reviews only for first execution; an already `SENDING` record may still reconcile.
This lock order prevents a positive interaction from committing between the
pause check and a new mutation, and avoids row-lock/advisory-lock inversion.
`npm run -s check:prospect-message-experiments:persistence` proves the race
against disposable PostgreSQL: the guarded transaction waits, observes the
committed review, and returns the pause without network, contact, or spend.

## Pending Advisory Model Activation

The structured model contract, provider adapter, durable reservation, receipt
table, approval binding, and operator UI now exist on the hardening branch, but
no live QC call is active. `npm run -s check:velvet-smirk:persistence` proves
the actual route and Postgres path with a trapped OpenRouter adapter: one
synthetic call brief and one synthetic email each receive a required immutable
receipt, exact replay performs no second provider request, changed receipt
bindings block both execution paths, and both disposable databases are removed.

Production activation still requires a separate deploy and configuration
approval packet containing:

- dedicated provider key and model name;
- one-draft-only execution mode;
- explicit operator confirmation;
- per-audit and daily cost caps;
- timeout and response-size limits;
- no tools and no contact-provider access;
- immutable prospect evidence and draft hashes;
- provider, model, request hash, response hash, latency, reserved cost, and
  provider-reported usage in the receipt;
- fail-closed behavior for quota exhaustion, timeout, malformed JSON, and
  provider errors.

The production screenshot showing Gemini `429 RESOURCE_EXHAUSTED` remains
evidence that the old dashboard-chat provider is unfunded. It is not a blocker
to this dedicated OpenRouter QC adapter, but funding and enabling the dedicated
key remains a separate configuration and spend decision that cannot weaken the
deterministic or human approval gates.

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
12. Close only after terminal jobs, a measured outcome for every sent job,
    and the server-enforced observation window. The closure receipt must show
    the latest send, window end, review time, and measured-job count.
13. Stop on any positive interaction and record one exact human review receipt.
14. Resume only after the pending review count returns to zero.
15. Promote nothing without the existing closed-cohort evidence gate.
