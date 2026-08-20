export const PROSPECT_MANUAL_CALL_MODE =
  "operator-tel-link-v1" as const;

export type ProspectManualCallConfig = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  mode: typeof PROSPECT_MANUAL_CALL_MODE | null;
  workspaceId: number | null;
  dailyApprovalCap: number | null;
  manualDialOnly: true;
  providerExecutionAllowed: false;
  automatedDialingAllowed: false;
};

export type PublicProspectManualCallConfig = {
  enabled: boolean;
  configured: boolean;
  availableForWorkspace: boolean;
  missing: string[];
  mode: typeof PROSPECT_MANUAL_CALL_MODE | null;
  workspaceId: number | null;
  dailyApprovalCap: number | null;
  manualDialOnly: true;
  providerExecutionAllowed: false;
  automatedDialingAllowed: false;
};

function positiveInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number
): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

export function readProspectManualCallConfig(
  env: Record<string, string | undefined> = process.env
): ProspectManualCallConfig {
  const enabled = env.PROSPECT_MANUAL_CALL_ENABLED === "true";
  const mode =
    env.PROSPECT_MANUAL_CALL_MODE === PROSPECT_MANUAL_CALL_MODE
      ? PROSPECT_MANUAL_CALL_MODE
      : null;
  const workspaceId = positiveInteger(
    env.PROSPECT_MANUAL_CALL_WORKSPACE_ID,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const dailyApprovalCap = positiveInteger(
    env.PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP,
    1,
    5
  );
  const missing: string[] = [];
  if (!mode) missing.push("PROSPECT_MANUAL_CALL_MODE");
  if (!workspaceId) missing.push("PROSPECT_MANUAL_CALL_WORKSPACE_ID");
  if (!dailyApprovalCap) {
    missing.push("PROSPECT_MANUAL_CALL_DAILY_APPROVAL_CAP");
  }

  return {
    enabled,
    configured: missing.length === 0,
    missing,
    mode,
    workspaceId,
    dailyApprovalCap,
    manualDialOnly: true,
    providerExecutionAllowed: false,
    automatedDialingAllowed: false,
  };
}

export function publicProspectManualCallConfig(
  config: ProspectManualCallConfig,
  workspaceId: number
): PublicProspectManualCallConfig {
  return {
    enabled: config.enabled,
    configured: config.configured,
    availableForWorkspace:
      config.enabled &&
      config.configured &&
      config.workspaceId === workspaceId,
    missing: [...config.missing],
    mode: config.mode,
    workspaceId: config.workspaceId,
    dailyApprovalCap: config.dailyApprovalCap,
    manualDialOnly: true,
    providerExecutionAllowed: false,
    automatedDialingAllowed: false,
  };
}
