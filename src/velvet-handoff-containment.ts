export const VELVET_HANDOFF_CONTAINMENT_CONTRACT =
  "smirk.velvet-handoff-containment.v1";

export const VELVET_HANDOFF_CREDENTIAL_VARIABLE =
  "VELVET_ALCHEMY_HANDOFF_API_KEY";

export const VELVET_HANDOFF_CONTAINMENT_APPROVAL =
  "APPROVE_DISABLE_LEGACY_VELVET_HANDOFF_IN_RAILWAY";

export type VelvetHandoffContainmentSnapshot = {
  projectId: string;
  serviceId: string;
  environmentId: string;
  liveCommit: string | null;
  liveReadinessConfirmed: boolean;
  liveSourceAvailable: boolean;
  liveSyntheticBoundaryPresent: boolean;
  targetVariablePresent: boolean;
  variableCount: number;
  deploymentIds: string[];
};

export type VelvetHandoffContainmentApprovalInput = {
  approvalPhrase: string | null;
  expectedProjectId: string | null;
  expectedServiceId: string | null;
  expectedEnvironmentId: string | null;
  expectedLiveCommit: string | null;
};

export function buildVelvetHandoffContainmentPlan(
  snapshot: VelvetHandoffContainmentSnapshot
) {
  const blockers: string[] = [];

  if (!snapshot.projectId) blockers.push("RAILWAY_PROJECT_ID_MISSING");
  if (!snapshot.serviceId) blockers.push("RAILWAY_SERVICE_ID_MISSING");
  if (!snapshot.environmentId) {
    blockers.push("RAILWAY_ENVIRONMENT_ID_MISSING");
  }
  if (!snapshot.liveReadinessConfirmed) {
    blockers.push("LIVE_SMIRK_READINESS_UNCONFIRMED");
  }
  if (!snapshot.liveCommit || !/^[a-f0-9]{40}$/i.test(snapshot.liveCommit)) {
    blockers.push("LIVE_SMIRK_COMMIT_UNCONFIRMED");
  }
  if (!snapshot.liveSourceAvailable) {
    blockers.push("LIVE_SMIRK_SOURCE_UNAVAILABLE");
  }
  if (snapshot.liveSyntheticBoundaryPresent) {
    blockers.push("LIVE_RECEIVER_IS_NOT_LEGACY");
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const alreadyAbsent = !snapshot.targetVariablePresent;

  return {
    contractVersion: VELVET_HANDOFF_CONTAINMENT_CONTRACT,
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    targetVariable: VELVET_HANDOFF_CREDENTIAL_VARIABLE,
    mutationRequired: !alreadyAbsent,
    idempotentReplay: alreadyAbsent,
    runtimeContained: false,
    productionConfigChangeStaged: false,
    deploymentPerformed: false,
    deploymentRequiredToChangeRunningRevision: true,
    approvalPhrase: VELVET_HANDOFF_CONTAINMENT_APPROVAL,
    exactTarget: {
      projectId: snapshot.projectId,
      serviceId: snapshot.serviceId,
      environmentId: snapshot.environmentId,
      liveCommit: snapshot.liveCommit,
    },
    observed: {
      liveReadinessConfirmed: snapshot.liveReadinessConfirmed,
      liveSourceAvailable: snapshot.liveSourceAvailable,
      liveSyntheticBoundaryPresent:
        snapshot.liveSyntheticBoundaryPresent,
      targetVariablePresent: snapshot.targetVariablePresent,
      variableCount: snapshot.variableCount,
      deploymentCount: snapshot.deploymentIds.length,
    },
    guardrails: {
      coldSmsAllowed: false,
      automatedProspectDialingAllowed: false,
      contactAuthorized: false,
      spendAuthorized: false,
      providerMutationAuthorized: false,
      deploymentAuthorized: false,
    },
    nextGate: alreadyAbsent
      ? "Verify the running revision separately; absence from staged configuration does not prove runtime containment."
      : "Exact provider-mutation approval may stage removal of only the handoff credential. A separate deploy approval is required to change the running revision.",
  };
}

export function evaluateVelvetHandoffContainmentApproval(
  snapshot: VelvetHandoffContainmentSnapshot,
  input: VelvetHandoffContainmentApprovalInput
) {
  const blockers: string[] = [];
  const plan = buildVelvetHandoffContainmentPlan(snapshot);

  blockers.push(...plan.blockers);
  if (input.approvalPhrase !== VELVET_HANDOFF_CONTAINMENT_APPROVAL) {
    blockers.push("EXACT_PROVIDER_MUTATION_APPROVAL_MISSING");
  }
  if (input.expectedProjectId !== snapshot.projectId) {
    blockers.push("RAILWAY_PROJECT_CHANGED_SINCE_APPROVAL");
  }
  if (input.expectedServiceId !== snapshot.serviceId) {
    blockers.push("RAILWAY_SERVICE_CHANGED_SINCE_APPROVAL");
  }
  if (input.expectedEnvironmentId !== snapshot.environmentId) {
    blockers.push("RAILWAY_ENVIRONMENT_CHANGED_SINCE_APPROVAL");
  }
  if (input.expectedLiveCommit !== snapshot.liveCommit) {
    blockers.push("LIVE_SMIRK_COMMIT_CHANGED_SINCE_APPROVAL");
  }
  if (!snapshot.targetVariablePresent) {
    blockers.push("TARGET_VARIABLE_ALREADY_ABSENT");
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    authorized: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    targetVariable: VELVET_HANDOFF_CREDENTIAL_VARIABLE,
    deploymentAuthorized: false,
  };
}

export function diffRailwayVariableMaps(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>
) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  const removed = beforeKeys.filter(key => !afterSet.has(key));
  const added = afterKeys.filter(key => !beforeSet.has(key));
  const changed = beforeKeys.filter(
    key => afterSet.has(key) && before[key] !== after[key]
  );

  return {
    removed,
    added,
    changed,
    exactlyTargetRemoved:
      removed.length === 1 &&
      removed[0] === VELVET_HANDOFF_CREDENTIAL_VARIABLE &&
      added.length === 0 &&
      changed.length === 0,
  };
}

export function verifyVelvetHandoffContainmentStage(input: {
  mutationAccepted: boolean;
  beforeVariables: Record<string, string | undefined>;
  afterVariables: Record<string, string | undefined>;
  beforeDeploymentIds: string[];
  afterDeploymentIds: string[];
}) {
  const diff = diffRailwayVariableMaps(
    input.beforeVariables,
    input.afterVariables
  );
  const beforeDeployments = new Set(input.beforeDeploymentIds);
  const newDeploymentIds = input.afterDeploymentIds.filter(
    id => !beforeDeployments.has(id)
  );
  const blockers: string[] = [];

  if (!input.mutationAccepted) {
    blockers.push("RAILWAY_VARIABLE_DELETE_NOT_ACCEPTED");
  }
  if (!diff.exactlyTargetRemoved) {
    blockers.push("RAILWAY_VARIABLE_DIFF_OUT_OF_SCOPE");
  }
  if (newDeploymentIds.length > 0) {
    blockers.push("UNEXPECTED_DEPLOYMENT_OBSERVED");
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    contractVersion: VELVET_HANDOFF_CONTAINMENT_CONTRACT,
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    targetVariable: VELVET_HANDOFF_CREDENTIAL_VARIABLE,
    providerMutationPerformed: true,
    productionConfigChangeStaged:
      input.mutationAccepted && diff.exactlyTargetRemoved,
    runtimeContained: false,
    deploymentPerformed: newDeploymentIds.length > 0,
    deploymentAuthorized: false,
    deploymentRequiredToChangeRunningRevision: true,
    variableDiff: {
      removed: diff.removed,
      added: diff.added,
      changed: diff.changed,
    },
    deploymentObservation: {
      beforeCount: input.beforeDeploymentIds.length,
      afterCount: input.afterDeploymentIds.length,
      newDeploymentIds,
    },
    nextGate:
      uniqueBlockers.length === 0
        ? "Obtain separate deploy approval, apply the staged Railway change, then prove the live endpoint fails closed."
        : "Stop and inspect the provider state; do not claim containment or deploy anything.",
  };
}
