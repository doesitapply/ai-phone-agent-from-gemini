import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION,
  PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_HOURS,
  buildProspectMessageExperimentAssignment,
  buildProspectMessageExperimentDefinition,
  hashProspectMessageExperimentDefinition,
  prospectMessageExperimentObservationWindowEndsAt,
  prospectMessageExperimentDefinitionSchema,
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
  eligibleProspectIds: Array.from(
    { length: 100 },
    (_, index) => index + 1
  ),
  cohortSize: 20,
});
const selectedProspectId = definition.cohort[0].prospectId;

test("uses fixed channel-specific outcome observation windows", () => {
  assert.equal(
    PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_HOURS.email,
    168
  );
  assert.equal(
    PROSPECT_MESSAGE_EXPERIMENT_OBSERVATION_WINDOW_HOURS.call,
    72
  );
  assert.equal(
    prospectMessageExperimentObservationWindowEndsAt({
      channel: "email",
      latestSentAt: "2026-07-30T17:00:00.000Z",
    }),
    "2026-08-06T17:00:00.000Z"
  );
  assert.throws(
    () =>
      prospectMessageExperimentObservationWindowEndsAt({
        channel: "call",
        latestSentAt: "not-a-date",
      }),
    /latest-send timestamp is invalid/
  );
});

test("builds a deterministic, definition-bound assignment", () => {
  const first = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: selectedProspectId,
    actualVariantKey: "owner-language-v1",
  });
  const replay = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: selectedProspectId,
    actualVariantKey: "owner-language-v1",
  });

  assert.deepEqual(first, replay);
  assert.equal(first.experimentDefinitionHash, hashProspectMessageExperimentDefinition(definition));
  assert.equal(first.workspaceId, 7);
  assert.equal(first.campaignId, 11);
  assert.equal(first.prospectId, selectedProspectId);
  assert.equal(verifyProspectMessageExperimentAssignment({
    definition,
    assignment: first,
  }), true);
});

test("marks operator content that differs from the assigned strategy off protocol", () => {
  const assigned = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: selectedProspectId,
    actualVariantKey: "owner-language-v1",
  });
  const deviated = buildProspectMessageExperimentAssignment({
    definition,
    prospectId: selectedProspectId,
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
    prospectId: selectedProspectId,
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

test("frozen cohort uses exact balanced assignment and rejects outside enrollment", () => {
  const assignments = definition.cohort.map(entry =>
    buildProspectMessageExperimentAssignment({
      definition,
      prospectId: entry.prospectId,
      actualVariantKey: entry.assignedVariantKey,
    })
  );
  const controls = assignments.filter(
    assignment => assignment.arm === "control"
  ).length;

  assert.equal(definition.eligiblePopulationSize, 100);
  assert.equal(definition.cohortSize, 20);
  assert.equal(controls, 10);
  assert.equal(assignments.length - controls, 10);
  assert.equal(
    new Set(assignments.map(assignment => assignment.assignmentHash)).size,
    20
  );
  const selected = new Set(
    definition.cohort.map(entry => entry.prospectId)
  );
  const outsideProspectId = definition.eligibleProspectIds.find(
    prospectId => !selected.has(prospectId)
  );
  assert.ok(outsideProspectId);
  assert.throws(
    () =>
      buildProspectMessageExperimentAssignment({
        definition,
        prospectId: outsideProspectId,
        actualVariantKey: "owner-language-v1",
      }),
    /not part of the experiment's frozen cohort/
  );
});

test("eligible population order cannot change deterministic cohort selection", () => {
  const replay = buildProspectMessageExperimentDefinition({
    experimentId: definition.experimentId,
    workspaceId: definition.workspaceId,
    campaignId: definition.campaignId,
    channel: definition.channel,
    controlVariantKey: definition.controlVariantKey,
    challengerVariantKey: definition.challengerVariantKey,
    preparedAt: definition.preparedAt,
    eligibleProspectIds: [...definition.eligibleProspectIds].reverse(),
    cohortSize: definition.cohortSize,
  });

  assert.deepEqual(replay, definition);
});

test("stored v1 definitions retain their legacy assignment semantics", () => {
  const legacy = prospectMessageExperimentDefinitionSchema.parse({
    contractVersion:
      PROSPECT_MESSAGE_EXPERIMENT_LEGACY_CONTRACT_VERSION,
    experimentId: "33333333-3333-4333-8333-333333333333",
    workspaceId: 7,
    campaignId: 11,
    channel: "email",
    controlVariantKey: "owner-language-v1",
    challengerVariantKey: "owner-language-v2",
    allocationBasisPoints: 5_000,
    preparedAt: "2026-07-29T20:00:00.000Z",
  });
  const assignment = buildProspectMessageExperimentAssignment({
    definition: legacy,
    prospectId: 9_999,
    actualVariantKey: legacy.controlVariantKey,
  });

  assert.equal(
    verifyProspectMessageExperimentAssignment({
      definition: legacy,
      assignment,
    }),
    true
  );
  assert.equal(assignment.prospectId, 9_999);
});
