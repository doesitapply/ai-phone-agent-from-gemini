import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectRevenueLoopStatus,
  type ProspectRevenueLoopConnections,
  type ProspectRevenueLoopCounts,
} from "../src/prospect-revenue-loop.ts";
import {
  buildProspectRevenueLoopCheckpoint,
  hashProspectRevenueLoopStatus,
  prospectRevenueLoopStatusSchema,
} from "../src/prospect-revenue-loop-runner.ts";

function counts(
  update: Partial<ProspectRevenueLoopCounts> = {}
): ProspectRevenueLoopCounts {
  return {
    campaigns: 0,
    discoveryPrepared: 0,
    discoveryApproved: 0,
    discoveryInFlight: 0,
    discoveryReadyForImport: 0,
    discoveryFailed: 0,
    sourcePrepared: 0,
    sourceApproved: 0,
    sourceInFlight: 0,
    pendingReviewLeads: 0,
    qualifiedLeads: 0,
    qualifiedEmailLeadsWithoutOutreach: 0,
    qualifiedCallLeadsWithoutOutreach: 0,
    qcRevisionsRequired: 0,
    outreachPrepared: 0,
    outreachApprovedEmail: 0,
    outreachApprovedCall: 0,
    outreachSending: 0,
    outreachSentWithoutOutcome: 0,
    outreachSentEmailWithoutOutcome: 0,
    outreachSentCallWithoutOutcome: 0,
    outcomeEvents: 0,
    positiveOutcomeJobs: 0,
    unreviewedPositiveOutcomeJobs: 0,
    velvetCallbacksPrepared: 0,
    velvetCallbacksSending: 0,
    passingInboxTests: 0,
    emailExperimentsPrepared: 0,
    emailExperimentsPreparedWithMatchingInboxTest: 0,
    emailExperimentsActive: 0,
    emailExperimentsReadyToClose: 0,
    emailExperimentUnenrolled: 0,
    callExperimentsPrepared: 0,
    callExperimentsActive: 0,
    callExperimentsReadyToClose: 0,
    callExperimentUnenrolled: 0,
    closedExperiments: 0,
    learningCandidatesPending: 0,
    learningCandidatesApproved: 0,
    learningCandidatesApprovedUnapplied: 0,
    ...update,
  };
}

function connections(
  available: boolean
): ProspectRevenueLoopConnections {
  const value = {
    configured: available,
    enabled: available,
    availableForWorkspace: available,
    missing: available ? [] : ["SYNTHETIC_CONFIGURATION"],
  };
  return {
    velvetDiscovery: { ...value },
    velvetSource: { ...value },
    advisoryQc: { ...value },
    emailProvider: { ...value },
    emailWebhook: { ...value },
    inboxPlacement: { ...value },
    velvetOutcome: { ...value },
  };
}

test("configuration checkpoints remain scheduler-visible but inert", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts(),
    connections: connections(false),
  });
  const checkpoint = buildProspectRevenueLoopCheckpoint({
    workspaceId: 7,
    observedAt: "2026-07-31T04:30:00.000Z",
    sourceOrigin: "https://smirkcalls.com/dashboard/prospecting",
    status,
  });
  assert.equal(checkpoint.schedulerDecision, "WAIT_CONFIGURATION");
  assert.equal(checkpoint.shouldScheduleNextCheck, true);
  assert.equal(checkpoint.hardStop, null);
  assert.equal(checkpoint.sourceOrigin, "https://smirkcalls.com");
  assert.equal(checkpoint.controls.contactAuthorized, false);
  assert.equal(checkpoint.controls.executionAuthorized, false);
  assert.equal(checkpoint.controls.spendAuthorized, false);
  assert.equal(checkpoint.controls.policyMutationAuthorized, false);
  assert.equal(checkpoint.controls.providerRequestAuthorized, false);
});

test("a measured interaction is a hard stop for the scheduled loop", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts({
      outcomeEvents: 3,
      positiveOutcomeJobs: 1,
      unreviewedPositiveOutcomeJobs: 1,
      emailExperimentsActive: 1,
      sourceApproved: 1,
      outreachApprovedEmail: 1,
    }),
    connections: connections(true),
  });
  const checkpoint = buildProspectRevenueLoopCheckpoint({
    workspaceId: 7,
    observedAt: "2026-07-31T04:31:00.000Z",
    sourceOrigin: "https://smirkcalls.com",
    status,
  });
  assert.equal(status.nextAction.code, "REVIEW_POSITIVE_OUTCOME");
  assert.equal(checkpoint.schedulerDecision, "STOP_INTERACTION");
  assert.equal(checkpoint.shouldScheduleNextCheck, false);
  assert.equal(checkpoint.hardStop, "interaction");
  assert.equal(checkpoint.nextAction.executionEffect, "none");
});

test("reviewed historical interactions do not stop future checkpoints", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts({
      outcomeEvents: 3,
      positiveOutcomeJobs: 1,
      unreviewedPositiveOutcomeJobs: 0,
      discoveryPrepared: 1,
    }),
    connections: connections(true),
  });
  const checkpoint = buildProspectRevenueLoopCheckpoint({
    workspaceId: 7,
    observedAt: "2026-07-31T04:31:30.000Z",
    sourceOrigin: "https://smirkcalls.com",
    status,
  });
  assert.equal(status.nextAction.code, "APPROVE_VELVET_DISCOVERY");
  assert.equal(checkpoint.schedulerDecision, "WAIT_HUMAN");
  assert.equal(checkpoint.shouldScheduleNextCheck, true);
  assert.equal(checkpoint.hardStop, null);
});

test("checkpoint hashing is stable and excludes observation time", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts({ outreachPrepared: 1 }),
    connections: connections(true),
  });
  const first = buildProspectRevenueLoopCheckpoint({
    workspaceId: 7,
    observedAt: "2026-07-31T04:32:00.000Z",
    sourceOrigin: "https://smirkcalls.com",
    status,
  });
  const second = buildProspectRevenueLoopCheckpoint({
    workspaceId: 7,
    observedAt: "2026-07-31T04:33:00.000Z",
    sourceOrigin: "https://smirkcalls.com",
    status,
  });
  assert.equal(first.statusHash, second.statusHash);
  assert.equal(first.statusHash, hashProspectRevenueLoopStatus(status));
  assert.notEqual(first.checkpointId, second.checkpointId);
});

test("runner input rejects widened guardrails or unknown actions", () => {
  const status = buildProspectRevenueLoopStatus({
    counts: counts(),
    connections: connections(false),
  });
  assert.equal(
    prospectRevenueLoopStatusSchema.safeParse({
      ...status,
      guardrails: {
        ...status.guardrails,
        smsAllowed: true,
      },
    }).success,
    false
  );
  assert.equal(
    prospectRevenueLoopStatusSchema.safeParse({
      ...status,
      nextAction: {
        ...status.nextAction,
        code: "AUTO_SEND_THE_BATCH",
      },
    }).success,
    false
  );
  assert.equal(
    prospectRevenueLoopStatusSchema.safeParse({
      ...status,
      nextAction: {
        ...status.nextAction,
        focus: {
          kind: "positive_outcome_review",
          reviewId: "11ec14f9-d4f0-4c3e-89fb-846d9be1f4a6",
        },
      },
    }).success,
    true
  );
  assert.equal(
    prospectRevenueLoopStatusSchema.safeParse({
      ...status,
      nextAction: {
        ...status.nextAction,
        focus: {
          kind: "learning_candidate",
          candidateId: 0,
        },
      },
    }).success,
    false
  );
});
