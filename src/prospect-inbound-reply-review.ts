import { createHash } from "node:crypto";
import { z } from "zod";

export const PROSPECT_INBOUND_REPLY_REVIEW_CONTRACT_VERSION =
  "smirk.prospect-inbound-reply-review.v1" as const;
export const PROSPECT_INBOUND_REPLY_RESOLUTION_CONTRACT_VERSION =
  "smirk.prospect-inbound-reply-resolution.v1" as const;
export const PROSPECT_INBOUND_REPLY_RESOLUTION_CONFIRMATION =
  "resolve-one-inbound-reply-v1" as const;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .email();

const inboundReplyResolutionSchema = z.enum([
  "reply",
  "opt_out",
  "not_actionable",
]);

const inboundReplyResolutionAttestationsSchema = z
  .object({
    messageContentReviewed: z.literal(true),
    senderIdentityMatched: z.literal(true),
    recipientOptOutVerified: z.literal(true).optional(),
    noContactExecutedByResolution: z.literal(true),
    followUpRemainsSeparate: z.literal(true),
  })
  .strict();

const inboundReplyCandidateSchema = z
  .object({
    outreachJobId: z.number().int().positive(),
    outreachApprovalId: z.string().uuid(),
    prospectId: z.number().int().positive(),
    businessName: z.string().trim().min(1).max(500),
    sentAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const prospectInboundReplyReviewPayloadSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_INBOUND_REPLY_REVIEW_CONTRACT_VERSION
    ),
    reviewId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    providerEventId: z.string().trim().min(8).max(200),
    inboundMessageId: z.string().trim().min(1).max(200),
    webhookPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    sender: emailSchema,
    occurredAt: z.string().datetime({ offset: true }),
    matchState: z.enum(["no_match", "unique", "ambiguous"]),
    candidates: z.array(inboundReplyCandidateSchema).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedMatchState =
      value.candidates.length === 0
        ? "no_match"
        : value.candidates.length === 1
          ? "unique"
          : "ambiguous";
    if (value.matchState !== expectedMatchState) {
      ctx.addIssue({
        code: "custom",
        path: ["matchState"],
        message:
          "The inbound-reply match state does not match its candidate set.",
      });
    }
    const approvals = new Set(
      value.candidates.map(candidate => candidate.outreachApprovalId)
    );
    const jobs = new Set(
      value.candidates.map(candidate => candidate.outreachJobId)
    );
    if (
      approvals.size !== value.candidates.length ||
      jobs.size !== value.candidates.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Inbound-reply candidates must be unique.",
      });
    }
  });

export const resolveProspectInboundReplySchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_INBOUND_REPLY_RESOLUTION_CONFIRMATION
    ),
    resolution: inboundReplyResolutionSchema,
    selectedOutreachApprovalId: z.string().uuid().optional(),
    notes: z.string().trim().min(3).max(2_000),
    attestations: inboundReplyResolutionAttestationsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.resolution === "not_actionable" &&
      value.selectedOutreachApprovalId !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedOutreachApprovalId"],
        message:
          "A not-actionable resolution cannot select an outreach record.",
      });
    }
    if (
      value.resolution === "reply" &&
      value.selectedOutreachApprovalId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedOutreachApprovalId"],
        message:
          "A reply resolution must select the exact outreach record.",
      });
    }
    if (
      value.resolution === "opt_out" &&
      value.attestations.recipientOptOutVerified !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["attestations", "recipientOptOutVerified"],
        message:
          "An opt-out resolution requires an explicit recipient opt-out attestation.",
      });
    }
    if (
      value.resolution !== "opt_out" &&
      value.attestations.recipientOptOutVerified !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["attestations", "recipientOptOutVerified"],
        message:
          "The recipient opt-out attestation is only valid for an opt-out resolution.",
      });
    }
  });

export const prospectInboundReplyResolutionReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_INBOUND_REPLY_RESOLUTION_CONTRACT_VERSION
    ),
    reviewId: z.string().uuid(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    resolution: inboundReplyResolutionSchema,
    selectedOutreachApprovalId: z.string().uuid().nullable(),
    notes: z.string().trim().min(3).max(2_000),
    attestations: inboundReplyResolutionAttestationsSchema,
    resultingOutcome: z.enum(["replied", "dnc"]).nullable(),
    suppressionRecorded: z.boolean(),
    noContactExecuted: z.literal(true),
    resolvedBy: z.string().trim().min(1).max(160),
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.resolution === "not_actionable" &&
      value.selectedOutreachApprovalId !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedOutreachApprovalId"],
        message:
          "A not-actionable receipt cannot select an outreach record.",
      });
    }
    if (
      value.resolution === "reply" &&
      value.selectedOutreachApprovalId === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedOutreachApprovalId"],
        message:
          "A reply receipt must identify the selected outreach record.",
      });
    }
    const expectedOutcome =
      value.resolution === "reply"
        ? "replied"
        : value.resolution === "opt_out"
          ? value.selectedOutreachApprovalId
            ? "dnc"
            : null
          : null;
    if (value.resultingOutcome !== expectedOutcome) {
      ctx.addIssue({
        code: "custom",
        path: ["resultingOutcome"],
        message: "The receipt outcome does not match the resolution.",
      });
    }
    if (
      value.suppressionRecorded !==
      (value.resolution === "opt_out")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["suppressionRecorded"],
        message:
          "Only an opt-out resolution may record recipient suppression.",
      });
    }
  });

export type ProspectInboundReplyReviewPayload = z.infer<
  typeof prospectInboundReplyReviewPayloadSchema
>;
export type ResolveProspectInboundReply = z.infer<
  typeof resolveProspectInboundReplySchema
>;
export type ProspectInboundReplyResolutionReceipt = z.infer<
  typeof prospectInboundReplyResolutionReceiptSchema
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

export function buildProspectInboundReplyReviewPayload(input: {
  reviewId: string;
  workspaceId: number;
  providerEventId: string;
  inboundMessageId: string;
  webhookPayloadHash: string;
  sender: string;
  occurredAt: string | Date;
  candidates: Array<{
    outreachJobId: number;
    outreachApprovalId: string;
    prospectId: number;
    businessName: string;
    sentAt: string | Date;
  }>;
}): ProspectInboundReplyReviewPayload {
  const candidates = input.candidates.map(candidate => ({
    ...candidate,
    sentAt: new Date(candidate.sentAt).toISOString(),
  }));
  return prospectInboundReplyReviewPayloadSchema.parse({
    contractVersion: PROSPECT_INBOUND_REPLY_REVIEW_CONTRACT_VERSION,
    ...input,
    candidates,
    matchState:
      candidates.length === 0
        ? "no_match"
        : candidates.length === 1
          ? "unique"
          : "ambiguous",
    occurredAt: new Date(input.occurredAt).toISOString(),
  });
}

export function hashProspectInboundReplyReviewPayload(
  payload: ProspectInboundReplyReviewPayload
): string {
  return hashValue(
    prospectInboundReplyReviewPayloadSchema.parse(payload)
  );
}

export function hashProspectInboundReplyResolutionRequest(
  request: ResolveProspectInboundReply
): string {
  return hashValue(resolveProspectInboundReplySchema.parse(request));
}

export function buildProspectInboundReplyResolutionReceipt(input: {
  reviewId: string;
  resolution: ResolveProspectInboundReply;
  resultingOutcome: "replied" | "dnc" | null;
  suppressionRecorded: boolean;
  resolvedBy: string;
  resolvedAt: string | Date;
}): ProspectInboundReplyResolutionReceipt {
  const resolution = resolveProspectInboundReplySchema.parse(
    input.resolution
  );
  return prospectInboundReplyResolutionReceiptSchema.parse({
    contractVersion:
      PROSPECT_INBOUND_REPLY_RESOLUTION_CONTRACT_VERSION,
    reviewId: input.reviewId,
    payloadHash: resolution.payloadHash,
    requestHash:
      hashProspectInboundReplyResolutionRequest(resolution),
    resolution: resolution.resolution,
    selectedOutreachApprovalId:
      resolution.selectedOutreachApprovalId || null,
    notes: resolution.notes,
    attestations: resolution.attestations,
    resultingOutcome: input.resultingOutcome,
    suppressionRecorded: input.suppressionRecorded,
    noContactExecuted: true,
    resolvedBy: input.resolvedBy,
    resolvedAt: new Date(input.resolvedAt).toISOString(),
  });
}

export function hashProspectInboundReplyResolutionReceipt(
  receipt: ProspectInboundReplyResolutionReceipt
): string {
  return hashValue(
    prospectInboundReplyResolutionReceiptSchema.parse(receipt)
  );
}
