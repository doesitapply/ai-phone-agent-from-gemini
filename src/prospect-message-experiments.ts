import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION =
  "smirk.prospect-message-experiment.v1" as const;
export const PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION =
  "smirk.prospect-message-assignment.v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION =
  "activate-one-reviewed-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION =
  "close-one-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION =
  "cancel-one-prepared-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS = 5_000;

const variantKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9:_-]+$/);

export const prospectMessageExperimentDefinitionSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
    ),
    experimentId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    channel: z.enum(["email", "call"]),
    controlVariantKey: variantKeySchema,
    challengerVariantKey: variantKeySchema,
    allocationBasisPoints: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS
    ),
    preparedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    value => value.controlVariantKey !== value.challengerVariantKey,
    "Control and challenger strategies must be different."
  );

export type ProspectMessageExperimentDefinition = z.infer<
  typeof prospectMessageExperimentDefinitionSchema
>;

const assignmentBaseSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION
    ),
    experimentId: z.string().uuid(),
    experimentDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    prospectId: z.number().int().positive(),
    channel: z.enum(["email", "call"]),
    arm: z.enum(["control", "challenger"]),
    assignedVariantKey: variantKeySchema,
    allocationBucket: z.number().int().min(0).max(9_999),
    allocationBasisPoints: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS
    ),
  })
  .strict();

export const prospectMessageExperimentAssignmentSchema =
  assignmentBaseSchema
    .extend({
      assignmentHash: z.string().regex(/^[a-f0-9]{64}$/),
      actualVariantKey: variantKeySchema,
      protocolCompliant: z.boolean(),
    })
    .strict();

export type ProspectMessageExperimentAssignment = z.infer<
  typeof prospectMessageExperimentAssignmentSchema
>;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function buildProspectMessageExperimentDefinition(input: {
  experimentId?: string;
  workspaceId: number;
  campaignId: number;
  channel: "email" | "call";
  controlVariantKey: string;
  challengerVariantKey: string;
  preparedAt: string;
}): ProspectMessageExperimentDefinition {
  return prospectMessageExperimentDefinitionSchema.parse({
    contractVersion: PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
    experimentId: input.experimentId || randomUUID(),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    channel: input.channel,
    controlVariantKey: input.controlVariantKey,
    challengerVariantKey: input.challengerVariantKey,
    allocationBasisPoints:
      PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS,
    preparedAt: input.preparedAt,
  });
}

export function hashProspectMessageExperimentDefinition(
  definition: ProspectMessageExperimentDefinition
): string {
  return sha256(
    prospectMessageExperimentDefinitionSchema.parse(definition)
  );
}

function assignmentBase(input: {
  definition: ProspectMessageExperimentDefinition;
  prospectId: number;
}) {
  const definition = prospectMessageExperimentDefinitionSchema.parse(
    input.definition
  );
  const experimentDefinitionHash =
    hashProspectMessageExperimentDefinition(definition);
  const allocationDigest = sha256({
    contractVersion: PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION,
    experimentId: definition.experimentId,
    experimentDefinitionHash,
    workspaceId: definition.workspaceId,
    campaignId: definition.campaignId,
    prospectId: input.prospectId,
    channel: definition.channel,
  });
  const allocationBucket =
    Number.parseInt(allocationDigest.slice(0, 8), 16) % 10_000;
  const arm =
    allocationBucket < definition.allocationBasisPoints
      ? ("control" as const)
      : ("challenger" as const);
  return assignmentBaseSchema.parse({
    contractVersion: PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION,
    experimentId: definition.experimentId,
    experimentDefinitionHash,
    workspaceId: definition.workspaceId,
    campaignId: definition.campaignId,
    prospectId: input.prospectId,
    channel: definition.channel,
    arm,
    assignedVariantKey:
      arm === "control"
        ? definition.controlVariantKey
        : definition.challengerVariantKey,
    allocationBucket,
    allocationBasisPoints: definition.allocationBasisPoints,
  });
}

export function buildProspectMessageExperimentAssignment(input: {
  definition: ProspectMessageExperimentDefinition;
  prospectId: number;
  actualVariantKey: string;
}): ProspectMessageExperimentAssignment {
  const base = assignmentBase(input);
  return prospectMessageExperimentAssignmentSchema.parse({
    ...base,
    assignmentHash: sha256(base),
    actualVariantKey: input.actualVariantKey,
    protocolCompliant:
      base.assignedVariantKey === input.actualVariantKey,
  });
}

export function verifyProspectMessageExperimentAssignment(input: {
  definition: ProspectMessageExperimentDefinition;
  assignment: ProspectMessageExperimentAssignment;
}): boolean {
  const assignment =
    prospectMessageExperimentAssignmentSchema.safeParse(input.assignment);
  if (!assignment.success) return false;
  try {
    const expected = buildProspectMessageExperimentAssignment({
      definition: input.definition,
      prospectId: assignment.data.prospectId,
      actualVariantKey: assignment.data.actualVariantKey,
    });
    return JSON.stringify(expected) === JSON.stringify(assignment.data);
  } catch {
    return false;
  }
}
