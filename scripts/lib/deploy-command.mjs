const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;

export const PROSPECT_SCHEMA_CHANGE_CONFIRMATION =
  "reviewed-prospect-schema";
export const PROSPECT_SCHEMA_BACKUP_CONFIRMATION =
  "verified-production-backup";

export function hasProspectSchemaDeployApproval(env = process.env) {
  return (
    String(env.CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE || "").trim() ===
      PROSPECT_SCHEMA_CHANGE_CONFIRMATION &&
    String(env.CONFIRM_SMIRK_PROSPECT_SCHEMA_BACKUP || "").trim() ===
      PROSPECT_SCHEMA_BACKUP_CONFIRMATION
  );
}

export function buildExactDeployCommand({ branch, commit, bootstrapMode = null }) {
  const normalizedBranch = String(branch || "").trim();
  const normalizedCommit = String(commit || "").trim();
  if (!BRANCH_PATTERN.test(normalizedBranch) || !COMMIT_PATTERN.test(normalizedCommit)) {
    throw new Error("exact deploy command requires a safe branch and 40-character commit");
  }
  return [
    ...(bootstrapMode ? [`SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=${bootstrapMode}`] : []),
    `CONFIRM_SMIRK_PROSPECT_SCHEMA_CHANGE=${PROSPECT_SCHEMA_CHANGE_CONFIRMATION}`,
    `CONFIRM_SMIRK_PROSPECT_SCHEMA_BACKUP=${PROSPECT_SCHEMA_BACKUP_CONFIRMATION}`,
    "CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix",
    ...(normalizedBranch === "main" && !bootstrapMode ? [] : [`CONFIRM_SMIRK_DEPLOY_BRANCH=${normalizedBranch}`]),
    `CONFIRM_SMIRK_DEPLOY_COMMIT=${normalizedCommit}`,
    "npm run deploy:post-call-fix",
  ].join(" ");
}

export function selectDeployCommandFromBundle(bundle = {}) {
  const bundledCommand =
    typeof bundle.deployCommand === "string" ? bundle.deployCommand.trim() : "";
  if (bundledCommand) return bundledCommand;

  const approvalStep = Array.isArray(bundle.approvalSteps)
    ? bundle.approvalSteps.find(
        (step) =>
          typeof step === "string" &&
          step.includes("npm run deploy:post-call-fix")
      )
    : null;
  if (approvalStep) return approvalStep;

  const nextAction =
    typeof bundle.nextAction === "string" ? bundle.nextAction.trim() : "";
  return nextAction || "See deploy approval note.";
}
