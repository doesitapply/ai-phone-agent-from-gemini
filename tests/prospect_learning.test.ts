import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectLearningScorecard,
  evaluateProspectLearningCandidate,
  type LearningObservation,
} from "../src/prospect-learning.ts";

const observations: LearningObservation[] = [
  ...Array.from({ length: 10 }, (_, index) => ({
    channel: "email" as const,
    variantKey: "current-v1",
    outcome: (index < 2 ? "replied" : "delivered") as
      | "replied"
      | "delivered",
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    channel: "email" as const,
    variantKey: "challenger-v2",
    outcome: (index < 4 ? "replied" : "delivered") as
      | "replied"
      | "delivered",
  })),
];

test("builds measured scorecards by channel and variant", () => {
  const scores = buildProspectLearningScorecard(observations);
  assert.equal(scores.length, 2);
  assert.equal(
    scores.find((score) => score.variantKey === "current-v1")?.positiveRate,
    0.2
  );
  assert.equal(
    scores.find((score) => score.variantKey === "challenger-v2")
      ?.positiveRate,
    0.4
  );
});

test("creates only a human-review candidate after both variants have enough data", () => {
  const result = evaluateProspectLearningCandidate({
    channel: "email",
    currentVariant: "current-v1",
    challengerVariant: "challenger-v2",
    observations,
  });
  assert.equal(result.ready, true);
  if (result.ready) {
    assert.equal(result.proposal.promoteVariant, "challenger-v2");
    assert.equal(result.evidence.absoluteLift, 0.2);
    assert.equal(result.sampleSize, 20);
  }
});

test("refuses low-sample and no-lift promotion candidates", () => {
  assert.deepEqual(
    evaluateProspectLearningCandidate({
      channel: "email",
      currentVariant: "current-v1",
      challengerVariant: "challenger-v2",
      observations: observations.slice(0, 9),
    }),
    { ready: false, code: "INSUFFICIENT_SAMPLE", sampleSize: 9 }
  );
  const noLift = evaluateProspectLearningCandidate({
    channel: "email",
    currentVariant: "challenger-v2",
    challengerVariant: "current-v1",
    observations,
  });
  assert.equal(noLift.ready, false);
  if (!noLift.ready) assert.equal(noLift.code, "NO_MEASURED_LIFT");
});
