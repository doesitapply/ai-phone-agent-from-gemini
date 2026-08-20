import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
  acknowledgeProspectPositiveOutcomeSchema,
  buildProspectPositiveOutcomeAcknowledgmentReceipt,
  buildProspectPositiveOutcomeReviewPayload,
  hashProspectPositiveOutcomeAcknowledgmentReceipt,
  hashProspectPositiveOutcomeAcknowledgmentRequest,
  hashProspectPositiveOutcomeReviewPayload,
  isPositiveProspectOutcome,
} from "../src/prospect-positive-outcome-review.ts";

const reviewId = "11111111-1111-4111-8111-111111111111";

function acknowledgment() {
  return acknowledgeProspectPositiveOutcomeSchema.parse({
    payloadHash: "a".repeat(64),
    confirmation:
      PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION,
    resolution: "continue_guarded_loop",
    notes: "Reviewed the synthetic reply.",
    attestations: {
      interactionReviewed: true,
      noContactExecutedByAcknowledgment: true,
      followUpRemainsSeparate: true,
    },
  });
}

test("only measured market interactions enter the positive review queue", () => {
  for (const outcome of [
    "replied",
    "qualified",
    "demo_booked",
    "converted",
  ]) {
    assert.equal(isPositiveProspectOutcome(outcome), true);
  }
  for (const outcome of [
    "delivered",
    "bounced",
    "not_interested",
    "dnc",
    "no_answer",
  ]) {
    assert.equal(isPositiveProspectOutcome(outcome), false);
  }
});

test("positive review payloads are exact, immutable, and hash-bound", () => {
  const payload = buildProspectPositiveOutcomeReviewPayload({
    reviewId,
    workspaceId: 7,
    campaignId: 2,
    prospectId: 3,
    businessName: "Synthetic Plumbing",
    outreachJobId: 4,
    outreachApprovalId:
      "22222222-2222-4222-8222-222222222222",
    channel: "email",
    outcomeEventId: 5,
    outcome: "replied",
    eventSource: "resend_webhook",
    externalEventId: "synthetic-reply-1",
    occurredAt: "2026-07-30T18:00:00.000Z",
    recordedBy: "synthetic_operator",
    notes: "  Interested in a demo.  ",
  });
  const hash = hashProspectPositiveOutcomeReviewPayload(payload);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(payload.notes, "Interested in a demo.");
  assert.notEqual(
    hash,
    hashProspectPositiveOutcomeReviewPayload({
      ...payload,
      outcome: "qualified",
    })
  );
});

test("acknowledgments require all no-execution attestations", () => {
  const valid = acknowledgment();
  assert.equal(
    acknowledgeProspectPositiveOutcomeSchema.safeParse(valid).success,
    true
  );
  assert.equal(
    acknowledgeProspectPositiveOutcomeSchema.safeParse({
      ...valid,
      attestations: {
        ...valid.attestations,
        noContactExecutedByAcknowledgment: false,
      },
    }).success,
    false
  );
  assert.equal(
    acknowledgeProspectPositiveOutcomeSchema.safeParse({
      ...valid,
      confirmation: "send-the-next-email",
    }).success,
    false
  );
});

test("the durable receipt binds the exact request, actor, and time", () => {
  const input = acknowledgment();
  const receipt =
    buildProspectPositiveOutcomeAcknowledgmentReceipt({
      reviewId,
      acknowledgment: input,
      acknowledgedBy: "dashboard_operator:synthetic",
      acknowledgedAt: "2026-07-30T18:05:00.000Z",
    });
  assert.equal(
    receipt.requestHash,
    hashProspectPositiveOutcomeAcknowledgmentRequest(input)
  );
  assert.equal(receipt.acknowledgedBy, "dashboard_operator:synthetic");
  assert.match(
    hashProspectPositiveOutcomeAcknowledgmentReceipt(receipt),
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    Object.hasOwn(receipt, "contactAuthorized"),
    false
  );
});
