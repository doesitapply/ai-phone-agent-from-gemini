import assert from "node:assert/strict";
import test from "node:test";
import {
  VELVET_HANDOFF_CONTAINMENT_APPROVAL,
  VELVET_HANDOFF_CREDENTIAL_VARIABLE,
  buildVelvetHandoffContainmentPlan,
  diffRailwayVariableMaps,
  evaluateVelvetHandoffContainmentApproval,
  verifyVelvetHandoffContainmentStage,
  type VelvetHandoffContainmentSnapshot,
} from "../src/velvet-handoff-containment.ts";

const snapshot: VelvetHandoffContainmentSnapshot = {
  projectId: "project-production",
  serviceId: "service-smirk",
  environmentId: "environment-production",
  liveCommit: "a".repeat(40),
  liveReadinessConfirmed: true,
  liveSourceAvailable: true,
  liveSyntheticBoundaryPresent: false,
  targetVariablePresent: true,
  variableCount: 12,
  deploymentIds: ["deployment-current", "deployment-previous"],
};

const exactApproval = {
  approvalPhrase: VELVET_HANDOFF_CONTAINMENT_APPROVAL,
  expectedProjectId: snapshot.projectId,
  expectedServiceId: snapshot.serviceId,
  expectedEnvironmentId: snapshot.environmentId,
  expectedLiveCommit: snapshot.liveCommit,
};

test("dry-run plan never claims a provider write, deploy, or containment", () => {
  const plan = buildVelvetHandoffContainmentPlan(snapshot);

  assert.equal(plan.ok, true);
  assert.equal(plan.mutationRequired, true);
  assert.equal(plan.productionConfigChangeStaged, false);
  assert.equal(plan.deploymentPerformed, false);
  assert.equal(plan.runtimeContained, false);
  assert.equal(plan.guardrails.providerMutationAuthorized, false);
  assert.equal(plan.guardrails.deploymentAuthorized, false);
});

test("forged or partial approval fails closed", () => {
  const forged = evaluateVelvetHandoffContainmentApproval(snapshot, {
    ...exactApproval,
    approvalPhrase: "approve",
  });
  assert.equal(forged.authorized, false);
  assert.ok(
    forged.blockers.includes("EXACT_PROVIDER_MUTATION_APPROVAL_MISSING")
  );

  const missing = evaluateVelvetHandoffContainmentApproval(snapshot, {
    approvalPhrase: null,
    expectedProjectId: null,
    expectedServiceId: null,
    expectedEnvironmentId: null,
    expectedLiveCommit: null,
  });
  assert.equal(missing.authorized, false);
  assert.ok(missing.blockers.length >= 5);
});

test("approval is bound to the exact provider target and live commit", () => {
  const stale = evaluateVelvetHandoffContainmentApproval(snapshot, {
    ...exactApproval,
    expectedServiceId: "another-service",
    expectedLiveCommit: "b".repeat(40),
  });

  assert.equal(stale.authorized, false);
  assert.deepEqual(stale.blockers, [
    "LIVE_SMIRK_COMMIT_CHANGED_SINCE_APPROVAL",
    "RAILWAY_SERVICE_CHANGED_SINCE_APPROVAL",
  ]);
});

test("exact approval authorizes only variable staging, never deployment", () => {
  const approval = evaluateVelvetHandoffContainmentApproval(
    snapshot,
    exactApproval
  );

  assert.equal(approval.authorized, true);
  assert.equal(
    approval.targetVariable,
    VELVET_HANDOFF_CREDENTIAL_VARIABLE
  );
  assert.equal(approval.deploymentAuthorized, false);
});

test("replayed staging is idempotent when the target is already absent", () => {
  const replaySnapshot = {
    ...snapshot,
    targetVariablePresent: false,
    variableCount: snapshot.variableCount - 1,
  };
  const plan = buildVelvetHandoffContainmentPlan(replaySnapshot);
  const approval = evaluateVelvetHandoffContainmentApproval(
    replaySnapshot,
    exactApproval
  );

  assert.equal(plan.idempotentReplay, true);
  assert.equal(plan.mutationRequired, false);
  assert.equal(plan.runtimeContained, false);
  assert.equal(approval.authorized, false);
  assert.ok(approval.blockers.includes("TARGET_VARIABLE_ALREADY_ABSENT"));
});

test("variable verification accepts exactly one removal and exposes no values", () => {
  const before = {
    APP_URL: "https://smirkcalls.com",
    [VELVET_HANDOFF_CREDENTIAL_VARIABLE]: "do-not-print-this-secret",
    DATABASE_URL: "do-not-print-this-database-url",
  };
  const after = {
    APP_URL: before.APP_URL,
    DATABASE_URL: before.DATABASE_URL,
  };
  const diff = diffRailwayVariableMaps(before, after);
  const verification = verifyVelvetHandoffContainmentStage({
    mutationAccepted: true,
    beforeVariables: before,
    afterVariables: after,
    beforeDeploymentIds: snapshot.deploymentIds,
    afterDeploymentIds: snapshot.deploymentIds,
  });

  assert.equal(diff.exactlyTargetRemoved, true);
  assert.equal(verification.ok, true);
  assert.equal(verification.productionConfigChangeStaged, true);
  assert.equal(verification.runtimeContained, false);
  assert.equal(verification.deploymentPerformed, false);
  assert.equal(
    JSON.stringify(verification).includes("do-not-print-this"),
    false
  );
});

test("unrelated variable drift or a new deployment makes verification fail", () => {
  const before = {
    KEEP: "same",
    [VELVET_HANDOFF_CREDENTIAL_VARIABLE]: "secret",
  };
  const outOfScope = verifyVelvetHandoffContainmentStage({
    mutationAccepted: true,
    beforeVariables: before,
    afterVariables: { KEEP: "changed" },
    beforeDeploymentIds: snapshot.deploymentIds,
    afterDeploymentIds: ["unexpected-deploy", ...snapshot.deploymentIds],
  });

  assert.equal(outOfScope.ok, false);
  assert.deepEqual(outOfScope.blockers, [
    "RAILWAY_VARIABLE_DIFF_OUT_OF_SCOPE",
    "UNEXPECTED_DEPLOYMENT_OBSERVED",
  ]);
  assert.equal(outOfScope.deploymentPerformed, true);
  assert.equal(outOfScope.runtimeContained, false);
});

test("missing live evidence and an already hardened receiver block legacy containment", () => {
  const missing = buildVelvetHandoffContainmentPlan({
    ...snapshot,
    liveCommit: null,
    liveReadinessConfirmed: false,
    liveSourceAvailable: false,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.blockers, [
    "LIVE_SMIRK_COMMIT_UNCONFIRMED",
    "LIVE_SMIRK_READINESS_UNCONFIRMED",
    "LIVE_SMIRK_SOURCE_UNAVAILABLE",
  ]);

  const hardened = buildVelvetHandoffContainmentPlan({
    ...snapshot,
    liveSyntheticBoundaryPresent: true,
  });
  assert.equal(hardened.ok, false);
  assert.deepEqual(hardened.blockers, ["LIVE_RECEIVER_IS_NOT_LEGACY"]);
});
