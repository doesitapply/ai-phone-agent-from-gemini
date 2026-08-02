import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  prospectMessageExperimentAssignmentSchema,
  type ProspectMessageExperimentAssignment,
} from "./prospect-message-experiments.js";
import {
  hashProspectQcDraft,
  prospectQcReceiptSchema,
  type ProspectQcReceipt,
} from "./prospect-qc.js";
import {
  prospectEmailComplianceSchema,
  type ProspectOutreachChannel,
} from "./prospect-outreach.js";

export const PROSPECT_QC_REVISION_CONTRACT_VERSION =
  "smirk.prospect-qc-revision.v1" as const;

export const PROSPECT_QC_REVISION_STATES = [
  "REVISION_REQUIRED",
  "REJECTED",
  "SUPERSEDED",
] as const;

export const prospectQcRevisionPayloadSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_QC_REVISION_CONTRACT_VERSION
    ),
    revisionId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    prospectId: z.number().int().positive(),
    channel: z.enum(["email", "call"]),
    recipient: z.string().trim().min(3).max(320),
    subject: z.string().trim().min(3).max(160).optional(),
    content: z.string().trim().min(20).max(5_000),
    variantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    emailCompliance: prospectEmailComplianceSchema.optional(),
    maxCostCents: z.number().int().min(0).max(100),
    expiresInHours: z.number().int().min(1).max(72),
    qcReceipt: prospectQcReceiptSchema,
    experimentAssignment:
      prospectMessageExperimentAssignmentSchema.optional(),
    preparedAt: z.string().datetime({ offset: true }),
    controls: z
      .object({
        humanReviewRequired: z.literal(true),
        approvalAuthorized: z.literal(false),
        contactAuthorized: z.literal(false),
        executionAuthorized: z.literal(false),
        modelReviewAuthorized: z.literal(false),
        providerRequestAuthorized: z.literal(false),
        smsAllowed: z.literal(false),
        automatedDialingAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (
      payload.qcReceipt.deterministicPassed ||
      payload.qcReceipt.verdict !== "REVISION_REQUIRED"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["qcReceipt"],
        message:
          "Only a deterministic QC failure can enter the revision ledger.",
      });
    }
    if (
      payload.qcReceipt.channel !== payload.channel ||
      payload.qcReceipt.variantKey !== payload.variantKey ||
      payload.qcReceipt.evidenceHash !== payload.evidenceHash ||
      new Date(payload.qcReceipt.evaluatedAt).toISOString() !==
        new Date(payload.preparedAt).toISOString() ||
      payload.qcReceipt.draftHash !==
        hashProspectQcDraft({
          channel: payload.channel,
          subject: payload.subject,
          content: payload.content,
        })
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["qcReceipt"],
        message:
          "The revision receipt must match the exact draft, evidence, and preparation time.",
      });
    }
    if (
      (payload.channel === "email" &&
        (!payload.subject ||
          !payload.emailCompliance ||
          payload.maxCostCents > 5)) ||
      (payload.channel === "call" &&
        (payload.subject ||
          payload.emailCompliance ||
          payload.maxCostCents < 1 ||
          payload.expiresInHours > 24))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Revision content and compliance fields must match the channel.",
      });
    }
  });

export type ProspectQcRevisionPayload = z.infer<
  typeof prospectQcRevisionPayloadSchema
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

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function hashProspectQcRevisionPayload(
  payload: ProspectQcRevisionPayload
): string {
  return sha256(prospectQcRevisionPayloadSchema.parse(payload));
}

export function buildProspectQcRevisionFingerprint(input: {
  workspaceId: number;
  campaignId: number;
  prospectId: number;
  channel: ProspectOutreachChannel;
  recipient: string;
  subject?: string;
  content: string;
  variantKey: string;
  evidenceHash: string;
  emailCompliance?: z.infer<typeof prospectEmailComplianceSchema>;
  maxCostCents: number;
  expiresInHours: number;
  qcReceipt: ProspectQcReceipt;
  experimentAssignment?: ProspectMessageExperimentAssignment;
}): string {
  return sha256({
    contractVersion: PROSPECT_QC_REVISION_CONTRACT_VERSION,
    ruleVersion: input.qcReceipt.ruleVersion,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.prospectId,
    channel: input.channel,
    recipient: input.recipient,
    subject: input.subject || null,
    content: input.content,
    variantKey: input.variantKey,
    evidenceHash: input.evidenceHash,
    emailCompliance: input.emailCompliance || null,
    maxCostCents: input.maxCostCents,
    expiresInHours: input.expiresInHours,
    experimentAssignmentHash:
      input.experimentAssignment?.assignmentHash || null,
  });
}

export function buildProspectQcRevisionPayload(input: {
  revisionId?: string;
  workspaceId: number;
  campaignId: number;
  prospectId: number;
  channel: ProspectOutreachChannel;
  recipient: string;
  subject?: string;
  content: string;
  variantKey: string;
  evidenceHash: string;
  emailCompliance?: z.infer<typeof prospectEmailComplianceSchema>;
  maxCostCents: number;
  expiresInHours: number;
  qcReceipt: ProspectQcReceipt;
  experimentAssignment?: ProspectMessageExperimentAssignment;
  preparedAt: string;
}): ProspectQcRevisionPayload {
  return prospectQcRevisionPayloadSchema.parse({
    contractVersion: PROSPECT_QC_REVISION_CONTRACT_VERSION,
    revisionId: input.revisionId || randomUUID(),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.prospectId,
    channel: input.channel,
    recipient: input.recipient,
    subject: input.subject,
    content: input.content,
    variantKey: input.variantKey,
    evidenceHash: input.evidenceHash,
    emailCompliance: input.emailCompliance,
    maxCostCents: input.maxCostCents,
    expiresInHours: input.expiresInHours,
    qcReceipt: input.qcReceipt,
    experimentAssignment: input.experimentAssignment,
    preparedAt: new Date(input.preparedAt).toISOString(),
    controls: {
      humanReviewRequired: true,
      approvalAuthorized: false,
      contactAuthorized: false,
      executionAuthorized: false,
      modelReviewAuthorized: false,
      providerRequestAuthorized: false,
      smsAllowed: false,
      automatedDialingAllowed: false,
    },
  });
}
