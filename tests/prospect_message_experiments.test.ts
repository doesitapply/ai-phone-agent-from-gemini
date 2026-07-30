import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectMessageExperimentAssignment,
  buildProspectMessageExperimentDefinition,
  hashProspectMessageExperimentDefinition,
  verifyProspectMessageExperimentAssignment,
} from "../src/prospect-message-experiments.ts";

const definition = buildProspectMessageExperimentDefinition({
  experimentId: "22222222-2222-4222-8222-222222222222",
  workspaceId: 7,
  campaignId: 11,
  channel: "email",
  controlVariantKey: "owner-language-v1",
  challengerVariantKey: "owner-language-v2",
  preparedAt: "2026-07-30T20:00:00.000Z",
});

test("builds a deterministic, definition-bound assignment", () => {
  const first = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: 31,
    actualVariantKey: "owner-language-v1",
  });
  const replay = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: 31,
    actualVariantKey: "owner-language-v1",
  });

  assert.deepEqual(first, replay);
  assert.equal(first.experimentDefinitionHash, hashProspectMessageExperimentDefinition(definition));
  assert.equal(first.workspaceId, 7);
  assert.equal(first.campaignId, 11);
  assert.equal(first.prospectId, 31);
  assert.equal(verifyProspectMessageExperimentAssignment({
    definition,
    assignment: first,
  }), true);
});

test("marks operator content that differs from the assigned strategy off protocol", () => {
  const assigned = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: 31,
    actualVariantKey: "owner-language-v1",
  });
  const deviated = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: 31,
    actualVariantKey:
      assigned.assignedVariantKey === "owner-language-v1"
        ? "owner-language-v2"
        : "owner-language-v1",
  });

  assert.equal(deviated.assignedVariantKey, assigned.assignedVariantKey);
  assert.equal(deviated.protocolCompliant, false);
  assert.notEqual(deviated.assignmentHash, "");
});

test("changed experiment or assignment bytes fail verification", () => {
  const assignment = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: 42,
    actualVariantKey: "owner-language-v2",
  });
  const changedDefinition = {
    ...definition,
    challengerVariantKey: "owner-language-v3",
  };

  assert.equal(verifyProspectMessageExperimentAssignment({
    definition: changedDefinition,
    assignment,
  }), false);
  assert.equal(verifyProspectMessageExperimentAssignment({
    definition,
    assignment: {
      ...assignment,
      allocationBucket: (assignment.allocationBucket + 1) % 10_000,
    },
  }), false);
});

test("assignment distribution uses both arms without changing per-prospect replay", () => {
  const assignments = Array.from({ length: 100 }, (_, index) =>
    buildProspectMessageExperimentAssignment({
      definition,
      prospectId: index + 1,
      actualVariantKey: "owner-language-v1",
    })
  );
  const controls = assignments.filter(
    assignment => assignment.arm === "control"
  ).length;

  assert.ok(controls >= 35 && controls <= 65);
  assert.equal(
    new Set(assignments.map(assignment => assignment.assignmentHash)).size,
    100
  );
});
