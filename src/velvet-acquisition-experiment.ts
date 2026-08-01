import { createHash } from "node:crypto";
import { z } from "zod";

export const VELVET_ACQUISITION_SOURCING_BINDING_CONTRACT =
  "smirk-velvet.acquisition-sourcing-binding.v1" as const;
export const VELVET_ACQUISITION_SOURCING_ASSIGNMENT_CONTRACT =
  "velvet.acquisition-sourcing-assignment.v1" as const;
export const VELVET_ACQUISITION_SOURCING_ASSIGNMENT_BINDING_CONTRACT =
  "smirk-velvet.acquisition-sourcing-assignment-binding.v1" as const;
export const VELVET_ACQUISITION_SOURCING_ACTIVE_RESPONSE_CONTRACT =
  "velvet-smirk.acquisition-sourcing-active.v1" as const;

const HASH = /^[a-f0-9]{64}$/;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function hashVelvetAcquisitionSourcingValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export const velvetAcquisitionSourcingBindingSchema = z
  .object({
    contractVersion: z.literal(VELVET_ACQUISITION_SOURCING_BINDING_CONTRACT),
    experimentId: z.string().uuid(),
    definitionHash: z.string().regex(HASH),
  })
  .strict();

const sourceCriteriaSchema = z
  .object({
    category: z.string().trim().min(2).max(120),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(2).max(80),
  })
  .strict();

const sourceArmSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    criteria: sourceCriteriaSchema,
  })
  .strict();

export const velvetAcquisitionSourcingActiveResponseSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(
      VELVET_ACQUISITION_SOURCING_ACTIVE_RESPONSE_CONTRACT,
    ),
    state: z.enum(["ACTIVE", "NONE"]),
    workspaceId: z.number().int().positive(),
    experiment: z
      .object({
        binding: velvetAcquisitionSourcingBindingSchema,
        dimension: z.enum(["category", "metro"]),
        arms: z
          .object({
            control: sourceArmSchema,
            challenger: sourceArmSchema,
          })
          .strict(),
        requestsPerArm: z.number().int().min(1).max(10),
        leadsPerRequest: z.number().int().min(1).max(20),
        totalRequestSlots: z.number().int().min(2).max(20),
        assignedRequests: z.number().int().nonnegative().max(20),
      })
      .strict()
      .nullable(),
    contactActionAllowed: z.literal(false),
    spendAuthorized: z.literal(false),
    policyChanged: z.literal(false),
    externalAction: z.literal("experiment_status_only"),
  })
  .strict()
  .superRefine((response, ctx) => {
    if ((response.state === "ACTIVE") !== Boolean(response.experiment)) {
      ctx.addIssue({
        code: "custom",
        path: ["experiment"],
        message: "ACTIVE state must contain exactly one experiment.",
      });
    }
    if (
      response.experiment &&
      response.experiment.assignedRequests >
        response.experiment.totalRequestSlots
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["experiment", "assignedRequests"],
        message: "Assigned requests cannot exceed frozen slots.",
      });
    }
  });

const assignmentPayloadSchema = z
  .object({
    contractVersion: z.literal(VELVET_ACQUISITION_SOURCING_ASSIGNMENT_CONTRACT),
    experimentId: z.string().uuid(),
    definitionHash: z.string().regex(HASH),
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    slotOrdinal: z.number().int().positive().max(20),
    arm: z.enum(["control", "challenger"]),
    armOrdinal: z.number().int().positive().max(10),
    selectionHash: z.string().regex(HASH),
    effectiveCriteria: z
      .object({
        category: z.string().trim().min(2).max(120),
        city: z.string().trim().min(1).max(120),
        state: z.string().trim().min(2).max(80),
        limit: z.number().int().min(1).max(20),
      })
      .strict(),
    contactActionAllowed: z.literal(false),
    spendAuthorized: z.literal(false),
  })
  .strict();

export const velvetAcquisitionSourcingAssignmentSchema = assignmentPayloadSchema
  .extend({ assignmentHash: z.string().regex(HASH) })
  .strict()
  .superRefine((assignment, ctx) => {
    const { assignmentHash, ...payload } = assignment;
    if (assignmentHash !== hashVelvetAcquisitionSourcingValue(payload)) {
      ctx.addIssue({
        code: "custom",
        path: ["assignmentHash"],
        message: "The Velvet sourcing assignment hash is invalid.",
      });
    }
  });

export const velvetAcquisitionSourcingAssignmentBindingSchema = z
  .object({
    contractVersion: z.literal(
      VELVET_ACQUISITION_SOURCING_ASSIGNMENT_BINDING_CONTRACT,
    ),
    experimentId: z.string().uuid(),
    definitionHash: z.string().regex(HASH),
    assignmentHash: z.string().regex(HASH),
    sourceDiscoveryRequestId: z
      .string()
      .min(20)
      .max(160)
      .regex(SAFE_EXTERNAL_ID),
    slotOrdinal: z.number().int().positive().max(20),
    arm: z.enum(["control", "challenger"]),
  })
  .strict();

export type VelvetAcquisitionSourcingBinding = z.infer<
  typeof velvetAcquisitionSourcingBindingSchema
>;
export type VelvetAcquisitionSourcingActiveResponse = z.infer<
  typeof velvetAcquisitionSourcingActiveResponseSchema
>;
export type VelvetAcquisitionSourcingAssignment = z.infer<
  typeof velvetAcquisitionSourcingAssignmentSchema
>;
export type VelvetAcquisitionSourcingAssignmentBinding = z.infer<
  typeof velvetAcquisitionSourcingAssignmentBindingSchema
>;

export function buildVelvetAcquisitionSourcingAssignmentBinding(
  assignment: VelvetAcquisitionSourcingAssignment,
): VelvetAcquisitionSourcingAssignmentBinding {
  return velvetAcquisitionSourcingAssignmentBindingSchema.parse({
    contractVersion: VELVET_ACQUISITION_SOURCING_ASSIGNMENT_BINDING_CONTRACT,
    experimentId: assignment.experimentId,
    definitionHash: assignment.definitionHash,
    assignmentHash: assignment.assignmentHash,
    sourceDiscoveryRequestId: assignment.requestId,
    slotOrdinal: assignment.slotOrdinal,
    arm: assignment.arm,
  });
}

export function assignmentMatchesVelvetSourceBinding(input: {
  assignment: VelvetAcquisitionSourcingAssignment | null;
  binding: VelvetAcquisitionSourcingAssignmentBinding | undefined;
}): boolean {
  if (!input.binding) return input.assignment === null;
  return Boolean(
    input.assignment &&
    input.assignment.experimentId === input.binding.experimentId &&
    input.assignment.definitionHash === input.binding.definitionHash &&
    input.assignment.assignmentHash === input.binding.assignmentHash &&
    input.assignment.requestId === input.binding.sourceDiscoveryRequestId &&
    input.assignment.slotOrdinal === input.binding.slotOrdinal &&
    input.assignment.arm === input.binding.arm,
  );
}

export function assignmentMatchesVelvetRequest(input: {
  assignment: VelvetAcquisitionSourcingAssignment | null;
  binding: VelvetAcquisitionSourcingBinding | undefined;
  requestId: string;
}): boolean {
  if (!input.binding) return input.assignment === null;
  return Boolean(
    input.assignment &&
    input.assignment.experimentId === input.binding.experimentId &&
    input.assignment.definitionHash === input.binding.definitionHash &&
    input.assignment.requestId === input.requestId,
  );
}
