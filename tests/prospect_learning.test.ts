import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectLearningScorecard,
  evaluateProspectLearningCandidate,
  type LearningObservation,
} from "../src/prospect-learning.ts";

const observations: LearningObservation[] = [
  ...Array.from({ length: 10 }, (_, index) => ({
    outreachJobId: `current-${index + 1}`,
    channel: "email" as const,
    variantKey: "current-v1",
    outcome: (index < 2 ? "replied" : "delivered") as
      | "replied"
      | "delivered",
    occurredAt: new Date(Date.UTC(2026, 6, 1, 9, index)).toISOString(),
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    outreachJobId: `challenger-${index + 1}`,
    channel: "email" as const,
    variantKey: "challenger-v2",
    outcome: (index < 4 ? "replied" : "delivered") as
      | "replied"
      | "delivered",
    occurredAt: new Date(Date.UTC(2026, 6, 2, 9, index)).toISOString(),
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
  assert.equal(
    scores.find((score) => score.variantKey === "challenger-v2")?.eventCount,
    10
  );
});

test("counts one canonical lifecycle outcome per executed outreach job", () => {
  const scores = buildProspectLearningScorecard([
    {
      outreachJobId: "job-1",
      channel: "email",
      variantKey: "current-v1",
      outcome: "delivered",
      occurredAt: "2026-07-01T09:00:00.000Z",
    },
    {
      outreachJobId: "job-1",
      channel: "email",
      variantKey: "current-v1",
      outcome: "replied",
      occurredAt: "2026-07-01T09:05:00.000Z",
    },
    {
      outreachJobId: "job-1",
      channel: "email",
      variantKey: "current-v1",
      outcome: "qualified",
      occurredAt: "2026-07-01T09:10:00.000Z",
    },
    {
      outreachJobId: "job-2",
      channel: "email",
      variantKey: "current-v1",
      outcome: "replied",
      occurredAt: "2026-07-01T10:00:00.000Z",
    },
    {
      outreachJobId: "job-2",
      channel: "email",
      variantKey: "current-v1",
      outcome: "not_interested",
      occurredAt: "2026-07-01T10:05:00.000Z",
    },
    {
      outreachJobId: "job-1",
      channel: "email",
      variantKey: "current-v1",
      outcome: "delivered",
      occurredAt: "2026-07-01T10:30:00.000Z",
    },
  ]);

  assert.equal(scores.length, 1);
  assert.equal(scores[0].sampleSize, 2);
  assert.equal(scores[0].eventCount, 6);
  assert.equal(scores[0].positive, 1);
  assert.equal(scores[0].positiveRate, 0.5);
  assert.deepEqual(scores[0].outcomes, {
    qualified: 1,
    not_interested: 1,
  });
});

test("does not let repeated events satisfy the ten-job promotion gate", () => {
  const repeatedEvents = [
    ...observations.filter((observation) =>
      observation.outreachJobId.startsWith("challenger-")
    ),
    ...Array.from({ length: 10 }, (_, index) => ({
      outreachJobId: `current-${(index % 5) + 1}`,
      channel: "email" as const,
      variantKey: "current-v1",
      outcome: index % 2 === 0 ? ("delivered" as const) : ("replied" as const),
      occurredAt: new Date(Date.UTC(2026, 6, 3, 9, index)).toISOString(),
    })),
  ];

  assert.deepEqual(
    evaluateProspectLearningCandidate({
      channel: "email",
      currentVariant: "current-v1",
      challengerVariant: "challenger-v2",
      observations: repeatedEvents,
    }),
    { ready: false, code: "INSUFFICIENT_SAMPLE", sampleSize: 15 }
  );
});

test("fails closed when one outreach job changes strategy attribution", () => {
  assert.throws(
    () =>
      buildProspectLearningScorecard([
        {
          outreachJobId: "job-conflict",
          channel: "email",
          variantKey: "current-v1",
          outcome: "delivered",
          occurredAt: "2026-07-01T09:00:00.000Z",
        },
        {
          outreachJobId: "job-conflict",
          channel: "email",
          variantKey: "challenger-v2",
          outcome: "replied",
          occurredAt: "2026-07-01T09:05:00.000Z",
        },
      ]),
    /changed channel or strategy attribution/
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
