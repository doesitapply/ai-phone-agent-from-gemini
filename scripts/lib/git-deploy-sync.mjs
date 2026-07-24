export function classifyGitRemoteSync({ localCommit, remoteCommit, mergeBase }) {
  if (!localCommit || !remoteCommit || !mergeBase) return "unknown";
  if (localCommit === remoteCommit) return "current";
  if (mergeBase === remoteCommit) return "ahead";
  if (mergeBase === localCommit) return "behind";
  return "diverged";
}

export function analyzeDeployRemoteSync({
  localBranch,
  localCommit,
  resolveRemoteCommit,
  resolveMergeBase,
}) {
  const normalizedBranch = String(localBranch || "").trim() || "main";
  const targetRemoteRef = normalizedBranch === "main" ? null : `origin/${normalizedBranch}`;
  const requestedRefs = ["origin/main", targetRemoteRef].filter(Boolean);
  const remotes = [];

  for (const remoteRef of requestedRefs) {
    const remoteCommit = resolveRemoteCommit(remoteRef);
    if (!remoteCommit && remoteRef === targetRemoteRef) continue;
    const mergeBase = remoteCommit ? resolveMergeBase(localCommit, remoteRef) : null;
    remotes.push({
      remoteRef,
      remoteCommit,
      mergeBase,
      gitRemoteSync: classifyGitRemoteSync({ localCommit, remoteCommit, mergeBase }),
      isDeployBranchRemote: remoteRef === targetRemoteRef,
    });
  }

  const blockingRemotes = remotes.filter(
    ({ gitRemoteSync }) => gitRemoteSync === "behind" || gitRemoteSync === "diverged",
  );
  const selectedRemote =
    blockingRemotes.find(({ isDeployBranchRemote }) => isDeployBranchRemote)
    || blockingRemotes[0]
    || remotes.find(({ gitRemoteSync, isDeployBranchRemote }) => isDeployBranchRemote && gitRemoteSync !== "current")
    || remotes.find(({ gitRemoteSync }) => gitRemoteSync !== "current")
    || remotes[0]
    || {
      remoteRef: "origin/main",
      remoteCommit: null,
      mergeBase: null,
      gitRemoteSync: "unknown",
      isDeployBranchRemote: false,
    };

  const approvalRequired = blockingRemotes.length > 0;
  const gitRemoteSync = approvalRequired
    ? selectedRemote.gitRemoteSync
    : (remotes.some(({ gitRemoteSync: state }) => state === "unknown")
      ? "unknown"
      : (remotes.some(({ gitRemoteSync: state }) => state === "ahead") ? "ahead" : "current"));
  const [remoteName, ...remoteBranchParts] = selectedRemote.remoteRef.split("/");

  return {
    approvalRequired,
    gitRemoteSync,
    remoteRef: selectedRemote.remoteRef,
    remoteName,
    remoteBranch: remoteBranchParts.join("/"),
    remoteCommit: selectedRemote.remoteCommit,
    mergeBase: selectedRemote.mergeBase,
    remotes,
  };
}
