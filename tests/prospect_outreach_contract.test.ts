import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectOutreachPayload,
  canTransitionProspectOutreach,
  hashProspectEvidence,
  hashProspectOutreachPayload,
  isExactRecordedExecutionReplay,
  isExactProspectOutcomeReplay,
  isValidExecutionProofReference,
  normalizeProspectOutreachRecipient,
  outcomeToProspectStatus,
  assertProspectOutcomeMatchesChannel,
  assertRecordedExecutionWindow,
  assertProspectOutreachApprovalAttestations,
  prepareProspectOutreachSchema,
  prospectOutreachApprovalSchema,
  prospectOutreachPayloadSchema,
  selectCanonicalProspectOutcomeEvent,
} from "../src/prospect-outreach.ts";

const evidenceHash = "a".repeat(64);

test("binds outreach to the exact non-empty research evidence array", () => {
  const evidence = [
    {
      url: "https://example.com/",
      observation: "The public website includes a contact path.",
      kind: "contact_path",
      basis: "observed",
      confidence: "high",
    },
  ];
  const hash = hashProspectEvidence(evidence);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hashProspectEvidence(evidence), hash);
  assert.equal(
    hashProspectEvidence([
      {
        confidence: "high",
        basis: "observed",
        kind: "contact_path",
        observation: "The public website includes a contact path.",
        url: "https://example.com/",
      },
    ]),
    hash,
    "JSONB key reordering must not change the evidence receipt"
  );
  assert.notEqual(
    hashProspectEvidence([
      { ...evidence[0], observation: "The observation changed." },
    ]),
    hash
  );
  assert.throws(() => hashProspectEvidence([]));
});

test("builds an immutable recipient-specific email approval payload", () => {
  const payload = buildProspectOutreachPayload({
    workspaceId: 1,
    campaignId: 2,
    prospectId: 3,
    recipient: "OWNER@EXAMPLE.COM",
    evidenceHash,
    preparedAt: "2026-07-30T16:00:00.000Z",
    qcContext: {
      businessName: "Synthetic Plumbing",
      industry: "plumbing",
      evidenceObservation:
        "a possible mobile booking issue that may be creating friction.",
    },
    draft: {
      channel: "email",
      subject: "Capturing urgent plumbing calls",
      body:
        "I noticed a possible mobile booking issue that may be creating friction. Would a review-only proof call be useful?",
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure:
          "This is a commercial message from SMIRK.",
        physicalPostalAddress: "100 Example Way, Reno, NV 89501",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      maxCostCents: 2,
      expiresInHours: 24,
    },
  });

  assert.equal(payload.recipient, "owner@example.com");
  assert.equal(payload.controls.smsAllowed, false);
  assert.equal(payload.controls.bulkExecution, false);
  assert.equal(
    payload.controls.providerExecution,
    "operator-triggered-single-recipient"
  );
  assert.equal(payload.controls.compliance.channel, "email");
  assert.match(payload.content, /commercial message/i);
  assert.match(payload.content, /100 Example Way/);
  assert.match(payload.content, /reply no/i);
  assert.match(hashProspectOutreachPayload(payload), /^[a-f0-9]{64}$/);
  assert.equal(
    prospectOutreachPayloadSchema.safeParse({
      ...payload,
      subject: "Changed after QC",
    }).success,
    false
  );
  assert.equal(
    prospectOutreachPayloadSchema.safeParse({
      ...payload,
      evidenceHash: "b".repeat(64),
    }).success,
    false
  );
});

test("supports only email and call, never SMS", () => {
  const result = prepareProspectOutreachSchema.safeParse({
    channel: "sms",
    body: "Synthetic SMS draft that must never be accepted.",
  });
  assert.equal(result.success, false);
});

test("rejects unsupported outcome claims", () => {
  const result = prepareProspectOutreachSchema.safeParse({
    channel: "email",
    subject: "Your website",
    body:
      "Your critical revenue leaks are costing you and you are losing money every day.",
    emailCompliance: {
      senderIdentity: "SMIRK",
      advertisementDisclosure:
        "This is a commercial message from SMIRK.",
      physicalPostalAddress: "100 Example Way, Reno, NV 89501",
      optOutInstructions:
        "If this is not relevant, reply no and I will not follow up.",
    },
    maxCostCents: 2,
    expiresInHours: 24,
  });
  assert.equal(result.success, false);
});

test("approval requires channel-specific compliance attestations", () => {
  const emailApproval = prospectOutreachApprovalSchema.parse({
    payloadHash: "b".repeat(64),
    attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      emailComplianceReviewed: true,
    },
  });
  assert.doesNotThrow(() =>
    assertProspectOutreachApprovalAttestations("email", emailApproval)
  );

  const incompleteCallApproval = prospectOutreachApprovalSchema.parse({
    payloadHash: "b".repeat(64),
    attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      doNotCallChecked: true,
    },
  });
  assert.throws(() =>
    assertProspectOutreachApprovalAttestations(
      "call",
      incompleteCallApproval
    )
  );
});

test("normalizes email and phone recipients without guessing ambiguous phones", () => {
  assert.equal(
    normalizeProspectOutreachRecipient("email", "Owner@Example.com"),
    "owner@example.com"
  );
  assert.equal(
    normalizeProspectOutreachRecipient("call", "(775) 555-0142"),
    "+17755550142"
  );
  assert.throws(() =>
    normalizeProspectOutreachRecipient("call", "555-0142")
  );
});

test("approval states are explicit and terminal states cannot replay", () => {
  assert.equal(
    canTransitionProspectOutreach("PREPARED", "APPROVED"),
    true
  );
  assert.equal(canTransitionProspectOutreach("APPROVED", "SENDING"), true);
  assert.equal(canTransitionProspectOutreach("APPROVED", "SENT"), true);
  assert.equal(canTransitionProspectOutreach("SENDING", "SENT"), true);
  assert.equal(canTransitionProspectOutreach("SENT", "SENDING"), false);
  assert.equal(canTransitionProspectOutreach("REJECTED", "APPROVED"), false);
});

test("manual execution proof must fall inside the approved window", () => {
  assert.doesNotThrow(() =>
    assertRecordedExecutionWindow({
      approvedAt: "2026-07-30T16:00:00.000Z",
      occurredAt: "2026-07-30T16:05:00.000Z",
      expiresAt: "2026-07-30T17:00:00.000Z",
      now: new Date("2026-07-30T16:06:00.000Z"),
    })
  );
  assert.throws(() =>
    assertRecordedExecutionWindow({
      approvedAt: "2026-07-30T16:00:00.000Z",
      occurredAt: "2026-07-30T15:59:59.000Z",
      expiresAt: "2026-07-30T17:00:00.000Z",
      now: new Date("2026-07-30T16:06:00.000Z"),
    })
  );
  assert.throws(() =>
    assertRecordedExecutionWindow({
      approvedAt: "2026-07-30T16:00:00.000Z",
      occurredAt: "2026-07-30T17:00:01.000Z",
      expiresAt: "2026-07-30T17:00:00.000Z",
      now: new Date("2026-07-30T17:01:00.000Z"),
    })
  );
});

test("manual execution records require structured proof and exact replay facts", () => {
  assert.equal(
    isValidExecutionProofReference("manual:gmail-sent-message-id"),
    true
  );
  assert.equal(isValidExecutionProofReference("sent it"), false);
  assert.equal(
    isExactRecordedExecutionReplay(
      {
        sentAt: new Date("2026-07-30T16:05:00.000Z"),
        proofReference: "manual:gmail-sent-message-id",
      },
      {
        occurredAt: "2026-07-30T16:05:00.000Z",
        proofReference: "manual:gmail-sent-message-id",
      }
    ),
    true
  );
  assert.equal(
    isExactRecordedExecutionReplay(
      {
        sentAt: new Date("2026-07-30T16:05:00.000Z"),
        proofReference: "manual:gmail-sent-message-id",
      },
      {
        occurredAt: "2026-07-30T16:06:00.000Z",
        proofReference: "manual:changed-proof-reference",
      }
    ),
    false
  );
});

test("outcomes map to persisted prospect states without inventing conversion", () => {
  assert.equal(outcomeToProspectStatus("delivered"), "contacted");
  assert.equal(outcomeToProspectStatus("demo_booked"), "interested");
  assert.equal(outcomeToProspectStatus("converted"), "converted");
  assert.equal(outcomeToProspectStatus("bounced"), "pending");
});

test("canonical prospect outcome is stable when provider facts arrive out of order", () => {
  const events = [
    {
      externalEventId: "event-reply-0001",
      outcome: "replied" as const,
      occurredAt: "2026-07-30T16:02:00.000Z",
    },
    {
      externalEventId: "event-delivery-0001",
      outcome: "delivered" as const,
      occurredAt: "2026-07-30T16:01:00.000Z",
    },
  ];
  assert.deepEqual(
    selectCanonicalProspectOutcomeEvent(events),
    events[0]
  );
  assert.deepEqual(
    selectCanonicalProspectOutcomeEvent([...events].reverse()),
    events[0]
  );
  assert.equal(
    selectCanonicalProspectOutcomeEvent([
      ...events,
      {
        externalEventId: "event-dnc-0001",
        outcome: "dnc" as const,
        occurredAt: "2026-07-30T15:59:00.000Z",
      },
      {
        externalEventId: "event-converted-after-dnc-0001",
        outcome: "converted" as const,
        occurredAt: "2026-07-30T16:05:00.000Z",
      },
    ]).outcome,
    "dnc"
  );
  assert.throws(
    () => selectCanonicalProspectOutcomeEvent([]),
    /At least one prospect outcome event is required/
  );
});

test("outcomes must match the approved outreach channel", () => {
  assert.doesNotThrow(() =>
    assertProspectOutcomeMatchesChannel("email", "replied")
  );
  assert.doesNotThrow(() =>
    assertProspectOutcomeMatchesChannel("call", "call_connected")
  );
  assert.throws(() =>
    assertProspectOutcomeMatchesChannel("email", "call_connected")
  );
  assert.throws(() =>
    assertProspectOutcomeMatchesChannel("call", "bounced")
  );
});

test("idempotent outcome replay requires the same durable facts", () => {
  const stored = {
    lead_id: 3,
    outreach_job_id: 9,
    outcome: "replied",
    occurred_at: new Date("2026-07-30T16:00:00.000Z"),
    notes: "Asked for a demo",
  };
  assert.equal(
    isExactProspectOutcomeReplay(stored, {
      leadId: 3,
      outreachJobId: 9,
      outcome: "replied",
      occurredAt: "2026-07-30T16:00:00.000Z",
      notes: "Asked for a demo",
    }),
    true
  );
  assert.equal(
    isExactProspectOutcomeReplay(stored, {
      leadId: 3,
      outreachJobId: 9,
      outcome: "converted",
      occurredAt: "2026-07-30T16:00:00.000Z",
      notes: "Asked for a demo",
    }),
    false
  );
});
