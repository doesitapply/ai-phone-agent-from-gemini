import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildProspectAcquisitionConfigurationStagePlan,
  evaluateProspectAcquisitionConfigurationStageApproval,
  SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET,
  verifyProspectAcquisitionConfigurationStage,
  type ProspectAcquisitionConfigurationStageSnapshot,
} from "../src/prospect-acquisition-configuration-stage.ts";

const snapshot: ProspectAcquisitionConfigurationStageSnapshot = {
  ...SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET,
  headCommit: "a".repeat(40),
  liveCommit: "b".repeat(40),
  liveReadinessConfirmed: true,
  deploymentIds: ["deployment-current", "deployment-previous"],
  activeDeploymentPresent: false,
  worktreeClean: true,
  headPublished: true,
};

const authorityAssignments = {
  VELVET_LEAD_SOURCE_BASE_URL: "https://velvetalchemy.manus.space",
  VELVET_BASE_URL: "https://velvetalchemy.manus.space",
  VELVET_LEAD_SOURCE_API_KEY: `research-${"r".repeat(32)}`,
  VELVET_OUTCOME_API_KEY: `outcome-${"o".repeat(32)}`,
  VELVET_OUTCOME_SIGNING_SECRET: `signing-${"s".repeat(32)}`,
  VELVET_LEAD_SOURCE_WORKSPACE_ID: "1",
  VELVET_OUTCOME_WORKSPACE_ID: "1",
};

const noContactAssignments = {
  ...authorityAssignments,
  VELVET_DISCOVERY_ENABLED: "false",
  VELVET_LEAD_SOURCE_ENABLED: "false",
  PROSPECT_REVENUE_LOOP_PREPARER_ENABLED: "false",
  PROSPECT_REVENUE_LOOP_PREPARER_API_KEY: `preparer-${"p".repeat(32)}`,
  PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID: "1",
  PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT: "1",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY: "plumbing",
  PROSPECT_REVENUE_LOOP_DISCOVERY_CITY: "Reno",
  PROSPECT_REVENUE_LOOP_DISCOVERY_STATE: "NV",
};

test("a valid private authority bundle produces a redacted digest-bound dry run", () => {
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {
      DASHBOARD_API_KEY: `dashboard-${"d".repeat(32)}`,
    },
    requestedAssignments: authorityAssignments,
    snapshot,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.mutationRequired, true);
  assert.equal(plan.stagedConfigurationReady, true);
  assert.equal(plan.allExecutionSwitchesDisabled, true);
  assert.equal(plan.assignmentNames.length, 7);
  assert.match(plan.assignmentDigest, /^[a-f0-9]{64}$/);
  assert.match(
    plan.approvalPhrase,
    /^APPROVE_SMIRK_PROSPECT_ACQUISITION_CONFIG_STAGE:/
  );
  const serialized = JSON.stringify(plan);
  for (const secret of [
    authorityAssignments.VELVET_LEAD_SOURCE_API_KEY,
    authorityAssignments.VELVET_OUTCOME_API_KEY,
    authorityAssignments.VELVET_OUTCOME_SIGNING_SECRET,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("the assignment digest changes when a private value, target, or commit changes", () => {
  const base = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: authorityAssignments,
    snapshot,
  });
  const changedSecret = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: {
      ...authorityAssignments,
      VELVET_OUTCOME_SIGNING_SECRET: `changed-${"x".repeat(32)}`,
    },
    snapshot,
  });
  const changedTarget = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: authorityAssignments,
    snapshot: { ...snapshot, serviceId: "service-other" },
  });
  const changedCommit = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: authorityAssignments,
    snapshot: { ...snapshot, headCommit: "c".repeat(40) },
  });

  assert.notEqual(base.assignmentDigest, changedSecret.assignmentDigest);
  assert.notEqual(base.assignmentDigest, changedTarget.assignmentDigest);
  assert.notEqual(base.assignmentDigest, changedCommit.assignmentDigest);
});

test("missing, extra, malformed, reused, and unsafe values fail closed", () => {
  const invalid = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {
      DASHBOARD_API_KEY: authorityAssignments.VELVET_LEAD_SOURCE_API_KEY,
    },
    requestedAssignments: {
      ...authorityAssignments,
      VELVET_OUTCOME_API_KEY:
        authorityAssignments.VELVET_LEAD_SOURCE_API_KEY,
      VELVET_OUTCOME_SIGNING_SECRET: "contains\nnewline",
      VELVET_OUTCOME_WORKSPACE_ID: undefined,
      UNREVIEWED_VARIABLE: "not-allowed",
    },
    snapshot,
  });

  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.blockers.includes(
      "STAGE_VARIABLE_NOT_ALLOWED:UNREVIEWED_VARIABLE"
    )
  );
  assert.ok(
    invalid.blockers.includes(
      "STAGE_VALUE_NOT_STRING:VELVET_OUTCOME_WORKSPACE_ID"
    )
  );
  assert.ok(
    invalid.blockers.includes(
      "STAGE_VALUE_INVALID:VELVET_OUTCOME_SIGNING_SECRET"
    )
  );
  assert.ok(invalid.blockers.includes("VELVET_OPERATOR_KEY_SEPARATION"));
  assert.ok(
    invalid.blockers.includes("VELVET_SOURCE_OUTCOME_KEY_SEPARATION")
  );
});

test("all execution switches must remain false during phase staging", () => {
  const safe = buildProspectAcquisitionConfigurationStagePlan({
    phase: "no-contact-discovery",
    currentVariables: {},
    requestedAssignments: noContactAssignments,
    snapshot,
  });
  const enabled = buildProspectAcquisitionConfigurationStagePlan({
    phase: "no-contact-discovery",
    currentVariables: {},
    requestedAssignments: {
      ...noContactAssignments,
      VELVET_DISCOVERY_ENABLED: "true",
    },
    snapshot,
  });

  assert.equal(safe.ok, true);
  assert.equal(safe.allExecutionSwitchesDisabled, true);
  assert.equal(enabled.ok, false);
  assert.equal(enabled.allExecutionSwitchesDisabled, false);
  assert.ok(
    enabled.blockers.includes("STAGE_EXECUTION_SWITCH_MUST_REMAIN_DISABLED")
  );

  const laterSwitchAlreadyEnabled =
    buildProspectAcquisitionConfigurationStagePlan({
      phase: "velvet-authority",
      currentVariables: {
        PROSPECT_EMAIL_EXECUTION_ENABLED: "true",
      },
      requestedAssignments: authorityAssignments,
      snapshot,
    });
  assert.equal(laterSwitchAlreadyEnabled.ok, false);
  assert.equal(
    laterSwitchAlreadyEnabled.allExecutionSwitchesDisabled,
    false
  );
  assert.ok(
    laterSwitchAlreadyEnabled.blockers.includes(
      "STAGE_EXECUTION_SWITCH_NOT_DISABLED:PROSPECT_EMAIL_EXECUTION_ENABLED"
    )
  );
});

test("only the exact generated approval authorizes no-deploy staging", () => {
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: authorityAssignments,
    snapshot,
  });
  const forged = evaluateProspectAcquisitionConfigurationStageApproval({
    plan,
    providedApproval: "approve",
  });
  const exact = evaluateProspectAcquisitionConfigurationStageApproval({
    plan,
    providedApproval: plan.approvalPhrase,
  });

  assert.equal(forged.authorized, false);
  assert.ok(
    forged.blockers.includes("EXACT_PROVIDER_MUTATION_APPROVAL_MISSING")
  );
  assert.equal(exact.authorized, true);
  assert.equal(exact.providerMutationAuthorized, true);
  assert.equal(exact.deploymentAuthorized, false);
  assert.equal(exact.contactAuthorized, false);
  assert.equal(exact.spendAuthorized, false);
});

test("the exact production target and clean published source are mandatory", () => {
  const wrongTarget = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: {},
    requestedAssignments: authorityAssignments,
    snapshot: {
      ...snapshot,
      serviceId: "another-service",
      worktreeClean: false,
      headPublished: false,
    },
  });

  assert.equal(wrongTarget.ok, false);
  assert.ok(
    wrongTarget.blockers.includes("RAILWAY_SERVICE_NOT_SMIRK_PRODUCTION")
  );
  assert.ok(wrongTarget.blockers.includes("LOCAL_WORKTREE_DIRTY"));
  assert.ok(wrongTarget.blockers.includes("LOCAL_HEAD_NOT_PUBLISHED"));
});

test("an exact staged diff verifies without exposing values or claiming runtime activation", () => {
  const before = {
    APP_URL: "https://smirkcalls.com",
    VELVET_BASE_URL: "https://old.invalid",
  };
  const after = { ...before, ...authorityAssignments };
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: before,
    requestedAssignments: authorityAssignments,
    snapshot,
  });
  const verification = verifyProspectAcquisitionConfigurationStage({
    phase: "velvet-authority",
    beforeVariables: before,
    afterVariables: after,
    requestedAssignments: authorityAssignments,
    snapshot,
    afterDeploymentIds: snapshot.deploymentIds,
    acceptedAssignmentNames: plan.changedNames,
  });

  assert.equal(verification.ok, true);
  assert.equal(verification.productionConfigurationStaged, true);
  assert.equal(verification.deploymentPerformed, false);
  assert.equal(verification.runtimeActivated, false);
  assert.equal(verification.allExecutionSwitchesDisabled, true);
  assert.equal(
    JSON.stringify(verification).includes(
      authorityAssignments.VELVET_OUTCOME_API_KEY
    ),
    false
  );
});

test("unrelated variable drift, value mismatch, partial acceptance, or deployment fails verification", () => {
  const before = { KEEP: "same" };
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: before,
    requestedAssignments: authorityAssignments,
    snapshot,
  });
  const after = {
    KEEP: "changed",
    ...authorityAssignments,
    VELVET_OUTCOME_API_KEY: `wrong-${"w".repeat(32)}`,
  };
  const verification = verifyProspectAcquisitionConfigurationStage({
    phase: "velvet-authority",
    beforeVariables: before,
    afterVariables: after,
    requestedAssignments: authorityAssignments,
    snapshot,
    afterDeploymentIds: ["deployment-new", ...snapshot.deploymentIds],
    acceptedAssignmentNames: plan.changedNames.slice(0, -1),
  });

  assert.equal(verification.ok, false);
  assert.ok(
    verification.blockers.includes("RAILWAY_VARIABLE_DIFF_OUT_OF_SCOPE")
  );
  assert.ok(
    verification.blockers.includes("RAILWAY_VARIABLE_VALUE_MISMATCH")
  );
  assert.ok(
    verification.blockers.includes("RAILWAY_VARIABLE_SET_NOT_ACCEPTED")
  );
  assert.ok(
    verification.blockers.includes("UNEXPECTED_DEPLOYMENT_OBSERVED")
  );
  assert.equal(verification.runtimeActivated, false);
});

test("an already matching bundle is idempotent and cannot consume fresh approval", () => {
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: "velvet-authority",
    currentVariables: authorityAssignments,
    requestedAssignments: authorityAssignments,
    snapshot,
  });
  const approval = evaluateProspectAcquisitionConfigurationStageApproval({
    plan,
    providedApproval: plan.approvalPhrase,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.idempotentReplay, true);
  assert.equal(plan.mutationRequired, false);
  assert.equal(approval.authorized, false);
  assert.ok(
    approval.blockers.includes("STAGE_CONFIGURATION_ALREADY_MATCHES")
  );
});

test("the CLI requires a private file and stages with skip-deploys only", async () => {
  const [source, railwaySource] = await Promise.all([
    readFile(
      new URL(
        "../scripts/stage-prospect-acquisition-configuration.ts",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("../scripts/railway-json.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(source, /metadata\.mode & 0o077/);
  assert.match(source, /suppliedMetadata\.isSymbolicLink\(\)/);
  assert.match(source, /metadata\.ino !== suppliedMetadata\.ino/);
  assert.match(source, /VALUES_FILE_INSIDE_REPOSITORY/);
  assert.match(source, /metadata\.nlink !== 1/);
  assert.match(source, /skipDeploys: true/);
  assert.match(source, /graphqlOnly: true/);
  assert.match(source, /SMIRK_PROSPECT_ACQUISITION_STAGE_APPROVAL/);
  assert.doesNotMatch(source, /railway\s+(up|deploy)/i);
  assert.doesNotMatch(source, /JSON\.stringify\(requestedAssignments/);
  assert.match(railwaySource, /input: JSON\.stringify\(\{/);
  assert.doesNotMatch(railwaySource, /`Authorization: Bearer \$\{token\}`/);
  assert.doesNotMatch(railwaySource, /"--data"/);
});
