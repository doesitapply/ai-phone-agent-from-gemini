import assert from "node:assert/strict";
import test from "node:test";

import { buildAcquisitionLifecycle } from "../src/acquisition-lifecycle.ts";

test("synthetic acquisition detail is evidence-only and cannot be reviewed into action", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_0123456789abcdef0123456789abcdef01234567",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-manus-fake-lead-00000001",
      first_payload_hash: "a".repeat(64),
      record_kind: "synthetic",
      source_snapshot: { companyName: "Synthetic Test Co", reason: "Synthetic fixture" },
      source_observed_at: null,
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [],
    reviews: [],
    handoffs: [],
    approvals: [],
    calls: [],
    checkoutFulfillments: [],
    provisioningRequests: [],
    activationEvents: [],
  });

  assert.equal(detail.acquisition.acquisitionId, "acq_0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(detail.acquisition.sourceEvidence, {
    companyName: "Synthetic Test Co",
    reason: "Synthetic fixture",
  });
  assert.deepEqual(detail.capabilities, {
    mode: "evidence_only",
    canRecordReview: false,
    canPrepareOutreach: false,
    canPlaceCall: false,
    canStartCheckout: false,
    canWriteProvider: false,
  });
});

test("real acquisition allows only an internal evidence review", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_2222222222222222222222222222222222222222",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-lead-00000001",
      first_payload_hash: "b".repeat(64),
      record_kind: "real",
      source_snapshot: {},
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [],
    reviews: [],
    handoffs: [],
    approvals: [],
    calls: [],
    checkoutFulfillments: [],
    provisioningRequests: [],
    activationEvents: [],
  });

  assert.deepEqual(detail.capabilities, {
    mode: "evidence_only",
    canRecordReview: true,
    canPrepareOutreach: false,
    canPlaceCall: false,
    canStartCheckout: false,
    canWriteProvider: false,
  });
});

test("empty downstream evidence reports every missing lifecycle link without inventing pending work", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_3333333333333333333333333333333333333333",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-lead-00000002",
      first_payload_hash: "c".repeat(64),
      record_kind: "real",
      source_snapshot: {},
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [],
    reviews: [],
    handoffs: [],
    approvals: [],
    calls: [],
    checkoutFulfillments: [],
    provisioningRequests: [],
    activationEvents: [],
  });

  assert.equal(detail.stages.source.state, "received");
  assert.equal(detail.stages.review.state, "none_recorded");
  assert.equal(detail.stages.handoff.state, "none_recorded");
  assert.equal(detail.stages.approval.state, "none_recorded");
  assert.equal(detail.stages.touch.state, "none_recorded");
  assert.equal(detail.stages.checkout.state, "none_recorded");
  assert.equal(detail.stages.provisioning.state, "none_recorded");
  assert.equal(detail.stages.activation.state, "none_recorded");
  assert.equal(detail.stages.feedback.state, "not_implemented");
  assert.deepEqual(detail.attribution, {
    complete: false,
    missingLinks: [
      "review",
      "handoff",
      "approval",
      "touch",
      "checkout",
      "provisioning",
      "activation",
      "feedback",
    ],
  });
});

test("review and activation stages derive independently from their own latest evidence", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_4444444444444444444444444444444444444444",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-lead-00000003",
      first_payload_hash: "d".repeat(64),
      record_kind: "real",
      source_snapshot: {},
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [],
    reviews: [
      {
        review_id: "acr_old",
        decision: "observe_only",
        contact_basis: "not_evaluated",
        candidate_channel: "none",
        created_at: "2026-08-21T12:01:00.000Z",
      },
      {
        review_id: "acr_latest",
        decision: "eligible_for_later_review",
        contact_basis: "public_business_contact",
        candidate_channel: "email",
        created_at: "2026-08-21T12:02:00.000Z",
      },
    ],
    handoffs: [],
    approvals: [],
    calls: [],
    checkoutFulfillments: [],
    provisioningRequests: [],
    activationEvents: [
      {
        id: 12,
        event_type: "workspace_activated",
        status: "complete",
        created_at: "2026-08-21T12:03:00.000Z",
      },
    ],
  });

  assert.equal(detail.stages.review.state, "eligible_for_later_review");
  assert.equal(detail.currentReview?.reviewId, "acr_latest");
  assert.equal(detail.currentReview?.contactBasis, "public_business_contact");
  assert.equal(detail.stages.activation.state, "activated");
  assert.deepEqual(detail.attribution.missingLinks, [
    "handoff",
    "approval",
    "touch",
    "checkout",
    "provisioning",
    "feedback",
  ]);
});

test("directly linked evidence fills each lifecycle stage without enabling execution", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_5555555555555555555555555555555555555555",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-lead-00000004",
      first_payload_hash: "e".repeat(64),
      record_kind: "real",
      source_snapshot: {},
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [
      { receipt_id: "ace_source", event_type: "source_received", status: "received", received_at: "2026-08-21T12:00:00.000Z" },
      { receipt_id: "ace_feedback", event_type: "velvet_feedback", status: "feedback_delivered", received_at: "2026-08-21T12:08:00.000Z" },
    ],
    reviews: [
      { review_id: "acr_review", decision: "observe_only", created_at: "2026-08-21T12:01:00.000Z" },
    ],
    handoffs: [
      { id: 7, status: "acknowledged", created_at: "2026-08-21T12:02:00.000Z" },
    ],
    approvals: [
      { approval_id: "approval_1", status: "APPROVED", created_at: "2026-08-21T12:03:00.000Z" },
    ],
    calls: [
      { call_sid: "CA123", status: "completed", ended_at: "2026-08-21T12:04:00.000Z" },
    ],
    checkoutFulfillments: [
      { checkout_session_id: "cs_live_123", status: "completed", payment_verified: true, updated_at: "2026-08-21T12:05:00.000Z" },
    ],
    provisioningRequests: [
      { id: 8, status: "provisioned", updated_at: "2026-08-21T12:06:00.000Z" },
    ],
    activationEvents: [
      { id: 9, event_type: "workspace_activated", status: "complete", created_at: "2026-08-21T12:07:00.000Z" },
    ],
  });

  assert.equal(detail.stages.handoff.state, "linked");
  assert.equal(detail.stages.approval.state, "approved");
  assert.equal(detail.stages.touch.state, "terminal");
  assert.equal(detail.stages.checkout.state, "provider_verified_paid");
  assert.equal(detail.stages.provisioning.state, "provisioned");
  assert.equal(detail.stages.activation.state, "activated");
  assert.equal(detail.stages.feedback.state, "delivered");
  assert.equal(detail.stages.source.receipts.length, 1);
  assert.equal(detail.stages.feedback.events.length, 1);
  assert.deepEqual(detail.attribution, { complete: true, missingLinks: [] });
  assert.equal(detail.capabilities.canPrepareOutreach, false);
  assert.equal(detail.capabilities.canPlaceCall, false);
  assert.equal(detail.capabilities.canStartCheckout, false);
  assert.equal(detail.capabilities.canWriteProvider, false);
});

test("checkout completion is not promoted to verified payment without explicit provider evidence", () => {
  const detail = buildAcquisitionLifecycle({
    record: {
      acquisition_id: "acq_6666666666666666666666666666666666666666",
      source_system: "velvet_alchemy",
      source_record_id: "velvet-lead-00000005",
      first_payload_hash: "f".repeat(64),
      record_kind: "real",
      source_snapshot: {},
      first_received_at: "2026-08-21T12:00:00.000Z",
    },
    events: [],
    reviews: [],
    handoffs: [],
    approvals: [],
    calls: [],
    checkoutFulfillments: [
      { checkout_session_id: "cs_live_unverified", status: "completed", updated_at: "2026-08-21T12:05:00.000Z" },
    ],
    provisioningRequests: [],
    activationEvents: [],
  });

  assert.equal(detail.stages.checkout.state, "completed");
  assert.notEqual(detail.stages.checkout.state, "provider_verified_paid");
  assert.equal(detail.attribution.missingLinks.includes("checkout"), false);
  assert.equal(detail.attribution.complete, false);
});
