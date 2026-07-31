import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION =
  "smirk.prospect-message-experiment.v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION =
  "smirk.prospect-message-experiment.v2" as const;
export const PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION =
  "smirk.prospect-message-assignment.v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN =
  "deterministic-eligible-cohort-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN =
  "deterministic-assignment-v1" as const;
export const PROSPECT_MESSAGE_COHORT_SELECTION_VERSION =
  "smirk.prospect-message-cohort-selection.v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_ACTIVATION_CONFIRMATION =
  "activate-one-reviewed-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_CLOSE_CONFIRMATION =
  "close-one-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_CANCEL_CONFIRMATION =
  "cancel-one-prepared-message-experiment-v1" as const;
export const PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS = 5_000;
export const PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE = 20;
export const PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE = 200;
export const PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION = 10_000;

const variantKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9:_-]+$/);

const experimentDefinitionBaseShape = {
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
} as const;

const legacyProspectMessageExperimentDefinitionSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION
    ),
    ...experimentDefinitionBaseShape,
  })
  .strict()
  .refine(
    value => value.controlVariantKey !== value.challengerVariantKey,
    "Control and challenger strategies must be different."
  );

const frozenCohortEntrySchema = z
  .object({
    prospectId: z.number().int().positive(),
    selectionRank: z
      .number()
      .int()
      .min(1)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE),
    selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
    arm: z.enum(["control", "challenger"]),
    assignedVariantKey: variantKeySchema,
    allocationBucket: z.number().int().min(0).max(9_999),
  })
  .strict();

export type ProspectMessageExperimentCohortEntry = z.infer<
  typeof frozenCohortEntrySchema
>;

type FrozenCohortInput = {
  experimentId: string;
  workspaceId: number;
  campaignId: number;
  channel: "email" | "call";
  controlVariantKey: string;
  challengerVariantKey: string;
  eligibleProspectIds: number[];
  cohortSize: number;
};

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizedEligibleProspectIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function eligiblePopulationHash(input: {
  workspaceId: number;
  campaignId: number;
  channel: "email" | "call";
  eligibleProspectIds: number[];
}): string {
  return sha256({
    cohortSelectionVersion: PROSPECT_MESSAGE_COHORT_SELECTION_VERSION,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    channel: input.channel,
    eligibleProspectIds: input.eligibleProspectIds,
  });
}

function buildFrozenCohortEntries(
  input: FrozenCohortInput
): ProspectMessageExperimentCohortEntry[] {
  return input.eligibleProspectIds
    .map(prospectId => {
      const selectionHash = sha256({
        cohortSelectionVersion:
          PROSPECT_MESSAGE_COHORT_SELECTION_VERSION,
        experimentId: input.experimentId,
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        channel: input.channel,
        prospectId,
      });
      return {
        prospectId,
        selectionHash,
        allocationBucket:
          Number.parseInt(selectionHash.slice(0, 8), 16) % 10_000,
      };
    })
    .sort(
      (left, right) =>
        left.selectionHash.localeCompare(right.selectionHash) ||
        left.prospectId - right.prospectId
    )
    .slice(0, input.cohortSize)
    .map((entry, index) => {
      const arm =
        index % 2 === 0
          ? ("control" as const)
          : ("challenger" as const);
      return {
        prospectId: entry.prospectId,
        selectionRank: index + 1,
        selectionHash: entry.selectionHash,
        arm,
        assignedVariantKey:
          arm === "control"
            ? input.controlVariantKey
            : input.challengerVariantKey,
        allocationBucket: entry.allocationBucket,
      };
    });
}

const frozenProspectMessageExperimentDefinitionSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
    ),
    ...experimentDefinitionBaseShape,
    studyDesign: z.literal(
      PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN
    ),
    cohortSelectionVersion: z.literal(
      PROSPECT_MESSAGE_COHORT_SELECTION_VERSION
    ),
    eligibleProspectIds: z
      .array(z.number().int().positive())
      .min(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION),
    eligiblePopulationSize: z
      .number()
      .int()
      .min(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_ELIGIBLE_POPULATION),
    eligiblePopulationHash: z.string().regex(/^[a-f0-9]{64}$/),
    cohortSize: z
      .number()
      .int()
      .min(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE),
    selectedProspectIdsHash: z.string().regex(/^[a-f0-9]{64}$/),
    cohort: z
      .array(frozenCohortEntrySchema)
      .min(PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE)
      .max(PROSPECT_MESSAGE_EXPERIMENT_MAX_COHORT_SIZE),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.controlVariantKey === value.challengerVariantKey) {
      ctx.addIssue({
        code: "custom",
        path: ["challengerVariantKey"],
        message: "Control and challenger strategies must be different.",
      });
    }
    if (value.cohortSize % 2 !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["cohortSize"],
        message: "The frozen cohort size must be even.",
      });
    }
    const normalizedIds = normalizedEligibleProspectIds(
      value.eligibleProspectIds
    );
    if (
      normalizedIds.length !== value.eligibleProspectIds.length ||
      JSON.stringify(normalizedIds) !==
        JSON.stringify(value.eligibleProspectIds)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["eligibleProspectIds"],
        message:
          "Eligible prospect IDs must be unique and sorted ascending.",
      });
    }
    if (
      value.eligiblePopulationSize !==
      value.eligibleProspectIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["eligiblePopulationSize"],
        message:
          "The eligible population size does not match the frozen IDs.",
      });
    }
    if (value.cohortSize > value.eligibleProspectIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["cohortSize"],
        message:
          "The frozen cohort cannot exceed the eligible population.",
      });
    }
    const expectedPopulationHash = eligiblePopulationHash({
      workspaceId: value.workspaceId,
      campaignId: value.campaignId,
      channel: value.channel,
      eligibleProspectIds: value.eligibleProspectIds,
    });
    if (value.eligiblePopulationHash !== expectedPopulationHash) {
      ctx.addIssue({
        code: "custom",
        path: ["eligiblePopulationHash"],
        message: "The frozen eligible population hash is invalid.",
      });
    }
    const expectedCohort = buildFrozenCohortEntries({
      experimentId: value.experimentId,
      workspaceId: value.workspaceId,
      campaignId: value.campaignId,
      channel: value.channel,
      controlVariantKey: value.controlVariantKey,
      challengerVariantKey: value.challengerVariantKey,
      eligibleProspectIds: value.eligibleProspectIds,
      cohortSize: value.cohortSize,
    });
    if (JSON.stringify(value.cohort) !== JSON.stringify(expectedCohort)) {
      ctx.addIssue({
        code: "custom",
        path: ["cohort"],
        message:
          "The selected cohort does not match deterministic balanced selection.",
      });
    }
    const expectedSelectedHash = sha256({
      cohortSelectionVersion:
        PROSPECT_MESSAGE_COHORT_SELECTION_VERSION,
      experimentId: value.experimentId,
      prospectIds: expectedCohort.map(entry => entry.prospectId),
    });
    if (value.selectedProspectIdsHash !== expectedSelectedHash) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedProspectIdsHash"],
        message: "The frozen selected-prospect hash is invalid.",
      });
    }
  });

export type FrozenProspectMessageExperimentDefinition = z.infer<
  typeof frozenProspectMessageExperimentDefinitionSchema
>;

export const prospectMessageExperimentDefinitionSchema = z.union([
  legacyProspectMessageExperimentDefinitionSchema,
  frozenProspectMessageExperimentDefinitionSchema,
]);

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

export function buildProspectMessageExperimentDefinition(input: {
  experimentId?: string;
  workspaceId: number;
  campaignId: number;
  channel: "email" | "call";
  controlVariantKey: string;
  challengerVariantKey: string;
  preparedAt: string;
  eligibleProspectIds: number[];
  cohortSize?: number;
}): FrozenProspectMessageExperimentDefinition {
  const experimentId = input.experimentId || randomUUID();
  const eligibleProspectIds = normalizedEligibleProspectIds(
    input.eligibleProspectIds
  );
  const cohortSize =
    input.cohortSize ||
    PROSPECT_MESSAGE_EXPERIMENT_DEFAULT_COHORT_SIZE;
  const cohort = buildFrozenCohortEntries({
    experimentId,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    channel: input.channel,
    controlVariantKey: input.controlVariantKey,
    challengerVariantKey: input.challengerVariantKey,
    eligibleProspectIds,
    cohortSize,
  });
  return frozenProspectMessageExperimentDefinitionSchema.parse({
    contractVersion: PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION,
    experimentId,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    channel: input.channel,
    controlVariantKey: input.controlVariantKey,
    challengerVariantKey: input.challengerVariantKey,
    allocationBasisPoints:
      PROSPECT_MESSAGE_EXPERIMENT_ALLOCATION_BASIS_POINTS,
    preparedAt: input.preparedAt,
    studyDesign: PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN,
    cohortSelectionVersion:
      PROSPECT_MESSAGE_COHORT_SELECTION_VERSION,
    eligibleProspectIds,
    eligiblePopulationSize: eligibleProspectIds.length,
    eligiblePopulationHash: eligiblePopulationHash({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      channel: input.channel,
      eligibleProspectIds,
    }),
    cohortSize,
    selectedProspectIdsHash: sha256({
      cohortSelectionVersion:
        PROSPECT_MESSAGE_COHORT_SELECTION_VERSION,
      experimentId,
      prospectIds: cohort.map(entry => entry.prospectId),
    }),
    cohort,
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
  const frozenEntry =
    definition.contractVersion ===
    PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
      ? definition.cohort.find(
          entry => entry.prospectId === input.prospectId
        )
      : null;
  if (
    definition.contractVersion ===
      PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION &&
    !frozenEntry
  ) {
    throw new Error(
      "The prospect is not part of the experiment's frozen cohort."
    );
  }
  const allocationDigest =
    definition.contractVersion ===
    PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION
      ? sha256({
          contractVersion:
            PROSPECT_MESSAGE_ASSIGNMENT_CONTRACT_VERSION,
          experimentId: definition.experimentId,
          experimentDefinitionHash,
          workspaceId: definition.workspaceId,
          campaignId: definition.campaignId,
          prospectId: input.prospectId,
          channel: definition.channel,
        })
      : null;
  const allocationBucket = frozenEntry
    ? frozenEntry.allocationBucket
    : Number.parseInt(String(allocationDigest).slice(0, 8), 16) %
      10_000;
  const arm = frozenEntry
    ? frozenEntry.arm
    : allocationBucket < definition.allocationBasisPoints
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
    assignedVariantKey: frozenEntry
      ? frozenEntry.assignedVariantKey
      : arm === "control"
        ? definition.controlVariantKey
        : definition.challengerVariantKey,
    allocationBucket,
    allocationBasisPoints: definition.allocationBasisPoints,
  });
}

export function getProspectMessageExperimentCohortEntry(
  definition: ProspectMessageExperimentDefinition,
  prospectId: number
): ProspectMessageExperimentCohortEntry | null {
  const parsed =
    prospectMessageExperimentDefinitionSchema.parse(definition);
  if (
    parsed.contractVersion !==
    PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
  ) {
    return null;
  }
  return (
    parsed.cohort.find(entry => entry.prospectId === prospectId) ||
    null
  );
}

export function getProspectMessageExperimentStudyDesign(
  definition: ProspectMessageExperimentDefinition
):
  | typeof PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN
  | typeof PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN {
  const parsed =
    prospectMessageExperimentDefinitionSchema.parse(definition);
  return parsed.contractVersion ===
    PROSPECT_MESSAGE_EXPERIMENT_CONTRACT_VERSION
    ? PROSPECT_MESSAGE_EXPERIMENT_STUDY_DESIGN
    : PROSPECT_MESSAGE_EXPERIMENT_LEGACY_STUDY_DESIGN;
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
