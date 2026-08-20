import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_INBOUND_REPLY_RESOLUTION_CONFIRMATION,
  buildProspectInboundReplyResolutionReceipt,
  buildProspectInboundReplyReviewPayload,
  hashProspectInboundReplyResolutionReceipt,
  hashProspectInboundReplyResolutionRequest,
  hashProspectInboundReplyReviewPayload,
  prospectInboundReplyResolutionReceiptSchema,
  resolveProspectInboundReplySchema,
} from "../src/prospect-inbound-reply-review.ts";

const payload = buildProspectInboundReplyReviewPayload({
  reviewId: "11111111-1111-4111-8111-111111111111",
  workspaceId: 7,
  providerEventId: "evt_inbound_reply_synthetic_0001",
  inboundMessageId: "email_inbound_synthetic_0001",
  webhookPayloadHash: "a".repeat(64),
  sender: " OWNER@EXAMPLE.COM ",
  occurredAt: "2026-08-02T16:00:00-07:00",
  candidates: [
    {
      outreachJobId: 9,
      outreachApprovalId: "22222222-2222-4222-8222-222222222222",
      prospectId: 23,
      businessName: "Synthetic Plumbing",
      sentAt: "2026-08-01T18:00:00.000Z",
    },
  ],
});

function request(
  resolution: "reply" | "opt_out" | "not_actionable"
) {
  return {
    payloadHash: hashProspectInboundReplyReviewPayload(payload),
    contentReceiptHash: "c".repeat(64),
    confirmation: PROSPECT_INBOUND_REPLY_RESOLUTION_CONFIRMATION,
    resolution,
    ...(resolution === "not_actionable"
      ? {}
      : {
          selectedOutreachApprovalId:
            payload.candidates[0].outreachApprovalId,
        }),
    notes: "Reviewed the exact synthetic inbound message.",
    attestations: {
      messageContentReviewed: true,
      senderIdentityMatched: true,
      ...(resolution === "opt_out"
        ? { recipientOptOutVerified: true as const }
        : {}),
      noContactExecutedByResolution: true,
      followUpRemainsSeparate: true,
    },
  } as const;
}

test("inbound reply review payloads are normalized and immutable", () => {
  assert.equal(payload.sender, "owner@example.com");
  assert.equal(payload.occurredAt, "2026-08-02T23:00:00.000Z");
  assert.equal(payload.matchState, "unique");
  assert.match(hashProspectInboundReplyReviewPayload(payload), /^[a-f0-9]{64}$/);
  assert.notEqual(
    hashProspectInboundReplyReviewPayload(payload),
    hashProspectInboundReplyReviewPayload({
      ...payload,
      inboundMessageId: "email_inbound_synthetic_changed",
    })
  );
});

test("candidate cardinality determines the immutable match state", () => {
  const unmatched = buildProspectInboundReplyReviewPayload({
    ...payload,
    candidates: [],
  });
  const ambiguous = buildProspectInboundReplyReviewPayload({
    ...payload,
    candidates: [
      payload.candidates[0],
      {
        outreachJobId: 10,
        outreachApprovalId: "33333333-3333-4333-8333-333333333333",
        prospectId: 24,
        businessName: "Synthetic HVAC",
        sentAt: "2026-08-01T17:59:00.000Z",
      },
    ],
  });
  assert.equal(unmatched.matchState, "no_match");
  assert.equal(ambiguous.matchState, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

test("reply decisions require an exact candidate while dismissals forbid one", () => {
  const reply = request("reply");
  assert.equal(resolveProspectInboundReplySchema.safeParse(reply).success, true);
  assert.equal(
    resolveProspectInboundReplySchema.safeParse({
      ...reply,
      selectedOutreachApprovalId: undefined,
    }).success,
    false
  );
  assert.equal(
    resolveProspectInboundReplySchema.safeParse({
      ...request("not_actionable"),
      selectedOutreachApprovalId:
        payload.candidates[0].outreachApprovalId,
    }).success,
    false
  );
});

test("opt-out classification requires a dedicated human attestation", () => {
  const valid = request("opt_out");
  assert.equal(resolveProspectInboundReplySchema.safeParse(valid).success, true);
  assert.equal(
    resolveProspectInboundReplySchema.safeParse({
      ...valid,
      selectedOutreachApprovalId: undefined,
    }).success,
    true
  );
  assert.equal(
    resolveProspectInboundReplySchema.safeParse({
      ...valid,
      attestations: {
        ...valid.attestations,
        recipientOptOutVerified: undefined,
      },
    }).success,
    false
  );
  assert.equal(
    resolveProspectInboundReplySchema.safeParse({
      ...request("reply"),
      attestations: {
        ...request("reply").attestations,
        recipientOptOutVerified: true,
      },
    }).success,
    false
  );
});

test("resolution receipts bind the exact request and resulting action", () => {
  const resolution = request("opt_out");
  const receipt = buildProspectInboundReplyResolutionReceipt({
    reviewId: payload.reviewId,
    resolution,
    resultingOutcome: "dnc",
    suppressionRecorded: true,
    resolvedBy: "dashboard_operator:synthetic",
    resolvedAt: "2026-08-02T23:05:00.000Z",
  });
  assert.equal(
    receipt.requestHash,
    hashProspectInboundReplyResolutionRequest(resolution)
  );
  assert.equal(receipt.contentReceiptHash, "c".repeat(64));
  assert.match(
    hashProspectInboundReplyResolutionReceipt(receipt),
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    prospectInboundReplyResolutionReceiptSchema.safeParse({
      ...receipt,
      resultingOutcome: "replied",
    }).success,
    false
  );
  assert.equal(
    prospectInboundReplyResolutionReceiptSchema.safeParse({
      ...receipt,
      selectedOutreachApprovalId: null,
      resultingOutcome: null,
    }).success,
    true
  );
  assert.equal(
    prospectInboundReplyResolutionReceiptSchema.safeParse({
      ...receipt,
      selectedOutreachApprovalId: null,
    }).success,
    false
  );
});
