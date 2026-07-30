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
  tracking pixel, CC, BCC, SMS, or call instruction.

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

The current causal engine is intentionally two-arm with deterministic 50/50
assignment. A `50/50/50` experiment is not a valid allocation and is not
supported.

Use sequential champion-versus-challenger tests:

1. Micro A versus Micro B.
2. Close the cohort only after all enrolled jobs are terminal and the outcome
   window is reviewed.
3. Require at least 10 measured, protocol-matched prospects per arm and
   positive challenger lift.
4. Human-review the resulting recommendation.
5. Test the approved winner versus Micro C in a new immutable experiment.

Do not use opens as the primary outcome. The provider intentionally has no
tracking pixel, and mailbox privacy features make open data unreliable. Primary
market outcomes are reply, qualified reply, demo booked, and conversion.

## Controlled Inbox-Placement Gate

Server acceptance and a low bounce rate do not establish inbox placement.
Before another real-prospect cohort, use only addresses controlled by Cameron
or explicitly authorized testers:

- two Google or Google Workspace mailboxes;
- two Microsoft or Microsoft 365 mailboxes;
- one Yahoo or AOL mailbox.

No seed send may run without explicit approval for that exact five-recipient
test.

For each seed address, record:

| Field | Required value |
| --- | --- |
| seed address label | non-secret label, not the address in tracked artifacts |
| provider | Google, Microsoft, Yahoo, or AOL |
| strategy key | exact registered variant key |
| approval ID | exact SMIRK approval UUID |
| payload hash | exact immutable payload hash |
| provider message ID | Resend message ID |
| provider acceptance | accepted or rejected |
| folder | primary/inbox, promotions/other, spam/junk, or missing |
| SPF | pass, fail, or unavailable |
| DKIM | pass, fail, or unavailable |
| DMARC | pass, fail, or unavailable |
| From alignment | aligned or not aligned |
| visible footer | clean or defective |
| inspected at | timestamp |
| inspected by | operator identity |

Inspect authentication from each message's raw headers. Do not infer SPF, DKIM,
DMARC, or folder placement from a Resend `200` response.

## Seed Acceptance

The seed gate passes only when:

- all five messages used the exact production-equivalent plain-text path;
- all five have a recorded folder result;
- Google and Microsoft each have at least one message in the normal inbox;
- SPF, DKIM, and DMARC pass and align on every received seed;
- the compliance footer is visible and clean;
- no tracking pixel, hidden HTML, or unexpected link is present;
- no seed address is suppressed or bounced;
- one operator records the exact evidence.

If the gate fails:

- pause real-prospect sends;
- do not rewrite copy based only on a folder-placement defect;
- repair DNS, sender reputation, mailbox configuration, or provider setup;
- repeat a newly approved controlled seed test.

Passing five seeds is useful evidence, not a guarantee that every prospect will
receive mail in the primary inbox.

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
3. Prepare five recipient-specific seed drafts.
4. Review and approve each seed payload.
5. Obtain exact approval to send those five controlled messages.
6. Record folder and authentication evidence.
7. Prepare one two-arm micro experiment.
8. Review and approve real recipients one at a time.
9. Close only after terminal jobs and an observed outcome window.
10. Promote nothing without the existing closed-cohort evidence gate.
