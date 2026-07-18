const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;

export function buildExactDeployCommand({ branch, commit, bootstrapMode = null }) {
  const normalizedBranch = String(branch || "").trim();
  const normalizedCommit = String(commit || "").trim();
  if (!BRANCH_PATTERN.test(normalizedBranch) || !COMMIT_PATTERN.test(normalizedCommit)) {
    throw new Error("exact deploy command requires a safe branch and 40-character commit");
  }
  return [
    ...(bootstrapMode ? [`SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=${bootstrapMode}`] : []),
    "CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix",
    ...(normalizedBranch === "main" && !bootstrapMode ? [] : [`CONFIRM_SMIRK_DEPLOY_BRANCH=${normalizedBranch}`]),
    `CONFIRM_SMIRK_DEPLOY_COMMIT=${normalizedCommit}`,
    "npm run deploy:post-call-fix",
  ].join(" ");
}
