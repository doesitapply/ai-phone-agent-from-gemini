import { createHash } from "node:crypto";
import { z } from "zod";

export const PROSPECT_POSITIVE_OUTCOME_REVIEW_CONTRACT_VERSION =
  "smirk.prospect-positive-outcome-review.v1" as const;
export const PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONTRACT_VERSION =
  "smirk.prospect-positive-outcome-acknowledgment.v1" as const;
export const PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION =
  "acknowledge-one-positive-outcome-v1" as const;

export const POSITIVE_PROSPECT_OUTCOMES = [
  "replied",
  "qualified",
  "demo_booked",
  "converted",
] as const;

export const prospectPositiveOutcomeSchema = z.enum(
  POSITIVE_PROSPECT_OUTCOMES
);

export const prospectPositiveOutcomeReviewPayloadSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_POSITIVE_OUTCOME_REVIEW_CONTRACT_VERSION
    ),
    reviewId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    prospectId: z.number().int().positive(),
    businessName: z.string().trim().min(1).max(500),
    outreachJobId: z.number().int().positive(),
    outreachApprovalId: z.string().uuid(),
    channel: z.enum(["email", "call"]),
    outcomeEventId: z.number().int().positive(),
    outcome: prospectPositiveOutcomeSchema,
    eventSource: z.string().trim().min(1).max(80),
    externalEventId: z.string().trim().min(1).max(240),
    occurredAt: z.string().datetime({ offset: true }),
    recordedBy: z.string().trim().min(1).max(160),
    notes: z.string().trim().max(2_000).nullable(),
  })
  .strict();

export const acknowledgeProspectPositiveOutcomeSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONFIRMATION
    ),
    resolution: z.enum([
      "continue_guarded_loop",
      "handled_outside_smirk",
      "escalated_to_owner",
      "not_actionable",
    ]),
    notes: z.string().trim().min(1).max(2_000).optional(),
    attestations: z
      .object({
        interactionReviewed: z.literal(true),
        noContactExecutedByAcknowledgment: z.literal(true),
        followUpRemainsSeparate: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const prospectPositiveOutcomeAcknowledgmentReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONTRACT_VERSION
    ),
    reviewId: z.string().uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    resolution:
      acknowledgeProspectPositiveOutcomeSchema.shape.resolution,
    notes: z.string().trim().max(2_000).nullable(),
    attestations:
      acknowledgeProspectPositiveOutcomeSchema.shape.attestations,
    acknowledgedBy: z.string().trim().min(1).max(160),
    acknowledgedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProspectPositiveOutcomeReviewPayload = z.infer<
  typeof prospectPositiveOutcomeReviewPayloadSchema
>;
export type AcknowledgeProspectPositiveOutcome = z.infer<
  typeof acknowledgeProspectPositiveOutcomeSchema
>;
export type ProspectPositiveOutcomeAcknowledgmentReceipt = z.infer<
  typeof prospectPositiveOutcomeAcknowledgmentReceiptSchema
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function isoTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function optionalNotes(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function isPositiveProspectOutcome(
  outcome: string
): outcome is z.infer<typeof prospectPositiveOutcomeSchema> {
  return prospectPositiveOutcomeSchema.safeParse(outcome).success;
}

export function buildProspectPositiveOutcomeReviewPayload(input: {
  reviewId: string;
  workspaceId: number;
  campaignId: number;
  prospectId: number;
  businessName: string;
  outreachJobId: number;
  outreachApprovalId: string;
  channel: "email" | "call";
  outcomeEventId: number;
  outcome: z.infer<typeof prospectPositiveOutcomeSchema>;
  eventSource: string;
  externalEventId: string;
  occurredAt: string | Date;
  recordedBy: string;
  notes?: string | null;
}): ProspectPositiveOutcomeReviewPayload {
  return prospectPositiveOutcomeReviewPayloadSchema.parse({
    contractVersion: PROSPECT_POSITIVE_OUTCOME_REVIEW_CONTRACT_VERSION,
    reviewId: input.reviewId,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.prospectId,
    businessName: input.businessName,
    outreachJobId: input.outreachJobId,
    outreachApprovalId: input.outreachApprovalId,
    channel: input.channel,
    outcomeEventId: input.outcomeEventId,
    outcome: input.outcome,
    eventSource: input.eventSource,
    externalEventId: input.externalEventId,
    occurredAt: isoTimestamp(input.occurredAt),
    recordedBy: input.recordedBy,
    notes: optionalNotes(input.notes),
  });
}

export function hashProspectPositiveOutcomeReviewPayload(
  payload: ProspectPositiveOutcomeReviewPayload
): string {
  return hashValue(
    prospectPositiveOutcomeReviewPayloadSchema.parse(payload)
  );
}

export function hashProspectPositiveOutcomeAcknowledgmentRequest(
  input: AcknowledgeProspectPositiveOutcome
): string {
  return hashValue(
    acknowledgeProspectPositiveOutcomeSchema.parse(input)
  );
}

export function buildProspectPositiveOutcomeAcknowledgmentReceipt(input: {
  reviewId: string;
  acknowledgment: AcknowledgeProspectPositiveOutcome;
  acknowledgedBy: string;
  acknowledgedAt: string | Date;
}): ProspectPositiveOutcomeAcknowledgmentReceipt {
  const acknowledgment =
    acknowledgeProspectPositiveOutcomeSchema.parse(
      input.acknowledgment
    );
  return prospectPositiveOutcomeAcknowledgmentReceiptSchema.parse({
    contractVersion:
      PROSPECT_POSITIVE_OUTCOME_ACKNOWLEDGMENT_CONTRACT_VERSION,
    reviewId: input.reviewId,
    payloadHash: acknowledgment.payloadHash,
    requestHash:
      hashProspectPositiveOutcomeAcknowledgmentRequest(
        acknowledgment
      ),
    resolution: acknowledgment.resolution,
    notes: optionalNotes(acknowledgment.notes),
    attestations: acknowledgment.attestations,
    acknowledgedBy: input.acknowledgedBy,
    acknowledgedAt: isoTimestamp(input.acknowledgedAt),
  });
}

export function hashProspectPositiveOutcomeAcknowledgmentReceipt(
  receipt: ProspectPositiveOutcomeAcknowledgmentReceipt
): string {
  return hashValue(
    prospectPositiveOutcomeAcknowledgmentReceiptSchema.parse(receipt)
  );
}
