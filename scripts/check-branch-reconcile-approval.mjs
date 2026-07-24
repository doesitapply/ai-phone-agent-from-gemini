#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { analyzeDeployRemoteSync } from "./lib/git-deploy-sync.mjs";

const approvalToken = "APPROVE_SMIRK_BRANCH_RECONCILE";
const markdownPath = "output/branch-reconcile-approval.md";
const jsonPath = "output/branch-reconcile-approval.json";

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const localBranch = git(["branch", "--show-current"]) || "unknown";
const localCommit = git(["rev-parse", "HEAD"]);
const sync = analyzeDeployRemoteSync({
  localBranch,
  localCommit,
  resolveRemoteCommit: (remoteRef) => git(["rev-parse", remoteRef]),
  resolveMergeBase: (_commit, remoteRef) => git(["merge-base", "HEAD", remoteRef]),
});
const {
  approvalRequired,
  gitRemoteSync,
  remoteRef,
  remoteCommit,
  mergeBase,
  remoteName,
  remoteBranch,
  remotes: remoteStates,
} = sync;
const conflictForecastCommand =
  `SMIRK_BRANCH_SYNC_REMOTE=${remoteRef} npm run -s check:branch-sync-conflict-forecast`;
const branchReconcileCommand = `git pull --rebase ${remoteName} ${remoteBranch}`;

if (!approvalRequired) {
  console.log(JSON.stringify({
    ok: true,
    approvalRequired,
    gitRemoteSync,
    localBranch,
    localCommit,
    remoteBranch: remoteRef,
    remoteCommit,
    remoteStates,
    checkedArtifacts: [],
    reason: "Branch reconciliation is not required for the current git state.",
    failures: [],
  }, null, 2));
  process.exit(0);
}

const failures = [];
if (!existsSync(markdownPath)) failures.push(`${markdownPath} is missing`);
if (!existsSync(jsonPath)) failures.push(`${jsonPath} is missing`);

let markdown = "";
let data = null;
if (existsSync(markdownPath)) markdown = readFileSync(markdownPath, "utf8");
if (existsSync(jsonPath)) {
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    failures.push(`${jsonPath} is not valid JSON`);
  }
}

if (data) {
  if (data.approvalRequired !== approvalRequired) {
    failures.push(`approvalRequired=${data.approvalRequired} does not match current git state ${approvalRequired}`);
  }
  if (data.gitRemoteSync !== gitRemoteSync) {
    failures.push(`gitRemoteSync=${data.gitRemoteSync} does not match current git state ${gitRemoteSync}`);
  }
  if (data.localBranch !== localBranch) {
    failures.push(`localBranch=${data.localBranch} does not match current branch ${localBranch}`);
  }
  if (data.localCommit !== localCommit) {
    failures.push(`localCommit=${data.localCommit} does not match current commit ${localCommit}`);
  }
  if (data.remoteCommit !== remoteCommit) {
    failures.push(`remoteCommit=${data.remoteCommit} does not match ${remoteRef} ${remoteCommit}`);
  }
  if (data.remoteBranch !== remoteRef) {
    failures.push(`remoteBranch=${data.remoteBranch} does not match current blocking remote ${remoteRef}`);
  }
  if (data.mergeBaseWithRemote !== mergeBase) {
    failures.push(`mergeBaseWithRemote=${data.mergeBaseWithRemote} does not match current merge base ${mergeBase}`);
  }
  if (data.approvalToken !== approvalToken) {
    failures.push(`approvalToken must be ${approvalToken}`);
  }
  if (!String(data.boundary || "").includes("does not authorize deploy")) {
    failures.push("boundary must say branch reconciliation approval does not authorize deploy");
  }
  if (approvalRequired && data.branchReconcileCommand !== branchReconcileCommand) {
    failures.push(`branchReconcileCommand must be ${branchReconcileCommand} when approval is required`);
  }
  if (approvalRequired && data.conflictForecastCommand !== conflictForecastCommand) {
    failures.push(`conflictForecastCommand must be ${conflictForecastCommand} when approval is required`);
  }
  if (approvalRequired && !String(data.stopRule || "").includes("stop and preserve the conflicted state")) {
    failures.push("stopRule must tell the operator to stop and preserve conflicts when approval is required");
  }
}

for (const required of [
  "Branch reconciliation approval only",
  "does not authorize deploy",
  approvalToken,
  conflictForecastCommand,
  "If rebase produces conflicts, stop and preserve the conflicted state",
  branchReconcileCommand,
  "npm run -s check:deploy-post-call-fix-ready",
  "npm run write:deploy-approval-bundle",
  "npm run -s check:deploy-approval-handoff",
]) {
  if (!markdown.includes(required)) {
    failures.push(`${markdownPath} must include ${JSON.stringify(required)}`);
  }
}

const out = {
  ok: failures.length === 0,
  approvalRequired,
  gitRemoteSync,
  localBranch,
  localCommit,
  remoteBranch: remoteRef,
  remoteCommit,
  remoteStates,
  checkedArtifacts: [markdownPath, jsonPath],
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
