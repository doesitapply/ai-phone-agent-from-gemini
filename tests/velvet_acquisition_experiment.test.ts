import assert from "node:assert/strict";
import test from "node:test";
import {
  VELVET_ACQUISITION_SOURCING_ASSIGNMENT_CONTRACT,
  VELVET_ACQUISITION_SOURCING_BINDING_CONTRACT,
  assignmentMatchesVelvetRequest,
  assignmentMatchesVelvetSourceBinding,
  buildVelvetAcquisitionSourcingAssignmentBinding,
  hashVelvetAcquisitionSourcingValue,
  velvetAcquisitionSourcingAssignmentSchema,
  velvetAcquisitionSourcingBindingSchema,
} from "../src/velvet-acquisition-experiment.ts";
import {
  buildVelvetDiscoveryRequest,
  velvetDiscoveryRequestSchema,
} from "../src/velvet-discovery.ts";
import {
  buildVelvetLeadSourceRequest,
  velvetLeadSourceRequestSchema,
} from "../src/velvet-lead-source.ts";

const experimentId = "97361295-e91c-4489-af87-acbdfb341b57";
const definitionHash = "a".repeat(64);
const discoveryRequestId = "smirk-discovery-experiment-97361295-0001";

function assignmentFixture() {
  const payload = {
    contractVersion: VELVET_ACQUISITION_SOURCING_ASSIGNMENT_CONTRACT,
    experimentId,
    definitionHash,
    requestId: discoveryRequestId,
    slotOrdinal: 1,
    arm: "control" as const,
    armOrdinal: 1,
    selectionHash: "b".repeat(64),
    effectiveCriteria: {
      category: "plumbing",
      city: "Reno",
      state: "NV",
      limit: 10,
    },
    contactActionAllowed: false as const,
    spendAuthorized: false as const,
  };
  return velvetAcquisitionSourcingAssignmentSchema.parse({
    ...payload,
    assignmentHash: hashVelvetAcquisitionSourcingValue(payload),
  });
}

test("SMIRK binds experiment discovery to one exact frozen definition", () => {
  const binding = velvetAcquisitionSourcingBindingSchema.parse({
    contractVersion: VELVET_ACQUISITION_SOURCING_BINDING_CONTRACT,
    experimentId,
    definitionHash,
  });
  const request = buildVelvetDiscoveryRequest({
    requestId: discoveryRequestId,
    workspaceId: 1,
    criteria: { limit: 10, learningMode: "experiment" },
    acquisitionExperiment: binding,
  });
  const assignment = assignmentFixture();

  assert.equal(
    assignmentMatchesVelvetRequest({
      assignment,
      binding: request.acquisitionExperiment,
      requestId: request.requestId,
    }),
    true,
  );
  assert.equal(
    velvetDiscoveryRequestSchema.safeParse({
      ...request,
      acquisitionExperiment: undefined,
    }).success,
    false,
  );
  assert.equal(
    assignmentMatchesVelvetRequest({
      assignment: { ...assignment, requestId: `${discoveryRequestId}-x` },
      binding,
      requestId: request.requestId,
    }),
    false,
  );
});

test("lead pulls preserve the exact discovery assignment receipt", () => {
  const assignment = assignmentFixture();
  const sourceBinding =
    buildVelvetAcquisitionSourcingAssignmentBinding(assignment);
  const request = buildVelvetLeadSourceRequest({
    requestId: "smirk-source-experiment-97361295-0001",
    workspaceId: 1,
    sourceDiscoveryRequestId: discoveryRequestId,
    sourceAcquisitionExperimentAssignment: sourceBinding,
    criteria: {
      limit: 10,
      category: "plumbing",
      city: "Reno",
      state: "NV",
      learningMode: "none",
    },
  });

  assert.equal(
    assignmentMatchesVelvetSourceBinding({
      assignment,
      binding: request.sourceAcquisitionExperimentAssignment,
    }),
    true,
  );
  assert.equal(
    velvetLeadSourceRequestSchema.safeParse({
      ...request,
      sourceDiscoveryRequestId: "smirk-discovery-experiment-97361295-9999",
    }).success,
    false,
  );
});

test("forged assignment hashes fail before attribution", () => {
  const assignment = assignmentFixture();
  assert.equal(
    velvetAcquisitionSourcingAssignmentSchema.safeParse({
      ...assignment,
      arm: "challenger",
    }).success,
    false,
  );
});
