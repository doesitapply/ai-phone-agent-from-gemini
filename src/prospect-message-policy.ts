import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const PROSPECT_MESSAGE_POLICY_CONTRACT_VERSION =
  "smirk.prospect-message-policy.v1" as const;
export const PROSPECT_MESSAGE_POLICY_APPLY_CONFIRMATION =
  "apply-one-approved-message-policy-v1" as const;
export const PROSPECT_MESSAGE_POLICY_ROLLBACK_CONFIRMATION =
  "rollback-one-message-policy-v1" as const;

const variantKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9:_-]+$/);

const policyReleaseBase = {
  contractVersion: z.literal(
    PROSPECT_MESSAGE_POLICY_CONTRACT_VERSION
  ),
  releaseId: z.string().uuid(),
  workspaceId: z.number().int().positive(),
  campaignId: z.number().int().positive(),
  channel: z.enum(["email", "call"]),
  version: z.number().int().positive(),
  championVariantKey: variantKeySchema,
  previousChampionVariantKey: variantKeySchema,
  appliedBy: z.string().trim().min(2).max(160),
  appliedAt: z.string().datetime({ offset: true }),
  controls: z
    .object({
      nextExperimentControlOnly: z.literal(true),
      existingJobsChanged: z.literal(false),
      contactAuthorized: z.literal(false),
      executionAuthorized: z.literal(false),
      spendAuthorized: z.literal(false),
    })
    .strict(),
} as const;

const sourceCandidateSchema = z
  .object({
    id: z.number().int().positive(),
    candidateKey: z.string().trim().min(3).max(180),
    version: z.number().int().positive(),
    experimentId: z.string().uuid(),
    experimentDefinitionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    sampleSize: z.number().int().min(20),
  })
  .strict();

const promotionReleaseSchema = z
  .object({
    ...policyReleaseBase,
    action: z.literal("PROMOTE"),
    sourceCandidate: sourceCandidateSchema,
    rollbackOfReleaseId: z.null(),
    reason: z.null(),
    attestations: z
      .object({
        approvedCandidateReviewed: z.literal(true),
        measuredEvidenceReviewed: z.literal(true),
        futureExperimentsOnly: z.literal(true),
        noContactOrSpendAuthorized: z.literal(true),
      })
      .strict(),
  })
  .strict();

const rollbackReleaseSchema = z
  .object({
    ...policyReleaseBase,
    action: z.literal("ROLLBACK"),
    sourceCandidate: z.null(),
    rollbackOfReleaseId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    attestations: z
      .object({
        currentPolicyReviewed: z.literal(true),
        rollbackTargetReviewed: z.literal(true),
        futureExperimentsOnly: z.literal(true),
        noContactOrSpendAuthorized: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const prospectMessagePolicyReleaseSchema =
  z.discriminatedUnion("action", [
    promotionReleaseSchema,
    rollbackReleaseSchema,
  ]);

export type ProspectMessagePolicyRelease = z.infer<
  typeof prospectMessagePolicyReleaseSchema
>;

export const prospectMessagePolicyReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_MESSAGE_POLICY_CONTRACT_VERSION
    ),
    releaseId: z.string().uuid(),
    releaseHash: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.number().int().positive(),
    championVariantKey: variantKeySchema,
  })
  .strict();

export type ProspectMessagePolicyReceipt = z.infer<
  typeof prospectMessagePolicyReceiptSchema
>;

export const applyProspectMessagePolicySchema = z
  .object({
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_MESSAGE_POLICY_APPLY_CONFIRMATION
    ),
    attestations: promotionReleaseSchema.shape.attestations,
  })
  .strict();

export const rollbackProspectMessagePolicySchema = z
  .object({
    releaseHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(3).max(500),
    confirmation: z.literal(
      PROSPECT_MESSAGE_POLICY_ROLLBACK_CONFIRMATION
    ),
    attestations: rollbackReleaseSchema.shape.attestations,
  })
  .strict();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(
      key =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )
    .join(",")}}`;
}

export function hashProspectMessagePolicyValue(
  value: unknown
): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

export function buildProspectMessagePolicyRelease(
  input: Omit<
    ProspectMessagePolicyRelease,
    "contractVersion" | "releaseId"
  > & { releaseId?: string }
): ProspectMessagePolicyRelease {
  return prospectMessagePolicyReleaseSchema.parse({
    ...input,
    contractVersion: PROSPECT_MESSAGE_POLICY_CONTRACT_VERSION,
    releaseId: input.releaseId || randomUUID(),
  });
}

export function buildProspectMessagePolicyReceipt(input: {
  release: ProspectMessagePolicyRelease;
  releaseHash: string;
}): ProspectMessagePolicyReceipt {
  return prospectMessagePolicyReceiptSchema.parse({
    contractVersion: input.release.contractVersion,
    releaseId: input.release.releaseId,
    releaseHash: input.releaseHash,
    version: input.release.version,
    championVariantKey: input.release.championVariantKey,
  });
}
