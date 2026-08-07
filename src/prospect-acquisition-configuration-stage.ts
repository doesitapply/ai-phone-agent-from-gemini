import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildProspectAcquisitionConfigurationPlan,
  PROSPECT_ACQUISITION_ACTIVATION_SWITCHES,
} from "./prospect-acquisition-configuration-plan.js";
import type { ProspectAcquisitionConfigurationPhaseId } from "./prospect-acquisition-connection-readiness.js";

export const PROSPECT_ACQUISITION_CONFIGURATION_STAGE_CONTRACT =
  "smirk.prospect-acquisition-configuration-stage.v1" as const;
export const PROSPECT_ACQUISITION_CONFIGURATION_STAGE_APPROVAL_PREFIX =
  "APPROVE_SMIRK_PROSPECT_ACQUISITION_CONFIG_STAGE" as const;
export const SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET = {
  projectId: "90599f03-6d6f-4044-8933-e0301be67a82",
  serviceId: "96bcd6e7-9487-4197-bcd1-a6bd0546e6b2",
  environmentId: "22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a",
} as const;

export type ProspectAcquisitionConfigurationStageSnapshot = {
  projectId: string;
  serviceId: string;
  environmentId: string;
  headCommit: string;
  liveCommit: string | null;
  liveReadinessConfirmed: boolean;
  deploymentIds: string[];
  activeDeploymentPresent: boolean;
  worktreeClean: boolean;
  headPublished: boolean;
};

type VariableMap = Record<string, string | undefined>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function validCommit(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{40}$/i.test(value));
}

function validTargetId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(value);
}

function normalizedAssignments(input: Record<string, unknown>): {
  assignments: Record<string, string>;
  blockers: string[];
} {
  const assignments: Record<string, string> = {};
  const blockers: string[] = [];
  for (const [name, rawValue] of Object.entries(input)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      blockers.push("STAGE_VARIABLE_NAME_INVALID");
      continue;
    }
    if (typeof rawValue !== "string") {
      blockers.push(`STAGE_VALUE_NOT_STRING:${name}`);
      continue;
    }
    if (
      rawValue.length === 0 ||
      rawValue.length > 4_096 ||
      rawValue.trim() !== rawValue ||
      /[\r\n\0]/.test(rawValue)
    ) {
      blockers.push(`STAGE_VALUE_INVALID:${name}`);
      continue;
    }
    assignments[name] = rawValue;
  }
  return { assignments, blockers };
}

function exactStringEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildProspectAcquisitionConfigurationStagePlan(input: {
  phase: ProspectAcquisitionConfigurationPhaseId;
  currentVariables: VariableMap;
  requestedAssignments: Record<string, unknown>;
  snapshot: ProspectAcquisitionConfigurationStageSnapshot;
}) {
  const blockers: string[] = [];
  const normalized = normalizedAssignments(input.requestedAssignments);
  blockers.push(...normalized.blockers);

  const currentPlan = buildProspectAcquisitionConfigurationPlan({
    phase: input.phase,
    env: input.currentVariables,
    source: "synthetic-test",
  });
  const requiredNames = currentPlan.requiredVariables
    .map(variable => variable.name)
    .sort();
  const providedNames = Object.keys(normalized.assignments).sort();
  const requiredSet = new Set(requiredNames);
  const providedSet = new Set(providedNames);
  const missingNames = requiredNames.filter(name => !providedSet.has(name));
  const unexpectedNames = providedNames.filter(name => !requiredSet.has(name));
  if (missingNames.length > 0) {
    blockers.push(...missingNames.map(name => `STAGE_VALUE_MISSING:${name}`));
  }
  if (unexpectedNames.length > 0) {
    blockers.push(
      ...unexpectedNames.map(name => `STAGE_VARIABLE_NOT_ALLOWED:${name}`)
    );
  }

  const stagedVariables = {
    ...input.currentVariables,
    ...normalized.assignments,
  };
  const enabledOrInvalidSwitches =
    PROSPECT_ACQUISITION_ACTIVATION_SWITCHES.filter(name => {
      const value = String(stagedVariables[name] || "").trim();
      return value !== "" && value !== "false";
    });
  blockers.push(
    ...enabledOrInvalidSwitches.map(
      name => `STAGE_EXECUTION_SWITCH_NOT_DISABLED:${name}`
    )
  );
  const stagedPlan = buildProspectAcquisitionConfigurationPlan({
    phase: input.phase,
    env: stagedVariables,
    source: "synthetic-test",
  });
  if (!stagedPlan.stagedConfigurationReady) {
    blockers.push(...stagedPlan.stagedConfigurationBlockers);
  }
  if (
    !stagedPlan.activation.allExecutionSwitchesDisabled ||
    enabledOrInvalidSwitches.length > 0
  ) {
    blockers.push("STAGE_EXECUTION_SWITCH_MUST_REMAIN_DISABLED");
  }
  if (!validTargetId(input.snapshot.projectId)) {
    blockers.push("RAILWAY_PROJECT_ID_INVALID");
  } else if (
    input.snapshot.projectId !==
    SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET.projectId
  ) {
    blockers.push("RAILWAY_PROJECT_NOT_SMIRK_PRODUCTION");
  }
  if (!validTargetId(input.snapshot.serviceId)) {
    blockers.push("RAILWAY_SERVICE_ID_INVALID");
  } else if (
    input.snapshot.serviceId !==
    SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET.serviceId
  ) {
    blockers.push("RAILWAY_SERVICE_NOT_SMIRK_PRODUCTION");
  }
  if (!validTargetId(input.snapshot.environmentId)) {
    blockers.push("RAILWAY_ENVIRONMENT_ID_INVALID");
  } else if (
    input.snapshot.environmentId !==
    SMIRK_PROSPECT_ACQUISITION_RAILWAY_TARGET.environmentId
  ) {
    blockers.push("RAILWAY_ENVIRONMENT_NOT_SMIRK_PRODUCTION");
  }
  if (!validCommit(input.snapshot.headCommit)) {
    blockers.push("LOCAL_HEAD_COMMIT_UNCONFIRMED");
  }
  if (!validCommit(input.snapshot.liveCommit)) {
    blockers.push("LIVE_SMIRK_COMMIT_UNCONFIRMED");
  }
  if (!input.snapshot.liveReadinessConfirmed) {
    blockers.push("LIVE_SMIRK_READINESS_UNCONFIRMED");
  }
  if (input.snapshot.activeDeploymentPresent) {
    blockers.push("ACTIVE_RAILWAY_DEPLOYMENT_PRESENT");
  }
  if (!input.snapshot.worktreeClean) {
    blockers.push("LOCAL_WORKTREE_DIRTY");
  }
  if (!input.snapshot.headPublished) {
    blockers.push("LOCAL_HEAD_NOT_PUBLISHED");
  }

  const assignmentDigest = sha256({
    contractVersion: PROSPECT_ACQUISITION_CONFIGURATION_STAGE_CONTRACT,
    phase: input.phase,
    target: {
      projectId: input.snapshot.projectId,
      serviceId: input.snapshot.serviceId,
      environmentId: input.snapshot.environmentId,
    },
    headCommit: input.snapshot.headCommit,
    liveCommit: input.snapshot.liveCommit,
    assignments: normalized.assignments,
  });
  const changedNames = providedNames.filter(
    name => input.currentVariables[name] !== normalized.assignments[name]
  );
  const approvalPhrase = `${PROSPECT_ACQUISITION_CONFIGURATION_STAGE_APPROVAL_PREFIX}: phase=${input.phase}; digest=${assignmentDigest}; head=${input.snapshot.headCommit}; live=${input.snapshot.liveCommit || "UNCONFIRMED"}; target=${input.snapshot.projectId}/${input.snapshot.serviceId}/${input.snapshot.environmentId}; action=stage-with-skip-deploys-only`;
  const uniqueBlockers = sortedUnique(blockers);

  return {
    contractVersion: PROSPECT_ACQUISITION_CONFIGURATION_STAGE_CONTRACT,
    ok: uniqueBlockers.length === 0,
    phase: input.phase,
    blockers: uniqueBlockers,
    assignmentDigest,
    assignmentNames: providedNames,
    requiredNames,
    changedNames,
    mutationRequired: changedNames.length > 0,
    idempotentReplay: changedNames.length === 0,
    stagedConfigurationReady: stagedPlan.stagedConfigurationReady,
    allExecutionSwitchesDisabled:
      stagedPlan.activation.allExecutionSwitchesDisabled &&
      enabledOrInvalidSwitches.length === 0,
    approvalPhrase,
    exactTarget: {
      projectId: input.snapshot.projectId,
      serviceId: input.snapshot.serviceId,
      environmentId: input.snapshot.environmentId,
      headCommit: input.snapshot.headCommit,
      liveCommit: input.snapshot.liveCommit,
    },
    observed: {
      currentVariableCount: Object.keys(input.currentVariables).length,
      assignmentCount: providedNames.length,
      deploymentCount: input.snapshot.deploymentIds.length,
      liveReadinessConfirmed: input.snapshot.liveReadinessConfirmed,
      activeDeploymentPresent: input.snapshot.activeDeploymentPresent,
      worktreeClean: input.snapshot.worktreeClean,
      headPublished: input.snapshot.headPublished,
    },
    guardrails: {
      valuesDisclosed: false as const,
      providerMutationAuthorized: false as const,
      deploymentAuthorized: false as const,
      contactAuthorized: false as const,
      spendAuthorized: false as const,
      coldSmsAllowed: false as const,
      bulkEmailAllowed: false as const,
      automatedProspectDialingAllowed: false as const,
    },
    nextGate:
      uniqueBlockers.length > 0
        ? "Resolve the named blockers and regenerate the exact digest."
        : changedNames.length === 0
          ? "Configuration already matches these private values. A separate deploy and remote authority proof are still required."
          : "Obtain exact digest-bound provider-mutation approval to stage only these variables with --skip-deploys.",
  };
}

export function evaluateProspectAcquisitionConfigurationStageApproval(input: {
  plan: ReturnType<
    typeof buildProspectAcquisitionConfigurationStagePlan
  >;
  providedApproval: string | null;
}) {
  const blockers = [...input.plan.blockers];
  if (!input.plan.mutationRequired) {
    blockers.push("STAGE_CONFIGURATION_ALREADY_MATCHES");
  }
  if (!exactStringEqual(input.providedApproval, input.plan.approvalPhrase)) {
    blockers.push("EXACT_PROVIDER_MUTATION_APPROVAL_MISSING");
  }
  const uniqueBlockers = sortedUnique(blockers);
  return {
    authorized: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    assignmentDigest: input.plan.assignmentDigest,
    assignmentNames: input.plan.assignmentNames,
    providerMutationAuthorized: uniqueBlockers.length === 0,
    deploymentAuthorized: false as const,
    contactAuthorized: false as const,
    spendAuthorized: false as const,
  };
}

function diffVariableMaps(before: VariableMap, after: VariableMap) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  return {
    added: afterKeys.filter(key => !beforeSet.has(key)),
    removed: beforeKeys.filter(key => !afterSet.has(key)),
    changed: beforeKeys.filter(
      key => afterSet.has(key) && before[key] !== after[key]
    ),
  };
}

export function verifyProspectAcquisitionConfigurationStage(input: {
  phase: ProspectAcquisitionConfigurationPhaseId;
  beforeVariables: VariableMap;
  afterVariables: VariableMap;
  requestedAssignments: Record<string, unknown>;
  snapshot: ProspectAcquisitionConfigurationStageSnapshot;
  afterDeploymentIds: string[];
  acceptedAssignmentNames: string[];
}) {
  const plan = buildProspectAcquisitionConfigurationStagePlan({
    phase: input.phase,
    currentVariables: input.beforeVariables,
    requestedAssignments: input.requestedAssignments,
    snapshot: input.snapshot,
  });
  const normalized = normalizedAssignments(input.requestedAssignments);
  const diff = diffVariableMaps(input.beforeVariables, input.afterVariables);
  const expectedAdded = plan.changedNames.filter(
    name => !(name in input.beforeVariables)
  );
  const expectedChanged = plan.changedNames.filter(
    name => name in input.beforeVariables
  );
  const assignmentValuesMatch = plan.assignmentNames.every(
    name => input.afterVariables[name] === normalized.assignments[name]
  );
  const acceptedNamesMatch =
    JSON.stringify([...input.acceptedAssignmentNames].sort()) ===
    JSON.stringify(plan.changedNames);
  const variableDiffMatches =
    JSON.stringify(diff.added) === JSON.stringify(expectedAdded) &&
    JSON.stringify(diff.changed) === JSON.stringify(expectedChanged) &&
    diff.removed.length === 0;
  const previousDeployments = new Set(input.snapshot.deploymentIds);
  const newDeploymentIds = input.afterDeploymentIds.filter(
    id => !previousDeployments.has(id)
  );
  const stagedPlan = buildProspectAcquisitionConfigurationPlan({
    phase: input.phase,
    env: input.afterVariables,
    source: "synthetic-test",
  });
  const blockers: string[] = [];
  if (!plan.ok) blockers.push(...plan.blockers);
  if (!acceptedNamesMatch) blockers.push("RAILWAY_VARIABLE_SET_NOT_ACCEPTED");
  if (!variableDiffMatches) blockers.push("RAILWAY_VARIABLE_DIFF_OUT_OF_SCOPE");
  if (!assignmentValuesMatch) blockers.push("RAILWAY_VARIABLE_VALUE_MISMATCH");
  if (newDeploymentIds.length > 0) {
    blockers.push("UNEXPECTED_DEPLOYMENT_OBSERVED");
  }
  if (!stagedPlan.safeStagingState) {
    blockers.push("STAGED_CONFIGURATION_NOT_SAFE");
  }
  const uniqueBlockers = sortedUnique(blockers);
  return {
    contractVersion: PROSPECT_ACQUISITION_CONFIGURATION_STAGE_CONTRACT,
    ok: uniqueBlockers.length === 0,
    phase: input.phase,
    blockers: uniqueBlockers,
    assignmentDigest: plan.assignmentDigest,
    assignmentNames: plan.assignmentNames,
    changedNames: plan.changedNames,
    providerMutationPerformed: input.acceptedAssignmentNames.length > 0,
    productionConfigurationStaged:
      uniqueBlockers.length === 0 && plan.changedNames.length > 0,
    stagedConfigurationReady: stagedPlan.stagedConfigurationReady,
    allExecutionSwitchesDisabled:
      stagedPlan.activation.allExecutionSwitchesDisabled,
    deploymentPerformed: newDeploymentIds.length > 0,
    deploymentAuthorized: false as const,
    runtimeActivated: false as const,
    variableDiff: diff,
    deploymentObservation: {
      beforeCount: input.snapshot.deploymentIds.length,
      afterCount: input.afterDeploymentIds.length,
      newDeploymentIds,
    },
    guardrails: {
      valuesDisclosed: false as const,
      contactAuthorized: false as const,
      spendAuthorized: false as const,
      executionAuthorized: false as const,
      deploymentAuthorized: false as const,
    },
    nextGate:
      uniqueBlockers.length === 0
        ? "Obtain separate deploy approval, then run the no-write remote authority proof before enabling any execution switch."
        : "Stop and inspect Railway state. Do not deploy or claim activation.",
  };
}
