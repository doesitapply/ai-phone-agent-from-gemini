const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function liveVersion(live) {
  return String(live?.version || live?.versionHeader || live?.actualVersion || "").trim();
}

function liveBranch(live) {
  return String(live?.branch || live?.branchHeader || live?.actualBranch || "").trim();
}

export function evaluateStripeWebhookSmokeApprovalIntegrity({
  approval,
  note,
  currentCommit,
  currentBranch,
  currentLive,
}) {
  const failures = [];
  const commit = String(currentCommit || "").trim();
  const branch = String(currentBranch || "").trim();
  const savedLive = approval?.readiness?.liveCurrent;
  const savedLiveVersion = liveVersion(savedLive);
  const savedLiveBranch = liveBranch(savedLive);
  const actualLiveVersion = liveVersion(currentLive);
  const actualLiveBranch = liveBranch(currentLive);
  const requireTrue = (condition, message) => { if (!condition) failures.push(message); };

  requireTrue(COMMIT_PATTERN.test(commit), "current Git commit must be an exact 40-character commit");
  requireTrue(branch.length > 0, "current Git branch must be present");
  requireTrue(approval?.sourceCommit === commit, "approval sourceCommit must match current HEAD");
  requireTrue(approval?.sourceBranch === branch, "approval sourceBranch must match current branch");
  requireTrue(savedLive?.ok === true, "saved approval liveCurrent must be true");
  requireTrue(savedLiveVersion === commit, "saved approval live version must match current HEAD");
  requireTrue(savedLiveBranch === branch, "saved approval live branch must match current branch");
  requireTrue(approval?.liveVersion === commit, "approval liveVersion must explicitly match current HEAD");
  requireTrue(approval?.liveBranch === branch, "approval liveBranch must explicitly match current branch");
  requireTrue(currentLive?.ok === true, "production must still match current HEAD when approval is exercised");
  requireTrue(actualLiveVersion === commit, "current production version must match current HEAD");
  requireTrue(actualLiveBranch === branch, "current production branch must match current branch");
  requireTrue(String(note || "").includes(`Commit: ${commit}`), "approval note must name the exact current commit");
  requireTrue(String(note || "").includes(`Branch: ${branch}`), "approval note must name the exact current branch");
  requireTrue(String(note || "").includes(`Live version: ${commit}`), "approval note must bind the exact live version");
  requireTrue(String(note || "").includes(`Live branch: ${branch}`), "approval note must bind the exact live branch");

  return {
    ok: failures.length === 0,
    failures,
    currentCommit: COMMIT_PATTERN.test(commit) ? commit : null,
    currentBranch: branch || null,
    savedLiveVersion: savedLiveVersion || null,
    savedLiveBranch: savedLiveBranch || null,
    actualLiveVersion: actualLiveVersion || null,
    actualLiveBranch: actualLiveBranch || null,
  };
}
