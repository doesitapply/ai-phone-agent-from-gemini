export type AcquisitionRecordKind = "real" | "synthetic" | "quarantined";

export type AcquisitionLifecycleRecord = {
  acquisition_id: string;
  source_system: string;
  source_record_id: string;
  first_payload_hash: string;
  record_kind: AcquisitionRecordKind;
  source_snapshot?: Record<string, unknown> | null;
  source_observed_at?: string | Date | null;
  first_received_at: string | Date;
};

export type AcquisitionLifecycleInput = {
  record: AcquisitionLifecycleRecord;
  events: readonly Record<string, unknown>[];
  reviews: readonly Record<string, unknown>[];
  handoffs: readonly Record<string, unknown>[];
  approvals: readonly Record<string, unknown>[];
  calls: readonly Record<string, unknown>[];
  checkoutFulfillments: readonly Record<string, unknown>[];
  provisioningRequests: readonly Record<string, unknown>[];
  activationEvents: readonly Record<string, unknown>[];
};

export type AcquisitionLifecycleStageKey =
  | "review"
  | "handoff"
  | "approval"
  | "touch"
  | "checkout"
  | "provisioning"
  | "activation"
  | "feedback";

type EvidenceRecord = Readonly<Record<string, unknown>>;

function stringValue(record: EvidenceRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function timestampValue(record: EvidenceRecord, ...keys: string[]): number {
  const raw = keys.map((key) => record[key]).find((value) => value instanceof Date || typeof value === "string");
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function latestRecord(records: readonly EvidenceRecord[]): EvidenceRecord | null {
  return records.reduce<EvidenceRecord | null>((latest, record) => {
    if (!latest) return record;
    return timestampValue(record, "created_at", "createdAt", "updated_at", "updatedAt", "received_at", "receivedAt", "ended_at", "endedAt", "started_at", "startedAt")
      >= timestampValue(latest, "created_at", "createdAt", "updated_at", "updatedAt", "received_at", "receivedAt", "ended_at", "endedAt", "started_at", "startedAt")
      ? record
      : latest;
  }, null);
}

function normalizedState(value: string, fallback = "recorded"): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_") || fallback;
}

function currentReviewValue(record: EvidenceRecord | null) {
  if (!record) return null;
  return {
    reviewId: stringValue(record, "review_id", "reviewId"),
    decision: stringValue(record, "decision") || "recorded",
    candidateChannel: stringValue(record, "candidate_channel", "candidateChannel") || "none",
    contactBasis: stringValue(record, "contact_basis", "contactBasis") || "not_evaluated",
    evidenceHash: stringValue(record, "evidence_hash", "evidenceHash") || null,
    evidenceRef: stringValue(record, "evidence_ref", "evidenceRef") || null,
    reviewedBy: stringValue(record, "reviewed_by", "reviewedBy") || null,
    observedAt: record.observed_at ?? record.observedAt ?? null,
    expiresAt: record.expires_at ?? record.expiresAt ?? null,
    createdAt: record.created_at ?? record.createdAt ?? null,
  };
}

function activationState(records: readonly EvidenceRecord[]): string {
  if (records.length === 0) return "none_recorded";
  const completedTypes = records
    .filter((record) => ["complete", "completed", "succeeded", "success"].includes(stringValue(record, "status").toLowerCase()))
    .map((record) => stringValue(record, "event_type", "eventType").toLowerCase());
  if (completedTypes.some((type) => ["activated", "workspace_activated", "setup_completed"].includes(type))) return "activated";
  if (completedTypes.some((type) => ["buyer_activation_email", "buyer_invite_accepted", "owner_access_delivered"].includes(type))) return "owner_access_delivered";
  if (completedTypes.includes("workspace_created")) return "workspace_created";
  const latest = latestRecord(records);
  return stringValue(latest || {}, "status").toLowerCase() || "recorded";
}

function isFeedbackEvent(record: EvidenceRecord): boolean {
  const eventType = normalizedState(stringValue(record, "event_type", "eventType"), "");
  const status = normalizedState(stringValue(record, "status"), "");
  return eventType.includes("feedback") || status.startsWith("feedback_");
}

function isTouchEvent(record: EvidenceRecord): boolean {
  if (isFeedbackEvent(record)) return false;
  const eventType = normalizedState(stringValue(record, "event_type", "eventType"), "");
  const status = normalizedState(stringValue(record, "status"), "");
  const hasLinkedDelivery = Boolean(
    stringValue(record, "channel")
    || stringValue(record, "call_sid", "callSid")
    || stringValue(record, "external_delivery_id", "externalDeliveryId"),
  );
  return hasLinkedDelivery
    || eventType.includes("touch")
    || eventType.includes("outreach")
    || ["attempted", "provider_accepted", "delivered", "failed", "replied"].includes(status);
}

function isSourceReceipt(record: EvidenceRecord): boolean {
  const eventType = normalizedState(stringValue(record, "event_type", "eventType"), "");
  return eventType === "source_received" || eventType === "source_updated" || eventType === "quarantined";
}

function linkedState(records: readonly EvidenceRecord[]): string {
  return records.length > 0 ? "linked" : "none_recorded";
}

function latestStatus(records: readonly EvidenceRecord[]): string {
  const latest = latestRecord(records);
  return latest ? normalizedState(stringValue(latest, "status")) : "none_recorded";
}

function touchState(calls: readonly EvidenceRecord[], touchEvents: readonly EvidenceRecord[]): string {
  const latestEvent = latestRecord(touchEvents);
  const latestCall = latestRecord(calls);
  if (!latestEvent && !latestCall) return "none_recorded";

  const eventTime = latestEvent ? timestampValue(latestEvent, "created_at", "createdAt", "received_at", "receivedAt") : -1;
  const callTime = latestCall ? timestampValue(latestCall, "ended_at", "endedAt", "started_at", "startedAt", "created_at", "createdAt") : -1;
  if (latestEvent && eventTime >= callTime) return normalizedState(stringValue(latestEvent, "status"));

  const callStatus = normalizedState(stringValue(latestCall || {}, "status"));
  if (["completed", "busy", "failed", "no_answer", "canceled", "cancelled"].includes(callStatus)) return "terminal";
  if (["initiated", "queued", "ringing", "answered", "in_progress"].includes(callStatus)) return "provider_accepted";
  return "recorded";
}

function checkoutState(records: readonly EvidenceRecord[]): string {
  if (records.length === 0) return "none_recorded";
  const verifiedPaid = records.some((record) => (
    record.payment_verified === true
    || record.paymentVerified === true
    || record.provider_verified_paid === true
    || record.providerVerifiedPaid === true
  ));
  if (verifiedPaid) return "provider_verified_paid";
  return latestStatus(records);
}

function feedbackState(records: readonly EvidenceRecord[]): string {
  if (records.length === 0) return "not_implemented";
  const state = latestStatus(records);
  return state.startsWith("feedback_") ? state.slice("feedback_".length) : state;
}

export function buildAcquisitionLifecycle(input: AcquisitionLifecycleInput) {
  const { record } = input;
  const latestReview = latestRecord(input.reviews);
  const currentReview = currentReviewValue(latestReview);
  const sourceReceipts = input.events.filter(isSourceReceipt);
  const touchEvents = input.events.filter(isTouchEvent);
  const feedbackEvents = input.events.filter(isFeedbackEvent);
  const stages = {
    source: {
      state: "received" as const,
      receipts: [...sourceReceipts],
    },
    review: {
      state: currentReview?.decision || "none_recorded",
      reviews: [...input.reviews],
    },
    handoff: {
      state: linkedState(input.handoffs),
      records: [...input.handoffs],
    },
    approval: {
      state: latestStatus(input.approvals),
      records: [...input.approvals],
    },
    touch: {
      state: touchState(input.calls, touchEvents),
      calls: [...input.calls],
      events: [...touchEvents],
    },
    checkout: {
      state: checkoutState(input.checkoutFulfillments),
      fulfillments: [...input.checkoutFulfillments],
    },
    provisioning: {
      state: latestStatus(input.provisioningRequests),
      requests: [...input.provisioningRequests],
    },
    activation: {
      state: activationState(input.activationEvents),
      events: [...input.activationEvents],
    },
    feedback: {
      state: feedbackState(feedbackEvents),
      events: [...feedbackEvents],
    },
  };
  const missingLinks: AcquisitionLifecycleStageKey[] = [];
  if (input.reviews.length === 0) missingLinks.push("review");
  if (input.handoffs.length === 0) missingLinks.push("handoff");
  if (input.approvals.length === 0) missingLinks.push("approval");
  if (input.calls.length === 0 && touchEvents.length === 0) missingLinks.push("touch");
  if (input.checkoutFulfillments.length === 0) missingLinks.push("checkout");
  if (input.provisioningRequests.length === 0) missingLinks.push("provisioning");
  if (input.activationEvents.length === 0) missingLinks.push("activation");
  if (feedbackEvents.length === 0) missingLinks.push("feedback");
  return {
    acquisition: {
      acquisitionId: record.acquisition_id,
      sourceSystem: record.source_system,
      sourceRecordId: record.source_record_id,
      recordKind: record.record_kind,
      payloadHash: record.first_payload_hash,
      sourceObservedAt: record.source_observed_at ?? null,
      receivedAt: record.first_received_at,
      sourceEvidence: record.source_snapshot ?? {},
    },
    currentReview,
    stages,
    attribution: {
      complete: missingLinks.length === 0,
      missingLinks,
    },
    capabilities: {
      mode: "evidence_only" as const,
      canRecordReview: record.record_kind === "real",
      canPrepareOutreach: false as const,
      canPlaceCall: false as const,
      canStartCheckout: false as const,
      canWriteProvider: false as const,
    },
  };
}
