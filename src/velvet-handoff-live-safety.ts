export const VELVET_HANDOFF_LIVE_SAFETY_CONTRACT =
  "smirk.velvet-handoff-live-safety.v1";

export const VELVET_HANDOFF_SYNTHETIC_MODE =
  "synthetic-fixture-only-v1";

export type VelvetHandoffLiveSafetyInput = {
  localTargetCommit: string | null;
  localTargetSource: string | null;
  liveSmirkCommit: string | null;
  liveSmirkSource: string | null;
  railwayVariablesRead: boolean;
  handoffApiKeyConfigured: boolean;
  handoffApiKeyStrong: boolean;
  handoffMode: string | null;
  handoffWorkspaceConfigured: boolean;
  handoffCredentialSeparated: boolean;
  velvetBundleRead: boolean;
  velvetBundleSource: string | null;
  requestsPerformed: number;
};

export type VelvetHandoffReceiverState =
  | "LEGACY_RECEIVER_EXPOSED"
  | "DISABLED_NO_HANDOFF_CREDENTIAL"
  | "DISABLED_WEAK_HANDOFF_CREDENTIAL"
  | "DISABLED_SYNTHETIC_MODE_NOT_CONFIGURED"
  | "DISABLED_WORKSPACE_NOT_CONFIGURED"
  | "SYNTHETIC_FIXTURE_ONLY"
  | "UNKNOWN";

const REQUIRED_SMIRK_SOURCE_MARKERS = [
  "VELVET_SYNTHETIC_HANDOFF_MODE",
  "VELVET_SYNTHETIC_HANDOFF_PHONE",
  "validateSyntheticVelvetHandoffPayload",
  "VELVET_ALCHEMY_HANDOFF_SYNTHETIC_FIXTURE_REQUIRED",
  "if (!validateSyntheticVelvetHandoffPayload(input).ok)",
] as const;

const LEGACY_VELVET_BUNDLE_MARKERS = [
  "Queue SMIRK Call",
  "SMIRK call queued",
  "triggerHandoff",
] as const;

const HARDENED_VELVET_BUNDLE_MARKERS = [
  "Add to SMIRK Research",
  "No contact action was created",
  "SMIRK Research Queue",
] as const;

export function inspectSmirkSyntheticHandoffSource(source: string | null): {
  available: boolean;
  syntheticBoundaryPresent: boolean;
  missingMarkers: string[];
} {
  if (!source) {
    return {
      available: false,
      syntheticBoundaryPresent: false,
      missingMarkers: [...REQUIRED_SMIRK_SOURCE_MARKERS],
    };
  }
  const missingMarkers = REQUIRED_SMIRK_SOURCE_MARKERS.filter(
    marker => !source.includes(marker)
  );
  return {
    available: true,
    syntheticBoundaryPresent: missingMarkers.length === 0,
    missingMarkers,
  };
}

export function inspectVelvetProductionBundle(source: string | null): {
  available: boolean;
  legacyHandoffControlPresent: boolean;
  hardenedResearchControlPresent: boolean;
  safe: boolean;
} {
  if (!source) {
    return {
      available: false,
      legacyHandoffControlPresent: false,
      hardenedResearchControlPresent: false,
      safe: false,
    };
  }
  const legacyHandoffControlPresent = LEGACY_VELVET_BUNDLE_MARKERS.some(
    marker => source.includes(marker)
  );
  const hardenedResearchControlPresent = HARDENED_VELVET_BUNDLE_MARKERS.every(
    marker => source.includes(marker)
  );
  return {
    available: true,
    legacyHandoffControlPresent,
    hardenedResearchControlPresent,
    safe: !legacyHandoffControlPresent && hardenedResearchControlPresent,
  };
}

function resolveReceiverState(input: {
  liveSourceSafe: boolean;
  variablesRead: boolean;
  apiKeyConfigured: boolean;
  apiKeyStrong: boolean;
  mode: string | null;
  workspaceConfigured: boolean;
}): VelvetHandoffReceiverState {
  if (!input.variablesRead) return "UNKNOWN";
  if (!input.apiKeyConfigured) return "DISABLED_NO_HANDOFF_CREDENTIAL";
  if (!input.liveSourceSafe) return "LEGACY_RECEIVER_EXPOSED";
  if (!input.apiKeyStrong) return "DISABLED_WEAK_HANDOFF_CREDENTIAL";
  if (input.mode !== VELVET_HANDOFF_SYNTHETIC_MODE) {
    return "DISABLED_SYNTHETIC_MODE_NOT_CONFIGURED";
  }
  if (!input.workspaceConfigured) return "DISABLED_WORKSPACE_NOT_CONFIGURED";
  return "SYNTHETIC_FIXTURE_ONLY";
}

export function buildVelvetHandoffLiveSafetyReport(
  input: VelvetHandoffLiveSafetyInput
) {
  const localTarget = inspectSmirkSyntheticHandoffSource(
    input.localTargetSource
  );
  const liveSmirk = inspectSmirkSyntheticHandoffSource(
    input.liveSmirkSource
  );
  const liveVelvet = inspectVelvetProductionBundle(
    input.velvetBundleSource
  );
  const receiverState = resolveReceiverState({
    liveSourceSafe: liveSmirk.syntheticBoundaryPresent,
    variablesRead: input.railwayVariablesRead,
    apiKeyConfigured: input.handoffApiKeyConfigured,
    apiKeyStrong: input.handoffApiKeyStrong,
    mode: input.handoffMode,
    workspaceConfigured: input.handoffWorkspaceConfigured,
  });
  const blockers: string[] = [];

  if (!localTarget.syntheticBoundaryPresent) {
    blockers.push("LOCAL_TARGET_SYNTHETIC_BOUNDARY_MISSING");
  }
  if (!liveSmirk.available) {
    blockers.push("LIVE_SMIRK_SOURCE_UNAVAILABLE");
  } else if (!liveSmirk.syntheticBoundaryPresent) {
    blockers.push("LIVE_SMIRK_SYNTHETIC_BOUNDARY_NOT_DEPLOYED");
  }
  if (
    !input.localTargetCommit ||
    !input.liveSmirkCommit ||
    input.localTargetCommit !== input.liveSmirkCommit
  ) {
    blockers.push("LIVE_SMIRK_COMMIT_NOT_LOCAL_TARGET");
  }
  if (!input.railwayVariablesRead) {
    blockers.push("RAILWAY_PRODUCTION_VARIABLES_UNAVAILABLE");
  }
  if (
    input.handoffApiKeyConfigured &&
    !input.handoffCredentialSeparated
  ) {
    blockers.push("HANDOFF_CREDENTIAL_NOT_SEPARATED");
  }
  if (receiverState === "LEGACY_RECEIVER_EXPOSED") {
    blockers.push("LIVE_LEGACY_HANDOFF_RECEIVER_EXPOSED");
  }
  if (!input.velvetBundleRead || !liveVelvet.available) {
    blockers.push("LIVE_VELVET_BUNDLE_UNAVAILABLE");
  } else {
    if (liveVelvet.legacyHandoffControlPresent) {
      blockers.push("LIVE_VELVET_LEGACY_HANDOFF_UI_PRESENT");
    }
    if (!liveVelvet.hardenedResearchControlPresent) {
      blockers.push("LIVE_VELVET_RESEARCH_UI_UNPROVEN");
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const containmentRequired =
    receiverState === "LEGACY_RECEIVER_EXPOSED";
  const nextActions = containmentRequired
    ? [
        "Obtain explicit approval to remove or rotate only VELVET_ALCHEMY_HANDOFF_API_KEY in SMIRK Railway, then verify the legacy endpoint fails closed.",
        "Deploy the reviewed SMIRK synthetic-only receiver before re-enabling any synthetic handoff credential.",
        "Deploy the reviewed Velvet research-queue UI before using the live SMIRK action.",
      ]
    : uniqueBlockers.length > 0
      ? [
          "Deploy the reviewed SMIRK and Velvet hardening commits under their separate approval gates, then rerun this read-only check.",
        ]
      : [];

  return {
    contractVersion: VELVET_HANDOFF_LIVE_SAFETY_CONTRACT,
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    containmentRequired,
    containmentApprovalPhrase: containmentRequired
      ? "APPROVE_DISABLE_LEGACY_VELVET_HANDOFF_IN_RAILWAY"
      : null,
    localTarget: {
      commit: input.localTargetCommit,
      sourceAvailable: localTarget.available,
      syntheticBoundaryPresent:
        localTarget.syntheticBoundaryPresent,
      missingMarkerCount: localTarget.missingMarkers.length,
    },
    liveSmirk: {
      commit: input.liveSmirkCommit,
      sourceAvailable: liveSmirk.available,
      matchesLocalTarget:
        Boolean(input.localTargetCommit) &&
        input.localTargetCommit === input.liveSmirkCommit,
      syntheticBoundaryPresent: liveSmirk.syntheticBoundaryPresent,
      missingMarkerCount: liveSmirk.missingMarkers.length,
      railwayVariablesRead: input.railwayVariablesRead,
      handoffApiKeyConfigured: input.handoffApiKeyConfigured,
      handoffApiKeyStrong: input.handoffApiKeyStrong,
      handoffModeConfigured:
        input.handoffMode === VELVET_HANDOFF_SYNTHETIC_MODE,
      handoffWorkspaceConfigured: input.handoffWorkspaceConfigured,
      handoffCredentialSeparated: input.handoffCredentialSeparated,
      receiverState,
    },
    liveVelvet: {
      bundleRead: input.velvetBundleRead,
      legacyHandoffControlPresent:
        liveVelvet.legacyHandoffControlPresent,
      hardenedResearchControlPresent:
        liveVelvet.hardenedResearchControlPresent,
    },
    guardrails: {
      coldSmsAllowed: false,
      automatedProspectDialingAllowed: false,
      contactAuthorized: false,
      spendAuthorized: false,
      providerMutationPerformed: false,
      productionWritePerformed: false,
      credentialsExposed: false,
    },
    requestsPerformed: input.requestsPerformed,
    nextActions,
    externalAction: "read-only-production-inspection",
  };
}
